# Video Room — Phase 6: Enterprise Viewer Mode & Audience Management (VR-6)

Status: **Approved** (brainstorming, 2026-07-20)
Depends on: VR-3 (member lifecycle), VR-4 (seat engine), VR-5 (media engine)

## 1. Objective

Let users participate in a Video Room as a **viewer** (audience) without occupying a
seat, and let a viewer transition to a **participant** (seat holder) and back. The whole
phase is a thin **cohesion / facade layer** over the lifecycle (VR-3) and seat (VR-4)
engines that already exist — **not** a parallel viewer stack.

The organising principle:

> **A viewer is a member with the default `VIEWER` role. A participant is a member
> occupying a GUEST seat.** Both facts already hold in the codebase today; VR-6 makes
> them a first-class, viewer-shaped API surface and closes the two gaps that a
> viewer↔participant transition exposes.

Everything the brief lists (join, leave, reconnect, heartbeat, session, presence, sync,
promotion, demotion, counters, events, audit, monitoring) is delivered by **reuse +
composition**, with a small, cohesive set of net-new units and **zero new tables, zero
new Redis lifecycle, zero duplicated validation.**

## 2. Locked design decisions (brainstorming, 2026-07-20)

1. **Scale model = "facade now + scale seam."** Reuse the member-is-viewer model now
   (durable member + presence, same tier as Audio Rooms), but write the facade against
   an `IViewerPresence` interface so a future Redis-only broadcast-scale audience path is
   an additive, config-gated implementation — never a rewrite. True "millions of
   concurrent viewers" is the seam's second implementation, out of scope for VR-6.
2. **Viewer presence = derived labels over the existing FSM.** No new state machine and
   no change to `derivePresenceState`. A pure projection maps the 7-state
   `VideoRoomPresenceState` to the brief's viewer vocabulary (`WATCHING`/`BACKGROUND`/…).
3. **Promotion = host-direct / force-seat.** `POST …/viewer/promote` lets an authorized
   host/moderator seat a viewer immediately (reuse `seatUser`). `POST …/viewer/demote`
   un-seats (reuse `vacateUser`/`removeFromSeat`) and live-downgrades the media session to
   `SUBSCRIBER`. The existing viewer-initiated `request→approve` and `invite→accept`
   flows (VR-4) are untouched.
4. **Participants counter derives from the seat snapshot** (VR-4 authority). The dead
   `participants` Redis set (`addParticipant`/`removeParticipant` — zero callers) stays
   retired; one source of truth per count.
5. **Statistics reuse `VideoRoomStatistics`.** No new stats table; VR-6 only starts
   feeding the two already-declared-but-unfed fields (`currentParticipants`,
   `peakParticipants`).
6. **Anonymous viewer stays future-ready.** The seam accommodates it; not implemented now.

## 3. Reuse map (what already exists — do NOT recreate)

| Concern | Existing symbol (reused verbatim unless noted) |
|---|---|
| Viewer join / leave / reconnect / sync / reclaim | `VideoRoomMemberService.{join,leave,reconnect,sync,reclaim}` — already assigns `VideoRoomMemberRole.VIEWER`, already validates exists→live→block→password→capacity→dup, already `presence.addViewer` |
| Session register / heartbeat / dup-eviction / grace | `VideoRoomSessionService` + `VideoRoomSessionMonitor` |
| Presence FSM (single source of truth) | `derivePresenceState` (`services/video-room-presence-state.ts`) → `VideoRoomPresenceState` enum |
| Audience Redis set + count | `VideoRoomPresenceService.{addViewer,removeViewer,isViewer,viewerCount}` + `videoRoomViewersKey` |
| Room-state snapshot / version / counts | `VideoRoomStateService` + `RoomSyncCounts` (already carries `viewers/online/idle/reconnecting/participants`) |
| Promote (viewer→participant) | `VideoRoomSeatService.seatUser(roomId, userId, actorId, seatIndex, ip?)` + `findOpenSeat` |
| Demote (participant→viewer) | `VideoRoomSeatService.vacateUser(roomId, userId, actorId, action, ip?)` (idempotent) / `removeFromSeat` |
| Live media role flip (demote gap-fill) | existing publisher-role plumbing around `video-room-media.service.ts:287-300` → `mediaSessions.setRole(roomId, userId, VideoRoomPublishRole.SUBSCRIBER)` |
| Effective role derivation (`PARTICIPANT`/`VIEWER`) | `VideoRoomPermissionService.resolveEffectiveRole` (owner → grant → GUEST seat ⇒ PARTICIPANT → else null/viewer) |
| Statistics (durable) | `VideoRoomStatistics` (`peakViewers`, `peakParticipants`, `totalJoins`, `currentViewers`, `currentParticipants`, `totalDurationSeconds`) + `VideoRoomsRepository.{bumpStatsOnJoin,bumpStatsOnLeave}` |
| Audit / history (durable, immutable) | `VideoRoomEventsRepository.appendEvent` |
| Realtime fan-out (no domain gateway) | EVENT_BUS → `VideoRoomSocketListener` → `/video-room` namespace |
| Dormant viewer events (to be wired) | `ViewerJoinedEvent`/`ViewerLeftEvent` (carry `viewerCount`) → `VIEWER_CONNECTED`/`VIEWER_DISCONNECTED` socket names |
| Stubbed viewer vocabulary | `ViewerStatus` enum (`WATCHING`/`BACKGROUND`/`LEFT`, currently unused) |
| Config knobs | `videoRoom` namespace: `defaultMaxViewers`, `maxViewersCap`, heartbeat/reconnect/idle/session TTLs |
| Metrics registry | `VideoRoomsMetrics` (`viewers` gauge, `joins/leaves/reconnects/heartbeatFailures/duplicateSessions` counters, `sessionDuration` histogram) |

## 4. Component architecture (new units, single-purpose)

All under `src/modules/video-rooms/`. Each unit has one responsibility, communicates through
typed interfaces, and holds no Prisma/Redis primitives of its own (those stay in repos and
the presence/state managers).

| New file | Responsibility |
|---|---|
| `interfaces/viewer-presence.interface.ts` | `IViewerPresence` seam (see §5) + `VIEWER_PRESENCE` DI token |
| `services/viewer-presence/durable-viewer-presence.ts` | Default seam impl: audience = active members not on a seat; backed by member repo + Redis `viewers` set |
| `services/video-room-viewer.service.ts` | **Facade.** join/leave/reconnect/heartbeat delegate to member/session services + emit viewer events; promote/demote orchestration (§7) |
| `services/video-room-viewer-query.service.ts` | Read models: audience list, audience count, `viewer/me` (presence + permissions + seat eligibility) |
| `services/video-room-viewer-presence.projection.ts` | Pure `toViewerPresence(state, ctx)` mapping FSM → viewer labels (§6) |
| `constants/video-room-viewer-permissions.ts` | Viewer capability matrix (§11) — **learning-contribution point** |
| `controllers/video-rooms-viewers.controller.ts` | 9 REST endpoints (§8), thin delegation |
| `dto/viewer.dto.ts` | Join/Leave/Reconnect/Heartbeat/Promote/Demote + Response/Summary/Presence DTOs (§9) |
| `events/video-room-viewer.events.ts` | `ViewerPromotedEvent`, `ViewerDemotedEvent`, `ViewerPresenceChangedEvent` (§10) |

Wiring changes (no new files): `video-rooms.module.ts` (providers + `VIEWER_PRESENCE`
binding), `listeners/video-room-socket.listener.ts` (3 new subscriptions),
`constants/video-room.constants.ts` (3 new socket event names), `enums/index.ts` (extend
`ViewerStatus` mapping usage), `video-rooms.metrics.ts` (peak-viewers gauge + promote/demote
counters), `common/exceptions/error-codes.ts` (only the codes with no equivalent).

## 5. The `IViewerPresence` seam

The facade never touches the member repo or Redis directly for audience membership; it goes
through this interface. This is the single abstraction that makes "millions of viewers" a
later config switch rather than a rewrite.

```ts
export interface AudiencePage {
  items: ViewerSummaryView[];
  total: number;
}

export interface IViewerPresence {
  /** Register audience presence (join / reconnect). */
  markPresent(roomId: string, userId: string): Promise<void>;
  /** Drop audience presence (leave / reclaim). */
  markAbsent(roomId: string, userId: string): Promise<void>;
  isPresent(roomId: string, userId: string): Promise<boolean>;
  /** Audience = present members NOT occupying a seat. */
  audienceCount(roomId: string): Promise<number>;
  listAudience(roomId: string, take: number, skip: number): Promise<AudiencePage>;
}
export const VIEWER_PRESENCE = Symbol('VIEWER_PRESENCE');
```

- **`DurableViewerPresence` (default, ships in VR-6):** `markPresent/markAbsent` reuse
  `VideoRoomPresenceService.addViewer/removeViewer`; `audienceCount` =
  `viewerCount(roomId) − occupiedSeatCount(roomId)` (occupied count from the VR-4 seat
  snapshot); `listAudience` = active members minus current seat occupants, mapped to
  `ViewerSummaryView`. **Behavior-preserving** — the member join/leave path already calls
  `addViewer/removeViewer`, so the durable impl reflects reality without new writes.
- **`EphemeralViewerPresence` (future, config-gated, NOT in VR-6):** Redis-only
  `SADD/SREM/SCARD`, no per-viewer DB row, batched history flush. Promotion in that mode
  materializes a durable member before seating (documented as a seam concern; a
  `materialize(roomId, userId)` hook may be added to the interface when that impl lands).

Selection is by a `videoRoom.viewerPresenceMode` config value (default `durable`), bound in
the module provider. The facade/controller/events depend only on `IViewerPresence`.

## 6. Viewer presence projection + counters

### 6.1 Projection (pure, no FSM change)

`toViewerPresence(state: VideoRoomPresenceState): ViewerStatus`-family label:

| FSM state | Viewer label |
|---|---|
| `ONLINE` | `WATCHING` |
| `CONNECTING` | `WATCHING` (optimistic; first-beat window) |
| `IDLE` | `BACKGROUND` |
| `RECONNECTING` | `RECONNECTING` |
| `DISCONNECTED` | `RECONNECTING` (client-facing; still within grace) |
| `LEFT` | `LEFT` |
| `OFFLINE` | `OFFLINE` |

The projection is a pure function with its own `*.spec.ts` (one case per state). `ONLINE`
remains available as a raw label where callers want the FSM value; the viewer surface uses
the mapped label. The `ViewerStatus` enum is extended to the full label set
(`WATCHING`, `BACKGROUND`, `ONLINE`, `RECONNECTING`, `LEFT`, `OFFLINE`).

### 6.2 Counters (Redis is source of truth; one authority per count)

| Counter | Source |
|---|---|
| Current Viewers (audience) | `IViewerPresence.audienceCount` = `viewers.SCARD − occupiedSeats` |
| Current Participants | VR-4 seat snapshot occupied-seat count |
| Peak Viewers | `VideoRoomStatistics.peakViewers` (already conditional-max on join) |
| Total Viewers | `VideoRoomStatistics.totalJoins` (already incremented on join) |
| Online / Idle / Background Viewers | folded from the projection over the bounded audience roster |
| Reconnecting Viewers | folded from the projection (RECONNECTING) |

`GET …/viewers/count` returns the full breakdown in one payload. **Precision note:**
`audienceCount`, `peakViewers`, and `totalJoins` are exact; the per-state split
(online/idle/background/reconnecting) is computed over the active-member roster bounded by
`VIDEO_ROOM_MAX_PAGE_SIZE` — mirroring how VR-3 `VideoRoomMemberService.listPresence`
already derives presence (`listActiveMembers(roomId, VIDEO_ROOM_MAX_PAGE_SIZE, 0)`). At the
durable tier this covers realistic room sizes; the broadcast-scale split is a concern of the
future `EphemeralViewerPresence` impl.

## 7. Operations → services

### 7.1 Facade lifecycle (delegation, no duplication)

| Facade method | Delegates to | VR-6 addition |
|---|---|---|
| `joinAsViewer(actor, roomId, dto, ctx)` | `VideoRoomMemberService.join` | emit `ViewerJoinedEvent{ viewerCount }`; return viewer-shaped payload |
| `leaveAsViewer(actor, roomId, dto, ctx)` | `VideoRoomMemberService.leave` | emit `ViewerLeftEvent{ viewerCount }` |
| `reconnectViewer(actor, roomId, dto, ctx)` | `VideoRoomMemberService.reconnect` | viewer-shaped payload |
| `heartbeat(dto)` | `VideoRoomSessionService.heartbeat` | (pass-through) |

The dormant `ViewerJoined`/`ViewerLeft` events are emitted by the facade (not the member
service), so member-roster consumers keep getting `UserJoined`/`UserLeft` while audience
consumers get `viewer_connected`/`viewer_disconnected` — both are legitimate, distinct client
signals already mapped in the socket listener.

### 7.2 Promote (viewer → participant) — `VideoRoomViewerService.promote`

RBAC: actor needs `VideoRoomPermission.MANAGE_SEATS` (checked via `VideoRoomPermissionService`).
Under the seat lock (owned by `seatUser`):
1. Validate: room live; target is an active member (viewer); target not already seated.
2. `seatIndex = dto.seatIndex ?? findOpenSeat(roomId)`; if none → `VIDEO_ROOM_CAPACITY_EXCEEDED`.
3. `await seatSvc.seatUser(roomId, targetUserId, actor.id, seatIndex, ip)` — occupies the
   GUEST seat; effective role `PARTICIPANT` + PUBLISHER capability follow automatically.
4. `repo.setParticipantStats(roomId, occupiedSeatCount)` — **sets** `currentParticipants`
   to the authoritative live occupied-seat count (not `+1`, to avoid concurrent drift) and
   conditional-bumps `peakParticipants` (new repo method, mirrors `bumpStatsOnJoin`'s
   set-current + conditional-max pattern).
5. Audit `viewer.promoted` (`appendEvent`); emit `ViewerPromotedEvent{ roomId, userId, seatIndex, actorId }`; `metrics.incViewerPromotion()`.

### 7.3 Demote (participant → viewer) — `VideoRoomViewerService.demote`

RBAC: `MANAGE_PARTICIPANTS` (+ `assertOutranks` for demoting others; self-demote allowed).
1. Validate: target currently occupies a seat (else `VIDEO_ROOM_NOT_PARTICIPANT`).
2. `await seatSvc.vacateUser(roomId, targetUserId, actor.id, 'seat.demoted', ip)` — releases
   the seat (idempotent). Derived role reverts to `VIEWER`.
3. **Gap-fill (live media):** if the target has a live media session in `PUBLISHER` role,
   drive `mediaSvc`/`mediaSessions.setRole(roomId, userId, SUBSCRIBER)` (reuse the existing
   plumbing at `video-room-media.service.ts:287-300`) so an already-connected publisher
   actually stops publishing; emit the existing media state-changed broadcast so the client
   re-fetches a subscriber token. No-op if the target had no live publish session.
4. `repo.setParticipantStats(roomId, occupiedSeatCount)` (recomputed post-vacate; same
   set-current authority as promote — no `-1` drift).
5. Audit `viewer.demoted`; emit `ViewerDemotedEvent{ roomId, userId, actorId }`; `metrics.incViewerDemotion()`.

### 7.4 Query — `VideoRoomViewerQueryService`

- `listAudience(roomId, take, skip)` → `IViewerPresence.listAudience` (paginated, audience only).
- `countAudience(roomId)` → the §6.2 breakdown.
- `getMyViewer(userId, roomId)` → `ViewerResponseDto`: effective role, viewer presence label,
  live session summary, viewer capability set (§11), and seat eligibility (can this user
  request/be promoted right now).

## 8. REST API surface

`@Controller('video-rooms')`, global `JwtAuthGuard`; `@NotGuest()` on all state-changers;
`@Ip()` for audit; `POST → @HttpCode(200)`; UUID room id via `ParseUuidPipe`; full Swagger
(`@ApiOperation`/`@ApiResponse`/examples) mirroring `video-rooms-members.controller.ts`.

| Method & path | Handler | Notes |
|---|---|---|
| `POST /:id/viewer/join` | `viewer.joinAsViewer` | body `JoinViewerDto`; returns viewer-shaped room sync |
| `POST /:id/viewer/leave` | `viewer.leaveAsViewer` | body `LeaveViewerDto` |
| `POST /:id/viewer/reconnect` | `viewer.reconnectViewer` | body `ReconnectViewerDto` |
| `POST /:id/viewer/heartbeat` | `viewer.heartbeat` | body `ViewerHeartbeatDto` → `{ alive }` |
| `POST /:id/viewer/promote` | `viewer.promote` | body `PromoteViewerDto`; RBAC `MANAGE_SEATS` |
| `POST /:id/viewer/demote` | `viewer.demote` | body `DemoteViewerDto`; RBAC `MANAGE_PARTICIPANTS` |
| `GET  /:id/viewers` | `query.listAudience` | paginated audience roster |
| `GET  /:id/viewers/count` | `query.countAudience` | full counter breakdown |
| `GET  /:id/viewer/me` | `query.getMyViewer` | caller's viewer view |

Note: join/leave/reconnect/heartbeat intentionally mirror the member endpoints (viewer =
member) but give the mobile client a viewer-semantic surface; they share the underlying
implementation. The existing `/:id/join` etc. remain valid.

## 9. DTOs & exceptions

**DTOs** (`dto/viewer.dto.ts`; reuse/extend existing join/leave/reconnect/heartbeat DTO
shapes — same `socketId`/`deviceId`/`platform`/`password`/`inBackground` fields, validated):
- `JoinViewerDto`, `LeaveViewerDto`, `ReconnectViewerDto`, `ViewerHeartbeatDto`
- `PromoteViewerDto { targetUserId: uuid; seatIndex?: int }`
- `DemoteViewerDto { targetUserId: uuid }`
- `ViewerResponseDto`, `ViewerSummaryDto`, `ViewerPresenceDto` (response shapes)

**Exceptions** — map the brief's names onto existing `ERROR_CODES`; add only the missing:

| Brief exception | Resolution |
|---|---|
| `ViewerJoinException` | reuse `VIDEO_ROOM_NOT_FOUND` / `VIDEO_ROOM_ENDED` / `VIDEO_ROOM_CAPACITY_EXCEEDED` / `VIDEO_ROOM_BLOCKED` / `VIDEO_ROOM_PASSWORD_INVALID` via `BusinessException` |
| `ViewerLeaveException` | reuse `VIDEO_ROOM_NOT_FOUND` |
| `DuplicateViewerException` | reuse `VIDEO_ROOM_DUPLICATE_SESSION` |
| `ViewerCapacityExceededException` | reuse `VIDEO_ROOM_CAPACITY_EXCEEDED` |
| `ViewerReconnectException` | reuse `VIDEO_ROOM_RECONNECT_FAILED` |
| `ViewerSessionException` | reuse `VIDEO_ROOM_SESSION_EXPIRED` |
| `ViewerPromotionException` | **new** `VIDEO_ROOM_PROMOTION_FAILED` (+ `VIDEO_ROOM_NOT_VIEWER` where the target is not an audience member) |
| `ViewerDemotionException` | **new** `VIDEO_ROOM_DEMOTION_FAILED` (+ `VIDEO_ROOM_NOT_PARTICIPANT`) |

All raised as `BusinessException(code, message, httpStatus)` — the module's existing pattern;
no bespoke exception classes.

## 10. Events, socket, audit, metrics

**Events (EVENT_BUS).** Wire the dormant `VIEWER_JOINED`/`VIEWER_LEFT`; add 3 new to
`VIDEO_ROOM_EVENTS`:
- `VIEWER_PROMOTED: 'video_room.viewer_promoted'` → `ViewerPromotedEvent{ roomId, userId, seatIndex, actorId }`
- `VIEWER_DEMOTED: 'video_room.viewer_demoted'` → `ViewerDemotedEvent{ roomId, userId, actorId }`
- `VIEWER_PRESENCE_CHANGED: 'video_room.viewer_presence_changed'` → `ViewerPresenceChangedEvent{ roomId, userId, status, audienceCount }`

**Socket (outbound only; no domain gateway).** Add to `VIDEO_ROOM_SOCKET_EVENTS` +
subscribe in `VideoRoomSocketListener`:
- `viewer_connected` / `viewer_disconnected` (map from now-wired `ViewerJoined`/`ViewerLeft`)
- `viewer_promoted` / `viewer_demoted` / `viewer_presence_changed`

The brief's inbound "socket handlers" (`joinViewer`, `viewerHeartbeat`, …) map to the REST
endpoints in §8 — this module has no domain socket gateway by design.

**Audit** (`appendEvent`, rich row: roomId, userId, socketId, deviceId, platform, ip, sid):
`viewer.joined`, `viewer.left`, `viewer.reconnected`, `viewer.promoted`, `viewer.demoted`,
plus the reclaim/heartbeat-timeout rows already produced by VR-3.

**Metrics** (`VideoRoomsMetrics`): reuse `viewers` gauge / `joins,leaves,reconnects,
heartbeatFailures,sessionDuration`; add `video_rooms_peak_viewers` gauge and
`video_rooms_viewer_promotions_total` / `video_rooms_viewer_demotions_total` counters. Watch
time = the existing `video_rooms_session_duration_seconds` histogram (already observed on
leave/reclaim) and `totalDurationSeconds/totalJoins`.

## 11. Viewer permission matrix — LEARNING-CONTRIBUTION POINT

`constants/video-room-viewer-permissions.ts` declares the read-only capability set a viewer
holds, surfaced by `GET …/viewer/me` and enforced where relevant. Proposed default (the
author will confirm/adjust — this is a genuine product-policy choice, mirroring the VR-4
seat-request-priority contribution point):

```ts
export const VIEWER_CAPABILITIES = {
  canReceiveStreams: true,
  canViewParticipants: true,
  canViewSeats: true,
  canViewRoomInfo: true,
  canRequestSeat: true,
  canReportUser: true,
  canShareRoom: true,
  canFollowHost: true,
  // hard-false — enforced by seat/media derivation, listed for the client:
  canPublishCamera: false,
  canPublishAudio: false,
  canOccupySeat: false,   // only via promote / request-approve / invite-accept
  canMuteOthers: false,
  canManageRoom: false,
} as const;
```

`canRequestSeat` and `canShareRoom`/`canFollowHost` are the live policy levers (e.g. a room
setting could disable seat requests). The matrix is a plain constant + a `videoRoomViewerCan`
helper; media capabilities remain seat-derived (not granted here), consistent with VR-4's
permission model.

## 12. Validations (enforced in services, reusing existing gates)

Join reuses the VR-3 chain verbatim (exists → live → block → password → capacity[`maxViewers`]
→ duplicate-session). Promote adds: room live, target is an active member, target not already
seated, an open seat exists, actor `MANAGE_SEATS`. Demote adds: target currently seated, actor
`MANAGE_PARTICIPANTS` + outranks target (self-demote exempt). Reconnect reuses the VR-3 grace
window. No new validation primitives.

## 13. Config additions (`videoRoom` namespace)

- `viewerPresenceMode: 'durable' | 'ephemeral'` (default `durable`) — selects the
  `IViewerPresence` implementation. Only `durable` is implemented in VR-6.

No other config additions — heartbeat/reconnect/idle/session TTLs and `maxViewers` caps are
reused. Add the key to `env.validation.ts` + `.env.example` + `configuration.ts` with the
string-coercion note already established for this namespace.

## 14. Testing plan (TDD, colocated `*.spec.ts`)

- **Projection:** `video-room-viewer-presence.projection.spec.ts` — one case per FSM state → label.
- **Seam (durable):** `durable-viewer-presence.spec.ts` — audience = present − seated; count/list correctness incl. seated-user exclusion.
- **Facade:** `video-room-viewer.service.spec.ts` — join/leave/reconnect delegate + emit viewer events; promote (seatUser called, stats bumped, event, RBAC denial); demote (vacateUser called, live media `setRole(SUBSCRIBER)` driven when publishing, no-op when not, stats, event, RBAC/outrank).
- **Query:** `video-room-viewer-query.service.spec.ts` — audience page, count breakdown, `viewer/me` shape incl. capabilities.
- **Permissions:** `video-room-viewer-permissions.spec.ts` — matrix + helper.
- **Controller:** `video-rooms-viewers.controller.spec.ts` — 9 routes, guards, delegation, Swagger presence.
- **Events/socket:** extend `video-room-socket.listener.spec.ts` — 5 viewer mappings (connected/disconnected/promoted/demoted/presence_changed).
- **Metrics:** peak-viewers gauge + promotion/demotion counters.

Target: no regressions against the current module baseline; new specs land green (aim ≈ +60–90 tests, in line with prior phases).

## 15. Implementation order

1. `IViewerPresence` interface + `VIEWER_PRESENCE` token + `DurableViewerPresence` (+ spec).
2. Presence projection function + `ViewerStatus` extension (+ spec).
3. Viewer permission matrix constant + helper (+ spec) — confirm the learning-contribution default.
4. New events + socket names + error codes; wire dormant `ViewerJoined`/`ViewerLeft`.
5. `VideoRoomViewerService` facade: lifecycle delegation + event emission (+ spec).
6. Promote/demote orchestration incl. `bumpParticipantStats` repo method + live media role gap-fill (+ spec).
7. `VideoRoomViewerQueryService` (+ spec).
8. DTOs + `video-rooms-viewers.controller.ts` (+ spec) + Swagger.
9. Metrics additions; socket-listener spec extension; config (`viewerPresenceMode`) + env wiring.
10. Module wiring; full `tsc` + ESLint + boundaries + module test-suite green; verification.

## 16. Non-goals / explicit exclusions

- **Broadcast-scale (millions) audience** — that is the `EphemeralViewerPresence` seam
  implementation; VR-6 ships only the seam + durable impl.
- **Anonymous viewer** — future-ready via the seam; not implemented.
- Room chat, emoji, virtual gifts, treasure boxes, wallet, PK battles, rankings,
  notifications, moderation, analytics processing, recording, live-streaming business logic
  — all out of scope per the brief.
- No new tables, no new BullMQ queues, no new Redis lifecycle, no domain socket gateway.
