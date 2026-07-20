# Video Room — Phase 4: Multi-Seat Management Engine (VR-4)

- **Date:** 2026-07-20
- **Status:** Approved (design)
- **Module:** `src/modules/video-rooms` (new slice inside the existing module — no new module, no new tables)
- **Depends on:** VR-0 (infra), VR-1 (seat schema/repository/views), VR-2 (lifecycle + permission + Redis versioned state), VR-3 (member/presence/session)

## 1. Objective

Implement a production-grade multi-seat management engine for Video Rooms: dynamic layouts,
seat lock/unlock (incl. bulk), reservation with auto-release, invitation workflow, request
workflow, seat switching, seat transfer / force-transfer, owner-seat protection, live Redis
synchronization, socket events, event-bus publishing, immutable audit logging, and monitoring —
built to the Phase 0–3 quality bar (SOLID, repository + service layers, event-driven, CQRS-ready,
horizontally scalable).

Explicitly **out of scope** (per brief): camera/mic controls, video publish/playback, viewer mode,
beauty filters, chat, gifts, treasure boxes, wallet, PK battles, moderation actions, notifications,
analytics processing, recording.

## 2. Locked design decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope fidelity | **Conventions-first** — full engine, but expressed on the existing lean schema + video-room primitives; add storage only where a capability truly can't be modeled. Mirrors how VR-1..VR-3 shipped. |
| 2 | Live seat-state authority | **Redis-authoritative + DB write-through** — versioned, lock-serialized Redis snapshot is the source of truth for reads + socket sync; every mutation write-throughs to `video_room_seats` (durable projection/history + recovery). Mirrors `VideoRoomStateService`; honors the brief ("Redis live, DB history"). |
| 3 | Migration policy | **Zero schema change** — project the whole engine over existing tables. No migration. |
| 4 | Request model | **Pending-request list + read-time priority** — approve/reject individually; priority computed at read time (owner-affinity → role rank → VIP → FIFO). No queue table. |

## 3. Reuse map (what already exists — do NOT recreate)

- **Schema (VR-1, `prisma/schema/video_rooms_seats.prisma`):** `video_room_seats`
  (`seatIndex`, `seatType` OWNER/HOST/GUEST, `seatStatus` EMPTY/OCCUPIED/LOCKED/RESERVED,
  `occupantUserId`, `reservedForUserId`, `isLocked`, `isMuted`, `isVideoOn`, `metadata Json?`),
  `video_room_seat_requests` (`seatIndex?`, `status`, `expiresAt`, ...), `video_room_invitations`
  (`inviteeUserId`, `seatIndex?`, `status`, `expiresAt`, ...), `video_room_roles` (grants).
- **Repository (VR-1):** `VideoRoomSeatsRepository` — pure persistence incl. `expireStaleRequests`,
  `expireStaleInvitations`.
- **Views/mappers (VR-1):** `VideoRoomSeatView`, request/invitation/role views + mappers.
- **Live-state primitive (VR-0/2):** `VideoRoomStateService` (versioned, lock-serialized Redis).
- **RBAC (VR-2):** `VideoRoomPermissionService` + `VIDEO_ROOM_PERMISSION_MATRIX` + `VideoRoomPermission`.
- **Socket bridge (VR-0/3):** `VideoRoomSocketListener`, `SocketManager.emitToNamespaceRoom`,
  `VIDEO_ROOM_NAMESPACE`, `VIDEO_ROOM_SOCKET_EVENTS`.
- **Event bus (VR-0):** `EVENT_BUS` / `IEventBus`, `DomainEvent` base.
- **Audit (VR-1):** `VideoRoomEventService` → append-only `video_room_events`
  (`eventType`, `payload`, `actorId`, `referenceId`, `correlationId`).
- **Infra:** `LockService` (`withLock`), `CacheService`, `VideoRoomSessionMonitor` (fleet-locked sweep),
  `VideoRoomsMetrics`, `ERROR_CODES` (SEAT_* codes already present), `BusinessException`.
- **Config/constants:** `VIDEO_ROOM_DEFAULT_HOST_SEATS=9`, `VIDEO_ROOM_MAX_SEATS=20`,
  `VIDEO_ROOM_OWNER_SEAT_INDEX=0`, `VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS=60`,
  `VIDEO_ROOM_INVITATION_TTL_SECONDS=120`. Layout on `VideoRoomSettings.hostSeatCount/guestSeatCount`.

## 4. Component architecture (new units, single-purpose)

```
VideoRoomSeatStateService      Redis-authoritative versioned seat snapshot (mirrors VideoRoomStateService)
VideoRoomSeatService           occupancy: take/leave/switch/transfer/force/move/remove/lock/unlock/lockMany/unlockMany/configureLayout/getStage
VideoRoomSeatRequestService    request/cancel/approve/reject + read-time priority
VideoRoomSeatInvitationService invite/accept/reject/cancel
VideoRoomSeatReservationService reserve/cancel + TTL auto-release
VideoRoomSeatsController        the 12 REST endpoints + GET stage
video-room-seat.events.ts      EVENT_BUS seat event classes
VideoRoomSeatSocketListener    bus seat-events -> video_room.seat_* socket broadcasts
VideoRoomSeatLifecycleListener reacts to room events (USER_LEFT->vacate, CLOSED/DELETED->clearStage, OWNERSHIP_TRANSFERRED->move owner seat)
constants/video-room-seat-lifecycle.ts  SEAT_TRANSITIONS legality table + guards

Extend: VideoRoomPermissionService (seat-derived roles), VideoRoomsMetrics (seat gauges/counters),
        VideoRoomSessionMonitor (seat-expiry sweep), VIDEO_ROOM_SOCKET_EVENTS, dto/seat.dto.ts, ERROR_CODES
Reuse:  VideoRoomSeatsRepository, LockService, CacheService, VideoRoomEventService, scheduler
```

## 5. State topology (Redis-authoritative + DB write-through)

Mutation pipeline, under a per-room seat lock:

```
withLock( videoRoomSeatLockKey(roomId) ):
  1. load authoritative seat snapshot from Redis (rebuild from DB if cold)
  2. validate transition (SEAT_TRANSITIONS) + permission (RBAC)
  3. mutate snapshot in memory, version++          <- Redis = source of truth
  4. CacheService.set(seat snapshot)                <- authoritative write
  5. VideoRoomSeatsRepository.updateSeat(...)        <- durable projection/history
  6. VideoRoomEventService append "seat.<action>" {actor, target, seatIndex, ip, requestId}
  7. publish SeatEvent on EVENT_BUS -> socket listener -> video_room.seat_* broadcast
```

Consistency trade-off (accepted, same as `VideoRoomStateService`): Redis is authoritative; DB is a
write-through projection. A crash between step 4 and 5 loses the last uncommitted mutation on a Redis
wipe; recovery rebuilds the snapshot from DB (`restore`), version reset to 1. Writes are inside the
lock so no concurrent divergence.

**New Redis keys** (existing `video-room:{roomId}:…` hash-tag convention, Cluster-safe single-key ops):

| Key builder | Value | Purpose |
|---|---|---|
| `videoRoomSeatStateKey(roomId)` = `video-room:{roomId}:seats` | JSON | Authoritative versioned seat snapshot |
| `videoRoomSeatLockKey(roomId)` = `video-room:seat:{roomId}` | lock | Serializes all seat mutations for a room |
| `videoRoomSeatReservationKey(roomId, i)` = `video-room:{roomId}:seat:{i}:hold` | userId + TTL | Reservation hold auto-reaped by the monitor |

Snapshot shape (`SeatStageSnapshot`): `{ roomId, version, updatedAt, hostSeatCount, guestSeatCount,
seats: SeatEntry[] }` where `SeatEntry = { seatIndex, seatType, status, occupantUserId,
reservedForUserId, isLocked, isMuted, isVideoOn, reason?, invitedUserId?, requestedBy?[] }`.

## 6. Brief -> schema mappings (why zero migration works)

**Seat states — brief's 8 modeled on stored 4 + derived overlays** (client sees all 8 via a computed
`displayStatus`):

| Brief state | Representation (no new enum values) |
|---|---|
| EMPTY / OCCUPIED / LOCKED / RESERVED | Stored `VideoRoomSeatStatus` values |
| INVITED | Seat held `RESERVED` + PENDING `video_room_invitations` row -> overlay `invitedUserId` |
| REQUESTED | Seat appears in a PENDING `video_room_seat_requests` row -> overlay `requestedBy[]` |
| DISABLED | `isLocked=true` + `metadata.reason='disabled'` |
| MAINTENANCE | `isLocked=true` + `metadata.reason='maintenance'` |

**Seat "types" — brief's 6 = physical kind × occupant role** (physical `VideoRoomSeatType` stays
OWNER/HOST/GUEST):

| Brief "type" | Representation |
|---|---|
| Owner Seat | seatIndex 0, `seatType=OWNER` (protected) |
| Admin Seat | HOST seat whose occupant holds an ADMIN grant (`video_room_roles`) |
| Speaker Seat | HOST seat (publishing-capable) — occupant resolves to HOST |
| Participant Seat | GUEST seat — occupant resolves to PARTICIPANT |
| Premium Seat | HOST/GUEST seat flagged `metadata.premium=true` |
| Reserved Seat | any seat currently in `RESERVED` status |

## 7. Seat state machine (`constants/video-room-seat-lifecycle.ts`)

Single `SEAT_TRANSITIONS` source of truth (mirrors `video-room-lifecycle.ts`). Legal edges:

```
EMPTY     -> OCCUPIED (take / accept-invite / approve-request), RESERVED (reserve / invite-hold), LOCKED (lock/disable/maintenance)
RESERVED  -> OCCUPIED (holder takes), EMPTY (cancel / expire), LOCKED (lock)
OCCUPIED  -> EMPTY (leave / remove / kick), OCCUPIED (switch / transfer — occupant changes), LOCKED (lock while occupied -> forces vacate)
LOCKED    -> EMPTY (unlock)
```

Owner seat (index 0) excluded from LOCK / RESERVE / foreign-OCCUPY; reassigned only by ownership transfer.

## 8. Permission integration (extend, don't replace)

Complete `VideoRoomPermissionService.resolveEffectiveRole` with the seat-derived tier the existing
code already anticipates (safe: HOST/PARTICIPANT map to empty permission sets):

```
OWNER (room.ownerId) -> grant ADMIN/MODERATOR (video_room_roles)
  -> HOST (occupies a HOST seat) -> PARTICIPANT (occupies a GUEST seat)
  -> VIEWER (active member) -> null
```

Seat verbs check existing `MANAGE_SEATS` / `MANAGE_PARTICIPANTS`. Self-service verbs (request, accept/
reject own invite, take/leave/switch own seat) require active membership only. Force-transfer / remove
require the actor to outrank the target (authority rank). Nothing hardcoded — all matrix-driven.

## 9. Operations -> services

**VideoRoomSeatService (occupancy):** `getStage` (any member); `takeSeat` (self; blocked if room
requires approval -> must request); `leaveSeat` (self); `lockSeat`/`unlockSeat` and bulk
`lockSeats`/`unlockSeats` (MANAGE_SEATS; `metadata.reason` carries disable/maintenance);
`switchSeat(toIndex)` (self, atomic); `transferSeat(userId, fromIndex?, toIndex, force?)` and
`removeFromSeat` (MANAGE_PARTICIPANTS, outrank guard); `configureLayout(hostSeatCount, guestSeatCount)`
(MANAGE_SEATS; reconcile settings + seat rows; displaced occupants vacated).

**VideoRoomSeatReservationService:** `reserve(seatIndex, forUserId, ttl?)` -> RESERVED + Redis hold;
`cancelReservation`; auto-release on TTL via monitor.

**VideoRoomSeatRequestService:** `request` (dedupe one PENDING/user), `cancelRequest`, `approve`
(seats them), `reject`; `listRequests` ordered by read-time priority (owner-affinity -> role rank ->
VIP -> FIFO).

**VideoRoomSeatInvitationService:** `invite` (optionally reserves the seat -> INVITED), `accept`
(-> OCCUPIED), `reject`, `cancel`; one active invite per (room, invitee, seat).

Owner-seat rules enforced centrally: index 0 always exists; cannot be locked/reserved/occupied-by-
another/removed; only `TRANSFER_OWNERSHIP` (existing lifecycle) reassigns it.

## 10. REST API surface (`@Controller('video-rooms')`, JWT-guarded; in-room checks in services)

```
GET    video-rooms/:id/seats
POST   video-rooms/:id/seats/reserve            { seatIndex, forUserId, ttlSeconds? }
DELETE video-rooms/:id/seats/reserve            { seatIndex }
POST   video-rooms/:id/seats/request            { seatIndex? }                 @NotGuest
DELETE video-rooms/:id/seats/request            (cancel own)
POST   video-rooms/:id/seats/request/:reqId/approve | /reject
POST   video-rooms/:id/seats/invite             { inviteeUserId, seatIndex? }
POST   video-rooms/:id/seats/invite/accept | /reject   { invitationId }        @NotGuest (accept)
POST   video-rooms/:id/seats/lock | /unlock     { seatIndexes: number[] }      (bulk-capable)
POST   video-rooms/:id/seats/switch             { toSeatIndex }                 @NotGuest
POST   video-rooms/:id/seats/transfer           { userId, fromSeatIndex?, toSeatIndex, force? }
```

Every route fully Swagger-documented (auth, permission, validation, examples, status codes) per the
existing controllers.

## 11. DTOs & exceptions

- **DTOs** (`dto/seat.dto.ts`, extend existing): `ReserveSeatDto`, `CancelReservationDto`,
  `SeatRequestDto` (exists as `CreateSeatRequestDto`), `ResolveSeatRequestDto`, `SeatInvitationDto`
  (exists), `AcceptSeatInvitationDto`, `RejectSeatInvitationDto`, `LockSeatsDto`, `UnlockSeatsDto`,
  `SwitchSeatDto`, `TransferSeatDto`. Responses reuse `VideoRoomSeatView` + a new `SeatStageView`
  (`seats[]` + `version` + overlays).
- **Exceptions:** platform convention — `BusinessException(code, msg, httpStatus)` + `ERROR_CODES`
  (not bespoke classes). Most `SEAT_*` codes exist; add gaps: `SEAT_RESERVED`, `SEAT_REQUEST_EXPIRED`,
  `SEAT_SWITCH_INVALID`, `SEAT_TRANSFER_INVALID`, `DUPLICATE_SEAT_INVITATION`, `DUPLICATE_SEAT_REQUEST`.

## 12. Events, audit, metrics, scheduler

- **EVENT_BUS (`video-room-seat.events.ts`):** `SeatTakenEvent`, `SeatLeftEvent`, `SeatLockedEvent`,
  `SeatUnlockedEvent`, `SeatReservedEvent`, `SeatReleasedEvent`, `SeatRequestedEvent`,
  `SeatRequestResolvedEvent`, `SeatInvitationSentEvent`, `SeatInvitationResolvedEvent`,
  `SeatSwitchedEvent`, `SeatTransferredEvent`, `SeatUpdatedEvent`, `SeatSyncEvent`.
- **Socket (`VideoRoomSeatSocketListener` + new `VIDEO_ROOM_SOCKET_EVENTS`):** `video_room.seat_sync`,
  `…seat_locked`, `…seat_unlocked`, `…seat_reserved`, `…seat_released`, `…seat_requested`,
  `…seat_approved`, `…seat_rejected`, `…seat_invitation_sent`, `…seat_invitation_accepted`,
  `…seat_invitation_rejected`, `…seat_switched`, `…seat_transferred`, `…seat_updated`. Services never
  touch sockets — bus -> listener -> broadcast.
- **Audit:** every mutation appends `video_room_events` via `VideoRoomEventService` with
  `{roomId, seatId, seatIndex, actorId, targetUserId, action, requestId, ip}` in the payload
  (IP + requestId threaded from the controller). Immutable; satisfies the brief's audit fields, no new table.
- **Metrics (extend `VideoRoomsMetrics`):** gauges `video_rooms_seats_occupied/empty/locked`; counters
  `…_seat_requests/invitations/transfers/switches/reservation_timeouts_total`; histograms
  `…_seat_op_latency_seconds`, `…_seat_redis_sync_seconds`.
- **Scheduler:** extend `VideoRoomSessionMonitor` swept work — `expireStaleRequests` /
  `expireStaleInvitations` + reap reservation holds, publishing `SeatReleased` /
  `SeatRequestResolved(EXPIRED)` so clients stay synced. Fleet-safe via the existing monitor lock.

## 13. Module wiring & file plan

Register new services / listeners / controller in `video-rooms.module.ts` (providers + controllers).
No new module. ~14 new files + ~5 extended, each with a colocated `.spec.ts`.

## 14. Testing plan (TDD)

Unit specs per service: state-machine transitions, occupancy invariants (one seat/user, no duplicate
occupancy), owner-seat protection, request dedupe + read-time priority ordering, reservation expiry,
invitation accept/reject/expire, switch/transfer outranking, layout reconcile displacement. Plus:
socket-listener bridge spec, controller spec, permission-resolution spec. Bar: comprehensive coverage,
zero regressions, ESLint + `boundaries` + `tsc` clean (the Phase 0–3 standard).

## 15. Learning-mode contribution points (during implementation)

Two genuine business-logic forks will be scaffolded (signature + TODO) for the user to implement:
1. **Read-time request-priority comparator** — owner-affinity vs role rank vs VIP vs FIFO.
2. **`SEAT_TRANSITIONS` legality table** — which edges are permitted.

## 16. Non-goals / explicit exclusions

Everything in the brief's "DO NOT IMPLEMENT" list (camera, mic, video publish/playback, viewer mode,
beauty filters, chat, gifts, treasure boxes, wallet, PK, moderation actions, notifications, analytics
processing, recording). Also: no new Prisma tables, no new module, no priority-queue table, no bespoke
exception classes.
