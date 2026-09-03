# VR-17 — Backend product gaps found during mobile implementation

Recorded 2026-07-24, extended 2026-07-25 through Task 24 of
`docs/superpowers/plans/2026-07-24-video-room-settings.md`.
**Revised 2026-09-01**, when the deferred settings controls were built out.

These are **not** VR-17 regressions and were deliberately **not** worked around
on the client. Each needs a separate backend or client-feature decision.

---

## CLOSED 2026-09-01 — the deferred settings controls now ship

Every item in this section was previously omitted from the settings surface
because the client had no screen for it. Each is now built against the routes
that already existed:

- **Treasure ladder** — `TreasurePage` (create with an optional `poolOverride`,
  the DRAFT→ACTIVE→PAUSED→CLOSED→ARCHIVED lifecycle, per-box progress, winners).
  Renders only the transitions the current status accepts, since every other one
  is a 409.
- **PK History** — `PkHistoryPage` over `GET :id/pk/history`. Read-only, and
  terminal-only, which is what the route returns.
- **Cover image** — Room Management, through the same presign→PUT→`PATCH :id
  {imageKey}` chain the create screen already used. Commits the object KEY, not
  a URL: the bucket is presigned, so a URL's signature changes on every read.
- **Share Room** — needed a NEW backend route (see §5). `roomShare` builds a
  `room/:id` deep link, which resolves to the AUDIO room screen.
- **Moderation review** — report queue (with review/dismiss), audit trail, and
  the warning log, plus the warn action, all on `ModerationPage` drill-downs.
- **Video quality selector** — `POST :id/media/quality` plus a Zego preset map,
  and `GET :id/media/state` to seed the caller's own beauty/quality from server
  truth rather than a widget-local bool that reset on every page pop.
- **Room statistics** — Room Info reads
  `GET video-rooms/analytics/room/:roomId`. A 403 renders as a missing section,
  not an error: the panel is open to everyone but the stats need VIEW_ANALYTICS.

Two contract bugs surfaced while wiring these, both fixed:

- `GET :id/media/state` returns the whole media STAGE, not the caller's row, so
  the client must find itself in `participants[]`. Parsing the envelope's top
  level yielded silent all-defaults.
- The client's `VideoRoomPermission` mirror was missing `REVIEW_REPORTS` (18 of
  19 values), and its "mirrors all N permissions" pinning test had been updated
  to match the mirror rather than the server. MODERATOR holds REVIEW_REPORTS and
  not MANAGE_PARTICIPANTS, so this decided whether the role the report queue
  exists for could see it.

---

## 1. No self-vacate-seat endpoint — FIXED 2026-09-01

**Status:** closed. `demote` now skips the MANAGE_PARTICIPANTS assert (and the
outranks check, as before) when `actor.id === dto.targetUserId`, which is
option 1 below. Stepping down from your own seat is not a moderation action.

Seat 0 is still refused, for either caller: vacating the owner seat would leave
the room hosted by nobody, so the owner's exits stay Transfer Ownership and
Close Room. The client hides "Leave My Seat" on seat 0 rather than offering a
control that always 409s.

`visibleSectionsFor` gained an `isSeated` escape hatch for the same reason: the
row lives on the Seats page, which is gated on MANAGE_SEATS, and a plain seated
participant holds neither permission.

The original analysis follows.

A seated participant has no way to leave their seat and return to the audience.

`POST /video-rooms/:id/viewer/demote` looks like the route, but
`VideoRoomViewerService.demote` asserts `MANAGE_PARTICIPANTS` **before** the
self-check:

```ts
// video-room-viewer.service.ts
const room = await this.requireLiveRoom(roomId);
await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_PARTICIPANTS); // ← unconditional
...
if (actor.id !== dto.targetUserId) {
  await this.permissions.assertOutranks(...); // self is exempt from outranking only
}
```

So the self-case is exempt from *outranking* but not from the *permission*. A
plain HOST/PARTICIPANT calling it for themselves gets 403. Their only exit is
leaving the room entirely (`POST :id/leave`), which also drops them from the
audience.

**Client state (Task 15):** the repository method is named `removeFromSeat(roomId,
targetUserId)` and is documented as a host action. The "Leave Seat" tile in
`video_room_live_screen.dart` was removed — it was gated on the literal
`seat.userId == 'current_user_cohost'`, so it never rendered, and its action had
no route.

**Options:**
1. Relax `demote` to skip the permission assert when `actor.id === dto.targetUserId`
   (smallest change; self-demote becomes always allowed for a seated user).
2. Add a dedicated `POST :id/seats/leave` that vacates the caller's own seat.

**Task 22 (Seats page) must not ship a self-leave control until one of these
exists.**

---

## 2. `POST /video-rooms/:id/end` does not exist (fixed client-side)

**Status:** resolved on the client; no backend change needed.

The mobile client posted to `/video-rooms/:id/end`, which 404s. The only
`:id/end` route lives under the platform-admin prefix
(`admin/video-rooms/:id/end`, `VideoRoomsAdminController`) and a room owner
cannot call it. The owner-facing route is `POST :id/close`.

Client now calls `:id/close`. Worth confirming no other consumer (web, admin
tooling) relies on the non-existent room-scoped `:id/end`.

---

## 3. `allowScreenShare` / `allowRecording` remain unenforceable

**Status:** known, deliberate (recorded in Task 10). **Still open after the
2026-09-01 build-out** — these are the only settings-page controls deliberately
left out, because they are the only ones with no enforcing route to call.

Both columns exist on `VideoRoomSettings` but have no service method and no
route, so they were removed from `WRITABLE_SETTINGS_FIELDS`. They are rejected
with `VALIDATION_ERROR`/400 if patched, and the client model marks them
read-only. Do not re-add them to the writable set without a matching
enforcement guard.

---

## 4. Guards fail OPEN when the settings row is missing

**Status:** open, low risk — consistent across all four guards.

`allowInvite`, `allowAnnouncements`, `allowReporting` and the two media guards
all use the shape:

```ts
const settings = await this.rooms.getSettings(roomId);
if (settings && !settings.allowX) throw new BusinessException(...);
```

A missing settings row therefore reads as "allowed". In practice the row is
created transactionally with the room, so the branch is unreachable — but if
that invariant ever breaks, every gate silently opens. Worth one consistent
decision (fail-closed, or an explicit assert that the row exists) at the final
review.

---

## Fixed during this work (no longer open)

- **`seatApprovalRequired` missing from `VideoRoomSettingsView`** — it is
  writable via `PATCH :id/settings` but was not projected by `toSettingsView`,
  which is the payload of the `video_room.settings_updated` broadcast. Every
  client reconciling from that broadcast would have reset the toggle to its
  default. Added to the view and the mapper, with
  `video-room-detail.mapper.spec.ts` pinning the invariant off
  `WRITABLE_SETTINGS_FIELDS`.
- **Owner room cap** — enforcement was commented out in
  `VideoRoomLifecycleService.create` but the spec still asserted a 409. The test
  now pins the current no-cap behaviour and fails if the cap is reinstated
  without an explicit decision.

---

## 5. Video rooms had no share link (added 2026-09-01)

**Status:** closed, with a new route.

`ShareService.roomShare` formats any id into `soulzaa://room/<id>` +
`<base>/r/<id>`, which the app resolves to the AUDIO room screen. Sharing a
video room through it handed the recipient a link to the wrong surface.

Added `videoRoomShare` / `videoRoomQr` (`GET social/video-rooms/:roomId/share`
and `/qr`) producing `soulzaa://video-room/<id>` + `<base>/vr/<id>`, mirroring
the client route `/video-room/:id`. `ShareTarget.resourceType` gained
`'video-room'`. `share.service.spec.ts` pins that the two link shapes can never
collapse into one.

The client fetches these rather than formatting them: the share base URL and
deep-link scheme are server config, and a second copy would drift.
