# Video Room — Phase 8: Enterprise Seat Request & Invitation Workflow (VR-8)

**Date:** 2026-07-21
**Status:** Approved (Section A architecture approved by user, 2026-07-21)
**Depends on:** VR-0 … VR-7 (all complete, uncommitted working tree)

---

## 1. Objective

Complete the seat request / invitation / queue / promotion workflow for video rooms.

VR-4 already shipped the *happy paths* (request, cancel, approve, reject, invite,
accept, reject, cancel) against real Prisma tables, and VR-6 shipped
promotion/demotion. VR-8 closes the remaining gaps: an ordered **queue** with VIP
priority and positions, the **terminal states** the workflow was missing
(`PROMOTED`, `FAILED`, `DELIVERED`), **retry/restore**, **event-emitting
expiry**, the **missing REST surface**, the **missing validations**, and the
**missing metrics**.

This is a *completion* phase. It introduces no new module, no parallel seat
stack, and no new tables.

---

## 2. Locked design decisions (brainstorming, 2026-07-21)

1. **Queue = Redis ZSET projection.** PostgreSQL `VideoRoomSeatRequest` remains
   the record of truth. The ordered queue is a rebuildable Redis sorted set.
   Losing Redis costs a rebuild, never data.
2. **Auto-advance is a per-room toggle, defaulting to approval-required.**
   New `VideoRoomSettings.seatApprovalRequired Boolean @default(true)` preserves
   today's behaviour for every existing room; opting out gives audio-room-style
   auto-advance.
3. **Additive-only schema.** Add `PROMOTED`/`FAILED` to
   `VideoRoomSeatRequestStatus`, `DELIVERED`/`FAILED` to
   `VideoRoomInvitationStatus`, plus `attemptCount`/`lastError`/`deliveredAt`
   columns. **No renames.** `PENDING ≡ SENT` and `ACCEPTED ≡ APPROVED` are
   documented aliases; wire DTOs emit the brief's vocabulary.
4. **Retry is explicit; restore is reconnect recovery.** Retry re-drives a
   `FAILED` row (bounded by `attemptCount`). Restore is automatic: a viewer who
   reconnects inside the existing grace window gets their disconnect-expired
   request revived at its **original `createdAt`**, so the ZSET score is
   unchanged and queue position is preserved exactly.
5. **Priority = VIP level → FIFO, with a fairness cap.** Authority rank is
   deliberately excluded: anyone holding `MANAGE_SEATS` can already seat
   themselves directly, so queue priority would be redundant.
6. **Auto-advance lives outside `VideoRoomSeatService`,** driven by
   `VideoRoomSeatQueueListener` reacting to seat lifecycle events.
7. **Scoring is a pure function** — `computeQueueScore()`, no I/O, unit-testable
   in isolation, the single place queue policy lives.
8. **All outbound updates flow EventBus → SocketListener.** No service emits to
   sockets directly.
9. **Errors use `BusinessException` + `ERROR_CODES`,** the platform convention
   across VR-0…VR-7 — *not* the brief's 8 bespoke exception classes. Same
   convention-over-checklist call made in VR-1.
10. **No git commits or pushes.** Working-tree only.

---

## 3. The gaps VR-8 closes

| # | Gap | Today |
|---|---|---|
| G1 | No queue ordering, position, or `queueUpdated` | `compareRequestPriority` is a pure-FIFO stub, sorted per read |
| G2 | No VIP priority | production.txt:3579 lists "Priority Seat Requests" as a VIP privilege — unimplemented |
| G3 | No auto-advance when a seat frees | Audio rooms has `advanceQueue`; video rooms has nothing |
| G4 | Missing states `PROMOTED`/`FAILED`/`DELIVERED` | 5 statuses each; a failed seating is indistinguishable from success |
| G5 | Expiry is silent | `expireStaleRequests` is a bulk `updateMany` returning a count — no events, clients never learn |
| G6 | No update/retry/restore operations | Not implemented |
| G7 | Missing REST: `GET /requests`, `GET /invitations`, `DELETE /invite` | `listRequests` exists in the service but is unrouted; `cancel` invitation is unrouted |
| G8 | Missing validations: banned/blocked, capacity, already-participant, seat locked/reserved on invite | Only room-live + membership + duplicate are checked |
| G9 | No workflow metrics | `seatRequests`/`seatInvitations` counters only; no latency, acceptance rate, or queue size |

---

## 4. Reuse map (what already exists — do NOT recreate)

| Need | Existing component |
|---|---|
| Seating a user (locked, versioned) | `VideoRoomSeatService.seatUser` / `vacateUser` / `mutateStage` |
| Finding an open seat | `VideoRoomSeatService.findOpenSeat` |
| Room-is-live guard | `VideoRoomSeatService.requireLiveRoom` |
| Permission checks | `VideoRoomPermissionService.assertPermission` (`MANAGE_SEATS`, `INVITE_USERS`, `MANAGE_PARTICIPANTS`) |
| Promotion / demotion | `VideoRoomViewerService.promote` / `demote` (VR-6) |
| Room-level ban/block | `VideoRoomModerationRepository.findActiveBlock` |
| Audit log | `VideoRoomEventsRepository.appendEvent` |
| Request/invitation persistence | `VideoRoomSeatsRepository` (create/find/list/setStatus/expire) |
| Fleet-locked sweep | `VideoRoomSeatMonitor` (extend, don't replace) |
| VIP level | `VIP_SERVICE.getLevelOrdinal(userId)` — `VipModule` is `@Global()`, no module import needed |
| Redis primitives | `CacheService`, `LockService` |
| Socket fan-out | `VideoRoomSeatSocketListener` |

---

## 5. Data model — additive only

```prisma
enum VideoRoomSeatRequestStatus {
  PENDING            // ≡ the brief's PENDING
  ACCEPTED           // ≡ the brief's APPROVED — decision made, seating in flight
  REJECTED
  CANCELLED
  EXPIRED
  PROMOTED           // NEW — seated successfully; terminal success
  FAILED             // NEW — seating threw; retryable
}

enum VideoRoomInvitationStatus {
  PENDING            // ≡ the brief's SENT
  DELIVERED          // NEW — invitee's client acked receipt
  ACCEPTED
  REJECTED
  EXPIRED
  CANCELLED
  FAILED             // NEW — seating threw on accept; retryable
}

model VideoRoomSeatRequest {
  attemptCount Int     @default(0)   // NEW — bounds retry
  lastError    String?               // NEW — failure reason surfaced to the retry UI
}

model VideoRoomInvitation {
  attemptCount Int       @default(0) // NEW
  lastError    String?               // NEW
  deliveredAt  DateTime?             // NEW
}

model VideoRoomSettings {
  seatApprovalRequired Boolean @default(true)  // NEW — false ⇒ auto-advance
}
```

Every change is additive with a default. No backfill, no rewritten rows, no
renames, no new tables.

---

## 6. Queue design

### 6.1 Redis keys

```
vr:{roomId}:seatq         ZSET   member=userId  score=computeQueueScore(...)
vr:{roomId}:seatq:skips   ZSET   member=userId  score=skipCount
```

Both carry a TTL refreshed on write, and are dropped when the room ends.

**Skips are a ZSET, not a hash, because `CacheService` exposes no hash
operations.** `addScore(skipsKey, userId, 1)` (ZINCRBY) increments and
`score(skipsKey, userId)` (ZSCORE) reads — no new Redis primitive is needed.

Every operation the queue needs already exists on `CacheService`, in the
"Sorted-set primitives (matchmaking queue)" family whose own docblock notes that
callers "serialize multi-step reads/writes with `LockService` where ordering
matters (e.g. read-lowest-then-remove)" — exactly the `advance()` pattern:

| Queue op | `CacheService` method | Redis |
|---|---|---|
| enqueue / re-score | `setScore` | `ZADD` |
| position (0-based, ascending) | `sortedRank` | `ZRANK` |
| front N | `sortedLowest` | `ZRANGE … WITHSCORES` |
| dequeue | `sortedRemove` | `ZREM` |
| size | `sortedCount` | `ZCARD` |
| projection present? | `exists` | `EXISTS` |
| TTL refresh / clear | `expire` / `del` | `EXPIRE` / `DEL` |
| skip increment / read | `addScore` / `score` | `ZINCRBY` / `ZSCORE` |

**Lower score sorts first**, matching `sortedRank`/`sortedLowest` ascending
semantics.

### 6.2 Scoring — pure policy

```ts
// constants/video-room-seat-queue.ts
export const QUEUE_FAIRNESS_SKIP_CAP = 3;

export interface QueueScoreInput {
  vipLevel: number;   // 0 when not VIP
  createdAt: Date;    // original request time — preserved across restore
  skipCount: number;  // times this entry was passed over
}

export function computeQueueScore(input: QueueScoreInput): number;
```

Lower score sorts first. Precedence:

1. An entry at or past `QUEUE_FAIRNESS_SKIP_CAP` is pinned ahead of everything
   else (anti-starvation).
2. Otherwise higher `vipLevel` sorts first.
3. Ties break on earlier `createdAt`.

Pure — no DI, no I/O, no clock read. Fully unit-testable, and the single knob
for queue policy. It replaces the VR-4 `compareRequestPriority` stub, which is
deleted.

### 6.3 `VideoRoomSeatQueueService` (new)

```ts
enqueue(roomId, userId, createdAt): Promise<number>   // → 1-based position
dequeue(roomId, userId): Promise<void>
position(roomId, userId): Promise<number | null>      // 1-based, null if absent
list(roomId, limit?): Promise<QueueEntryView[]>       // ordered, with positions
peekFront(roomId): Promise<string | null>
advance(roomId, seatIndex, actorId): Promise<boolean> // auto-seat the front
rebuild(roomId): Promise<number>                      // replay PENDING rows
size(roomId): Promise<number>
clear(roomId): Promise<void>
```

**Rebuild-on-miss:** every read path checks `EXISTS` on the ZSET first; a miss
triggers `rebuild(roomId)` from `listPendingRequests`. This makes the projection
self-healing after a Redis flush, failover, or cold start.

**`advance`** is the auto-advance primitive: pop the front under the existing
seat lock, seat them via `VideoRoomSeatService.seatUser`, mark the request
`PROMOTED`. If the front entry can't be seated (seat re-taken, user gone, block
in force), increment their `skipCount`, re-score, and try the next entry —
bounded to one pass so a poisoned queue can't spin.

`VideoRoomSeatQueueService` is the **sole publisher** of `SeatQueueUpdatedEvent`.

### 6.4 `VideoRoomSeatQueueListener` (new)

Keeps queue mechanics out of `VideoRoomSeatService`:

| Subscribes to | Action |
|---|---|
| `SeatLeftEvent`, `SeatReleasedEvent` | if `!seatApprovalRequired` → `advance(roomId, seatIndex, actorId)`; else emit `QueueUpdated` |
| `SeatTakenEvent` | `dequeue(userId)` — a seated user leaves the queue |
| `UserLeftEvent` | `dequeue(userId)` + cancel their pending request |
| `UserReconnectedEvent` | **restore**: revive a disconnect-expired request at its original `createdAt` |
| `RoomClosedEvent`, `RoomDeletedEvent` | `clear(roomId)` |

(Event class names verified against `video-room.events.ts` and
`video-room-seat.events.ts` — the module has no `MemberLeft`/`RoomEnded` types.)

---

## 7. Request state machine

```
                 ┌──────────── retry (attemptCount < MAX) ────────────┐
                 v                                                    │
  (create) → PENDING ──approve──→ ACCEPTED ──seatUser ok──→ PROMOTED  │
                 │                    │                               │
                 │                    └──seatUser throws──→ FAILED ───┘
                 ├──reject──────→ REJECTED
                 ├──cancel──────→ CANCELLED
                 └──TTL lapse───→ EXPIRED ──restore (reconnect ≤ grace)──→ PENDING
```

Every transition is validated by a single guard table; illegal transitions raise
`BusinessException(ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION, …, 409)`.

**Restore preserves `createdAt`.** Because the ZSET score is derived from
`createdAt`, a restored request re-enters at exactly its former position — the
viewer loses nothing for a transient disconnect.

**Retry** is bounded by `VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS`; the row records
`lastError` so the client can show *why*.

## 8. Invitation state machine

```
  (send) → PENDING ──client ack──→ DELIVERED
              │                        │
              ├────accept──────────────┤──→ (seatUser ok) → ACCEPTED
              │                        │     (seatUser throws) → FAILED ──retry──→ PENDING
              ├────reject──────────────┤──→ REJECTED
              ├────cancel (inviter)────┤──→ CANCELLED
              └────TTL lapse───────────┴──→ EXPIRED
```

`DELIVERED` is set by an explicit ack endpoint, stamping `deliveredAt`. It is
purely informational — accept/reject work from `PENDING` or `DELIVERED` alike —
but it powers the invitation **delivery rate** metric and lets the inviter's UI
distinguish "not seen yet" from "seen, ignoring".

---

## 9. Validations

Added to `request()` (in order, cheapest first):

| Check | Failure |
|---|---|
| Room exists + live | `VIDEO_ROOM_NOT_FOUND` (404) / `VIDEO_ROOM_INVALID_STATE` (409) — via existing `requireLiveRoom` |
| Viewer joined + active | `VIDEO_ROOM_NOT_MEMBER` (403) |
| Not room-blocked/banned | `VIDEO_ROOM_BLOCKED` (403) |
| Not already seated | `ALREADY_ON_SEAT` (409) |
| No duplicate pending request | `DUPLICATE_SEAT_REQUEST` (409) |
| Requested seat exists / unlocked / unreserved (when `seatIndex` given) | `SEAT_NOT_FOUND` / `SEAT_LOCKED` / `SEAT_RESERVED` |
| Participant capacity not exceeded | `VIDEO_ROOM_CAPACITY_EXCEEDED` (409) |

Added to `invite()`:

| Check | Failure |
|---|---|
| Room live + `INVITE_USERS` | `VIDEO_ROOM_INVALID_STATE` (409) / `VIDEO_ROOM_FORBIDDEN` (403) |
| Target is an active member of this room | `VIDEO_ROOM_NOT_MEMBER` (409) — subsumes "user exists", since a non-existent user can hold no membership row |
| Target not already seated | `ALREADY_ON_SEAT` (409) |
| Target not room-blocked | `VIDEO_ROOM_BLOCKED` (403) |
| Seat available / not locked / not reserved | `SEAT_TAKEN` / `SEAT_LOCKED` / `SEAT_RESERVED` |
| No duplicate pending invitation for that seat | `DUPLICATE_SEAT_INVITATION` (409) |

### New error codes (3)

```ts
SEAT_REQUEST_INVALID_TRANSITION: 'SEAT_REQUEST_INVALID_TRANSITION',
SEAT_INVITATION_INVALID_TRANSITION: 'SEAT_INVITATION_INVALID_TRANSITION',
SEAT_RETRY_EXHAUSTED: 'SEAT_RETRY_EXHAUSTED',
```

Everything else the brief asks for already exists: `QUEUE_ENTRY_NOT_FOUND`,
`VIDEO_ROOM_CAPACITY_EXCEEDED`, `VIDEO_ROOM_BLOCKED`,
`VIDEO_ROOM_PROMOTION_FAILED`, `VIDEO_ROOM_DEMOTION_FAILED`, `ROOM_BANNED`,
`DUPLICATE_SEAT_REQUEST`, `DUPLICATE_SEAT_INVITATION`, `SEAT_LOCKED`,
`SEAT_RESERVED`, `ALREADY_ON_SEAT`, `SEAT_REQUEST_EXPIRED`,
`SEAT_INVITATION_EXPIRED`.

---

## 10. Event-emitting expiry

`VideoRoomSeatMonitor.sweep()` changes from silent bulk `updateMany` to a
bounded per-row pass:

```
listExpiredRequests(now, EXPIRY_SWEEP_LIMIT)
  → for each: setRequestStatus(EXPIRED) + dequeue + publish SeatRequestExpiredEvent
listExpiredInvitations(now, EXPIRY_SWEEP_LIMIT)
  → for each: setInvitationStatus(EXPIRED) + publish SeatInvitationExpiredEvent
→ publish one SeatQueueUpdatedEvent per affected room
```

Still fleet-locked by the existing `VIDEO_ROOM_SEAT_MONITOR_LOCK_KEY`, so
exactly one instance sweeps per tick. The bulk helpers stay as a fallback for
batches exceeding the sweep limit.

---

## 11. Contracts

### REST — on the actual `/video-rooms/:id` convention (not the brief's `/video-room/:roomId`)

Existing (VR-4), unchanged:

```
POST   /video-rooms/:id/seats/request
DELETE /video-rooms/:id/seats/request
POST   /video-rooms/:id/seats/request/:requestId/approve
POST   /video-rooms/:id/seats/request/:requestId/reject
POST   /video-rooms/:id/seats/invite
POST   /video-rooms/:id/seats/invite/accept
POST   /video-rooms/:id/seats/invite/reject
```

New in VR-8:

```
GET    /video-rooms/:id/seats/requests            # MANAGE_SEATS — ordered, with positions
GET    /video-rooms/:id/seats/invitations         # MANAGE_SEATS — pending/delivered
DELETE /video-rooms/:id/seats/invite              # inviter/owner/admin — cancel
PATCH  /video-rooms/:id/seats/request             # requester — change preferred seatIndex
POST   /video-rooms/:id/seats/request/:requestId/retry    # MANAGE_SEATS — re-drive FAILED
POST   /video-rooms/:id/seats/invite/:invitationId/retry  # invitee — re-drive FAILED
POST   /video-rooms/:id/seats/invite/:invitationId/ack    # invitee — mark DELIVERED
GET    /video-rooms/:id/seats/queue               # any member — queue + my position
```

Every endpoint gets full Swagger: summary, auth, required permission, request
schema, response schema, and documented status codes.

### Socket — outbound only

Existing, reused: `seat_requested`, `seat_approved`, `seat_rejected`,
`seat_invitation_sent`, `seat_invitation_accepted`, `seat_invitation_rejected`,
`viewer_promoted`, `viewer_demoted` (the brief's `participantPromoted` /
`participantDemoted` — aliased, **not** duplicated).

New:

```
video_room.seat_request_expired
video_room.seat_request_cancelled
video_room.seat_invitation_cancelled
video_room.seat_invitation_expired
video_room.seat_invitation_delivered
video_room.seat_queue_updated
```

`seat_queue_updated` carries `{ roomId, size, top: [{userId, position, vipLevel}] }`
truncated to `VIDEO_ROOM_QUEUE_PREVIEW_LIMIT` (new constant, default 20) — never
the whole queue, so a 10k-deep queue can't blow up a broadcast frame.

### Domain events

Four new classes in `video-room-seat.events.ts`: `SeatRequestExpiredEvent`,
`SeatInvitationExpiredEvent`, `SeatInvitationDeliveredEvent`,
`SeatQueueUpdatedEvent`.

The two *cancelled* socket events need no new domain event — they already ride
the existing `SeatRequestResolvedEvent` / `SeatInvitationResolvedEvent` with
`status: 'CANCELLED'`. The `SeatRequestResolution` union widens to include
`'PROMOTED' | 'FAILED'`.

> **Live bug this fixes.** The current listener branches
> `status === 'ACCEPTED' ? SEAT_APPROVED : SEAT_REJECTED`
> ([video-room-seat-socket.listener.ts:63](../../../src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts#L63)
> and again at L77 for invitations). So a request the user **cancelled**, or one
> that **expired**, is broadcast to the whole room as `seat_rejected` — clients
> are told the host rejected someone when nothing of the sort happened. Adding
> `PROMOTED`/`FAILED` to the union makes this worse (both would also read as
> "rejected"), so VR-8 must replace both ternaries with an exhaustive
> status→event map before widening the union.

### DTOs

New in `dto/seat-queue.dto.ts`: `UpdateSeatRequestDto`, `RetrySeatRequestDto`,
`AckSeatInvitationDto`, `CancelSeatInvitationDto`, `QueueResponseDto`,
`QueueEntryDto`, `PromotionResponseDto`, `ListSeatRequestsDto`,
`ListSeatInvitationsDto`. Existing `CreateSeatRequestDto`,
`CreateVideoRoomInvitationDto`, `AcceptSeatInvitationDto`,
`RejectSeatInvitationDto` are reused unchanged.

---

## 12. Monitoring

Added to `VideoRoomsMetrics` ([video-rooms.metrics.ts](../../../src/modules/video-rooms/video-rooms.metrics.ts)):

| Metric | Type | Purpose |
|---|---|---|
| `video_rooms_seat_queue_size` | Gauge (roomId-free, aggregate) | queue depth |
| `video_rooms_seat_request_resolutions_total{status}` | Counter | pending/approved/rejected/expired/promoted/failed |
| `video_rooms_seat_approval_latency_seconds` | Histogram | request created → resolved |
| `video_rooms_seat_invitation_outcomes_total{status}` | Counter | sent/delivered/accepted/rejected/expired/failed — powers delivery + acceptance rate |
| `video_rooms_seat_promotion_total{result}` | Counter | success/failure — powers promotion success rate |
| `video_rooms_seat_queue_advance_total{result}` | Counter | auto-advance seated/skipped |

Acceptance rate, delivery rate and promotion success rate are **derived in
Prometheus** from the counters above rather than stored — no stateful rate
tracking in the app.

Wired through a dedicated `VideoRoomSeatWorkflowMetricsListener` subscribing to
the domain events, mirroring the VR-4 decoupled-metrics pattern. Services never
touch the metrics registry directly.

---

## 13. Audit logging

Every workflow transition appends to the existing `video_room_events` table via
`VideoRoomEventsRepository.appendEvent`, carrying `roomId`, `actorId`,
`eventType`, and a payload with `requestId`/`invitationId`, `seatIndex`,
`subjectUserId`, and `ip`. New event types: `seat.request_updated`,
`seat.request_retried`, `seat.request_restored`, `seat.request_expired`,
`seat.request_promoted`, `seat.request_failed`, `seat.invitation_delivered`,
`seat.invitation_retried`, `seat.invitation_expired`, `seat.queue_advanced`.

Timestamps come from the table's `createdAt`; participant/viewer ids ride in the
payload. No new audit table.

---

## 14. Testing

| Suite | Coverage |
|---|---|
| `video-room-seat-queue.constants.spec` | `computeQueueScore` — VIP ordering, FIFO ties, fairness-cap pinning, boundary values |
| `video-room-seat-queue.service.spec` | enqueue/dequeue/position/list/size, rebuild-on-miss, advance success + skip path + bounded single pass |
| `video-room-seat-queue.listener.spec` | auto-advance on seat free gated by `seatApprovalRequired`; dequeue on seated/left; clear on room end |
| `video-room-seat-request.service.spec` (extend) | all 7 states, every legal + illegal transition, new validations, retry bound, restore preserves `createdAt` |
| `video-room-seat-invitation.service.spec` (extend) | all 7 states, ack→DELIVERED, retry, cancel, seat-availability validations |
| `video-room-seats.repository.spec` (extend) | new columns, `listExpired*` bounded queries, transition persistence |
| `video-room-seat.monitor.spec` (extend) | per-row expiry emits events, sweep limit respected, fleet lock honoured |
| `video-rooms-seats.controller.spec` (extend) | 8 new routes — auth, permission, validation, status codes |
| `video-room-seat-socket.listener.spec` (extend) | 6 new socket events, queue preview cap |
| `video-room-seat-workflow-metrics.listener.spec` | counters/histograms fire on the right events |

TDD throughout, matching VR-5/6/7: test first, then implementation, per task.

---

## 15. Out of scope

Chat, emoji, gifts, treasure boxes, wallet, PK battles, rankings,
notifications, moderation actions, analytics processing, recording. Also
explicitly out: room-level (`type = ROOM`) invitations — VR-8 handles
`type = SEAT` only; global (non-room) user blocks, which would require a new
cross-module dependency on `privacy`.

---

## 16. Definition of done

- [ ] Queue projection with VIP + FIFO + fairness cap, rebuildable from Postgres
- [ ] Auto-advance gated by `seatApprovalRequired`, driven from the listener
- [ ] 7 request states + 7 invitation states, every transition guarded
- [ ] Retry (bounded) + restore (reconnect, position-preserving)
- [ ] Expiry emits per-row events
- [ ] 8 new REST routes, fully Swagger-documented
- [ ] 6 new socket events + 4 new domain events
- [ ] 6 new metrics via a decoupled listener
- [ ] Audit entries for every transition
- [ ] `tsc`, `eslint`, boundary checks green
- [ ] Full video-rooms suite green, zero regressions against the project suite's pre-VR-8 baseline (captured before the first task runs)
- [ ] Nothing committed (working tree only)
