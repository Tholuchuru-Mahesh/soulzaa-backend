# Moderator Incognito Join, System-Attributed Warnings & Global 24h Ban

Status: approved for planning
Date: 2026-08-18

## 1. Goal

From the "Open" button on a room (audio room, video room, or live stream), a
moderator can:

1. Join the room **invisibly** — not in the participant/viewer list or count,
   no profile reachable, no friend/connection requests possible, no
   indication to anyone in the room that a moderator is present.
2. Send a **warning message** that appears in the room as sent by "System" —
   either broadcast to everyone in the room, or privately to just the
   targeted user — never attributed to the moderator.
3. **Ban** a user for 24 hours, with a required reason. A banned user is
   immediately disconnected from wherever they currently are and cannot join
   **any** audio room, video room, or live stream (not just the one they were
   banned from) until the ban expires.
4. Every incognito join, warning, and ban is written to an audit trail
   visible only to admins.

Bans are visible in the admin panel under a moderation section, with the
reason, the issuing moderator, and an unban action available to ADMIN and
SUPER_ADMIN (not to moderators).

All of the above must work in realtime over the existing Socket.IO
infrastructure — no polling.

**Terminology**: "moderator" throughout this spec means any actor whose
roles include `MODERATOR`, `ADMIN`, or `SUPER_ADMIN` — this matches the
tri-role check already used consistently everywhere incognito/anonymous
behavior exists today (`audio-rooms.service.ts:547-548`,
`video-room-member.service.ts:209-210`, `live-stream.service.ts:415-416`),
so this feature doesn't introduce a second, inconsistent notion of "who
counts as staff." `unbanUser` is the one exception — restricted to
`ADMIN`/`SUPER_ADMIN` only, per section 7.4.

## 2. Existing state (audit before design)

This feature is **not greenfield** — prior work already built pieces of it,
unevenly across the three room types. This section is the baseline the
design below builds on; implementers should re-verify line numbers against
current `main` before editing, since the working tree has uncommitted
changes on top of this baseline.

### 2.1 Incognito join

| Room type | State | Evidence |
|---|---|---|
| Live-streaming | **Done, correct.** Moderators join into a separate Redis set (`presence:livestream:{id}:moderators`), excluded from the public viewer count/list. Moderators also bypass that stream's own ban on join. | `src/modules/live-streaming/services/live-stream.service.ts:413-451`, `src/infra/redis/presence.service.ts:114-152` |
| Audio-rooms | **Not built.** Every join creates a real `RoomMember` row, bumps the visible presence count, and broadcasts `RoomJoinedEvent` with the real `actor.id`, regardless of role. | `src/modules/audio-rooms/services/audio-rooms.service.ts:486-546` |
| Video-rooms | **Partial / leaky.** The join broadcast blanks the moderator's username/avatar/name, but still bumps the visible viewer count and still includes the real `userId` in the broadcast payload. | `src/modules/video-rooms/services/video-room-member.service.ts:159-249` |

### 2.2 System-attributed messages

All three room types already have:
- A `SYSTEM_MODERATOR_ID` sentinel UUID (`00000000-0000-0000-0000-000000000000`), independently defined per module but intentionally matching.
- A `WARNED` domain event + an `anonymize()` step that strips the real moderator id before a socket payload goes out (`src/modules/audio-rooms/listeners/moderation-socket.listener.ts:83-87`, `src/modules/video-rooms/listeners/video-room-moderation-socket.listener.ts:117-121`).

But today `warn()` (`audio-rooms/services/moderation.service.ts:525-584`,
`video-rooms/services/video-room-moderation.service.ts:829-918`) only
privately notifies the **target user** via a push-notification job — it
never broadcasts to the room, and never persists as a real chat message.

Both `ChatMessageType` (`prisma/schema/audio_rooms_chat.prisma:89-95`) and
`VideoRoomMessageType` (`prisma/schema/video_rooms_chat.prisma:69`) already
have a `SYSTEM` enum value that is not currently used by the warn flow.
Video-rooms additionally has `VideoRoomSystemMessageService` +
`SYSTEM_MESSAGE_POLICY` (`video-rooms/services/video-room-system-message.service.ts`,
`video-rooms/constants/video-room-system-message.policy.ts`), used today
only for domain lifecycle events (room locked, seat approved, etc.), not
moderator warnings.

Live-streaming has **no persisted chat model at all** — `assertCanSendChat`
in `live-stream.service.ts:351-355` is an explicit stub documented as "no
live-stream chat feature exists yet in this codebase to call it from."
Live-streaming does have an ephemeral `broadcastSystemMessage` helper
(`live-stream.service.ts:331-338`) already used for mute/kick/ban notices,
emitting via `SocketManager.emitToNamespaceRoom` with no DB persistence.

### 2.3 Bans

No cross-room ban exists. Every ban today is scoped to one room/stream, with
explicitly "no cross-module FK relations" by design:
- `RoomBan` (`prisma/schema/audio_rooms_moderation.prisma:29`) — per audio room.
- Video-rooms has **no ban model** — only `VideoRoomBlock`, non-expiring, per room (`prisma/schema/video_rooms_moderation.prisma:32`, explicit comment: "the Video Room has no ban feature").
- `LiveStreamBan` (`prisma/schema/live_streaming_moderation.prisma:41`) — per stream, already wired into `joinStream`'s rejoin gate with a moderator bypass (`live-stream.service.ts:419-424`).

### 2.4 Already solved, no work needed

Profile visibility and friend-request blocking for moderators is **already
fully built**:
- `isHiddenAccount` already includes the `MODERATOR` role in `HIDDEN_ROLES` (`src/modules/admin-identity/services/admin-identity.service.ts:18`).
- `profile.service.gatedView` returns null (looks like a 404) for hidden accounts unless the viewer is staff (`src/modules/users/services/profile.service.ts:175-184`).
- `friends.service.resolveTarget` throws NOT_FOUND for a friend request targeting a hidden account (`src/modules/social/services/friends.service.ts:337-346`).

This spec does not touch this path further.

## 3. Non-goals / explicit scope boundaries

- **No live-stream chat feature.** The room-wide warning message on a live
  stream is an ephemeral socket broadcast (a banner/toast), not a persisted
  chat entry, because no chat feature exists there today and building one is
  out of scope for this request.
- **Existing per-room ban/mute/block tables are untouched.** `RoomBan`,
  `VideoRoomBlock`, `LiveStreamBan` continue to serve whatever other
  moderation flows use them today (they are hot paths for the existing
  report/appeal system). The moderator's new "ban" action from an incognito
  session writes **only** to the new global `PlatformUserBan` table — it
  does not also write to the old per-room ban tables, to avoid two
  ban-of-record systems disagreeing with each other.
- **No change to the mobile/admin frontends.** This spec is backend-only.
  The "Open" button's existing join call (`POST /rooms/:id/join`,
  `.../video-rooms/:id/join`, `.../live-streams/:id/join`) does not change
  shape — the backend behaves differently based on the caller's role.
- **No approval workflow for this ban.** Unlike the existing
  `moderation-approval` module (which gates certain room-local bans behind a
  second moderator's sign-off), the new global ban is issued unilaterally by
  the acting moderator, consistent with the 24-hour, single-reason,
  self-expiring design the user asked for.

## 4. Data model

New file `prisma/schema/platform_moderation.prisma`:

```prisma
enum PlatformRoomType {
  AUDIO_ROOM
  VIDEO_ROOM
  LIVE_STREAM
}

enum PlatformBanStatus {
  ACTIVE
  LIFTED
  EXPIRED
}

enum PlatformModerationActionType {
  INCOGNITO_JOIN
  INCOGNITO_LEAVE
  WARNING_SENT
  BAN_ISSUED
  BAN_LIFTED
}

model PlatformUserBan {
  id           String             @id @default(uuid())
  targetUserId String
  moderatorId  String
  reason       String
  roomType     PlatformRoomType
  originRoomId String
  status       PlatformBanStatus  @default(ACTIVE)
  bannedAt     DateTime           @default(now())
  expiresAt    DateTime
  liftedAt     DateTime?
  liftedBy     String?

  @@index([targetUserId, status])
  @@index([status, expiresAt])
}

model PlatformModerationAuditLog {
  id           String                        @id @default(uuid())
  moderatorId  String
  action       PlatformModerationActionType
  roomType     PlatformRoomType
  roomId       String
  targetUserId String?
  reason       String?
  createdAt    DateTime                      @default(now())

  @@index([moderatorId, createdAt])
  @@index([targetUserId, createdAt])
}
```

No foreign keys to `User` are declared (matching the existing convention in
every other room-moderation schema file in this codebase — "reference by id,
no cross-module FK relations").

## 5. New module: `src/modules/platform-moderation/`

A small leaf module, structured like the existing `moderation-approval`
module (already consumed by all three room modules today) — not folded into
`mobile-workforce`, which is already a large orchestrator and shouldn't
become a dependency of core room-join logic.

Contains:
- `platform-ban.repository.ts` — Prisma access for `PlatformUserBan`.
- `platform-ban.service.ts` — `banUser`, `assertNotGloballyBanned`, `unbanUser`, `listBans`.
- `platform-moderation-audit.service.ts` — `record(action, ...)` used by ban/warn/incognito-join call sites across modules.
- `platform-moderation-admin.controller.ts` — the `admin/moderation/*` REST surface (section 8).
- Exports `PlatformBanService` and `PlatformModerationAuditService` for `audio-rooms`, `video-rooms`, `live-streaming` to import.

## 6. Incognito join

### 6.1 Presence layer

`PresenceService` (`src/infra/redis/presence.service.ts`) gets a moderator-set
split for room presence, mirroring the pattern that `joinLiveStream` already
uses successfully:

- `joinRoom(roomId, userId, isModerator = false)`: when `isModerator`, write
  to a new `presence:room:{roomId}:moderators` set (TTL 86400s, same as the
  existing public set) instead of `roomMembersKey`. Still write
  `userRoomsKey(userId)` in both cases, so disconnect-cleanup keeps working
  for moderators too.
- `leaveRoom(roomId, userId, isModerator = false)`: mirrors the above.
- `roomMemberCount` / `roomMembers`: unchanged — they only ever read the
  public set, so moderators are naturally excluded.
- `isInRoom(roomId, userId)`: checks both sets (used for idempotent
  re-join detection, unrelated to visible presence).

Video-rooms' own presence calls (`presence.viewerCount` /
`presence.addViewer`, `video-room-member.service.ts:160-171`) need the same
split verified against whatever presence class backs them at implementation
time — confirm whether these are the same `PresenceService` instance or a
video-rooms-specific wrapper before extending it (the property names differ
from audio-rooms' `roomMemberCount`/`joinRoom`, which suggests they may not
be identical).

### 6.2 Room service join() changes

In `audio-rooms.service.ts:join()` and `video-room-member.service.ts`'s
equivalent, when `actor` has role `MODERATOR` (or `ADMIN`/`SUPER_ADMIN`):

- Skip the durable `RoomMember`/`VideoRoomMember` upsert entirely — no row
  is created, so nothing querying that table can discover them either.
- Skip `RoomJoinedEvent` / `emitUserJoined` broadcast entirely (not the
  blanked-fields version video-rooms does today — no broadcast at all).
- Route presence through the new moderator set (6.1).
- Keep the existing investigation-recording and performance-stat side
  effects as-is — they key off `actor.id` directly, not off a `RoomMember`
  row, so removing the row doesn't affect them.
- The moderator's socket still performs the transport-level `client.join(roomId)`,
  so they continue receiving the room's live chat/media/state — only the
  domain-level "who's here" surfaces exclude them.
- Write a `PlatformModerationAuditLog` row via `PlatformModerationAuditService.record({ action: 'INCOGNITO_JOIN', moderatorId: actor.id, roomType, roomId })`. Mirror on leave with `INCOGNITO_LEAVE`.

Live-streaming needs no join()-path changes (already correct per 2.1) — only
the ban-gate addition in section 7.3.

## 7. Global 24-hour ban

### 7.1 `PlatformBanService.banUser`

```
banUser(moderatorId, targetUserId, reason, originRoomType, originRoomId): Promise<PlatformUserBan>
```

- Validates `reason` is non-empty (required — "moderator must give reason").
- Writes the `PlatformUserBan` row, `expiresAt = bannedAt + 24h`.
- Mirrors into Redis: `SET ban:user:{targetUserId} <banId> EX 86400`. The
  Redis TTL **is** the enforcement window — no separate expiry sweep job is
  needed for enforcement (the DB row's `status` is corrected to `EXPIRED`
  lazily, on read, by the admin list endpoint comparing `expiresAt` to now).
- Immediately calls the existing `SocketManager.disconnectUserEverywhere(targetUserId)`
  (`src/infra/socket/socket.manager.ts:257-264`) to drop them from whatever
  room/video/live session they're in right now, regardless of which room
  type the ban originated from.
- Writes a `BAN_ISSUED` audit row.

### 7.2 `PlatformBanService.assertNotGloballyBanned(userId)`

Single Redis `EXISTS ban:user:{userId}` check (plus a read of the reason for
the error body). Throws `ForbiddenException` with the reason and expiry,
e.g.:

> "You are banned from joining rooms until {expiresAt} for: {reason}"

per the requirement that the banned user sees the reason, not a generic
message.

### 7.3 Join-gate call sites

One added call, next to each room type's existing local ban check, gated by
the same `!isModerator` condition live-streaming's local check already uses
(a moderator should never be blocked by a ban meant for regular users):

- `audio-rooms.service.ts:join()`, beside `assertNotBanned` (line ~492).
- `video-room-member.service.ts`'s join equivalent, before the capacity check (~line 140-160).
- `live-stream.service.ts:joinStream()`, beside the existing `isActivelyBanned` check (line ~422).

### 7.4 `PlatformBanService.unbanUser(adminId, banId)`

- Guarded to `ADMIN` / `SUPER_ADMIN` roles only (not `MODERATOR`), per the
  requirement that lifting a ban is an admin action.
- Deletes the Redis key immediately (so the effect is instant, not waiting
  for a poll).
- Flips the DB row: `status: LIFTED, liftedAt: now(), liftedBy: adminId`.
- Writes a `BAN_LIFTED` audit row.

## 8. Admin panel surface

New controller under the existing `admin/*` convention:

- `GET /admin/moderation/bans?status=&targetUserId=&page=` — paginated list; each row includes moderator id/username, target id/username, reason, `roomType`/`originRoomId`, `bannedAt`, `expiresAt`, `status` (with lazy `EXPIRED` correction on read).
- `POST /admin/moderation/bans/:id/lift` — admin/super-admin only, calls `unbanUser`.
- `GET /admin/moderation/audit-log?moderatorId=&targetUserId=&action=&page=` — paginated audit trail covering `INCOGNITO_JOIN`/`INCOGNITO_LEAVE`/`WARNING_SENT`/`BAN_ISSUED`/`BAN_LIFTED`.

## 9. Warning messages

`warn()` in `audio-rooms/services/moderation.service.ts` and
`video-rooms/services/video-room-moderation.service.ts` gains a
`scope: 'PRIVATE' | 'ROOM'` parameter, **defaulting to `PRIVATE`** so
existing callers/tests are unaffected unless a caller opts into room-wide.

- **`PRIVATE`** (unchanged behavior): the existing anonymized push-notification unicast to the target user only.
- **`ROOM`** (new): in addition, insert a persisted message via each room's
  existing chat service, using the already-unused `SYSTEM` value on
  `ChatMessageType` / `VideoRoomMessageType`, `senderId` =
  `SYSTEM_MODERATOR_ID` / `VIDEO_ROOM_SYSTEM_ACTOR_ID`, pushed through the
  normal chat broadcast path so it renders identically to any other chat
  message to every participant, just attributed to "System." For
  video-rooms this reuses `VideoRoomSystemMessageService`/`SYSTEM_MESSAGE_POLICY`
  with a new `MODERATOR_WARNING` policy entry.
- **Live-streaming**: no `PRIVATE`/`ROOM` split needed on the chat side since
  there's no chat — `ROOM` scope extends the existing ephemeral
  `broadcastSystemMessage` helper with a new warning case (banner/toast,
  not persisted). `PRIVATE` scope reuses the existing per-user
  notification path as today.

Every warning call (either scope) writes a `WARNING_SENT` audit row,
including the `reason`/message text and chosen scope.

## 10. Error handling

- `assertNotGloballyBanned` failure → `403 Forbidden` with reason + expiry in the message, at REST join time (not silently dropped at the socket layer — the join request itself fails).
- `banUser` with empty/missing reason → `400 Bad Request` before any row is written.
- `unbanUser` by a non-admin/super-admin actor → `403 Forbidden` (role guard, standard pattern already used by other `admin/*` controllers).
- `unbanUser` on an already-`LIFTED`/`EXPIRED` ban → no-op, returns current state (idempotent, not an error) — avoids a race between two admins.

## 11. Testing strategy

Per this repo's TDD convention, tests are written alongside each unit,
following the existing spec-file patterns already in each touched module:

- `platform-ban.service.spec.ts` — ban issue/check/lift/expiry-on-read, reason required, Redis TTL semantics, disconnect-everywhere call.
- `presence.service.spec.ts` additions — moderator-set join/leave/count exclusion for room presence (mirrors the existing live-stream presence tests already in this file).
- Each room service's `join()` spec — moderator path skips DB row + broadcast + count bump; banned regular user rejected with reason; moderator bypasses the room-local ban (existing behavior preserved).
- `moderation.service.spec.ts` / `video-room-moderation.service.spec.ts` — `warn()` with `scope: 'ROOM'` persists a `SYSTEM`-typed message and broadcasts it; `scope: 'PRIVATE'` (and the default) preserves current unicast-only behavior byte-for-byte.
- `platform-moderation-admin.controller.spec.ts` — role guards on list/lift endpoints, pagination, `EXPIRED` lazy-correction.

## 12. Open items for the implementation plan

- Confirm whether video-rooms' `presence.viewerCount`/`addViewer` are the
  same `PresenceService` class as audio-rooms' `roomMemberCount`/`joinRoom`,
  or a separate wrapper — determines whether section 6.1's presence change
  is one edit or two.
- Confirm the exact DTO/permission-guard shape moderator-facing endpoints
  (ban, warn) should use in each room's existing moderation controller —
  each of the three already has its own moderation controller and DTO
  conventions to follow rather than introduce a new one.
