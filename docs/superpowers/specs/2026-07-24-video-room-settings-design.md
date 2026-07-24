# VR-17 — Video Room Settings (Mobile + minimal backend)

Status: **Design approved (2026-07-24) — awaiting plan.** Strictly additive. No Git. **No Prisma migration.**

Scope spans two repos: `soulzaa-backend` (6 files + 7 guards) and `soulzaa-mobile` (the bulk).

Owner workflow: TDD — one task at a time, failing test → implementation → passing test. Backend: run `tsc` + `eslint` + `jest` after every task. Mobile: `flutter analyze` + `flutter test`. Stop for review after each task. **Never commit.**

---

## 1. Objective

Make the Video Room Settings surface production-ready in the Soulzaa Flutter client, backed by the existing NestJS video-rooms module, so that:

- every control shown is **actually enforced** by the server,
- boolean toggles apply instantly and synchronise live to all participants,
- text/number fields commit on explicit Save,
- the Owner / Admin / Moderator / Audience permission matrix is read from the server rather than invented client-side.

### Approved scope decisions (locked)

| Decision | Choice |
|---|---|
| Scope | **A + B** — fix the broken mobile layer; add only the one missing settings endpoint + socket event. No schema change. |
| Apply model | **Hybrid** — booleans apply immediately (optimistic + rollback); text/number use Save/Confirm. |
| UI architecture | **Hub + drill-down pages.** |
| `MANAGE_MEDIA` | **Not created.** Media gate flags reuse the existing `MANAGE_PARTICIPANTS` (owner + admin). Zero enum/matrix change. |
| Unenforced settings fields | Ship the 8 already enforced; add guards to make **7 more** real; defer 6. |
| Git | Design + implementation stay **uncommitted**. User commits manually. |

**What ships — 15 enforced settings:**

- **13 via `PATCH :id/settings`** = 6 already enforced (`allowChat`, `slowModeSeconds`, `allowGifts`, `allowTreasure`, `allowPk`, `seatApprovalRequired`) + 7 made real by new guards (§6).
- **2 via `POST :id/seats/layout`** = `hostSeatCount` + `guestSeatCount`, the remaining already-enforced pair, which must not go through the settings endpoint (§4.3).

Every other hub control rides an endpoint that already exists (§5.4).

### Out of scope (explicit — cut, with cause)

**Theme, Background, Seat Style, Entry Animation** — `themeId`/`backgroundId` columns exist, but there is no read route, no write route, and they appear in no DTO. `VideoRoomTheme`/`VideoRoomBackground` are seeded tables nothing serves.

**Followers Only** — `VideoRoomAccessPolicy.FOLLOWERS_ONLY` is stored but the join gate never reads it (`video-room-lifecycle.service.ts:38` stores intent; member/viewer/password services contain no `accessPolicy` read). Source comment: *"Enforcement of the richer policies … lands with the join phase"* — it did not.

**Gift Lock (minimum gift to join)** · **Games (open / enable / permissions)** · **Per-category notifications** (join/gift/PK/treasure/follow — only a single room-level `:id/notifications/mute` exists) · **PK Receive / Auto-Reject** · **Combo Gift toggle** · **Rocket Animation** · **Emoji Reactions** · **Gift Messages** · **Profile Card Click** — no column, no route, no enum.

**Background Blur** — `BeautySettings` is `{enabled, level, smoothSkin, brightness, sharpen, faceEnhance}`. No blur field in the ZEGO provider.

**Disable Audience Camera** — architecturally moot: audience are subscribers and never publish.

**Room Rules · Age Restriction · Layout Mode** — client-side fiction in the current model with no backing column. Removed.

**Deferred settings fields (6)** — `allowFollow` (cross-module/social), `allowShare` (no server action to gate), `joinApprovalRequired` + `allowJoinRequest` (require join-flow rework), `isRoomMuted` (redundant with moderation `muteAll`), `maxDurationMinutes` (needs a scheduler).

---

## 2. Audit findings that motivated this phase

1. **The current settings sheet is decorative.** `UpdateVideoRoomInput.toJson()` (`video_room_models.dart:458-465`) serialises only `name`, `description`, `tags`, `password`. `allowChat`, `allowGifts`, `allowPk`, `layoutMode`, `backgroundTheme`, `announcement`, `rules` are collected by the UI and silently dropped before the request.

2. **No settings endpoint exists.** `UpdateVideoRoomSettingsDto` defines all 21 fields and is referenced by nothing outside its own declaration. The only settings write path is `PATCH :id/chat/settings` (chat subset).

3. **No settings broadcast exists.** None of the 99 emitted `video_room.*` socket events is a settings update.

4. **The mobile repository calls routes that do not exist** (404 today): `/kick` (real: `/moderation/kick`), `/ban` (real: `/moderation/blacklist`), `/seats/:i/mute`, `/seats/:i/lock` (real: `POST :id/seats/lock`), `/seats/:i/leave`, `/seats/:i/request` (real: `POST :id/seats/request`).

   **Blast-radius verified (2026-07-24):** all six are confined to `video_room_repository_impl.dart`, and every caller is inside `features/video_room/` — `video_room_controller.dart:373,399,421,428,433,438` and `video_room_live_screen.dart:533,542,1040,1048,1058`. **Audio Room is unaffected:** its `requestSeat`/`leaveSeat` are a different repository (`audio_room/in_room/data/repositories/seat_actions_repository_impl.dart`) with different signatures, hitting the `/rooms/...` prefix from `core/constants/api_endpoints.dart:75-79`. Fixing the six is therefore contained to this feature.

   Consequence: the live screen's seat-action sheet (Request Seat, Leave Seat, Mute, Kick) is **broken in production today**, independent of settings. This phase repairs pre-existing breakage; it does not introduce it.

5. **Mobile has no Admin concept.** State models role as `VideoSeatType {host, coHost, audience}`; the server exposes an 18-permission matrix at `GET :id/me/permissions`.

6. **13 of 21 settings fields are write-only columns.** Outside DTOs/views/mappers/schema they have zero consumers in `src/`. Only 8 are read: `slowModeSeconds` (6 reads), `allowChat` (3), `hostSeatCount`/`guestSeatCount` (2 each), `allowGifts`/`allowTreasure`/`allowPk`/`seatApprovalRequired` (1 each).

> **Rule this phase adopts:** on this codebase the presence of a column proves *intent*, never *enforcement*. The only proof is a read.

---

## 3. What already exists (reuse map — do NOT rebuild)

| Concern | Reused artifact | Location |
|---|---|---|
| Settings persistence | `VideoRoomsRepository.updateSettings(roomId, data)` · `getSettings(roomId)` | `repositories/video-rooms.repository.ts:246` |
| Settings table | `VideoRoomSettings` (21 configurable columns, 1:1 with room) | `prisma/schema/video_rooms.prisma:190` |
| Settings DTO | `UpdateVideoRoomSettingsDto` — **already written, unused** | `dto/update-video-room-settings.dto.ts` |
| Settings projection | `VideoRoomSettingsView` (client-safe, drops audit) | `entities/video-room-detail.view.ts:12` |
| Permission matrix | `VideoRoomPermission` (18 values) · `VIDEO_ROOM_PERMISSION_MATRIX` · `ADMIN_PERMISSIONS` | `constants/video-room-permissions.ts` |
| Permission checks | `VideoRoomPermissionService.assertPermission / hasPermission / resolveEffectiveRole` | `services/video-room-permission.service.ts` |
| Permission cache | `VideoRoomPermissionCache` (per room+user, room-version stamped) | `services/video-room-permission-cache.service.ts` |
| Service template | `VideoRoomChatSettingsService` — the shape to mirror | `services/video-room-chat-settings.service.ts` |
| Direct-write + self-publish precedent | `VideoRoomModerationService.muteAll` | `services/video-room-moderation.service.ts:453` |
| Event bus | `EVENT_BUS` / `IEventBus` publish | `src/common/events/*` |
| Socket fan-out | `/video-room` namespace, broadcast-only; domain listeners emit `video_room.*` | `listeners/video-room-socket.listener.ts` |
| Errors | `BusinessException(errorCode, message, status)` — field is **`.errorCode`** | `src/common/exceptions/*` |
| Room profile write | `PATCH :id` accepts `name, description, imageKey, categoryId, language, visibility, accessPolicy, password, tags, country, isDiscoverable, maxParticipants, maxViewers, isLocked` | `controllers/video-rooms.controller.ts:113` |
| Reference data | `GET /audio-rooms/categories` · `/languages` — both `@Public()`, shared `room_categories`/`room_languages` | `modules/audio-rooms/controllers/audio-rooms.controller.ts:44` |
| Mobile design system | `core/theme/{app_colors,app_spacing,app_typography}` · `core/widgets/{app_button,app_loader,app_feedback,app_text_field}` | `soulzaa-mobile/lib/core/` |

**Read-only reuse of the audio-rooms reference routes is not an audio-room change.** `room_categories` / `room_languages` are shared platform reference data that video rooms already reference by value.

---

## 4. Backend changes (6 files, 2 new)

| File | Change |
|---|---|
| `services/video-room-settings.service.ts` | **NEW** — per-field permission gate → `updateSettings` → publish |
| `events/video-room.events.ts` | **NEW event** `VideoRoomSettingsUpdatedEvent` |
| `constants/video-room.constants.ts` | `SETTINGS_UPDATED: 'video_room.settings_updated'` |
| `controllers/video-rooms.controller.ts` | `PATCH :id/settings` consuming the existing `UpdateVideoRoomSettingsDto` |
| `controllers/video-rooms-seats.controller.ts` | `POST :id/seats/layout` exposing the existing **orphaned** `configureLayout` (§4.3) |
| `listeners/video-room-socket.listener.ts` | Bridge `VideoRoomSettingsUpdatedEvent` → room broadcast |

Plus **7 enforcement guards** added inside services that already exist (§6).

### 4.1 Per-field permission map

A single request-level gate is wrong: `VideoRoomChatSettingsService` gates on `MANAGE_ROOM`, which is owner-only, and would 403 Admins on seats/gifts/PK. Gate **per field**:

| Field | Permission | Effective roles |
|---|---|---|
| `allowChat` | `ROOM_MUTE` | Owner + Admin + Moderator |
| `slowModeSeconds` | `ROOM_MUTE` | Owner + Admin + Moderator |
| `allowAnnouncements` | `MANAGE_ANNOUNCEMENTS` | Owner + Admin + Moderator |
| `seatApprovalRequired` | `MANAGE_SEATS` | Owner + Admin |
| `allowPk` | `START_PK` | Owner + Admin |
| `allowGifts` | `MANAGE_TREASURE` | Owner + Admin |
| `allowTreasure` | `MANAGE_TREASURE` | Owner + Admin |
| `allowInvite` | `MANAGE_PARTICIPANTS` | Owner + Admin |
| `allowReporting` | `MANAGE_PARTICIPANTS` | Owner + Admin |
| `allowBeauty` | `MANAGE_PARTICIPANTS` | Owner + Admin |
| `allowCameraSwitch` | `MANAGE_PARTICIPANTS` | Owner + Admin |
| `allowScreenShare` | `MANAGE_PARTICIPANTS` | Owner + Admin |
| `allowRecording` | `MANAGE_PARTICIPANTS` | Owner + Admin |

**Fail-whole semantics:** collect the distinct permissions implied by the submitted fields, assert every one, and only then write. A partially-authorized patch throws and writes nothing.

**`allowViewerChat` is rejected from the write surface.** It is the deprecated column maintained as a mirror of `chatMode`; a direct client write would desynchronise the mirror the schema comment protects. It continues to be written only by the chat mirror logic.

Fields not in this map (`joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`, `isRoomMuted`, `maxDurationMinutes`) are **rejected** by the service — they are deferred, and accepting them would persist an unenforced value.

`hostSeatCount` and `guestSeatCount` are also **rejected here** — they belong to the seat-layout route (§4.3), not to this endpoint.

### 4.2 Dual event publish (do not skip the second)

`allowChat` / `slowModeSeconds` are also writable via `PATCH :id/chat/settings`, so this endpoint is a second writer to the same columns. Delegating to `VideoRoomChatSettingsService` would re-introduce the owner-only 403.

Follow the precedent `muteAll` already set — it writes `chatMode` directly *because* going through the settings service "would wrongly 403" ADMIN/MODERATOR, and therefore publishes `ChatModeChangedEvent` itself so chat clients still learn. This service inherits both halves:

- always publish `VideoRoomSettingsUpdatedEvent` (full settings snapshot),
- **additionally** publish `ChatModeChangedEvent` whenever `allowChat` or `slowModeSeconds` is in the patch.

Omitting the second publish is an invisible bug: persistence tests pass while chat clients never learn slow mode turned on.

### 4.3 Seat layout must NOT go through the settings endpoint

`VideoRoomSeatService.configureLayout(actor, roomId, hostSeatCount, guestSeatCount, ip)` already exists (`video-room-seat.service.ts:254`) and is **exposed by no controller** — the same dead-contract pattern as the settings DTO.

Patching `hostSeatCount` via `updateSettings` would write the settings columns **without** reconciling the actual `video_room_seats` rows, producing a settings row claiming 12 seats while only 9 seat rows exist. `configureLayout` does the whole operation:

- asserts `MANAGE_SEATS`,
- validates `1 + host + guest <= VIDEO_ROOM_MAX_SEATS` (20), else `SEAT_LAYOUT_INVALID`,
- **preserves existing occupants** — `existing ? { ...existing, seatType } : emptyEntry(i, seatType)`,
- computes `displaced` (occupants at `seatIndex >= total`), deletes those rows and publishes a `SeatLeftEvent` for each — vacated, **not disconnected**,
- commits a versioned stage via `seatState.commit`,
- its repo call `setSeatLayout` writes `hostSeatCount`/`guestSeatCount` onto the settings row, keeping settings in sync,
- and it **already publishes** `SeatUpdatedEvent{ seatIndex: null, reason: 'layout_changed' }` → `video_room.seat_updated`, which the mobile socket service already subscribes to. **Layout needs no new socket work.**

**Constraint:** `configureLayout` calls `requireLiveRoom` — layout can only be changed while the room is LIVE. The client disables the layout control with an explanatory label when the room is not live, rather than letting the call fail.

This satisfies the two seat requirements directly: *"existing seated users should remain whenever possible"* and *"removed seats must not disconnect unrelated users."*

**Change required:** add `POST :id/seats/layout` to `video-rooms-seats.controller.ts` delegating to `configureLayout`. No service change.

**UI mapping:** layout choice *N* ∈ {4, 6, 8, 9, 12} → `hostSeatCount = N - 1`, `guestSeatCount = 0`, since seat index 0 is the owner and `total = 1 + host + guest`. Shrinking below the highest occupied index displaces those occupants to the audience; the client shows a confirmation naming how many users will be moved before sending.

### 4.4 Socket contract

Event name: `video_room.settings_updated`, broadcast to the room on the `/video-room` namespace.

Payload: `{ roomId, settings: VideoRoomSettingsView, actorId, changed: string[] }`.

`settings` is the **full post-write snapshot**, not a delta — clients replace wholesale, which makes reconciliation idempotent and eliminates ordering hazards between concurrent admin edits.

---

## 5. Mobile changes

```
lib/features/video_room/
  domain/models/
    video_room_settings.dart        NEW   mirrors VideoRoomSettingsView 1:1
    video_room_permission.dart      NEW   enum + Set<VideoRoomPermission> + role
    video_room_models.dart          EDIT  remove password/rules/ageRestriction/layoutMode
  domain/repositories/
    video_room_repository.dart      EDIT  + settings / roles / moderation / seats
  data/repositories/
    video_room_repository_impl.dart EDIT  fix 6 wrong URLs; add new calls
  data/sources/
    video_room_socket_service.dart  EDIT  subscribe settings_updated + role + moderation
  presentation/providers/
    video_room_settings_controller.dart  NEW  hybrid apply, optimistic rollback
    video_room_state.dart                EDIT + settings, permissions, effectiveRole
  presentation/widgets/settings/
    video_room_settings_hub.dart         NEW  root list, permission-filtered
    sections/room_management_page.dart   NEW
    sections/privacy_access_page.dart    NEW
    sections/seats_page.dart             NEW
    sections/mic_camera_page.dart        NEW
    sections/audience_permissions_page.dart NEW
    sections/moderation_page.dart        NEW
    sections/admins_page.dart            NEW
    sections/room_info_page.dart         NEW
    widgets/settings_toggle_tile.dart    NEW  optimistic switch + pending + rollback
    widgets/settings_nav_tile.dart       NEW
    widgets/settings_editor_sheet.dart   NEW  text/number Save-Confirm
```

`video_room_settings_sheet.dart` is replaced by the hub. No new file exceeds ~250 lines.

### 5.1 Removed from the client model

`VideoRoomSettings.password` — the model holds a plaintext password and `fromJson` reads `json['password']`. The server correctly never returns it (`passwordHash` is excluded from `VideoRoomDetailView`), so it is always null and its presence invites a real leak. **Password becomes write-only** via `POST :id/lock`.

Also removed: `rules`, `ageRestriction`, `layoutMode`, `backgroundTheme` (no backing column).

### 5.2 Hub sections and gating

**Visibility is a union rule, not a single gate:** a section is visible when the user holds **at least one** permission required by any control inside it; controls they cannot use are then individually **disabled**. A single required-permission per section would be wrong — a Moderator holds `ROOM_MUTE` but not `MANAGE_PARTICIPANTS`, and gating "Audience Permissions" on the latter would hide Allow Chat and Slow Mode from exactly the role that is supposed to manage them mid-stream.

| Section | Permissions used by its controls | Visible to |
|---|---|---|
| Room Management | `MANAGE_ROOM` | Owner |
| Privacy & Access | `LOCK_ROOM`, `MANAGE_ROOM` | Owner |
| Seats | `MANAGE_SEATS` | Owner + Admin |
| Mic & Camera | `ROOM_MUTE`, `MANAGE_PARTICIPANTS` | Owner + Admin + Moderator |
| Audience Permissions | `ROOM_MUTE`, `MANAGE_ANNOUNCEMENTS`, `MANAGE_PARTICIPANTS` | Owner + Admin + Moderator |
| Gifts, Treasure & PK | `MANAGE_TREASURE`, `START_PK` | Owner + Admin |
| Moderation | `KICK_USERS`, `BLOCK_USERS`, `MUTE_USERS` | Owner + Admin + Moderator |
| Admins | `GRANT_ROLES`, `TRANSFER_OWNERSHIP` | Owner |
| Video (self) | none — requires only that you are publishing | Any publisher |
| Room Info | none | Everyone |
| Leave / End Room | `CLOSE_ROOM` for End only | Leave: everyone · End: Owner |

Within "Audience Permissions", a Moderator sees Allow Chat / Slow Mode / Allow Announcements enabled and Allow Invites / Allow Reporting disabled.

### 5.3 Data flow

**Toggle (instant).** Flip → optimistic state write + mark field pending → `PATCH :id/settings {field}` → on 2xx clear pending; on error **revert to the prior value** + snackbar. The server's `settings_updated` broadcast then overwrites wholesale; the sender reconciling with itself is a no-op.

**Text / number (Save).** Row tap → editor sheet with a local controller → validate → `PATCH :id` or `PATCH :id/settings` → success closes the sheet; failure keeps it open with an inline error. Partial text is never broadcast.

**Inbound socket.**
- `video_room.settings_updated` → replace `state.settings` wholesale.
- `video_room.updated` → replace room profile fields.
- `video_room.role_assigned` / `role_removed` / `role_updated` for **self** → refetch `GET :id/me/permissions` so a demoted admin loses the UI immediately.
- moderation events (`userKicked`, `userBlacklisted`, `userMuted`, …) → refresh the open moderation list.

**Permissions.** Fetched once on join via `GET :id/me/permissions`. The client gate is UX only; the server is the sole authority. A `403` refetches permissions and re-renders.

### 5.4 Controls that ride existing endpoints (not the settings table)

| Control | Route |
|---|---|
| Name / Description / Cover / Category / Language / Visibility / Max Participants | `PATCH :id` |
| Category & language options | `GET /audio-rooms/categories` · `/languages` |
| Lock / Unlock / Change Password | `POST :id/lock` · `POST :id/unlock` |
| Copy Room ID · Share Room | client-only |
| Seat layout 4/6/8/9/12 | `POST :id/seats/layout` (**new route**, existing `configureLayout`) |
| Seat lock / unlock | `POST :id/seats/lock` · `unlock` |
| Invite to seat | `POST :id/seats/invite` |
| Remove from seat | `POST :id/viewer/demote` |
| Approve / reject seat request | `POST :id/seats/request/:rid/approve` · `reject` |
| Broad Mute / Mute All · Unmute All | `POST :id/moderation/mute-all` · `unmute-all` (`channels: ['mic','chat']`) |
| Kick · Ban · Unban · Mute · Unmute · Warn | `:id/moderation/*` |
| Ban list · Muted list · History · Reports | `GET :id/blacklisted-users` · `muted-users` · `moderation/history` · `reports` |
| Admin list · Add · Remove · Update · Transfer | `:id/roles/*` · `:id/owner/transfer` |
| Permission summary | `GET video-rooms/permissions` |
| Beauty (self) · Video Quality (self) | `POST :id/media/beauty` · `:id/media/quality` |
| Mirror camera · Low data mode | client-local (ZEGO SDK / quality profile) |
| Room notification mute | `POST/DELETE/GET :id/notifications/mute` |
| PK history | `GET :id/pk/history` |
| Treasure config / lifecycle | `POST :id/treasure` + `start/pause/resume/close` |
| Room info & statistics | `GET :id` · `GET :id/viewers/count` · `GET :id/treasure` |
| Leave · End Room | `POST :id/leave` · `POST :id/close` |

**Beauty and Video Quality are caller-scoped.** `SetQualityDto {profile}` and `BeautySettingsDto` carry no `targetUserId` ("*the caller's publishing camera stream*"), so they need no permission entry — only that the caller is publishing. The room-wide *gate* is the separate `allowBeauty` settings flag.

**Broad Mute and Mute All are one feature**, not two: `muteAll` sweeps every staged participant through `media.forceMute` while skipping `ELEVATED_VIDEO_ROOM_ROLES`, and because it is a *force* mute the target cannot self-unmute until `unmuteAll`. Exposing two controls would create two switches fighting over one server flag.

---

## 6. The 7 new enforcement guards

Each is a short check at an existing entry point, localized to the service that already owns that action. No cross-module dependencies.

| Field | Service | Guarded action |
|---|---|---|
| `allowInvite` | `video-room-seat-invitation.service.ts` | seat invite |
| `allowAnnouncements` | `video-room-announcement.service.ts` | create / update announcement |
| `allowReporting` | `video-room-report.service.ts` | submit report |
| `allowBeauty` | `video-room-media.service.ts` | apply beauty settings |
| `allowCameraSwitch` | `video-room-media.service.ts` | camera switch |
| `allowScreenShare` | `video-room-media.service.ts` | start screen share |
| `allowRecording` | `video-room-media.service.ts` | start recording |

Shape:

```ts
const settings = await this.rooms.getSettings(roomId);
if (!settings.allowInvite) {
  throw new BusinessException(
    ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
    'Seat invitations are disabled in this room.',
    HttpStatus.FORBIDDEN,
  );
}
```

Owner/admin bypass is **not** applied: these flags express room policy, and the person who can change the flag can simply turn it back on.

---

## 7. Error handling

- Server is the sole authority; the client gate is UX only.
- `BusinessException` surfaces via **`.errorCode`** (not `.code`).
- Toggle failure reverts optimistic state and raises a snackbar via the existing `AppFeedback`.
- `403` additionally refetches `GET :id/me/permissions` and re-renders, so a client whose role changed mid-session self-corrects.
- Editor sheets keep focus and show an inline error rather than closing on failure.
- All list screens (ban list, muted users, admins, history) use the existing loader / empty / error view widgets.

---

## 8. Testing (TDD)

### Backend

`video-room-settings.service.spec.ts`
- each field's permission admits the right roles and denies the rest,
- a multi-field patch containing one unauthorized field **throws and writes nothing**,
- a no-op patch writes nothing and publishes nothing,
- `VideoRoomSettingsUpdatedEvent` always published on a real write,
- `ChatModeChangedEvent` **additionally** published when `allowChat` / `slowModeSeconds` is in the patch,
- `allowViewerChat`, `hostSeatCount`/`guestSeatCount`, and the 6 deferred fields are rejected.

`video-rooms.controller.spec.ts` — route wiring, DTO validation, guest denial.

`video-rooms-seats.controller.spec.ts` — the new `POST :id/seats/layout` route delegates to `configureLayout`, denies guests, and surfaces `SEAT_LAYOUT_INVALID` for an over-capacity request. `configureLayout` itself is already covered — do not duplicate its occupant-preservation and displacement tests, assert only the wiring.

7 guard specs — disabled path throws, enabled path passes, existing behaviour unchanged.

### Mobile

- `video_room_settings_test.dart` — model round-trip against the real `VideoRoomSettingsView` shape; unknown fields ignored; nulls safe.
- `video_room_settings_controller_test.dart` — optimistic apply; rollback on failure restores the prior value; socket echo reconciles; concurrent toggles do not interleave incorrectly.
- `video_room_permission_test.dart` — hub section filtering per permission set; owner/admin/moderator/audience produce the expected section lists.
- Existing `video_room_controller_test.dart` and `video_room_models_test.dart` must continue to pass.

### Regression gates

`tsc` 0 errors · `eslint` 0 · full backend `jest` suite green (no regressions against the current baseline) · `flutter analyze` clean · `flutter test` green.

---

## 9. Explicit non-goals

- No Prisma migration.
- No change to `VideoRoomPermission` or `VIDEO_ROOM_PERMISSION_MATRIX`.
- No change to Audio Rooms (the two reference routes are read-only reuse).
- No change to PK battle, treasure, gift, chat, or games business logic.
- No placeholder UI: every shipped control is enforced server-side.
- No Git operations of any kind.
