# VR-17 — Backend product gaps found during mobile implementation

Recorded 2026-07-24, extended 2026-07-25 through Task 24 of
`docs/superpowers/plans/2026-07-24-video-room-settings.md`.

These are **not** VR-17 regressions and were deliberately **not** worked around
on the client. Each needs a separate backend or client-feature decision.

---

## Controls deferred because the CLIENT has no screen (not a backend gap)

The backend routes exist and are enforced; the mobile client simply has no UI
built for them yet, so the settings surface omits the drill-down rather than
shipping a dead row. These are future client-feature work:

- **Treasure Configuration** (`POST :id/treasure` + lifecycle) and **PK History**
  (`GET :id/pk/history`) — `lib/features/treasure_box/presentation/screens` is
  empty and there is no PK-history view. (Gifts/Treasure/PK page, Task 23.)
- **Cover image** (`PATCH :id {imageKey}`) — no image-picker + `/storage/presign`
  upload flow in the video-room feature. (Room Management, Task 21.)
- **Share Room** — no deep-link builder for a video room. (Room Management.)
- **Moderation action history / report queue / warn** (`GET :id/moderation/history`,
  `GET :id/reports`, `POST :id/moderation/warn`) — read/review surfaces with
  their own UX; the Moderation page ships only the two enforced reversible
  rosters (block + mute). (Moderation, Task 24.)
- **Video quality selector** (Auto/Low/Medium/HD) — no client-side quality API
  wired to the Zego engine; the Video page ships Beauty (enforced) plus two
  device-local prefs. (Video & Audio, Task 24.)
- **Room statistics** (gift totals, coin totals, session duration, treasure
  progress) — the client `VideoRoom` model does not carry them and there is no
  parsed stats contract, so Room Info shows only the fields the model holds.

---

## 1. No self-vacate-seat endpoint (blocking, decide before Task 22)

**Status:** open — client action removed rather than faked.

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

**Status:** known, deliberate (recorded in Task 10).

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
