# Video Room — User Identity & Speaker Request Workflow

**Date:** 2026-07-28
**Status:** Approved, ready for implementation planning
**Repos:** `soulzaa-backend` (NestJS/Prisma/Socket.IO), `soulzaa-mobile` (Flutter/Riverpod)

---

## 1. Problem

Six reported symptoms in the Video Room:

1. Join notifications read "User joined" instead of the real display name.
2. The host profile popup shows hardcoded values.
3. Host tapping their own profile should open a self-profile, not the public one.
4. Hardcoded identity values throughout the room.
5. "Request to Speak" does not reliably reach the host.
6. Approve / reject / auto-seat / release do not synchronise in real time.

## 2. Findings

The backend speaker-request engine is **complete and correct**. `VideoRoomSeatRequestService`
implements request, cancel, update, approve, reject, retry and restore with CAS-guarded
state transitions, a Redis fairness queue with VIP tiering and an anti-starvation skip
counter, TTL expiry, and bounded retry. Nearly every reported break is in the **client's
contract with that engine**.

### 2.1 Confirmed root causes

| # | Cause | Evidence |
|---|---|---|
| RC1 | Client emits seat requests on three invented socket channels. The gateway has four `@SubscribeMessage` handlers, all chat/typing. Nothing listens. The real API is REST `POST :id/seats/request`. | `video_room_socket_service.dart:176-205`; `video-room-chat.gateway.ts:44-76` |
| RC2 | The server's `requestId` is discarded — `await _dio.post(...)` never reads the response — so the controller fabricates `req_<timestamp>`. Host approval then calls `POST .../request/req_1753.../approve`, which 404s. | `video_room_repository_impl.dart:228-235`; `video_room_controller.dart:547` |
| RC3 | That 404, and every other failure, is swallowed by `catch (_) {}`, each followed by an optimistic local mutation. The host sees a seat fill that no one else sees; the requester sees "Request Sent" after a server refusal. | `video_room_controller.dart:558-581, 606-608, 646-649` |
| RC4 | Approve/reject broadcasts land on dead names. Backend emits dotted `video_room.seat_approved` / `.seat_rejected`; client listens on colon `video_room:seat_approved` / `:seat_rejected`. | `video_room_controller.dart:191-192` vs `video-room.constants.ts:57-70` |
| RC5 | The success snackbar fires synchronously without awaiting the request, so it always appears. | `video_room_live_screen.dart:2235-2243` |
| RC6 | The host popup avatar falls back to `profileControllerProvider` — **the viewer's own avatar** — when `room.hostAvatarUrl` is empty. Alongside hardcoded `'200'` coins, `'32'` following, `'Level: VIP'`. | `video_room_live_screen.dart:2486-2488, 2592, 2658, 2688` |
| RC7 | **Systemic:** the video-rooms module is identity-free by design. `toVideoRoomSeatRequestView` returns `{id, userId, seatIndex, status, createdAt}`; `toVideoRoomMemberView` returns `{userId, role, ...}`. No view in the module carries a name or avatar, so every UI surface substituted a hardcoded string. `'Audience User'`, `'User joined'` and `'Level: VIP'` are one bug in three costumes. | `video-room-stage.mapper.ts:28-36`; `video-room-member.mapper.ts:6-15` |

### 2.2 Already correct — explicitly out of scope

- **Host-gated seat refill.** `video-room-seat-queue.listener.ts:128-134` already gates
  `queue.advance()` behind `VideoRoomSettings.seatApprovalRequired`, default `true`.
  Writable via the VR-17 settings PATCH, already modelled in the Flutter
  `VideoRoomSettings`. **No change required.**
- **Auto-assign first open seat.** `driveSeating` already resolves
  `req.seatIndex ?? findOpenSeat()` (`video-room-seat-request.service.ts:468`).
- **Host-self vs host-public routing.** `_showHostSelfProfileSheet` /
  `_showHostPublicProfileSheet` already branch on host identity
  (`video_room_live_screen.dart:348-350, 416-418`). Only the rendered content is fake.
- **Join event identity.** `emitUserJoined` already sends `username`, `name`, `avatarUrl`
  (`video-room-member.service.ts:193-200`).
- **RTC.** The media layer is ZEGOCLOUD, not Agora. Untouched by this work.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Identity delivery | **Hybrid** — backend enriches high-frequency payloads; client keeps a cache and falls back to `GET /users/:identifier` only for bare userIds | Fast path renders correctly on first paint; the cache covers userIds arriving from gift/PK/moderation events that are not enriched |
| Seat refill on vacate | **Host-gated via `seatApprovalRequired`** (already shipped) | Matches §12; preserves VIP tiering and skip-counter fairness for rooms that opt into auto-fill |
| Seat choice on request | **Always any-seat** (`seatIndex: null`) | Matches §9/§11; a request can never die because one specific seat filled while it waited |
| DTO compatibility | **Additive only**, all new fields optional | No existing client breaks |
| Source of truth | **Server.** Client never optimistically mutates seats | Eliminates the RC3 divergence class |

## 4. Design

### 4.1 Backend — identity seam

Two batch helpers already exist in `ProfileService`, each half-suited:

- `getCards(ids)` (line 176) returns the **right fields** — `username`, `fullName`,
  `avatarUrl`, `verified`, `level`, `vipLevel` — but is **N+1**:
  `Promise.all(unique.map(id => this.getProfileView(id)))`.
- `resolvePublicIdentities(ids)` (line 200) has the **right batching** — parallel
  `findByIds` + `profilesByIds` joined in memory, explicitly written to avoid that N+1 —
  but returns only `{displayName, avatarUrl}`.

Building a third implementation in video-rooms would duplicate a join that already
exists twice. Instead:

**Step 1 — extend `resolvePublicIdentities` (users module).** Add two more batch loads
to its existing `Promise.all`: `ProfileRepository.statisticsByIds` and
`verificationsByIds` (both already exist). `PublicIdentity` gains four optional fields:

```
PublicIdentity = {
  displayName: string | null      // existing
  avatarUrl:   string | null      // existing
  username?:   string             // new
  level?:      number             // new — UserStatistics.level
  vipLevel?:   number             // new — UserStatistics.vipLevel (isVip = vipLevel > 0)
  verified?:   boolean            // new — UserVerification.verified
}
```

Four parallel batch queries total, regardless of id count. Additive and optional, so the
existing games-panel consumer is unaffected.

**Step 2 — thin cache adapter in video-rooms.** `VideoRoomIdentityCache` injects
`PROFILE_SERVICE` exactly as `games.service.ts:170` already does. It adds only caching,
no data access of its own:

- `CacheService.mget` on `video_room:identity:<userId>` for the batched read
- `resolvePublicIdentities` for the misses only
- `set` with a 60 s TTL
- `del` on the existing `user.profile_updated` / `user.avatar_updated` EVENT_BUS events
  (`users/events/user.events.ts`) — this is also what satisfies §13's "profile picture
  changes / display name changes update live", with no polling

**Deliberately not** reusing `getPublicProfile`: it is per-user and privacy-scoped to a
*viewer*, which is the wrong model for a fixed in-room roster, and would reintroduce
N+1. Bio, followers and family stay out of this payload; the host popup fetches those
from `GET /users/:identifier`, which already returns them.

**Optional follow-up (not in scope):** re-implement `getCards` on top of the extended
`resolvePublicIdentities` to retire its N+1. Flagged, not done — it has callers outside
this feature.

**Attachment points — all additive, all optional:**

| Surface | Change |
|---|---|
| `GET :id/seats/requests` | `SeatRequestListItemDto` gains `user?: PublicIdentity` |
| `video_room.seat_requested` broadcast | payload gains `user?: PublicIdentity` |
| `GET :id/members` | `VideoRoomMemberView` gains `user?: PublicIdentity` |

`SeatRequestedEvent` remains identity-free on the EVENT_BUS; enrichment happens in
`VideoRoomSeatSocketListener` at the broadcast boundary, so downstream domain
subscribers are unaffected.

**Broadcast enrichment must not run on the publisher's stack.**
`InMemoryEventBus.publish` (`emitAsync`) awaits listeners on the caller's own stack, and
`VideoRoomSeatSocketListener.emit` is synchronous today. Awaiting an identity lookup
inside the `SEAT_REQUESTED` subscription would put a cache/DB round-trip inside the
`POST :id/seats/request` request path, and a lookup failure would propagate into
`publish()` and could fail the seat request itself — the request would be lost because
its *notification* could not be decorated.

So the subscription returns synchronously and defers enrichment with `setImmediate`,
matching the established pattern documented at `video-room-seat-queue.listener.ts:35-59`.
The deferred work is fully defensive: on cache miss, lookup error, or timeout it emits
the **bare payload** rather than not emitting. `user` is optional on the wire precisely
so this degradation is invisible.

This is safe to degrade because the client rarely needs it: a seat requester is always
an active member (`assertEligibleToQueue`), so the host's identity cache is already
warmed for them by `GET :id/members` on room entry, and by `video_room.user_joined`
for anyone who joined later. Broadcast enrichment is an optimisation over an already-warm
cache, never the sole source.

### 4.2 Mobile — socket contract correction

`videoRoomSocketEventNames` drops the nine invented names and mirrors
`VIDEO_ROOM_SOCKET_EVENTS` exactly.

Removed: `seat.requested`, `video_room:seat_requested`, `video_room:request_seat`,
`seat_requested`, `video_room.speaker_request_created`, `seat_request:new`,
`video_room.speaker_request_resolved`, `video_room:seat_approved`,
`video_room:seat_rejected`.

Added: `video_room.seat_approved`, `video_room.seat_rejected`,
`video_room.seat_request_failed`, `video_room.seat_request_cancelled`,
`video_room.seat_request_expired`, `video_room.seat_queue_updated`.

`VideoRoomSocketService.emitRequestSeat()` is **deleted**. It targets no handler, and it
transmitted client-supplied `userId`/`username` — spoofable the day a handler is added.

### 4.3 Mobile — server-truthed request lifecycle

- `requestSeat()` sends `seatIndex: null`, **parses the response**, stores the server `id`.
- `VideoRoomRepository.requestSeat` returns `SpeakerRequestItem` instead of `void`.
- All `catch (_) {}` replaced with typed error surfacing: `DUPLICATE_SEAT_REQUEST`,
  `SEAT_FULL`, `SEAT_LOCKED`, `SEAT_RESERVED`, 403.
- The success snackbar moves after an awaited success. Failures show the server message.
- Approve/reject no longer mutate seats locally. `seat_sync` / `seat_approved` is the
  only thing that seats a user.
- Approve is **disabled** with "No speaker seats available" when no seat is free. This
  satisfies §11: the row stays `PENDING` and queued, rather than letting the host trigger
  `SEAT_FULL` → `FAILED` → dequeue, which costs the requester their queue position and
  burns one of three retry attempts.

### 4.4 Mobile — identity cache

`videoRoomIdentityCacheProvider`, keyed by userId.

- **Seeded** from enriched payloads (§4.1) — the fast path.
- **Warmed on room entry** from `GET :id/members`, so subsequent seat requests, gifts,
  PK events, join toasts and moderation events resolve from cache without a fallback
  fetch.
- **Falls back** to `GET /users/:identifier` only for a userId absent from the cache.
- Updated in place on `video_room.user_joined` (which already carries identity).

Bound to: Requests panel, join toasts, seat labels, host popup.

Removes `'Audience User'`, `'User'`, `'200'`, `'32'`, `'Level: VIP'`, and fixes the
RC6 avatar fallback — an absent host avatar renders the `AppAvatar` initials
placeholder, never another user's image.

### 4.5 Mobile — widget extraction

`video_room_live_screen.dart` is 3139 lines. Extract, with **no behavioral change**:

- `widgets/profile/host_public_profile_sheet.dart`
- `widgets/profile/host_self_profile_sheet.dart`
- `widgets/seats/speaker_requests_panel.dart`
- `widgets/seats/seat_request_sheet.dart`

Pure moves plus the data-binding changes above. No layout, styling or navigation changes.

## 5. Error handling

| Condition | Server | Client |
|---|---|---|
| Duplicate request | 409 `DUPLICATE_SEAT_REQUEST` | "You already have a pending request" |
| No seat free at approval | 409 `SEAT_FULL` | Approve pre-disabled; if raced, "No speaker seats available", row stays pending |
| Seat locked / reserved | 409 `SEAT_LOCKED` / `SEAT_RESERVED` | Server message surfaced |
| Not permitted | 403 | "Only the host can approve requests" |
| Request expired (60 s TTL) | `video_room.seat_request_expired` | Row removed, requester toasted |
| Seating threw | `video_room.seat_request_failed` | Row shows Retry (bounded to 3 attempts) |
| Identity lookup fails | — | Cache returns null; UI renders initials placeholder, never a fabricated name |

## 6. Testing

**Backend**
- Extended `resolvePublicIdentities`: N userIds → 4 batch queries (never N+1); new
  badge fields populated; missing ids still dropped; existing games-panel caller
  unaffected by the additive fields.
- `VideoRoomIdentityCache`: cache hit/miss split, TTL, `del` on
  `user.profile_updated` / `user.avatar_updated`.
- Enriched DTO shape; `user` field optional and absent-safe.
- No regression across the existing video-rooms suite.

**Mobile**
- **Contract test** extending `video_room_socket_events_test.dart`: fails if any client
  event name has no counterpart in the backend constants. This is the guard that stops
  RC1/RC4 recurring.
- `requestSeat` stores the server id, not a fabricated one.
- Failures surface instead of being swallowed.
- Approve/reject do not mutate seats before the server event arrives.
- Identity cache: warm-on-members, fallback-on-miss, update on profile change.

## 7. Requirement coverage

Mapping the original brief's numbered sections to this design.

| Req | Requirement | Resolution |
|---|---|---|
| §1 | Join notification shows real display name | §4.4 — payload already carries it (`emitUserJoined`); cache removes the `'User'` fallback |
| §2 | Host profile popup shows real profile | §4.4 — bound to `GET /users/:identifier` + cache; RC6 avatar bug fixed |
| §3 | Host self-profile ≠ public profile | **Already correct**; only content rebound |
| §4 | No hardcoded identity anywhere | §4.4 — removes `'Audience User'`, `'User'`, `'200'`, `'32'`, `'Level: VIP'` |
| §5 | Speaker request workflow works | §4.2 + §4.3 — RC1–RC5 |
| §6 | Request sends, shows Request Sent, no duplicates | §4.3 — awaited REST; `DUPLICATE_SEAT_REQUEST` surfaced |
| §7 | Host receives instantly with full identity | §4.1 enrichment + §4.2 correct event names |
| §8 | Approve / reject, synced instantly | §4.3 — server-truthed, no local mutation |
| §9 | Approve promotes + auto-seats | **Already correct** (`driveSeating` → `findOpenSeat`); client stops fighting it |
| §10 | Reject removes row, notifies, keeps in audience | §4.2 — `video_room.seat_rejected` now actually listened for |
| §11 | Auto-assign first free seat; if full, keep pending | §4.3 — any-seat requests + Approve disabled when full, preserving queue position |
| §12 | Seat freed → host can approve another | **Already correct** — `seatApprovalRequired` gate, default `true` |
| §13 | Realtime for all 14 listed events | §4.2 (names) + §4.4 (profile-change invalidation) |
| §14 | Backend-only data, no mocks | §4.1 + §4.4 |
| §15 | Testing checklist | §6 |

Three of the fifteen (§3, §9, §12) required no change — they were already implemented
correctly and were misdiagnosed as broken because the client could not observe them.

## 8. Constraints

- No git operations or commits at any point.
- No changes to ZEGOCLOUD media, room creation, layout, permissions, auth, or existing
  backend business logic.
- Reuse existing services; no parallel implementations.
- All DTO changes additive and backward compatible.
