# Video Room — Settings Integrity

Sub-project **A** of the Video Room Settings completion work.
Recorded 2026-07-29.

Repos: `/Users/lt611-18/soulzaa-backend`, `/Users/lt611-18/soulzaa-mobile`.

---

## 1. Problem

`VideoRoomSettings` carries 26 columns. Only 11 are writable and enforced. The
rest are stored, returned to clients, and never honoured — so the schema, the
API contract and the client model disagree about what the product does.

Three concrete defects follow from that drift:

1. The hub's **"Room muted" indicator can never appear**. Nothing writes
   video-room `isRoomMuted`.
2. The **settings DTO advertises 22 patchable fields; 11 actually work**. The
   other 11 pass validation and then hard-400.
3. **Every settings guard fails open.** A missing settings row reads as
   "allowed" at eight call sites simultaneously.

This sub-project makes schema, API and client tell the same truth. It adds no
product features.

---

## 2. Findings

### 2.1 Confirmed defects

**Dead mute indicator.** `video_room_settings_hub.dart:113` renders
`settings.isRoomMuted ? 'Room muted' : null`. Verified across both repos: every
writer of `isRoomMuted` (`setRoomMuted`, `setRoomMutedTx`) belongs to
**audio rooms**, on the separate `roomSettings` table. Video rooms' Mute All
writes `chatMode: READ_ONLY` and force-mutes each mic instead, so the branch is
unreachable. `video_room_settings_hub.dart:139` compounds it by registering
`isRoomMuted` in `kSectionSummaryFields`, where it can never be pending because
the field is not PATCH-writable.

**DTO / writable drift.** `UpdateVideoRoomSettingsDto` declares 22
`@ApiPropertyOptional` fields. `WRITABLE_SETTINGS_FIELDS`
(`video-room-settings.service.ts:27`) holds 11. The remaining 11 are rejected
with `VALIDATION_ERROR`/400 at `video-room-settings.service.ts:91`. The two
lists are maintained independently with nothing enforcing agreement.

The sharpest edge is `hostSeatCount` / `guestSeatCount`: they are genuinely
editable, but through `video-rooms-seats.controller.ts:474`, not this endpoint.
A client trusting Swagger gets "These settings cannot be changed here" for a
feature that works.

**Fail-open guards.** Eight call sites share the shape

```ts
const settings = await this.rooms.getSettings(roomId);
if (settings && !settings.allowX) throw new BusinessException(...);
```

| # | File | Line | Flag |
|---|---|---|---|
| 1 | `services/video-room-chat-policy.service.ts` | 73 | `allowChat` |
| 2 | `services/video-room-gift-context.handler.ts` | 99 | `allowGifts` |
| 3 | `services/video-room-pk-validation.service.ts` | 107 | `allowPk` |
| 4 | `services/video-room-treasure.service.ts` | 241 | `allowTreasure` |
| 5 | `services/video-room-seat-invitation.service.ts` | 589 | `allowInvite` |
| 6 | `services/video-room-report.service.ts` | 99 | `allowReporting` |
| 7 | `services/video-room-announcement.service.ts` | 186 | `allowAnnouncements` |
| 8 | `services/video-room-media.service.ts` | 873 | `allowBeauty`, `allowCameraSwitch` (one `assertMediaAllowed` method, bracket access `settings[flag]`) |

The row is created transactionally with the room, so the branch is unreachable
today. If that invariant ever breaks, all eight gates open silently at once.

**Latent broadcast gap.** `muteAll` mutates the settings row via
`this.rooms.updateSettings` but never publishes `RoomSettingsUpdatedEvent`. It
compensates with a direct `ChatModeChangedEvent`, so chat clients are covered —
but any client reconciling `VideoRoomSettings` from the `settings_updated`
broadcast never learns the row changed.

### 2.2 Already correct — explicitly out of scope

- **`seatApprovalRequired` guard.** `listeners/video-room-seat-queue.listener.ts:130`
  uses `settings?.seatApprovalRequired !== false`. A missing row yields
  `undefined !== false` → `true` → approval required. Already fails **closed**.
  Left untouched.
- **Chat policy fallbacks.** `chat-policy.service.ts:222`, `:231` and
  `chat.service.ts:79-80` use `settings?.field ?? default`. These are documented
  defaults, not authorization gates. Left untouched.
- **Room access control.** Entry is gated by room lock + bcrypt password,
  verified at `video-room-member.service.ts:141`. `joinApprovalRequired` being
  unimplemented is a missing feature, not an access-control hole.
- **The ZEGO / RTC media path.** Publishing, subscribing, stream binding,
  encoder and transport logic are working and are not touched. See §8.

---

## 3. Locked decisions

1. **`isRoomMuted` means mic-mute only**, and is written *only* by the
   Mute All / Unmute All actions. Chat state remains readable via `chatMode`,
   which the client already consumes; duplicating it here would create two
   sources of truth. This also matches audio rooms, where `isRoomMuted` already
   drives mic state (`voice_math.dart` `roomMuted`).
2. **`isRoomMuted` stays out of `WRITABLE_SETTINGS_FIELDS`.** It is the outcome
   of an action with side effects (mic sweep), not a flag. Two ways to mute a
   room would inevitably diverge.
3. **Zero migration.** Retired columns remain in Postgres, inert. Only the API
   surface and client models change. Reversible.
4. **`allowViewerChat` stays internal.** It continues to be written as a mirror
   of `chatMode` by `VideoRoomChatSettingsService` and `muteAll`/`unmuteAll`. It
   is removed from the public API and the client model only.
5. **A field enters the API when it works, never before.** Fields planned for
   sub-projects B and C (`allowShare`, `allowFollow`, `maxDurationMinutes`,
   `joinApprovalRequired`, `allowJoinRequest`) are removed now and re-added in
   their own sub-project *together with* their enforcement guard.
6. **`requireSettings(roomId)` lives on `VideoRoomsRepository`** — one
   implementation shared by all consumers, replacing eight copies of the same
   shape.

> **Review point — response trim is wider than first presented.** The design
> section originally named three fields for removal from the response
> (`allowScreenShare`, `allowRecording`, `allowViewerChat`). Applying the
> approved principle *"expose only implemented, writable settings"* consistently
> also removes `joinApprovalRequired`, `allowJoinRequest`, `allowShare`,
> `allowFollow` and `maxDurationMinutes` — eight in total (§4.3). Flagged
> explicitly so it can be narrowed back to three during review.

---

## 4. Design

### 4.1 `isRoomMuted` becomes real

`muteAll` currently writes settings **only** inside the `chat` branch, so a
mic-only mute performs no settings write at all. Both methods are restructured
to compute a single patch up front and issue one `updateSettings` call inside
the existing `moderationLockKey` lock:

```ts
// VideoRoomModerationService.muteAll
const patch: Prisma.VideoRoomSettingsUpdateInput = {};
if (chans.includes('chat')) {
  patch.chatMode = VideoRoomChatMode.READ_ONLY;
  patch.allowViewerChat = false;            // internal mirror, decision 4
}
if (chans.includes('mic')) {
  patch.isRoomMuted = true;                 // decision 1
}
const updated = Object.keys(patch).length
  ? await this.rooms.updateSettings(ref.id, patch)
  : null;
```

`unmuteAll` is the mirror image: `chatMode: NORMAL`, `allowViewerChat: true`,
`isRoomMuted: false`.

No new lock, no new transaction, no additional round trip — the `chat` branch
already made this call.

### 4.2 Settings broadcast on mute

After the lock releases, both methods publish `RoomSettingsUpdatedEvent`
alongside their existing `RoomModerationUpdatedEvent` and `ChatModeChangedEvent`:

```ts
if (updated) {
  await this.bus.publish(
    new RoomSettingsUpdatedEvent({
      roomId: ref.id,
      actorId: actor.id,
      changed: Object.keys(patch),
      settings: toSettingsView(updated)!,
    }),
  );
}
```

The event shape is unchanged (`video-room.events.ts:97`):
`{ roomId, actorId, changed: string[], settings: VideoRoomSettingsView }`.
`changed` lists the DB fields actually written; the client consumes `settings`.

**Why this delivery path.** The Flutter client has **no handler** for
`roomModerationUpdated`; it handles `video_room.settings_updated`
(`video_room_controller.dart:333`). `isRoomMuted` is already projected by
`toSettingsView` (`video-room-detail.mapper.ts:31`) and already parsed by the
mobile model (`video_room_settings.dart:102`). So publishing the existing event
delivers the new state with **no new socket event and no new client wiring** —
and closes the latent gap in §2.1 at the same time.

### 4.3 API and DTO contract trim

**DTO: 22 → 11.** `UpdateVideoRoomSettingsDto` is reduced to exactly
`WRITABLE_SETTINGS_FIELDS`:

`allowChat`, `slowModeSeconds`, `allowAnnouncements`, `seatApprovalRequired`,
`allowPk`, `allowGifts`, `allowTreasure`, `allowInvite`, `allowReporting`,
`allowBeauty`, `allowCameraSwitch`.

Removed: `allowViewerChat`, `allowScreenShare`, `allowRecording`, `isRoomMuted`,
`joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`,
`maxDurationMinutes`, `hostSeatCount`, `guestSeatCount`.

A class-level doc comment records that seat counts are edited through
`POST /video-rooms/:id/seats/layout`
(`video-rooms-seats.controller.ts:474`), not here.

**Drift guard.** A spec asserts the DTO's declared property list equals
`WRITABLE_SETTINGS_FIELDS`, read from `class-validator`'s metadata storage:

```ts
import { getMetadataStorage } from 'class-validator';

const declared = new Set(
  getMetadataStorage()
    .getTargetValidationMetadatas(UpdateVideoRoomSettingsDto, '', false, false)
    .map((m) => m.propertyName),
);
expect([...declared].sort()).toEqual([...WRITABLE_SETTINGS_FIELDS].sort());
```

`class-validator`'s public metadata API is used rather than Nest's
`swagger/apiModelPropertiesArray` internals. It is reliable here because every
DTO field carries `@IsOptional()` plus a type validator, and `nest-cli.json`
declares no Swagger CLI plugin, so all decorators are explicit. This mirrors the
existing house idiom in `video-room-detail.mapper.spec.ts:60`, which already
drives its assertions off `WRITABLE_SETTINGS_FIELDS`.

**Response trim.** Removed from `VideoRoomSettingsView`, `toSettingsView`, the
detail view/mapper, and the mobile `VideoRoomSettings` model:

`allowScreenShare`, `allowRecording`, `allowViewerChat`, `joinApprovalRequired`,
`allowJoinRequest`, `allowShare`, `allowFollow`, `maxDurationMinutes`.

**Retained in the response:**

- `isRoomMuted` — it is now real (§4.1).
- `hostSeatCount`, `guestSeatCount` — genuinely implemented and editable via
  `POST /video-rooms/:id/seats/layout`. They are removed from *this DTO* only,
  never from the response; clients must still read the current layout.

### 4.4 `requireSettings(roomId)`

Added to `VideoRoomsRepository`:

```ts
async requireSettings(roomId: string): Promise<VideoRoomSettings> {
  const settings = await this.getSettings(roomId);
  if (!settings) {
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      'Room settings are missing.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  return settings;
}
```

All eight guards in §2.1 collapse to:

```ts
const settings = await this.rooms.requireSettings(roomId);
if (!settings.allowX) throw new BusinessException(...);   // unchanged 403
```

`assertMediaAllowed` keeps its `settings[flag]` bracket access and its
`'allowBeauty' | 'allowCameraSwitch'` parameter type; only the two lines that
fetch and null-check the row change.

This removes duplicated code rather than adding any, and converts an invisible
open gate into a loud, actionable error. A missing row is a data-integrity bug,
not a policy decision — reporting it as "Gifts are disabled in this room" would
send the host to toggle a setting that cannot fix it.

### 4.5 Mobile changes

- `video_room_settings_hub.dart:113` — summary reads `'Mics muted'` when
  `isRoomMuted`, reflecting decision 1. Chat state continues to surface through
  the existing Audience Permissions summary (`'Chat off'`).
- `video_room_settings_hub.dart:139` — `isRoomMuted` removed from
  `kSectionSummaryFields`. That map tracks PATCH-in-flight keys, and
  `isRoomMuted` is not PATCH-writable.
- `video_room_settings.dart` — the eight retired fields removed from the
  constructor, `fromJson`, `toJson` and `copyWith`. `isRoomMuted`,
  `hostSeatCount` and `guestSeatCount` retained.

  **Verified safe.** This model exposes string-keyed accessors —
  `readBool(field)` (`:137`) and `setBool(field, value)` (`:145`) — both routed
  through `toJson()`. Removing keys cannot crash them: `readBool` returns `null`
  for an absent key and `setBool` returns `this` unchanged when
  `map[field] is! bool`. The UI only ever addresses the 11 writable fields via
  `controller.setSettingFlag`, all of which are retained, so no call site
  changes behaviour.

  This same stringly-typed addressing is what allowed Bug 1 to go unnoticed —
  `kSectionSummaryFields` names `'isRoomMuted'` as a string, so no compiler or
  test could observe that it referenced a column nothing wrote.
- `mic_camera_page.dart:15-19` — doc comment updated: `isRoomMuted` is now the
  readable mic-mute signal, so the note claiming "there is no field to read
  back" is corrected.

---

## 5. Error handling

| Condition | Code | HTTP |
|---|---|---|
| Settings row missing | `VIDEO_ROOM_SETTINGS_MISSING` *(new)* | 500 |
| Flag disabled | existing per-feature codes, unchanged | 403 |
| Non-writable field submitted | `VALIDATION_ERROR`, unchanged | 400 |

`VIDEO_ROOM_SETTINGS_MISSING` is added to `src/common/exceptions/error-codes.ts`
beside the other `VIDEO_ROOM_*` codes.

500 is deliberate: the row is an invariant of room creation, so its absence is a
server fault, not client error. It should page, not be swallowed.

Field removal cannot break the mobile client — its parser defaults absent keys
(`_b(json, 'isRoomMuted', false)`), and mobile is the only consumer, updated in
the same change.

---

## 6. Testing

TDD, matching the module's existing standard (248 spec files across
video-rooms).

**Mute channel matrix** — `video-room-moderation.service.spec.ts`:

| Action | `isRoomMuted` after |
|---|---|
| `muteAll(['mic'])` | `true` |
| `muteAll(['chat'])` | unchanged |
| `muteAll(['chat','mic'])` | `true` |
| `unmuteAll(['mic'])` | `false` |
| `unmuteAll(['chat'])` | unchanged |

**Broadcast** (explicitly required): `RoomSettingsUpdatedEvent` is emitted after
`muteAll` and after `unmuteAll`; its `settings` payload carries the correct
`isRoomMuted`; `changed` lists exactly the fields written; the event is **not**
emitted when the computed patch is empty. Existing
`RoomModerationUpdatedEvent` / `ChatModeChangedEvent` assertions must continue
to pass unchanged.

**Guards** — one case per site (8): a missing settings row raises
`VIDEO_ROOM_SETTINGS_MISSING`, and the existing disabled-flag 403 cases still
pass.

**Contract** — DTO drift guard (§4.3); `toSettingsView`/detail-mapper specs
assert the eight retired fields are absent and `isRoomMuted` present.

**Existing tests this change breaks** (must be updated, not deleted):

- `video-room-detail.mapper.spec.ts:73` — the "carries the row values through
  unchanged" `toMatchObject` asserts `maxDurationMinutes: 120`, which the
  response trim removes. Drop that key; keep `hostSeatCount: 6` /
  `guestSeatCount: 2`, which are retained per §4.3.
- `video-room-detail.mapper.spec.ts:90` — the "does not leak internal columns"
  list should gain the eight retired fields, converting the removal into a
  pinned invariant rather than an untested deletion.
- `video-room-detail.mapper.spec.ts:60` — "projects every field the settings
  endpoint can write" is driven off `WRITABLE_SETTINGS_FIELDS` and continues to
  pass unchanged, since all 11 writable fields remain projected. It must stay
  green throughout as the guard against over-trimming.
- Any `video-room-settings.service.spec.ts` case that patches a now-removed DTO
  field to assert the 400 path: the field is no longer assignable, so the case
  moves to the drift guard instead.

**Mobile** — hub summary renders `'Mics muted'`; `kSectionSummaryFields` no
longer contains `isRoomMuted`; `VideoRoomSettings.fromJson` ignores retired keys
and still parses `isRoomMuted`.

**Regression bar:** full backend suite and full mobile suite green, `tsc` clean
for touched files, no new lint. The 67 pre-existing `tsc` errors (attendance
module + `countryId` drift from commit `24a9583`, likely a missing
`prisma generate`) are unrelated and out of scope.

---

## 7. Requirement coverage

| Requirement | Section |
|---|---|
| `isRoomMuted` = mic only, written only by Mute All / Unmute All | §3.1, §3.2, §4.1 |
| Publish `RoomSettingsUpdatedEvent` whenever settings change | §4.2 |
| Trim API/DTO to implemented, writable settings only | §4.3 |
| Shared `requireSettings(roomId)` + `VIDEO_ROOM_SETTINGS_MISSING` | §4.4, §5 |
| Media-service guard updated, no RTC logic touched | §4.4, §8 |
| `allowViewerChat` internal, removed from API and client | §3.4, §4.3 |
| TDD coverage incl. broadcast-after-mute test | §6 |

---

## 8. Constraints

- **No ZEGO / RTC changes.** Publishing, subscribing, stream binding, encoder
  and transport logic are untouched. In `video-room-media.service.ts` only the
  two lines inside `assertMediaAllowed` that fetch and null-check the settings
  row change. No other method in that file is modified.
- **No migration.** Retired columns stay in Postgres.
- **No new features.** Join approval, share/follow enforcement, auto-end,
  chat-policy UI, moderation surfaces and cover image belong to sub-projects
  B–D and are out of scope here.
- **Screen share and recording are permanently out of scope** — both require
  media-engine work that is off limits, and recording additionally needs paid
  cloud-recording infrastructure and a consent/privacy decision.
- **No git operations** without explicit approval, per standing project rule.

---

## 9. Follow-ups (not this sub-project)

- `allowViewerChat` writes could stop once no consumer remains; needs a cleanup
  migration and a consumer audit first.
- Retired columns could be dropped from Postgres in a later migration once the
  API has shipped without them for a release.
- Sub-project B (room policy completion), C (join approval), D (client
  surfaces) each get their own spec → plan → implementation cycle.
