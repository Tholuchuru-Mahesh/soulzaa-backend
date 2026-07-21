# Video Room Phase 8 (VR-8) — Seat Request & Invitation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the video-room seat request/invitation workflow with a Redis-projected priority queue, the missing terminal states, retry/restore, event-emitting expiry, the missing REST surface, validations, and metrics.

**Architecture:** A *completion* phase over VR-4's existing seat request/invitation services — no new module, no parallel seat stack. The ordered queue is a rebuildable Redis ZSET projection over PostgreSQL (which stays the record of truth). Auto-advance is driven by a listener reacting to seat lifecycle events, never inline in `VideoRoomSeatService`. All seating flows through the existing locked `VideoRoomSeatService.seatUser` / `vacateUser` pipeline, and all client updates flow EventBus → SocketListener.

**Tech Stack:** NestJS 10, Prisma (PostgreSQL), ioredis via `CacheService`/`LockService`, `prom-client`, Jest, Socket.IO via `SocketManager`.

**Spec:** [`docs/superpowers/specs/2026-07-21-video-room-phase8-seat-request-invitation-workflow-design.md`](../specs/2026-07-21-video-room-phase8-seat-request-invitation-workflow-design.md)

## Global Constraints

- **NO git commits, NO git pushes, NO branches.** Working tree only. Every task ends with a *verification* step instead of a commit. This overrides the usual "commit frequently" guidance.
- **Schema changes are additive only.** New enum values and new nullable/defaulted columns. No renames, no dropped columns, no data migration. Schema lives in `prisma/schema/video_rooms_seats.prisma` and `prisma/schema/video_rooms.prisma`.
- **Errors use `BusinessException(ERROR_CODES.X, message, HttpStatus.Y)`.** Do NOT create bespoke exception classes (`SeatRequestException`, etc.) — the platform convention across VR-0…VR-7 is `BusinessException` + a code in `src/common/exceptions/error-codes.ts`.
- **No service emits to sockets directly.** Services publish domain events on `EVENT_BUS`; `VideoRoomSeatSocketListener` bridges to Socket.IO.
- **No new database tables.** The queue is Redis-only and rebuildable.
- **No new Redis primitives.** Everything needed already exists on `CacheService` (see the op table in spec §6.1).
- **Reuse, do not reimplement:** `VideoRoomSeatService.seatUser` / `vacateUser` / `findOpenSeat` / `requireLiveRoom`, `VideoRoomPermissionService.assertPermission`, `VideoRoomViewerService.promote` / `demote`, `VideoRoomModerationRepository.findActiveBlock`, `VideoRoomEventsRepository.appendEvent`.
- **REST convention is `/video-rooms/:id/...`** (plural, param named `id`) — NOT the brief's `/video-room/:roomId`. Match the existing controller.
- **Test style:** plain constructor injection with a `deps` object of `jest.fn()` mocks. No `Test.createTestingModule`. Match `video-room-seat-request.service.spec.ts`.
- **Verification commands:** `npx jest <path>` (single suite), `npx tsc --noEmit` (types), `npm run lint` (eslint, `--max-warnings 0`).

## File Structure

**Create (7)**

| File | Responsibility |
|---|---|
| `src/modules/video-rooms/constants/video-room-seat-queue.ts` | Pure queue policy: `computeQueueScore`, fairness cap, Redis key builders |
| `src/modules/video-rooms/constants/video-room-seat-queue.spec.ts` | Tests for the pure policy |
| `src/modules/video-rooms/services/video-room-seat-queue.service.ts` | ZSET projection: enqueue/dequeue/position/list/size/clear/rebuild/advance |
| `src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts` | Queue service tests |
| `src/modules/video-rooms/listeners/video-room-seat-queue.listener.ts` | Auto-advance + dequeue driven by seat/room lifecycle events |
| `src/modules/video-rooms/listeners/video-room-seat-queue.listener.spec.ts` | Listener tests |
| `src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.ts` (+ `.spec.ts`) | Workflow metrics, decoupled from services |
| `src/modules/video-rooms/dto/seat-queue.dto.ts` (+ `.spec.ts`) | VR-8 DTOs |

**Modify (11)**

`prisma/schema/video_rooms_seats.prisma`, `prisma/schema/video_rooms.prisma`, `src/common/exceptions/error-codes.ts`, `src/modules/video-rooms/constants/video-room.constants.ts`, `src/modules/video-rooms/events/video-room-seat.events.ts`, `src/modules/video-rooms/repositories/video-room-seats.repository.ts`, `src/modules/video-rooms/services/video-room-seat-request.service.ts`, `src/modules/video-rooms/services/video-room-seat-invitation.service.ts`, `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts`, `src/modules/video-rooms/scheduler/video-room-seat.monitor.ts`, `src/modules/video-rooms/video-rooms.metrics.ts`, `src/modules/video-rooms/controllers/video-rooms-seats.controller.ts`, `src/modules/video-rooms/video-rooms.module.ts`, plus barrel files (`constants/index.ts`, `services/index.ts`, `listeners/index.ts`, `dto/index.ts`).

## Task List

| # | Task | Deliverable |
|---|---|---|
| 1 | Schema, error codes, constants | Additive Prisma changes + generated client + 3 error codes + VR-8 constants |
| 2 | `computeQueueScore` pure policy | Tested scoring function |
| 3 | Domain events + socket event names | 4 event classes, widened unions, 6 socket names |
| 4 | Repository extensions | Bounded expiry queries, attempt/error persistence, restore, ack |
| 5 | `VideoRoomSeatQueueService` core | enqueue/dequeue/position/list/size/clear/rebuild |
| 6 | `VideoRoomSeatQueueService.advance` | Auto-advance with fairness skip accounting |
| 7 | Request state-machine guard + validations | Transition table + 7 new validations |
| 8 | Request service: queue + PROMOTED/FAILED/retry/restore/update | Full request workflow |
| 9 | Invitation service: validations + DELIVERED/FAILED/retry/cancel | Full invitation workflow |
| 10 | `VideoRoomSeatQueueListener` | Auto-advance wiring |
| 11 | Socket listener: exhaustive status map + 6 new events | **Fixes the mislabeling bug** |
| 12 | Expiry monitor: per-row events | Clients learn about expiry |
| 13 | Metrics + workflow metrics listener | 5 new metrics |
| 14 | DTOs | 9 DTOs with validation + Swagger |
| 15 | Controller: 8 new routes | Full REST surface, Swagger-documented |
| 16 | Module wiring + full verification | DI complete, whole suite green |

---

### Task 1: Schema, error codes, and VR-8 constants

**Files:**
- Modify: `prisma/schema/video_rooms_seats.prisma`
- Modify: `prisma/schema/video_rooms.prisma`
- Modify: `src/common/exceptions/error-codes.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: enum values `VideoRoomSeatRequestStatus.PROMOTED`, `.FAILED`; `VideoRoomInvitationStatus.DELIVERED`, `.FAILED`; columns `attemptCount`/`lastError` on both tables, `deliveredAt` on invitations, `seatApprovalRequired` on `VideoRoomSettings`; error codes `SEAT_REQUEST_INVALID_TRANSITION`, `SEAT_INVITATION_INVALID_TRANSITION`, `SEAT_RETRY_EXHAUSTED`; constants `VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS`, `VIDEO_ROOM_INVITATION_MAX_ATTEMPTS`, `VIDEO_ROOM_QUEUE_PREVIEW_LIMIT`, `VIDEO_ROOM_EXPIRY_SWEEP_LIMIT`, `VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS`

- [ ] **Step 1: Add the two new request statuses and two new invitation statuses**

In `prisma/schema/video_rooms_seats.prisma`, replace the two status enums (currently at lines ~37-43 and ~53-59):

```prisma
/// Lifecycle of a seat request. PENDING is the brief's "SENT"; ACCEPTED is the
/// brief's "APPROVED" (decision made, seating in flight). PROMOTED and FAILED
/// are the VR-8 terminal outcomes of the seating attempt itself.
enum VideoRoomSeatRequestStatus {
  PENDING
  ACCEPTED
  REJECTED
  CANCELLED
  EXPIRED
  PROMOTED
  FAILED
}

/// Lifecycle of an invitation. PENDING is the brief's "SENT"; DELIVERED means the
/// invitee's client acknowledged receipt; FAILED means seating threw on accept.
enum VideoRoomInvitationStatus {
  PENDING
  DELIVERED
  ACCEPTED
  REJECTED
  EXPIRED
  CANCELLED
  FAILED
}
```

- [ ] **Step 2: Add the retry/audit columns to both workflow tables**

In the same file, inside `model VideoRoomSeatRequest`, add after the `expiresAt` line:

```prisma
  /// VR-8 — how many seating attempts this request has consumed (bounds retry).
  attemptCount Int     @default(0)
  /// VR-8 — why the last seating attempt failed, surfaced to the retry UI.
  lastError    String?
```

Inside `model VideoRoomInvitation`, add after the `resolvedAt` line:

```prisma
  /// VR-8 — how many seating attempts this invitation has consumed.
  attemptCount Int       @default(0)
  /// VR-8 — why the last seating attempt failed.
  lastError    String?
  /// VR-8 — when the invitee's client acknowledged receipt (status DELIVERED).
  deliveredAt  DateTime?
```

- [ ] **Step 3: Add the auto-advance toggle to room settings**

In `prisma/schema/video_rooms.prisma`, inside `model VideoRoomSettings`, add immediately after the `guestSeatCount` line:

```prisma
  /// VR-8 — when true (default) a freed seat waits for owner/admin approval;
  /// when false the front of the seat queue is auto-promoted onto it.
  seatApprovalRequired Boolean  @default(true)
```

- [ ] **Step 4: Regenerate the Prisma client and confirm the new types exist**

Run:

```bash
npx prisma generate
```

Expected: `Generated Prisma Client` success message.

Then verify the new enum members are actually on the generated types:

```bash
node -e "const{VideoRoomSeatRequestStatus:R,VideoRoomInvitationStatus:I}=require('@prisma/client');console.log(R.PROMOTED,R.FAILED,I.DELIVERED,I.FAILED)"
```

Expected output: `PROMOTED FAILED DELIVERED FAILED`

If this prints `undefined`, the schema edit did not take — re-check Step 1 before continuing.

- [ ] **Step 5: Add the three new error codes**

In `src/common/exceptions/error-codes.ts`, add next to the existing `SEAT_REQUEST_EXPIRED` entry (~line 82):

```ts
  /** VR-8 — a seat-request status transition that the state machine forbids. */
  SEAT_REQUEST_INVALID_TRANSITION: 'SEAT_REQUEST_INVALID_TRANSITION',
  /** VR-8 — an invitation status transition that the state machine forbids. */
  SEAT_INVITATION_INVALID_TRANSITION: 'SEAT_INVITATION_INVALID_TRANSITION',
  /** VR-8 — retry refused: attemptCount has reached the configured maximum. */
  SEAT_RETRY_EXHAUSTED: 'SEAT_RETRY_EXHAUSTED',
```

Do NOT add codes that already exist — `QUEUE_ENTRY_NOT_FOUND`, `VIDEO_ROOM_CAPACITY_EXCEEDED`, `VIDEO_ROOM_BLOCKED`, `VIDEO_ROOM_PROMOTION_FAILED`, `VIDEO_ROOM_DEMOTION_FAILED`, `DUPLICATE_SEAT_REQUEST`, `DUPLICATE_SEAT_INVITATION`, `SEAT_LOCKED`, `SEAT_RESERVED`, `ALREADY_ON_SEAT`, `SEAT_REQUEST_EXPIRED`, `SEAT_INVITATION_EXPIRED`, `SEAT_TAKEN`, `SEAT_NOT_FOUND` are all already present.

- [ ] **Step 6: Add the VR-8 constants**

In `src/modules/video-rooms/constants/video-room.constants.ts`, append after the existing `VIDEO_ROOM_RESERVATION_TTL_SECONDS` block (~line 260):

```ts
// ============================================================
// VR-8 — seat request / invitation workflow + queue bounds.
// ============================================================

/** Max seating attempts for one seat request before retry is refused. */
export const VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS = 3;
/** Max seating attempts for one invitation before retry is refused. */
export const VIDEO_ROOM_INVITATION_MAX_ATTEMPTS = 3;
/** How many queue entries ride along in a `seat_queue_updated` broadcast. */
export const VIDEO_ROOM_QUEUE_PREVIEW_LIMIT = 20;
/** Upper bound on rows expired per monitor sweep (per collection). */
export const VIDEO_ROOM_EXPIRY_SWEEP_LIMIT = 500;
/** TTL (seconds) on the Redis queue projection; refreshed on every write. */
export const VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS = 6 * 60 * 60;
```

Then add the queue-advance lock key helper, next to the existing
`videoRoomSeatLockKey` (~line 175):

```ts
/**
 * Serializes queue *advancement* for a room. Deliberately DISTINCT from
 * `videoRoomSeatLockKey`: `advance` calls `VideoRoomSeatService.seatUser`, which
 * takes the seat lock itself, and `LockService` is NOT re-entrant (`SET NX`) —
 * reusing the seat key here would make every auto-advance retry 20× and throw.
 */
export function videoRoomSeatQueueLockKey(roomId: string): string {
  return `video-room:seatq:lock:{${roomId}}`;
}
```

> **Hash tags are mandatory.** All three keys embed `{roomId}` in Redis
> Cluster hash-tag braces, matching `videoRoomSeatLockKey`'s
> `video-room:seat:{roomId}`. This is not cosmetic: `clear()` calls
> `cache.del(queueKey, skipsKey)`, which is a **multi-key** command, and
> `CacheService`'s own docblock warns that callers "must hash-tag them into a
> single slot". Without the braces that call throws `CROSSSLOT` on a clustered
> Redis — and never on a single-node dev instance, so it would ship green.

- [ ] **Step 7: Verify types still compile**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output. The new enum values are additive, so no existing `switch` or comparison breaks.

---

### Task 2: `computeQueueScore` — the pure queue policy

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-seat-queue.ts`
- Test: `src/modules/video-rooms/constants/video-room-seat-queue.spec.ts`
- Modify: `src/modules/video-rooms/constants/index.ts`

**Interfaces:**
- Consumes: `VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS` (Task 1)
- Produces:
  - `QUEUE_FAIRNESS_SKIP_CAP: number`
  - `interface QueueScoreInput { vipLevel: number; createdAt: Date; skipCount: number }`
  - `computeQueueScore(input: QueueScoreInput): number`
  - `videoRoomSeatQueueKey(roomId: string): string`
  - `videoRoomSeatQueueSkipsKey(roomId: string): string`

> **Design note for the implementer.** Lower score sorts first — this matches `CacheService.sortedRank` / `sortedLowest`, which are ascending (`ZRANK` / `ZRANGE`). The function must be **pure**: no `Date.now()`, no I/O, no randomness. Everything it needs arrives in `input`. This is what makes queue policy a one-file change and lets the tests below run without any mocks.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/constants/video-room-seat-queue.spec.ts`:

```ts
import {
  QUEUE_FAIRNESS_SKIP_CAP,
  computeQueueScore,
  videoRoomSeatQueueKey,
  videoRoomSeatQueueSkipsKey,
} from './video-room-seat-queue';

const at = (iso: string) => new Date(iso);

describe('computeQueueScore', () => {
  it('orders earlier requests first when VIP level and skips are equal', () => {
    const early = computeQueueScore({ vipLevel: 0, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 0 });
    const late = computeQueueScore({ vipLevel: 0, createdAt: at('2026-07-21T10:05:00Z'), skipCount: 0 });
    expect(early).toBeLessThan(late);
  });

  it('orders a higher VIP level ahead of an earlier non-VIP request', () => {
    const vip = computeQueueScore({ vipLevel: 3, createdAt: at('2026-07-21T10:05:00Z'), skipCount: 0 });
    const free = computeQueueScore({ vipLevel: 0, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 0 });
    expect(vip).toBeLessThan(free);
  });

  it('orders a higher VIP level ahead of a lower VIP level', () => {
    const titan = computeQueueScore({ vipLevel: 7, createdAt: at('2026-07-21T10:09:00Z'), skipCount: 0 });
    const bronze = computeQueueScore({ vipLevel: 1, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 0 });
    expect(titan).toBeLessThan(bronze);
  });

  it('breaks VIP ties on arrival time', () => {
    const first = computeQueueScore({ vipLevel: 2, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 0 });
    const second = computeQueueScore({ vipLevel: 2, createdAt: at('2026-07-21T10:00:01Z'), skipCount: 0 });
    expect(first).toBeLessThan(second);
  });

  it('pins an entry at the fairness cap ahead of the highest VIP', () => {
    const starved = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: QUEUE_FAIRNESS_SKIP_CAP,
    });
    const titan = computeQueueScore({ vipLevel: 7, createdAt: at('2026-07-21T09:00:00Z'), skipCount: 0 });
    expect(starved).toBeLessThan(titan);
  });

  it('does not pin an entry one skip below the cap', () => {
    const nearlyStarved = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: QUEUE_FAIRNESS_SKIP_CAP - 1,
    });
    const titan = computeQueueScore({ vipLevel: 7, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 0 });
    expect(titan).toBeLessThan(nearlyStarved);
  });

  it('orders two pinned entries among themselves by arrival time', () => {
    const older = computeQueueScore({ vipLevel: 0, createdAt: at('2026-07-21T10:00:00Z'), skipCount: QUEUE_FAIRNESS_SKIP_CAP });
    const newer = computeQueueScore({ vipLevel: 0, createdAt: at('2026-07-21T10:01:00Z'), skipCount: QUEUE_FAIRNESS_SKIP_CAP + 5 });
    expect(older).toBeLessThan(newer);
  });

  it('is pure — the same input always yields the same score', () => {
    const input = { vipLevel: 4, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 1 };
    expect(computeQueueScore(input)).toBe(computeQueueScore(input));
  });

  it('produces a finite, safe-integer-range score', () => {
    const score = computeQueueScore({ vipLevel: 0, createdAt: at('2099-12-31T23:59:59Z'), skipCount: 0 });
    expect(Number.isFinite(score)).toBe(true);
    expect(Math.abs(score)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('queue keys', () => {
  it('namespaces the queue and skip keys per room', () => {
    expect(videoRoomSeatQueueKey('room-1')).toBe('video-room:seatq:{room-1}');
    expect(videoRoomSeatQueueSkipsKey('room-1')).toBe('video-room:seatq:{room-1}:skips');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/constants/video-room-seat-queue.spec.ts`

Expected: FAIL — `Cannot find module './video-room-seat-queue'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/video-rooms/constants/video-room-seat-queue.ts`:

```ts
/**
 * VR-8 — seat queue policy and Redis key layout.
 *
 * The queue itself is a Redis ZSET projection over the PENDING rows in
 * `video_room_seat_requests` (Postgres stays the record of truth). This file
 * holds the ONLY place queue ordering is decided, deliberately as a pure
 * function: no clock read, no I/O, no DI. Change the precedence here and the
 * whole product's queue policy changes, with unit tests that need no mocks.
 *
 * Lower score sorts first, matching the ascending `CacheService.sortedRank` /
 * `sortedLowest` (ZRANK / ZRANGE) primitives the queue service uses.
 */

/**
 * How many times an entry may be passed over before it is pinned to the front,
 * ahead of every VIP. Without this, a steady trickle of VIP requests starves
 * regular viewers indefinitely.
 */
export const QUEUE_FAIRNESS_SKIP_CAP = 3;

/** Highest VIP ordinal the platform issues (VipLevel NONE=0 … TITAN=7). */
const MAX_VIP_ORDINAL = 7;

/**
 * Weight of one VIP tier, in "milliseconds of queue advantage". Far larger than
 * any plausible queue age, so a VIP always outranks a non-VIP regardless of
 * arrival time — while still leaving arrival time as the tie-breaker within a
 * tier. 1e12 ms ≈ 31.7 years.
 */
const VIP_TIER_WEIGHT = 1e12;

/** Band offset applied to entries at the fairness cap, pulling them below every VIP band. */
const PINNED_BAND = -((MAX_VIP_ORDINAL + 1) * VIP_TIER_WEIGHT);

export interface QueueScoreInput {
  /** VIP tier ordinal; 0 when the user has no VIP. */
  vipLevel: number;
  /** Original request time — preserved across restore so position survives a reconnect. */
  createdAt: Date;
  /** How many times this entry has been passed over by `advance`. */
  skipCount: number;
}

/**
 * Queue score — lower sorts first. Precedence:
 *   1. an entry at/past `QUEUE_FAIRNESS_SKIP_CAP` is pinned ahead of everything
 *   2. otherwise a higher `vipLevel` sorts first
 *   3. ties break on earlier `createdAt`
 */
export function computeQueueScore(input: QueueScoreInput): number {
  const { vipLevel, createdAt, skipCount } = input;

  // Defend against non-finite or invalid createdAt
  const arrivalTime = createdAt.getTime();
  const arrival = Number.isFinite(arrivalTime) ? arrivalTime : 0;

  if (skipCount >= QUEUE_FAIRNESS_SKIP_CAP) {
    // Pinned band: ordered among themselves by arrival, always below VIP bands.
    return PINNED_BAND + arrival;
  }

  // Defend against non-finite vipLevel and floor fractional values
  const safeVipLevel = Number.isFinite(vipLevel) ? Math.floor(vipLevel) : 0;
  const tier = Math.min(Math.max(safeVipLevel, 0), MAX_VIP_ORDINAL);
  return (MAX_VIP_ORDINAL - tier) * VIP_TIER_WEIGHT + arrival;
}

// NOTE (applied during execution, user-approved): the arrival/vipLevel guards above
// were added after review. A NaN reaching Redis as a ZSET score is accepted silently
// and sorts unpredictably forever. Valid inputs are unaffected — Math.floor(n) === n
// for integers — so the 10 original tests pass unchanged; 3 degenerate-case tests added.

/**
 * ZSET of userId → queue score for a room's pending seat requests.
 * `{roomId}` is a Redis Cluster hash tag so this key and the skips key below
 * land in the same slot — `clear()` deletes both in one multi-key call.
 */
export function videoRoomSeatQueueKey(roomId: string): string {
  return `video-room:seatq:{${roomId}}`;
}

/**
 * ZSET of userId → skip count. A ZSET rather than a hash because `CacheService`
 * exposes no hash operations; `addScore` (ZINCRBY) increments and `score`
 * (ZSCORE) reads.
 */
export function videoRoomSeatQueueSkipsKey(roomId: string): string {
  return `video-room:seatq:{${roomId}}:skips`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/constants/video-room-seat-queue.spec.ts`

Expected: PASS — 13 tests (10 policy + 3 degenerate-input guards).

- [ ] **Step 5: Export from the constants barrel**

In `src/modules/video-rooms/constants/index.ts`, add alongside the existing exports:

```ts
export * from './video-room-seat-queue';
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/constants`

Expected: tsc silent (exit 0); all constants suites pass.

---

### Task 3: Domain events and socket event names

**Files:**
- Modify: `src/modules/video-rooms/events/video-room-seat.events.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts`
- Test: `src/modules/video-rooms/events/video-room-seat.events.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `DomainEvent` from `src/common/events`
- Produces:
  - `VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED`, `.INVITATION_EXPIRED`, `.INVITATION_DELIVERED`, `.QUEUE_UPDATED`
  - `SeatRequestExpiredEvent`, `SeatInvitationExpiredEvent`, `SeatInvitationDeliveredEvent`, `SeatQueueUpdatedEvent`
  - widened `SeatRequestResolution = 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'PROMOTED' | 'FAILED'`
  - widened `SeatInvitationResolution = 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED'`
  - `interface QueuePreviewEntry { userId: string; position: number; vipLevel: number }`
  - socket names `SEAT_REQUEST_CANCELLED`, `SEAT_REQUEST_EXPIRED`, `SEAT_INVITATION_CANCELLED`, `SEAT_INVITATION_EXPIRED`, `SEAT_INVITATION_DELIVERED`, `SEAT_QUEUE_UPDATED`

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/events/video-room-seat.events.spec.ts`:

```ts
import {
  SeatInvitationDeliveredEvent,
  SeatInvitationExpiredEvent,
  SeatQueueUpdatedEvent,
  SeatRequestExpiredEvent,
  VIDEO_ROOM_SEAT_EVENTS,
} from './video-room-seat.events';

describe('VR-8 seat workflow events', () => {
  it('names the four new event types', () => {
    expect(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED).toBe('video_room.seat_request_expired');
    expect(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED).toBe('video_room.seat_invitation_expired');
    expect(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED).toBe('video_room.seat_invitation_delivered');
    expect(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED).toBe('video_room.seat_queue_updated');
  });

  it('carries the request id and user on an expiry event', () => {
    const e = new SeatRequestExpiredEvent({ roomId: 'r1', requestId: 'q1', userId: 'u1' });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED);
    expect(e.payload).toEqual({ roomId: 'r1', requestId: 'q1', userId: 'u1' });
  });

  it('carries the invitation id and invitee on an invitation expiry event', () => {
    const e = new SeatInvitationExpiredEvent({ roomId: 'r1', invitationId: 'i1', inviteeUserId: 'u2' });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED);
    expect(e.payload.inviteeUserId).toBe('u2');
  });

  it('carries the delivery timestamp on a delivered event', () => {
    const e = new SeatInvitationDeliveredEvent({
      roomId: 'r1',
      invitationId: 'i1',
      inviteeUserId: 'u2',
      deliveredAt: '2026-07-21T10:00:00.000Z',
    });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED);
    expect(e.payload.deliveredAt).toBe('2026-07-21T10:00:00.000Z');
  });

  it('carries size and a bounded preview on a queue update', () => {
    const e = new SeatQueueUpdatedEvent({
      roomId: 'r1',
      size: 42,
      top: [{ userId: 'u1', position: 1, vipLevel: 3 }],
    });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED);
    expect(e.payload.size).toBe(42);
    expect(e.payload.top).toHaveLength(1);
    expect(e.payload.top[0].position).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room-seat.events.spec.ts`

Expected: FAIL — `SeatRequestExpiredEvent is not a constructor` / export not found.

- [ ] **Step 3: Add the event names and widen the unions**

In `src/modules/video-rooms/events/video-room-seat.events.ts`, add to the `VIDEO_ROOM_SEAT_EVENTS` object (after `SYNC`):

```ts
  REQUEST_EXPIRED: 'video_room.seat_request_expired',
  INVITATION_EXPIRED: 'video_room.seat_invitation_expired',
  INVITATION_DELIVERED: 'video_room.seat_invitation_delivered',
  QUEUE_UPDATED: 'video_room.seat_queue_updated',
```

Then replace the two resolution unions:

```ts
export type SeatRequestResolution =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PROMOTED'
  | 'FAILED';
export type SeatInvitationResolution =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';
```

- [ ] **Step 4: Add the four event classes**

Append to the same file:

```ts
/** One row in the bounded queue preview carried by `SeatQueueUpdatedEvent`. */
export interface QueuePreviewEntry {
  userId: string;
  /** 1-based position in the queue. */
  position: number;
  vipLevel: number;
}

/** A PENDING seat request passed its TTL and was expired by the monitor sweep. */
export class SeatRequestExpiredEvent extends DomainEvent<{
  roomId: string;
  requestId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED;
}

/** A PENDING/DELIVERED invitation passed its TTL and was expired by the sweep. */
export class SeatInvitationExpiredEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviteeUserId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED;
}

/** The invitee's client acknowledged receipt of an invitation. */
export class SeatInvitationDeliveredEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviteeUserId: string;
  deliveredAt: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED;
}

/**
 * The seat queue changed (join, leave, resolve, expire, advance, re-score).
 * `top` is truncated to VIDEO_ROOM_QUEUE_PREVIEW_LIMIT — never the whole queue,
 * so a very deep queue cannot blow up a broadcast frame.
 */
export class SeatQueueUpdatedEvent extends DomainEvent<{
  roomId: string;
  size: number;
  top: QueuePreviewEntry[];
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED;
}
```

> **Match the existing shape exactly.** `DomainEvent`'s constructor is
> `(payload, meta?)` and it declares `abstract readonly name: string` — there is
> **no** `super(type, payload)` form, and `IEventBus` subscribers match on
> `.name`. Every existing event in this file is written as a bare class body with
> a single `readonly name = …` line; copy that, and let the inherited constructor
> take the payload.

- [ ] **Step 5: Add the six socket event names**

In `src/modules/video-rooms/constants/video-room.constants.ts`, inside `VIDEO_ROOM_SOCKET_EVENTS`, add after `SEAT_INVITATION_REJECTED`:

```ts
  SEAT_REQUEST_CANCELLED: 'video_room.seat_request_cancelled',
  SEAT_REQUEST_EXPIRED: 'video_room.seat_request_expired',
  SEAT_INVITATION_CANCELLED: 'video_room.seat_invitation_cancelled',
  SEAT_INVITATION_EXPIRED: 'video_room.seat_invitation_expired',
  SEAT_INVITATION_DELIVERED: 'video_room.seat_invitation_delivered',
  SEAT_QUEUE_UPDATED: 'video_room.seat_queue_updated',
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room-seat.events.spec.ts`

Expected: PASS — 5 tests.

- [ ] **Step 7: Verify nothing else broke**

Run: `npx tsc --noEmit`

Expected: exit 0. **If tsc reports an error in `video-room-seat-socket.listener.ts`**, that is expected only if the listener narrows on the resolution union — leave it for Task 11, which rewrites that file. Note the error and continue.

---

### Task 4: Repository extensions

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-room-seats.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-seats.repository.spec.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `VIDEO_ROOM_EXPIRY_SWEEP_LIMIT` (Task 1), new enum values (Task 1)
- Produces, on `VideoRoomSeatsRepository`:
  - `listExpiredRequests(now: Date, limit: number): Promise<VideoRoomSeatRequest[]>`
  - `listExpiredInvitations(now: Date, limit: number): Promise<VideoRoomInvitation[]>`
  - `setRequestStatus(id, status, actorId, resolvedBy?, opts?: { lastError?: string | null; bumpAttempt?: boolean }): Promise<VideoRoomSeatRequest>`
  - `setInvitationStatus(id, status, actorId, opts?: { lastError?: string | null; bumpAttempt?: boolean; deliveredAt?: Date }): Promise<VideoRoomInvitation>`
  - `updateRequestSeatIndex(id: string, seatIndex: number | null, actorId: string): Promise<VideoRoomSeatRequest>`
  - `restoreRequest(id: string, actorId: string, expiresAt: Date): Promise<VideoRoomSeatRequest>`
  - `findInvitationById(id: string): Promise<VideoRoomInvitation | null>` (already exists — do not duplicate)

> **Important:** `setRequestStatus` already exists with signature `(id, status, actorId, resolvedBy)`. **Extend it with a trailing optional `opts` parameter** rather than changing the existing four — every current call site must keep compiling unchanged.

- [ ] **Step 1: Write the failing tests**

Create or extend `src/modules/video-rooms/repositories/video-room-seats.repository.spec.ts`. Add this describe block (if the file exists, append it; if not, create the file with these imports plus the block):

```ts
import { VideoRoomInvitationStatus, VideoRoomSeatRequestStatus } from '@prisma/client';
import { VideoRoomSeatsRepository } from './video-room-seats.repository';

describe('VideoRoomSeatsRepository — VR-8 workflow', () => {
  let prisma: any;
  let repo: VideoRoomSeatsRepository;

  beforeEach(() => {
    prisma = {
      videoRoomSeatRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'q1' }),
      },
      videoRoomInvitation: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'i1' }),
      },
    };
    repo = new VideoRoomSeatsRepository(prisma);
  });

  it('lists expired requests bounded by the caller-supplied limit', async () => {
    const now = new Date('2026-07-21T10:00:00Z');
    await repo.listExpiredRequests(now, 500);
    expect(prisma.videoRoomSeatRequest.findMany).toHaveBeenCalledWith({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: 500,
    });
  });

  it('lists expired invitations from both PENDING and DELIVERED', async () => {
    const now = new Date('2026-07-21T10:00:00Z');
    await repo.listExpiredInvitations(now, 500);
    const arg = prisma.videoRoomInvitation.findMany.mock.calls[0][0];
    expect(arg.where.status).toEqual({
      in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED],
    });
    expect(arg.take).toBe(500);
  });

  it('records lastError and bumps attemptCount when asked', async () => {
    await repo.setRequestStatus('q1', VideoRoomSeatRequestStatus.FAILED, 'actor', 'actor', {
      lastError: 'seat taken',
      bumpAttempt: true,
    });
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'q1' });
    expect(arg.data.status).toBe(VideoRoomSeatRequestStatus.FAILED);
    expect(arg.data.lastError).toBe('seat taken');
    expect(arg.data.attemptCount).toEqual({ increment: 1 });
  });

  it('does not touch attemptCount on an ordinary status change', async () => {
    await repo.setRequestStatus('q1', VideoRoomSeatRequestStatus.REJECTED, 'actor', 'actor');
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.data.attemptCount).toBeUndefined();
    expect(arg.data.lastError).toBeUndefined();
  });

  it('stamps deliveredAt when marking an invitation DELIVERED', async () => {
    const when = new Date('2026-07-21T10:00:00Z');
    await repo.setInvitationStatus('i1', VideoRoomInvitationStatus.DELIVERED, 'u2', {
      deliveredAt: when,
    });
    const arg = prisma.videoRoomInvitation.update.mock.calls[0][0];
    expect(arg.data.deliveredAt).toBe(when);
  });

  it('updates only the preferred seat index, leaving status untouched', async () => {
    await repo.updateRequestSeatIndex('q1', 4, 'u1');
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.data.seatIndex).toBe(4);
    expect(arg.data.status).toBeUndefined();
  });

  it('restores a request to PENDING without disturbing createdAt', async () => {
    const expiresAt = new Date('2026-07-21T10:05:00Z');
    await repo.restoreRequest('q1', 'u1', expiresAt);
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.data.status).toBe(VideoRoomSeatRequestStatus.PENDING);
    expect(arg.data.expiresAt).toBe(expiresAt);
    expect(arg.data.resolvedAt).toBeNull();
    expect(arg.data.createdAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/repositories/video-room-seats.repository.spec.ts`

Expected: FAIL — `repo.listExpiredRequests is not a function`.

- [ ] **Step 3: Extend `setRequestStatus` and `setInvitationStatus` with an options parameter**

In `src/modules/video-rooms/repositories/video-room-seats.repository.ts`, first add these interfaces near the other input types at the top of the file:

```ts
/** VR-8 — optional extras when transitioning a seat request. */
export interface SetRequestStatusOptions {
  /** Failure reason to persist (null clears a previous one). */
  lastError?: string | null;
  /** Increment `attemptCount` as part of this transition. */
  bumpAttempt?: boolean;
}

/** VR-8 — optional extras when transitioning an invitation. */
export interface SetInvitationStatusOptions {
  lastError?: string | null;
  bumpAttempt?: boolean;
  /** Stamp the delivery acknowledgement time (used with status DELIVERED). */
  deliveredAt?: Date;
}
```

Then replace the body of the existing `setRequestStatus` so the new trailing parameter is optional and the existing four-argument call sites keep working:

```ts
  /**
   * Transition a seat request. VR-8 adds the optional `opts` for failure
   * bookkeeping — `lastError` and an `attemptCount` bump — so retry can be
   * bounded without a second write.
   */
  async setRequestStatus(
    id: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy?: string,
    opts?: SetRequestStatusOptions,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.update({
      where: { id },
      data: {
        status,
        resolvedBy: resolvedBy ?? null,
        resolvedAt: new Date(),
        ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
        ...(opts?.bumpAttempt ? { attemptCount: { increment: 1 } } : {}),
        ...auditUpdate(actorId),
      },
    });
  }
```

And `setInvitationStatus`:

```ts
  /**
   * Transition an invitation. VR-8 adds `opts` for the DELIVERED acknowledgement
   * stamp and for failure/retry bookkeeping.
   */
  async setInvitationStatus(
    id: string,
    status: VideoRoomInvitationStatus,
    actorId: string,
    opts?: SetInvitationStatusOptions,
  ): Promise<VideoRoomInvitation> {
    return this.prisma.videoRoomInvitation.update({
      where: { id },
      data: {
        status,
        resolvedAt: new Date(),
        ...(opts?.deliveredAt !== undefined ? { deliveredAt: opts.deliveredAt } : {}),
        ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
        ...(opts?.bumpAttempt ? { attemptCount: { increment: 1 } } : {}),
        ...auditUpdate(actorId),
      },
    });
  }
```

> Preserve whatever the existing implementations already set (e.g. `resolvedAt`); the code above is the complete replacement body, so compare against the current file and keep any field it already wrote.

- [ ] **Step 4: Add the four new methods**

Append inside the class, next to the existing `expireStaleRequests` / `expireStaleInvitations` (keep those — they remain the bulk fallback):

```ts
  /**
   * VR-8 — expired PENDING requests, bounded, oldest first. The monitor walks
   * these one at a time so each expiry can publish its own event; the bulk
   * `expireStaleRequests` stays as the fallback for oversized batches.
   */
  async listExpiredRequests(now: Date, limit: number): Promise<VideoRoomSeatRequest[]> {
    return this.prisma.videoRoomSeatRequest.findMany({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /** VR-8 — expired invitations (PENDING *or* DELIVERED), bounded, oldest first. */
  async listExpiredInvitations(now: Date, limit: number): Promise<VideoRoomInvitation[]> {
    return this.prisma.videoRoomInvitation.findMany({
      where: {
        status: {
          in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED],
        },
        expiresAt: { lt: now },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /** VR-8 — change only the preferred seat on a still-PENDING request. */
  async updateRequestSeatIndex(
    id: string,
    seatIndex: number | null,
    actorId: string,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.update({
      where: { id },
      data: { seatIndex, ...auditUpdate(actorId) },
    });
  }

  /**
   * VR-8 — revive a request to PENDING with a fresh TTL. `createdAt` is
   * deliberately NOT touched: the queue score is derived from it, so a restored
   * request re-enters at exactly its former position.
   */
  async restoreRequest(
    id: string,
    actorId: string,
    expiresAt: Date,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.update({
      where: { id },
      data: {
        status: VideoRoomSeatRequestStatus.PENDING,
        resolvedAt: null,
        resolvedBy: null,
        lastError: null,
        expiresAt,
        ...auditUpdate(actorId),
      },
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/repositories/video-room-seats.repository.spec.ts`

Expected: PASS — 7 new tests, plus any pre-existing ones in the file.

- [ ] **Step 6: Verify existing call sites still compile**

Run: `npx tsc --noEmit`

Expected: exit 0 (aside from the Task 11 socket-listener error noted in Task 3, if present). The `opts` parameter is optional, so `setRequestStatus(id, status, actorId, actorId)` calls in `video-room-seat-request.service.ts` are unaffected.

---

### Task 5: `VideoRoomSeatQueueService` — core projection

**Files:**
- Create: `src/modules/video-rooms/services/video-room-seat-queue.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`
- Modify: `src/modules/video-rooms/services/index.ts`

**Interfaces:**
- Consumes: `computeQueueScore`, `videoRoomSeatQueueKey`, `videoRoomSeatQueueSkipsKey`, `QUEUE_FAIRNESS_SKIP_CAP` (Task 2); `SeatQueueUpdatedEvent`, `QueuePreviewEntry` (Task 3); `VIDEO_ROOM_QUEUE_PREVIEW_LIMIT`, `VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS` (Task 1); `CacheService`; `VideoRoomSeatsRepository.listPendingRequests`; `VIP_SERVICE`
- Produces, on `VideoRoomSeatQueueService`:
  - `interface QueueEntryView { userId: string; position: number; vipLevel: number; score: number }`
  - `enqueue(roomId: string, userId: string, createdAt: Date): Promise<number>`
  - `dequeue(roomId: string, userId: string): Promise<void>`
  - `position(roomId: string, userId: string): Promise<number | null>`
  - `list(roomId: string, limit?: number): Promise<QueueEntryView[]>`
  - `size(roomId: string): Promise<number>`
  - `clear(roomId: string): Promise<void>`
  - `rebuild(roomId: string): Promise<number>`
  - `publishUpdate(roomId: string): Promise<void>`

> **Two things the implementer must get right.**
> 1. **Positions are 1-based on the wire, 0-based in Redis.** `CacheService.sortedRank` returns `ZRANK` (0 = front). Every public method adds 1. Returning a 0 would read as "no position" to clients.
> 2. **Rebuild-on-miss is what makes this safe.** Every read checks `cache.exists(queueKey)` first; a miss replays the PENDING rows from Postgres. Without it, a Redis failover silently empties every room's queue. The shared `deps.cache.exists` mock defaults to `true` (projection present) so the ordinary paths are not doing hidden rebuilds; the one test that exercises recovery overrides it to `false` explicitly.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`:

```ts
import { VideoRoomSeatQueueService } from './video-room-seat-queue.service';

const QKEY = 'video-room:seatq:{r1}';
const SKEY = 'video-room:seatq:{r1}:skips';

describe('VideoRoomSeatQueueService', () => {
  let deps: any;
  let svc: VideoRoomSeatQueueService;

  beforeEach(() => {
    deps = {
      cache: {
        exists: jest.fn().mockResolvedValue(true),
        setScore: jest.fn(),
        sortedRank: jest.fn().mockResolvedValue(null),
        sortedLowest: jest.fn().mockResolvedValue([]),
        sortedRemove: jest.fn().mockResolvedValue(1),
        sortedCount: jest.fn().mockResolvedValue(0),
        score: jest.fn().mockResolvedValue(null),
        addScore: jest.fn().mockResolvedValue(1),
        expire: jest.fn(),
        del: jest.fn().mockResolvedValue(1),
      },
      seats: { listPendingRequests: jest.fn().mockResolvedValue([]) },
      vip: { getLevelOrdinal: jest.fn().mockResolvedValue(0) },
      bus: { publish: jest.fn() },
    };
    svc = new VideoRoomSeatQueueService(deps.cache, deps.seats, deps.vip, deps.bus);
  });

  describe('enqueue', () => {
    it('writes a score into the room queue and returns a 1-based position', async () => {
      deps.cache.sortedRank.mockResolvedValue(0);
      const pos = await svc.enqueue('r1', 'u1', new Date('2026-07-21T10:00:00Z'));
      expect(deps.cache.setScore).toHaveBeenCalledWith(QKEY, 'u1', expect.any(Number));
      expect(pos).toBe(1);
    });

    it('scores a VIP ahead of a non-VIP who arrived earlier', async () => {
      deps.vip.getLevelOrdinal.mockResolvedValue(5);
      await svc.enqueue('r1', 'vip', new Date('2026-07-21T10:05:00Z'));
      const vipScore = deps.cache.setScore.mock.calls[0][2];

      deps.vip.getLevelOrdinal.mockResolvedValue(0);
      await svc.enqueue('r1', 'free', new Date('2026-07-21T10:00:00Z'));
      const freeScore = deps.cache.setScore.mock.calls[1][2];

      expect(vipScore).toBeLessThan(freeScore);
    });

    it('refreshes the projection TTL on write', async () => {
      await svc.enqueue('r1', 'u1', new Date());
      expect(deps.cache.expire).toHaveBeenCalledWith(QKEY, expect.any(Number));
    });

    it('publishes a queue update', async () => {
      await svc.enqueue('r1', 'u1', new Date());
      expect(deps.bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.seat_queue_updated' }),
      );
    });
  });

  describe('dequeue', () => {
    it('removes the member from both the queue and the skip ledger', async () => {
      await svc.dequeue('r1', 'u1');
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(QKEY, 'u1');
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(SKEY, 'u1');
    });

    it('publishes a queue update', async () => {
      await svc.dequeue('r1', 'u1');
      expect(deps.bus.publish).toHaveBeenCalled();
    });
  });

  describe('position', () => {
    it('converts the 0-based Redis rank to a 1-based position', async () => {
      deps.cache.sortedRank.mockResolvedValue(2);
      await expect(svc.position('r1', 'u1')).resolves.toBe(3);
    });

    it('returns null when the user is not queued', async () => {
      deps.cache.sortedRank.mockResolvedValue(null);
      await expect(svc.position('r1', 'u1')).resolves.toBeNull();
    });

    it('rebuilds from Postgres when the projection is missing, then answers', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T10:00:00Z') },
      ]);
      deps.cache.sortedRank.mockResolvedValue(0);
      await expect(svc.position('r1', 'u1')).resolves.toBe(1);
      expect(deps.seats.listPendingRequests).toHaveBeenCalledWith('r1');
      expect(deps.cache.setScore).toHaveBeenCalledWith(QKEY, 'u1', expect.any(Number));
    });
  });

  describe('list', () => {
    it('returns ordered entries with 1-based positions', async () => {
      deps.cache.sortedLowest.mockResolvedValue([
        { member: 'u1', score: 10 },
        { member: 'u2', score: 20 },
      ]);
      deps.vip.getLevelOrdinal.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
      const rows = await svc.list('r1');
      expect(rows).toEqual([
        { userId: 'u1', position: 1, vipLevel: 3, score: 10 },
        { userId: 'u2', position: 2, vipLevel: 0, score: 20 },
      ]);
    });

    it('honours an explicit limit', async () => {
      await svc.list('r1', 5);
      expect(deps.cache.sortedLowest).toHaveBeenCalledWith(QKEY, 5);
    });
  });

  describe('rebuild', () => {
    it('replays every PENDING row and returns the count', async () => {
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T10:00:00Z') },
        { userId: 'u2', createdAt: new Date('2026-07-21T10:01:00Z') },
      ]);
      await expect(svc.rebuild('r1')).resolves.toBe(2);
      expect(deps.cache.setScore).toHaveBeenCalledTimes(2);
    });

    it('is a no-op that still succeeds when there is nothing pending', async () => {
      deps.seats.listPendingRequests.mockResolvedValue([]);
      await expect(svc.rebuild('r1')).resolves.toBe(0);
      expect(deps.cache.setScore).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('drops both projection keys', async () => {
      await svc.clear('r1');
      expect(deps.cache.del).toHaveBeenCalledWith(QKEY, SKEY);
    });
  });

  describe('publishUpdate', () => {
    it('caps the broadcast preview rather than sending the whole queue', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ member: `u${i}`, score: i }));
      deps.cache.sortedLowest.mockResolvedValue(many);
      deps.cache.sortedCount.mockResolvedValue(50);
      await svc.publishUpdate('r1');
      const event = deps.bus.publish.mock.calls[0][0];  // a SeatQueueUpdatedEvent
      expect(event.payload.size).toBe(50);
      expect(event.payload.top.length).toBeLessThanOrEqual(20);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`

Expected: FAIL — `Cannot find module './video-room-seat-queue.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/video-rooms/services/video-room-seat-queue.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { VIP_SERVICE, type IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import {
  computeQueueScore,
  videoRoomSeatQueueKey,
  videoRoomSeatQueueSkipsKey,
} from '../constants/video-room-seat-queue';
import {
  VIDEO_ROOM_QUEUE_PREVIEW_LIMIT,
  VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS,
} from '../constants/video-room.constants';
import { SeatQueueUpdatedEvent, type QueuePreviewEntry } from '../events/video-room-seat.events';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';

/** One ordered entry in a room's seat queue. */
export interface QueueEntryView {
  userId: string;
  /** 1-based position (Redis ranks are 0-based; the conversion happens here). */
  position: number;
  vipLevel: number;
  score: number;
}

/**
 * VR-8 — the seat queue, as a Redis ZSET projection over the PENDING rows in
 * `video_room_seat_requests`.
 *
 * Postgres remains the record of truth: this projection is rebuildable at any
 * time from `listPendingRequests`, and every read path checks for its presence
 * first (`rebuild`-on-miss), so a Redis flush or failover costs a rebuild rather
 * than a room's queue. Ordering policy lives entirely in the pure
 * `computeQueueScore`; this service only projects and reads.
 *
 * Sole publisher of `SeatQueueUpdatedEvent`.
 */
@Injectable()
export class VideoRoomSeatQueueService {
  private readonly logger = new Logger(VideoRoomSeatQueueService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly seats: VideoRoomSeatsRepository,
    @Inject(VIP_SERVICE) private readonly vip: IVipService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Add (or re-score) a user in the room queue. Returns their 1-based position. */
  async enqueue(roomId: string, userId: string, createdAt: Date): Promise<number> {
    const score = await this.scoreFor(roomId, userId, createdAt);
    const key = videoRoomSeatQueueKey(roomId);
    await this.cache.setScore(key, userId, score);
    await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
    await this.publishUpdate(roomId);
    return (await this.rawPosition(roomId, userId)) ?? 1;
  }

  /** Remove a user from the queue and forget their skip history. */
  async dequeue(roomId: string, userId: string): Promise<void> {
    await this.cache.sortedRemove(videoRoomSeatQueueKey(roomId), userId);
    await this.cache.sortedRemove(videoRoomSeatQueueSkipsKey(roomId), userId);
    await this.publishUpdate(roomId);
  }

  /** A user's 1-based queue position, or null when they are not queued. */
  async position(roomId: string, userId: string): Promise<number | null> {
    await this.ensureProjection(roomId);
    return this.rawPosition(roomId, userId);
  }

  /** The ordered queue, front first, bounded by `limit`. */
  async list(roomId: string, limit = VIDEO_ROOM_QUEUE_PREVIEW_LIMIT): Promise<QueueEntryView[]> {
    await this.ensureProjection(roomId);
    const rows = await this.cache.sortedLowest(videoRoomSeatQueueKey(roomId), limit);
    const out: QueueEntryView[] = [];
    for (const [index, row] of rows.entries()) {
      out.push({
        userId: row.member,
        position: index + 1,
        vipLevel: await this.vipLevel(row.member),
        score: row.score,
      });
    }
    return out;
  }

  /** How many users are waiting. */
  async size(roomId: string): Promise<number> {
    await this.ensureProjection(roomId);
    return this.cache.sortedCount(videoRoomSeatQueueKey(roomId));
  }

  /** Drop the whole projection (room ended / deleted). */
  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomSeatQueueKey(roomId), videoRoomSeatQueueSkipsKey(roomId));
  }

  /**
   * Replay every PENDING request into the ZSET. Idempotent — `setScore` is a
   * ZADD, so re-running simply re-writes the same scores.
   */
  async rebuild(roomId: string): Promise<number> {
    const pending = await this.seats.listPendingRequests(roomId);
    if (pending.length === 0) return 0;
    const key = videoRoomSeatQueueKey(roomId);
    for (const req of pending) {
      await this.cache.setScore(key, req.userId, await this.scoreFor(roomId, req.userId, req.createdAt));
    }
    await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
    this.logger.debug(`Rebuilt seat queue for room ${roomId}: ${pending.length} entr(ies)`);
    return pending.length;
  }

  /** Broadcast the current queue shape (size + bounded preview). */
  async publishUpdate(roomId: string): Promise<void> {
    const [size, rows] = await Promise.all([
      this.cache.sortedCount(videoRoomSeatQueueKey(roomId)),
      this.cache.sortedLowest(videoRoomSeatQueueKey(roomId), VIDEO_ROOM_QUEUE_PREVIEW_LIMIT),
    ]);
    const top: QueuePreviewEntry[] = [];
    for (const [index, row] of rows.slice(0, VIDEO_ROOM_QUEUE_PREVIEW_LIMIT).entries()) {
      top.push({ userId: row.member, position: index + 1, vipLevel: await this.vipLevel(row.member) });
    }
    await this.bus.publish(new SeatQueueUpdatedEvent({ roomId, size, top }));
  }

  // ---- Internal ----

  /** Rebuild the projection if Redis has lost it. */
  private async ensureProjection(roomId: string): Promise<void> {
    if (await this.cache.exists(videoRoomSeatQueueKey(roomId))) return;
    await this.rebuild(roomId);
  }

  /** 1-based position straight from Redis, without a projection check. */
  private async rawPosition(roomId: string, userId: string): Promise<number | null> {
    const rank = await this.cache.sortedRank(videoRoomSeatQueueKey(roomId), userId);
    return rank === null ? null : rank + 1;
  }

  /** Current score for a user, folding in VIP tier and accumulated skips. */
  private async scoreFor(roomId: string, userId: string, createdAt: Date): Promise<number> {
    const [vipLevel, skipCount] = await Promise.all([
      this.vipLevel(userId),
      this.skipCount(roomId, userId),
    ]);
    return computeQueueScore({ vipLevel, createdAt, skipCount });
  }

  /** VIP ordinal, degrading to 0 if the VIP module is unavailable. */
  private async vipLevel(userId: string): Promise<number> {
    try {
      return await this.vip.getLevelOrdinal(userId);
    } catch (err) {
      this.logger.warn(`VIP lookup failed for ${userId}; treating as non-VIP: ${(err as Error).message}`);
      return 0;
    }
  }

  private async skipCount(roomId: string, userId: string): Promise<number> {
    return (await this.cache.score(videoRoomSeatQueueSkipsKey(roomId), userId)) ?? 0;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`

Expected: PASS — 15 tests.

- [ ] **Step 5: Export from the services barrel**

In `src/modules/video-rooms/services/index.ts`, add alongside the existing exports:

```ts
export * from './video-room-seat-queue.service';
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`

Expected: tsc exit 0; suite green.

---

### Task 6: `VideoRoomSeatQueueService.advance` — auto-advance with fairness accounting

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-seat-queue.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 5; `VideoRoomSeatService.seatUser`; `VideoRoomSeatsRepository.findPendingRequest` / `setRequestStatus`; `LockService.withLock`; `videoRoomSeatQueueLockKey` (Task 1)
- Produces: `advance(roomId: string, seatIndex: number, actorId: string): Promise<string | null>` — the userId seated, or `null` if nobody could be seated

> **Why this is its own task.** `advance` is the only method that *mutates seats*, and it is the one place a poisoned entry could spin forever. It makes **exactly one pass** over the queue: each candidate that cannot be seated has its skip counter incremented (which re-scores it toward the fairness pin) and is passed over, and the pass stops at the end of the preview window. No recursion, no `while (true)`.
>
> **⚠️ Lock key — read this before writing any code.** `advance` MUST use
> `videoRoomSeatQueueLockKey(roomId)`, **not** `videoRoomSeatLockKey(roomId)`.
> `LockService.withLock` acquires with `SET … NX`; it is **not re-entrant**.
> `advance` calls `VideoRoomSeatService.seatUser`, which internally calls
> `mutateStage`, which takes `videoRoomSeatLockKey(roomId)` itself
> ([video-room-seat.service.ts:623](../../../src/modules/video-rooms/services/video-room-seat.service.ts#L623)).
> If `advance` already held that same key, the inner acquire would fail all 20
> retries (~2s) and throw — every single auto-advance would break, and only under
> real Redis, not under the mocked lock in these tests.
>
> The distinct queue lock still gives us what we need: two simultaneous
> seat-freed events for one room can't both advance and double-book a seat
> index. And correctness doesn't *depend* on it — if two advances did race, the
> loser's `seatUser` throws `SEAT_TAKEN` and the existing skip path handles it.

- [ ] **Step 1: Write the failing tests**

Append this describe block to `src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`, and extend the `beforeEach` deps object with the two new dependencies:

```ts
// --- add to the existing beforeEach `deps` object ---
//   seatSvc: { seatUser: jest.fn().mockResolvedValue({ version: 7 }) },
//   locks: { withLock: jest.fn(async (_k: string, fn: () => Promise<unknown>) => fn()) },
// --- and update the constructor call to ---
//   svc = new VideoRoomSeatQueueService(
//     deps.cache, deps.seats, deps.vip, deps.bus, deps.seatSvc, deps.locks,
//   );

describe('advance', () => {
  beforeEach(() => {
    deps.seatSvc = { seatUser: jest.fn().mockResolvedValue({ version: 7 }) };
    deps.locks = { withLock: jest.fn(async (_k: string, fn: () => Promise<unknown>) => fn()) };
    deps.seats.findPendingRequest = jest.fn().mockResolvedValue({ id: 'q1', userId: 'u1' });
    deps.seats.setRequestStatus = jest.fn();
    svc = new VideoRoomSeatQueueService(
      deps.cache,
      deps.seats,
      deps.vip,
      deps.bus,
      deps.seatSvc,
      deps.locks,
    );
  });

  it('seats the front of the queue and returns their id', async () => {
    deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
    await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u1');
    expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r1', 'u1', 'system', 3, undefined);
  });

  it('advances under the dedicated queue lock, NOT the re-entrant-unsafe seat lock', async () => {
    deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
    await svc.advance('r1', 3, 'system');
    expect(deps.locks.withLock).toHaveBeenCalledWith(
      'video-room:seatq:lock:{r1}',
      expect.any(Function),
    );
    // Regression guard: reusing the seat lock here deadlocks against
    // seatUser -> mutateStage, which acquires it with SET NX.
    expect(deps.locks.withLock).not.toHaveBeenCalledWith(
      'video-room:seat:{r1}',
      expect.any(Function),
    );
  });

  it('marks the seated user PROMOTED and removes them from the queue', async () => {
    deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
    await svc.advance('r1', 3, 'system');
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      'PROMOTED',
      'system',
      'system',
      expect.objectContaining({ bumpAttempt: true }),
    );
    expect(deps.cache.sortedRemove).toHaveBeenCalledWith('video-room:seatq:{r1}', 'u1');
  });

  it('returns null and seats nobody when the queue is empty', async () => {
    deps.cache.sortedLowest.mockResolvedValue([]);
    await expect(svc.advance('r1', 3, 'system')).resolves.toBeNull();
    expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
  });

  it('skips a candidate whose seating throws and tries the next one', async () => {
    deps.cache.sortedLowest.mockResolvedValue([
      { member: 'u1', score: 10 },
      { member: 'u2', score: 20 },
    ]);
    deps.seats.findPendingRequest = jest
      .fn()
      .mockResolvedValueOnce({ id: 'q1', userId: 'u1' })
      .mockResolvedValueOnce({ id: 'q2', userId: 'u2' });
    deps.seatSvc.seatUser
      .mockRejectedValueOnce(new Error('seat taken'))
      .mockResolvedValueOnce({ version: 8 });

    await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u2');
    expect(deps.cache.addScore).toHaveBeenCalledWith('video-room:seatq:{r1}:skips', 'u1', 1);
  });

  it('skips a candidate who no longer holds a pending request', async () => {
    deps.cache.sortedLowest.mockResolvedValue([
      { member: 'ghost', score: 10 },
      { member: 'u2', score: 20 },
    ]);
    deps.seats.findPendingRequest = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'q2', userId: 'u2' });

    await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u2');
    expect(deps.cache.sortedRemove).toHaveBeenCalledWith('video-room:seatq:{r1}', 'ghost');
  });

  it('makes exactly one pass — it does not retry a candidate it already skipped', async () => {
    deps.cache.sortedLowest.mockResolvedValue([
      { member: 'u1', score: 10 },
      { member: 'u2', score: 20 },
    ]);
    deps.seats.findPendingRequest = jest
      .fn()
      .mockResolvedValue({ id: 'q', userId: 'x' });
    deps.seatSvc.seatUser.mockRejectedValue(new Error('always fails'));

    await expect(svc.advance('r1', 3, 'system')).resolves.toBeNull();
    expect(deps.seatSvc.seatUser).toHaveBeenCalledTimes(2);
  });

  it('publishes a queue update after a successful advance', async () => {
    deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
    deps.bus.publish.mockClear();
    await svc.advance('r1', 3, 'system');
    expect(deps.bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'video_room.seat_queue_updated' }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts -t advance`

Expected: FAIL — `svc.advance is not a function`.

- [ ] **Step 3: Add the two new constructor dependencies**

In `src/modules/video-rooms/services/video-room-seat-queue.service.ts`, extend the imports:

```ts
import { VideoRoomSeatRequestStatus } from '@prisma/client';
import { LockService } from 'src/infra/redis/lock.service';
import { videoRoomSeatQueueLockKey } from '../constants/video-room.constants';
import { VideoRoomSeatService } from './video-room-seat.service';
```

and the constructor:

```ts
  constructor(
    private readonly cache: CacheService,
    private readonly seats: VideoRoomSeatsRepository,
    @Inject(VIP_SERVICE) private readonly vip: IVipService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly seatSvc: VideoRoomSeatService,
    private readonly locks: LockService,
  ) {}
```

- [ ] **Step 4: Implement `advance`**

Append inside the class, before the `// ---- Internal ----` marker:

```ts
  /**
   * Auto-promote the front of the queue onto a freed seat.
   *
   * Runs under the room's dedicated QUEUE lock — never the seat lock, which
   * `seatUser` takes for itself and which `LockService` cannot re-enter — so two
   * concurrent seat-freed events can't double-book one seat index.
   *
   * Makes exactly ONE pass over the queue preview: a candidate who
   * cannot be seated (seat re-taken, request already resolved, block in force)
   * has their skip counter incremented — which re-scores them toward the
   * fairness pin — and is passed over. Bounded so a poisoned queue can never
   * spin.
   *
   * @returns the userId seated, or null when nobody could take the seat.
   */
  async advance(roomId: string, seatIndex: number, actorId: string): Promise<string | null> {
    const seated = await this.locks.withLock(videoRoomSeatQueueLockKey(roomId), async () => {
      await this.ensureProjection(roomId);
      const candidates = await this.cache.sortedLowest(
        videoRoomSeatQueueKey(roomId),
        VIDEO_ROOM_QUEUE_PREVIEW_LIMIT,
      );

      for (const candidate of candidates) {
        const userId = candidate.member;
        const request = await this.seats.findPendingRequest(roomId, userId);

        // Stale projection entry — the row is gone or already resolved.
        if (!request) {
          await this.cache.sortedRemove(videoRoomSeatQueueKey(roomId), userId);
          continue;
        }

        try {
          await this.seatSvc.seatUser(roomId, userId, actorId, seatIndex, undefined);
        } catch (err) {
          this.logger.debug(
            `Queue advance skipped ${userId} in room ${roomId}: ${(err as Error).message}`,
          );
          await this.cache.addScore(videoRoomSeatQueueSkipsKey(roomId), userId, 1);
          await this.reScore(roomId, userId, request.createdAt);
          continue;
        }

        await this.seats.setRequestStatus(
          request.id,
          VideoRoomSeatRequestStatus.PROMOTED,
          actorId,
          actorId,
          { bumpAttempt: true, lastError: null },
        );
        await this.cache.sortedRemove(videoRoomSeatQueueKey(roomId), userId);
        await this.cache.sortedRemove(videoRoomSeatQueueSkipsKey(roomId), userId);
        return userId;
      }

      return null;
    });

    await this.publishUpdate(roomId);
    return seated ?? null;
  }
```

and add this private helper next to `scoreFor`:

```ts
  /** Recompute and rewrite a queued user's score (after a skip changes it). */
  private async reScore(roomId: string, userId: string, createdAt: Date): Promise<void> {
    await this.cache.setScore(
      videoRoomSeatQueueKey(roomId),
      userId,
      await this.scoreFor(roomId, userId, createdAt),
    );
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-queue.service.spec.ts`

Expected: PASS — 23 tests (15 from Task 5 + 8 new).

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`

Expected: tsc exit 0; lint clean (`--max-warnings 0`).

> **Circular-dependency note.** `VideoRoomSeatQueueService` depends on `VideoRoomSeatService`, and Task 10's listener depends on the queue service — but `VideoRoomSeatService` must NOT depend on the queue service. If you find yourself wanting to call the queue from inside `VideoRoomSeatService`, stop: that coupling is exactly what the listener in Task 10 exists to avoid.

---

### Task 7: Request state-machine guard and the new validations

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-seat-workflow.ts`
- Test: `src/modules/video-rooms/constants/video-room-seat-workflow.spec.ts`
- Modify: `src/modules/video-rooms/constants/index.ts`

**Interfaces:**
- Consumes: `VideoRoomSeatRequestStatus`, `VideoRoomInvitationStatus` (Task 1)
- Produces:
  - `SEAT_REQUEST_TRANSITIONS: Readonly<Record<VideoRoomSeatRequestStatus, readonly VideoRoomSeatRequestStatus[]>>`
  - `SEAT_INVITATION_TRANSITIONS: Readonly<Record<VideoRoomInvitationStatus, readonly VideoRoomInvitationStatus[]>>`
  - `canTransitionRequest(from, to): boolean`
  - `canTransitionInvitation(from, to): boolean`
  - `isTerminalRequestStatus(s): boolean`
  - `isTerminalInvitationStatus(s): boolean`

> **Why a table and not scattered `if`s.** With 7 states each there are 49 possible request transitions; only 9 are legal. A declarative table makes the illegal ones impossible to reach by accident, gives the services one guard call instead of ad-hoc checks, and — critically — lets the tests below enumerate *every* pair, so an illegal transition someone adds later fails a test rather than corrupting a row.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/constants/video-room-seat-workflow.spec.ts`:

```ts
import { VideoRoomInvitationStatus, VideoRoomSeatRequestStatus } from '@prisma/client';
import {
  SEAT_INVITATION_TRANSITIONS,
  SEAT_REQUEST_TRANSITIONS,
  canTransitionInvitation,
  canTransitionRequest,
  isTerminalInvitationStatus,
  isTerminalRequestStatus,
} from './video-room-seat-workflow';

const R = VideoRoomSeatRequestStatus;
const I = VideoRoomInvitationStatus;

describe('seat request transitions', () => {
  it.each([
    [R.PENDING, R.ACCEPTED],
    [R.PENDING, R.REJECTED],
    [R.PENDING, R.CANCELLED],
    [R.PENDING, R.EXPIRED],
    [R.ACCEPTED, R.PROMOTED],
    [R.ACCEPTED, R.FAILED],
    [R.FAILED, R.PENDING],
    [R.EXPIRED, R.PENDING],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionRequest(from, to)).toBe(true);
  });

  it.each([
    [R.PROMOTED, R.PENDING],
    [R.PROMOTED, R.FAILED],
    [R.REJECTED, R.ACCEPTED],
    [R.CANCELLED, R.ACCEPTED],
    [R.PENDING, R.PROMOTED],
    [R.PENDING, R.PENDING],
    [R.ACCEPTED, R.REJECTED],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransitionRequest(from, to)).toBe(false);
  });

  it('treats PROMOTED, REJECTED and CANCELLED as terminal', () => {
    expect(isTerminalRequestStatus(R.PROMOTED)).toBe(true);
    expect(isTerminalRequestStatus(R.REJECTED)).toBe(true);
    expect(isTerminalRequestStatus(R.CANCELLED)).toBe(true);
  });

  it('does not treat recoverable states as terminal', () => {
    expect(isTerminalRequestStatus(R.PENDING)).toBe(false);
    expect(isTerminalRequestStatus(R.FAILED)).toBe(false);
    expect(isTerminalRequestStatus(R.EXPIRED)).toBe(false);
  });

  it('declares an entry for every status so no state is unreachable by omission', () => {
    for (const status of Object.values(R)) {
      expect(SEAT_REQUEST_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('never allows a self-transition', () => {
    for (const status of Object.values(R)) {
      expect(canTransitionRequest(status, status)).toBe(false);
    }
  });
});

describe('seat invitation transitions', () => {
  it.each([
    [I.PENDING, I.DELIVERED],
    [I.PENDING, I.ACCEPTED],
    [I.PENDING, I.REJECTED],
    [I.PENDING, I.CANCELLED],
    [I.PENDING, I.EXPIRED],
    [I.DELIVERED, I.ACCEPTED],
    [I.DELIVERED, I.REJECTED],
    [I.DELIVERED, I.CANCELLED],
    [I.DELIVERED, I.EXPIRED],
    [I.DELIVERED, I.FAILED],
    [I.FAILED, I.PENDING],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionInvitation(from, to)).toBe(true);
  });

  it.each([
    [I.ACCEPTED, I.PENDING],
    [I.REJECTED, I.ACCEPTED],
    [I.CANCELLED, I.DELIVERED],
    [I.DELIVERED, I.PENDING],
    [I.EXPIRED, I.ACCEPTED],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransitionInvitation(from, to)).toBe(false);
  });

  it('declares an entry for every status', () => {
    for (const status of Object.values(I)) {
      expect(SEAT_INVITATION_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('treats ACCEPTED, REJECTED and CANCELLED as terminal', () => {
    expect(isTerminalInvitationStatus(I.ACCEPTED)).toBe(true);
    expect(isTerminalInvitationStatus(I.REJECTED)).toBe(true);
    expect(isTerminalInvitationStatus(I.CANCELLED)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/constants/video-room-seat-workflow.spec.ts`

Expected: FAIL — `Cannot find module './video-room-seat-workflow'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/video-rooms/constants/video-room-seat-workflow.ts`:

```ts
import { VideoRoomInvitationStatus, VideoRoomSeatRequestStatus } from '@prisma/client';

/**
 * VR-8 — the seat request / invitation state machines, declared as transition
 * tables rather than scattered conditionals.
 *
 * With seven states each, most of the 49 possible pairs are illegal; encoding
 * the legal ones once means services make a single guard call, and a future
 * edit that opens an unsafe path fails a test instead of corrupting rows.
 *
 * Request lifecycle:
 *   PENDING  → ACCEPTED (approved; seating in flight) | REJECTED | CANCELLED | EXPIRED
 *   ACCEPTED → PROMOTED (seated)                      | FAILED   (seating threw)
 *   FAILED   → PENDING  (explicit retry)
 *   EXPIRED  → PENDING  (restore on reconnect, original createdAt preserved)
 *
 * Invitation lifecycle:
 *   PENDING   → DELIVERED | ACCEPTED | REJECTED | CANCELLED | EXPIRED
 *   DELIVERED → ACCEPTED  | REJECTED | CANCELLED | EXPIRED  | FAILED
 *   FAILED    → PENDING   (explicit retry)
 */

const R = VideoRoomSeatRequestStatus;
const I = VideoRoomInvitationStatus;

export const SEAT_REQUEST_TRANSITIONS: Readonly<
  Record<VideoRoomSeatRequestStatus, readonly VideoRoomSeatRequestStatus[]>
> = Object.freeze({
  [R.PENDING]: [R.ACCEPTED, R.REJECTED, R.CANCELLED, R.EXPIRED],
  [R.ACCEPTED]: [R.PROMOTED, R.FAILED],
  [R.PROMOTED]: [],
  [R.FAILED]: [R.PENDING],
  [R.EXPIRED]: [R.PENDING],
  [R.REJECTED]: [],
  [R.CANCELLED]: [],
});

export const SEAT_INVITATION_TRANSITIONS: Readonly<
  Record<VideoRoomInvitationStatus, readonly VideoRoomInvitationStatus[]>
> = Object.freeze({
  [I.PENDING]: [I.DELIVERED, I.ACCEPTED, I.REJECTED, I.CANCELLED, I.EXPIRED, I.FAILED],
  [I.DELIVERED]: [I.ACCEPTED, I.REJECTED, I.CANCELLED, I.EXPIRED, I.FAILED],
  [I.ACCEPTED]: [],
  [I.REJECTED]: [],
  [I.CANCELLED]: [],
  [I.EXPIRED]: [],
  [I.FAILED]: [I.PENDING],
});

/** Whether a seat request may move `from` → `to`. Self-transitions are never legal. */
export function canTransitionRequest(
  from: VideoRoomSeatRequestStatus,
  to: VideoRoomSeatRequestStatus,
): boolean {
  return SEAT_REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Whether an invitation may move `from` → `to`. */
export function canTransitionInvitation(
  from: VideoRoomInvitationStatus,
  to: VideoRoomInvitationStatus,
): boolean {
  return SEAT_INVITATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A request status from which nothing further is possible. */
export function isTerminalRequestStatus(status: VideoRoomSeatRequestStatus): boolean {
  return SEAT_REQUEST_TRANSITIONS[status].length === 0;
}

/** An invitation status from which nothing further is possible. */
export function isTerminalInvitationStatus(status: VideoRoomInvitationStatus): boolean {
  return SEAT_INVITATION_TRANSITIONS[status].length === 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/constants/video-room-seat-workflow.spec.ts`

Expected: PASS — all `it.each` rows plus the structural checks.

- [ ] **Step 5: Export from the constants barrel**

In `src/modules/video-rooms/constants/index.ts`:

```ts
export * from './video-room-seat-workflow';
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/constants`

Expected: tsc exit 0; all constants suites green.

---

### Task 8: Request service — validations, queue, PROMOTED/FAILED, retry, restore, update

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-seat-request.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-request.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `VideoRoomSeatQueueService` (Tasks 5–6); `canTransitionRequest`, `isTerminalRequestStatus` (Task 7); `VideoRoomModerationRepository.findActiveBlock`; `VideoRoomSeatsRepository.updateRequestSeatIndex` / `restoreRequest` / `setRequestStatus(…, opts)` (Task 4); `VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS` (Task 1)
- Produces, on `VideoRoomSeatRequestService`:
  - `request(actor, roomId, seatIndex?, ip?)` — **extended** with 5 validations + enqueue
  - `updateRequest(actor, roomId, seatIndex, ip?): Promise<VideoRoomSeatRequestView>`
  - `retry(actor, roomId, requestId, ip?): Promise<SeatStageView>`
  - `restore(roomId, userId, ip?): Promise<VideoRoomSeatRequestView | null>`
  - `approve(...)` — **extended** to emit PROMOTED/FAILED
  - `listRequests(actor, roomId)` — **extended** to return queue positions
- **Removes:** `compareRequestPriority` and `RequestPriorityContext` (superseded by `computeQueueScore`)

- [ ] **Step 1: Write the failing tests**

Extend `src/modules/video-rooms/services/video-room-seat-request.service.spec.ts`. Update the shared `deps`/constructor first, then append the new describes:

```ts
// --- extend the existing beforeEach `deps` with: ---
//   moderation: { findActiveBlock: jest.fn().mockResolvedValue(null) },
//   queue: {
//     enqueue: jest.fn().mockResolvedValue(1),
//     dequeue: jest.fn(),
//     position: jest.fn().mockResolvedValue(1),
//     publishUpdate: jest.fn(),
//   },
// --- and append `deps.moderation, deps.queue` to the constructor call. ---

describe('request validations (VR-8)', () => {
  it('refuses a user blocked from the room', async () => {
    deps.moderation.findActiveBlock.mockResolvedValue({ id: 'b1' });
    await expect(svc.request(actor('u1'), 'r1')).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_ROOM_BLOCKED,
    });
  });

  it('refuses a user who already holds a seat', async () => {
    deps.seats.findOccupiedSeat = jest.fn().mockResolvedValue({ seatIndex: 2 });
    await expect(svc.request(actor('u1'), 'r1')).rejects.toMatchObject({
      code: ERROR_CODES.ALREADY_ON_SEAT,
    });
  });

  it('refuses a request for a locked seat', async () => {
    deps.seats.findSeat = jest.fn().mockResolvedValue({ seatIndex: 3, isLocked: true });
    await expect(svc.request(actor('u1'), 'r1', 3)).rejects.toMatchObject({
      code: ERROR_CODES.SEAT_LOCKED,
    });
  });

  it('refuses a request for a seat index that does not exist', async () => {
    deps.seats.findSeat = jest.fn().mockResolvedValue(null);
    await expect(svc.request(actor('u1'), 'r1', 99)).rejects.toMatchObject({
      code: ERROR_CODES.SEAT_NOT_FOUND,
    });
  });

  it('enqueues the requester once the request row is created', async () => {
    await svc.request(actor('u1'), 'r1');
    expect(deps.queue.enqueue).toHaveBeenCalledWith('r1', 'u1', expect.any(Date));
  });

  it('still refuses a duplicate pending request', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({ id: 'existing' });
    await expect(svc.request(actor('u1'), 'r1')).rejects.toMatchObject({
      code: ERROR_CODES.DUPLICATE_SEAT_REQUEST,
    });
  });
});

describe('approve → PROMOTED / FAILED', () => {
  beforeEach(() => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'PENDING',
      attemptCount: 0,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('marks the request PROMOTED after a successful seating', async () => {
    await svc.approve(actor('owner'), 'r1', 'q1');
    const statuses = deps.seats.setRequestStatus.mock.calls.map((c: any[]) => c[1]);
    expect(statuses).toContain('PROMOTED');
  });

  it('removes the promoted user from the queue', async () => {
    await svc.approve(actor('owner'), 'r1', 'q1');
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  it('marks the request FAILED and rethrows when seating throws', async () => {
    deps.seatSvc.seatUser.mockRejectedValue(new Error('seat taken'));
    await expect(svc.approve(actor('owner'), 'r1', 'q1')).rejects.toThrow('seat taken');
    const failed = deps.seats.setRequestStatus.mock.calls.find((c: any[]) => c[1] === 'FAILED');
    expect(failed).toBeDefined();
    expect(failed[4]).toMatchObject({ bumpAttempt: true, lastError: 'seat taken' });
  });

  it('leaves a failed requester in the queue so they can be retried', async () => {
    deps.seatSvc.seatUser.mockRejectedValue(new Error('seat taken'));
    await expect(svc.approve(actor('owner'), 'r1', 'q1')).rejects.toThrow();
    expect(deps.queue.dequeue).not.toHaveBeenCalled();
  });
});

describe('retry', () => {
  it('re-drives seating for a FAILED request', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1', roomId: 'r1', userId: 'u1', seatIndex: 2,
      status: 'FAILED', attemptCount: 1, createdAt: new Date(),
    });
    await svc.retry(actor('owner'), 'r1', 'q1');
    expect(deps.seatSvc.seatUser).toHaveBeenCalled();
  });

  it('refuses to retry a request that is not FAILED', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1', roomId: 'r1', userId: 'u1', status: 'PENDING', attemptCount: 0, createdAt: new Date(),
    });
    await expect(svc.retry(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      code: ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
    });
  });

  it('refuses once the attempt budget is exhausted', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1', roomId: 'r1', userId: 'u1', status: 'FAILED', attemptCount: 3, createdAt: new Date(),
    });
    await expect(svc.retry(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      code: ERROR_CODES.SEAT_RETRY_EXHAUSTED,
    });
  });
});

describe('restore', () => {
  it('revives an expired request and preserves its original createdAt', async () => {
    const createdAt = new Date('2026-07-21T10:00:00Z');
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1', roomId: 'r1', userId: 'u1', status: 'EXPIRED', createdAt,
    });
    deps.seats.restoreRequest = jest.fn().mockResolvedValue({
      id: 'q1', userId: 'u1', seatIndex: null, status: 'PENDING', createdAt,
    });
    await svc.restore('r1', 'u1');
    expect(deps.seats.restoreRequest).toHaveBeenCalledWith('q1', 'u1', expect.any(Date));
    // Re-enqueued at the ORIGINAL createdAt, so the ZSET score is unchanged.
    expect(deps.queue.enqueue).toHaveBeenCalledWith('r1', 'u1', createdAt);
  });

  it('returns null when there is nothing to restore', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue(null);
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it('does not restore a request the user deliberately cancelled', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1', roomId: 'r1', userId: 'u1', status: 'CANCELLED', createdAt: new Date(),
    });
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
  });
});

describe('updateRequest', () => {
  it('changes the preferred seat on a pending request', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({ id: 'q1', userId: 'u1', seatIndex: 2 });
    deps.seats.updateRequestSeatIndex = jest.fn().mockResolvedValue({
      id: 'q1', userId: 'u1', seatIndex: 5, status: 'PENDING', createdAt: new Date(),
    });
    const view = await svc.updateRequest(actor('u1'), 'r1', 5);
    expect(deps.seats.updateRequestSeatIndex).toHaveBeenCalledWith('q1', 5, 'u1');
    expect(view.seatIndex).toBe(5);
  });

  it('fails when the user has no pending request', async () => {
    deps.seats.findPendingRequest.mockResolvedValue(null);
    await expect(svc.updateRequest(actor('u1'), 'r1', 5)).rejects.toMatchObject({
      code: ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
    });
  });
});

describe('listRequests', () => {
  it('returns each pending request with its queue position', async () => {
    deps.seats.listPendingRequests.mockResolvedValue([
      { id: 'q1', userId: 'u1', seatIndex: null, status: 'PENDING', createdAt: new Date() },
    ]);
    deps.queue.position.mockResolvedValue(4);
    const rows = await svc.listRequests(actor('owner'), 'r1');
    expect(rows[0]).toMatchObject({ userId: 'u1', position: 4 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-request.service.spec.ts`

Expected: FAIL — constructor arity mismatch and `svc.retry is not a function`.

- [ ] **Step 3: Delete the superseded priority stub and add the new dependencies**

In `src/modules/video-rooms/services/video-room-seat-request.service.ts`, **delete** the entire `RequestPriorityContext` interface and the `compareRequestPriority` function (lines ~18-46) — `computeQueueScore` replaces them. Then extend the imports:

```ts
import {
  VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS,
  VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS,
} from '../constants/video-room.constants';
import {
  canTransitionRequest,
  isTerminalRequestStatus,
} from '../constants/video-room-seat-workflow';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomSeatQueueService } from './video-room-seat-queue.service';
```

and the constructor:

```ts
  constructor(
    private readonly seatSvc: VideoRoomSeatService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly queue: VideoRoomSeatQueueService,
  ) {}
```

- [ ] **Step 4: Add the validations and the enqueue to `request`**

Replace the body of `request` between the membership check and the `createRequest` call:

```ts
    // VR-8 — room-level ban/block.
    if (await this.moderation.findActiveBlock(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'You are blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    // VR-8 — already a participant: nothing to request.
    if (await this.seats.findOccupiedSeat(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_ON_SEAT,
        'You already hold a seat in this room.',
        HttpStatus.CONFLICT,
      );
    }

    if (await this.seats.findPendingRequest(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_SEAT_REQUEST,
        'You already have a pending seat request.',
        HttpStatus.CONFLICT,
      );
    }

    // VR-8 — when a specific seat is named, it must exist and be takeable.
    if (seatIndex !== undefined) {
      const seat = await this.seats.findSeat(roomId, seatIndex);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.SEAT_NOT_FOUND,
          'That seat does not exist in this room.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (seat.isLocked) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.seatStatus === VideoRoomSeatStatus.RESERVED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_RESERVED,
          'That seat is reserved.',
          HttpStatus.CONFLICT,
        );
      }
    }
```

and immediately after the existing `this.bus.publish(new SeatRequestedEvent({...}))`, add:

```ts
    await this.queue.enqueue(roomId, actor.id, req.createdAt);
```

Add `VideoRoomSeatStatus` to the `@prisma/client` import at the top of the file.

- [ ] **Step 5: Make `approve` emit PROMOTED / FAILED**

Replace the seating portion of `approve` (the `seatUser` call and the `setRequestStatus(ACCEPTED)` that follows it):

```ts
    const seatIndex = req.seatIndex ?? (await this.seatSvc.findOpenSeat(actor, roomId));
    await this.seats.setRequestStatus(
      req.id,
      VideoRoomSeatRequestStatus.ACCEPTED,
      actor.id,
      actor.id,
    );

    let view;
    try {
      view = await this.seatSvc.seatUser(roomId, req.userId, actor.id, seatIndex, ip);
    } catch (err) {
      const message = (err as Error).message;
      // The requester stays queued so an operator can retry them.
      await this.seats.setRequestStatus(
        req.id,
        VideoRoomSeatRequestStatus.FAILED,
        actor.id,
        actor.id,
        { bumpAttempt: true, lastError: message },
      );
      await this.events.appendEvent({
        roomId,
        actorId: actor.id,
        eventType: 'seat.request_failed',
        payload: { requestId: req.id, userId: req.userId, reason: message, ...(ip ? { ip } : {}) },
      });
      await this.bus.publish(
        new SeatRequestResolvedEvent({
          roomId,
          requestId: req.id,
          userId: req.userId,
          status: 'FAILED',
          actorId: actor.id,
        }),
      );
      throw err;
    }

    await this.seats.setRequestStatus(
      req.id,
      VideoRoomSeatRequestStatus.PROMOTED,
      actor.id,
      actor.id,
      { bumpAttempt: true, lastError: null },
    );
    await this.queue.dequeue(roomId, req.userId);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_promoted',
      payload: { requestId: req.id, userId: req.userId, seatIndex, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatRequestResolvedEvent({
        roomId,
        requestId: req.id,
        userId: req.userId,
        status: 'PROMOTED',
        actorId: actor.id,
        version: view.version,
        seatIndex,
      }),
    );
    return view;
```

Also add `await this.queue.dequeue(roomId, actor.id);` to `cancelRequest`, and `await this.queue.dequeue(roomId, req.userId);` to `reject`, right after each `setRequestStatus` call.

- [ ] **Step 6: Add `updateRequest`, `retry`, and `restore`**

Append these methods to the class, before the `// ---- Internal ----` marker:

```ts
  /** Change the preferred seat on your own still-pending request. */
  async updateRequest(
    actor: RoomActor,
    roomId: string,
    seatIndex: number | null,
    ip?: string,
  ): Promise<VideoRoomSeatRequestView> {
    await this.seatSvc.requireLiveRoom(roomId);
    const existing = await this.seats.findPendingRequest(roomId, actor.id);
    if (!existing) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'You have no pending seat request.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (seatIndex !== null) {
      const seat = await this.seats.findSeat(roomId, seatIndex);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.SEAT_NOT_FOUND,
          'That seat does not exist in this room.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (seat.isLocked) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
    }
    const updated = await this.seats.updateRequestSeatIndex(existing.id, seatIndex, actor.id);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_updated',
      payload: { requestId: existing.id, seatIndex, ...(ip ? { ip } : {}) },
    });
    await this.queue.publishUpdate(roomId);
    return toVideoRoomSeatRequestView(updated);
  }

  /**
   * Re-drive a FAILED request's seating. Bounded by `attemptCount` so a request
   * that fails for a structural reason cannot be retried forever.
   */
  async retry(actor: RoomActor, roomId: string, requestId: string, ip?: string) {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);

    const req = await this.seats.findRequestById(requestId);
    if (!req || req.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'Seat request not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!canTransitionRequest(req.status, VideoRoomSeatRequestStatus.PENDING)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
        `A request in state ${req.status} cannot be retried.`,
        HttpStatus.CONFLICT,
      );
    }
    if (req.attemptCount >= VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS) {
      throw new BusinessException(
        ERROR_CODES.SEAT_RETRY_EXHAUSTED,
        `This request has already used all ${VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS} seating attempts.`,
        HttpStatus.CONFLICT,
      );
    }

    await this.seats.setRequestStatus(
      req.id,
      VideoRoomSeatRequestStatus.PENDING,
      actor.id,
      actor.id,
      { lastError: null },
    );
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_retried',
      payload: { requestId: req.id, attempt: req.attemptCount + 1, ...(ip ? { ip } : {}) },
    });
    return this.approve(actor, roomId, req.id, ip);
  }

  /**
   * Reconnect recovery: revive a request that expired while the user was
   * disconnected. `createdAt` is untouched, so re-enqueueing yields the same ZSET
   * score and the viewer resumes at exactly their old position. Returns null when
   * there is nothing eligible — a deliberate cancel is never resurrected.
   */
  async restore(roomId: string, userId: string, ip?: string): Promise<VideoRoomSeatRequestView | null> {
    const latest = await this.seats.findLatestRequestForUser(roomId, userId);
    if (!latest || latest.status !== VideoRoomSeatRequestStatus.EXPIRED) return null;
    if (!canTransitionRequest(latest.status, VideoRoomSeatRequestStatus.PENDING)) return null;

    const expiresAt = new Date(Date.now() + VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS * 1000);
    const restored = await this.seats.restoreRequest(latest.id, userId, expiresAt);
    await this.events.appendEvent({
      roomId,
      actorId: userId,
      eventType: 'seat.request_restored',
      payload: { requestId: latest.id, ...(ip ? { ip } : {}) },
    });
    // Original createdAt → identical score → identical queue position.
    await this.queue.enqueue(roomId, userId, latest.createdAt);
    return toVideoRoomSeatRequestView(restored);
  }
```

- [ ] **Step 7: Rewrite `listRequests` to use queue positions**

Replace the whole `listRequests` method:

```ts
  /** Pending requests in queue order, each carrying its 1-based position. */
  async listRequests(
    actor: RoomActor,
    roomId: string,
  ): Promise<Array<VideoRoomSeatRequestView & { position: number | null }>> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const pending = await this.seats.listPendingRequests(roomId);
    const rows = await Promise.all(
      pending.map(async (req) => ({
        ...toVideoRoomSeatRequestView(req),
        position: await this.queue.position(roomId, req.userId),
      })),
    );
    return rows.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  }
```

- [ ] **Step 8: Add the repository method `restore` depends on**

In `src/modules/video-rooms/repositories/video-room-seats.repository.ts`:

```ts
  /** VR-8 — the user's most recent request in a room, whatever its status. */
  async findLatestRequestForUser(
    roomId: string,
    userId: string,
  ): Promise<VideoRoomSeatRequest | null> {
    return this.prisma.videoRoomSeatRequest.findFirst({
      where: { roomId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-request.service.spec.ts`

Expected: PASS — the pre-existing tests plus ~19 new ones.

- [ ] **Step 10: Verify**

Run: `npx tsc --noEmit`

Expected: exit 0 **except** for `compareRequestPriority` import errors in the old spec file — delete those imports and any test that exercised the deleted function, since `computeQueueScore` now owns that behaviour and is tested in Task 2.

---

### Task 9: Invitation service — validations, DELIVERED, FAILED, retry, cancel route support

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-seat-invitation.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `canTransitionInvitation` (Task 7); `VideoRoomModerationRepository.findActiveBlock`; `VideoRoomsRepository.getMember`; `VideoRoomSeatsRepository.setInvitationStatus(…, opts)` (Task 4); `SeatInvitationDeliveredEvent` (Task 3); `VIDEO_ROOM_INVITATION_MAX_ATTEMPTS` (Task 1)
- Produces, on `VideoRoomSeatInvitationService`:
  - `invite(...)` — **extended** with 4 validations
  - `accept(...)` — **extended** to emit FAILED on seating failure
  - `acknowledge(actor, roomId, invitationId, ip?): Promise<VideoRoomInvitationView>`
  - `retry(actor, roomId, invitationId, ip?): Promise<SeatStageView>`
  - `listInvitations(actor, roomId): Promise<VideoRoomInvitationView[]>`

- [ ] **Step 1: Write the failing tests**

Create or extend `src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts`:

```ts
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomSeatInvitationService } from './video-room-seat-invitation.service';

const actor = (id: string) => ({ id, roles: [] as never[] });

describe('VideoRoomSeatInvitationService — VR-8', () => {
  let deps: any;
  let svc: VideoRoomSeatInvitationService;

  beforeEach(() => {
    deps = {
      seatSvc: {
        requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }),
        seatUser: jest.fn().mockResolvedValue({ roomId: 'r1', version: 4, seats: [] }),
        findOpenSeat: jest.fn().mockResolvedValue(3),
      },
      seats: {
        listPendingInvitations: jest.fn().mockResolvedValue([]),
        createInvitation: jest.fn().mockResolvedValue({
          id: 'i1', inviterId: 'owner', inviteeUserId: 'u2', type: 'SEAT',
          seatIndex: 3, status: 'PENDING', expiresAt: new Date(Date.now() + 120_000),
        }),
        findInvitationById: jest.fn(),
        setInvitationStatus: jest.fn(),
        findOccupiedSeat: jest.fn().mockResolvedValue(null),
        findSeat: jest.fn().mockResolvedValue({ seatIndex: 3, isLocked: false, seatStatus: 'EMPTY' }),
      },
      permissions: { assertPermission: jest.fn() },
      events: { appendEvent: jest.fn() },
      bus: { publish: jest.fn() },
      moderation: { findActiveBlock: jest.fn().mockResolvedValue(null) },
      rooms: { getMember: jest.fn().mockResolvedValue({ isActive: true }) },
    };
    svc = new VideoRoomSeatInvitationService(
      deps.seatSvc, deps.seats, deps.permissions, deps.events,
      deps.bus, deps.moderation, deps.rooms,
    );
  });

  describe('invite validations', () => {
    it('refuses a target who is not an active member', async () => {
      deps.rooms.getMember.mockResolvedValue({ isActive: false });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('refuses a target already holding a seat', async () => {
      deps.seats.findOccupiedSeat.mockResolvedValue({ seatIndex: 1 });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        code: ERROR_CODES.ALREADY_ON_SEAT,
      });
    });

    it('refuses a target blocked from the room', async () => {
      deps.moderation.findActiveBlock.mockResolvedValue({ id: 'b1' });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_BLOCKED,
      });
    });

    it('refuses an invitation onto a locked seat', async () => {
      deps.seats.findSeat.mockResolvedValue({ seatIndex: 3, isLocked: true, seatStatus: 'EMPTY' });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        code: ERROR_CODES.SEAT_LOCKED,
      });
    });

    it('refuses an invitation onto a reserved seat', async () => {
      deps.seats.findSeat.mockResolvedValue({ seatIndex: 3, isLocked: false, seatStatus: 'RESERVED' });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        code: ERROR_CODES.SEAT_RESERVED,
      });
    });

    it('refuses an invitation onto an occupied seat', async () => {
      deps.seats.findSeat.mockResolvedValue({ seatIndex: 3, isLocked: false, seatStatus: 'OCCUPIED' });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        code: ERROR_CODES.SEAT_TAKEN,
      });
    });

    it('sends the invitation when every check passes', async () => {
      const view = await svc.invite(actor('owner'), 'r1', 'u2', 3);
      expect(view.id).toBe('i1');
      expect(deps.seats.createInvitation).toHaveBeenCalled();
    });
  });

  describe('acknowledge', () => {
    beforeEach(() => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1', roomId: 'r1', inviteeUserId: 'u2', status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      });
      deps.seats.setInvitationStatus.mockResolvedValue({
        id: 'i1', inviterId: 'owner', inviteeUserId: 'u2', type: 'SEAT',
        seatIndex: 3, status: 'DELIVERED', expiresAt: new Date(),
      });
    });

    it('marks the invitation DELIVERED and stamps the time', async () => {
      await svc.acknowledge(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1', 'DELIVERED', 'u2', expect.objectContaining({ deliveredAt: expect.any(Date) }),
      );
    });

    it('publishes a delivered event', async () => {
      await svc.acknowledge(actor('u2'), 'r1', 'i1');
      expect(deps.bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.seat_invitation_delivered' }),
      );
    });

    it('lets only the invitee acknowledge', async () => {
      await expect(svc.acknowledge(actor('someone-else'), 'r1', 'i1')).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('is idempotent — re-acking an already DELIVERED invitation is a no-op', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1', roomId: 'r1', inviteeUserId: 'u2', status: 'DELIVERED',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await svc.acknowledge(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).not.toHaveBeenCalled();
    });
  });

  describe('accept failure path', () => {
    beforeEach(() => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1', roomId: 'r1', inviteeUserId: 'u2', seatIndex: 3,
        status: 'DELIVERED', attemptCount: 0, expiresAt: new Date(Date.now() + 60_000),
      });
    });

    it('marks the invitation FAILED and rethrows when seating throws', async () => {
      deps.seatSvc.seatUser.mockRejectedValue(new Error('seat taken'));
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).rejects.toThrow('seat taken');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1', 'FAILED', 'u2',
        expect.objectContaining({ bumpAttempt: true, lastError: 'seat taken' }),
      );
    });

    it('accepts from DELIVERED just as it does from PENDING', async () => {
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).resolves.toBeDefined();
    });
  });

  describe('retry', () => {
    it('refuses to retry an invitation that is not FAILED', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1', roomId: 'r1', inviteeUserId: 'u2', status: 'PENDING',
        attemptCount: 0, expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.retry(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        code: ERROR_CODES.SEAT_INVITATION_INVALID_TRANSITION,
      });
    });

    it('refuses once the attempt budget is exhausted', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1', roomId: 'r1', inviteeUserId: 'u2', status: 'FAILED',
        attemptCount: 3, expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.retry(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        code: ERROR_CODES.SEAT_RETRY_EXHAUSTED,
      });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts`

Expected: FAIL — constructor arity mismatch / `svc.acknowledge is not a function`.

- [ ] **Step 3: Add the two new dependencies**

In `src/modules/video-rooms/services/video-room-seat-invitation.service.ts`, extend the imports and constructor:

```ts
import { VideoRoomSeatStatus } from '@prisma/client';
import { VIDEO_ROOM_INVITATION_MAX_ATTEMPTS } from '../constants/video-room.constants';
import { canTransitionInvitation } from '../constants/video-room-seat-workflow';
import { SeatInvitationDeliveredEvent } from '../events/video-room-seat.events';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
```

```ts
  constructor(
    private readonly seatSvc: VideoRoomSeatService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly rooms: VideoRoomsRepository,
  ) {}
```

- [ ] **Step 4: Add the invite validations**

In `invite`, insert after the `assertPermission` call and before the duplicate check:

```ts
    const member = await this.rooms.getMember(roomId, inviteeUserId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'That user is not an active member of this room.',
        HttpStatus.CONFLICT,
      );
    }
    if (await this.seats.findOccupiedSeat(roomId, inviteeUserId)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_ON_SEAT,
        'That user already holds a seat.',
        HttpStatus.CONFLICT,
      );
    }
    if (await this.moderation.findActiveBlock(roomId, inviteeUserId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'That user is blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (seatIndex !== undefined) {
      const seat = await this.seats.findSeat(roomId, seatIndex);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.SEAT_NOT_FOUND,
          'That seat does not exist in this room.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (seat.isLocked) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.seatStatus === VideoRoomSeatStatus.RESERVED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_RESERVED,
          'That seat is reserved.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.seatStatus === VideoRoomSeatStatus.OCCUPIED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_TAKEN,
          'That seat is already occupied.',
          HttpStatus.CONFLICT,
        );
      }
    }
```

- [ ] **Step 5: Wrap `accept`'s seating in the FAILED path**

Replace the seating portion of `accept`:

```ts
    const seatIndex = inv.seatIndex ?? (await this.seatSvc.findOpenSeat(actor, roomId));
    let view;
    try {
      view = await this.seatSvc.seatUser(roomId, actor.id, actor.id, seatIndex, ip);
    } catch (err) {
      const message = (err as Error).message;
      await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.FAILED, actor.id, {
        bumpAttempt: true,
        lastError: message,
      });
      await this.events.appendEvent({
        roomId,
        actorId: actor.id,
        eventType: 'seat.invitation_failed',
        payload: { invitationId: inv.id, reason: message, ...(ip ? { ip } : {}) },
      });
      await this.bus.publish(
        new SeatInvitationResolvedEvent({
          roomId,
          invitationId: inv.id,
          inviteeUserId: actor.id,
          status: 'FAILED',
        }),
      );
      throw err;
    }
    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.ACCEPTED, actor.id, {
      bumpAttempt: true,
      lastError: null,
    });
```

- [ ] **Step 6: Allow accept/reject/cancel from DELIVERED as well as PENDING**

In `requirePendingInvitation`, replace the status check so `DELIVERED` is equally actionable:

```ts
    const actionable: VideoRoomInvitationStatus[] = [
      VideoRoomInvitationStatus.PENDING,
      VideoRoomInvitationStatus.DELIVERED,
    ];
    if (!actionable.includes(inv.status)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation is no longer actionable.',
        HttpStatus.CONFLICT,
      );
    }
```

- [ ] **Step 7: Add `acknowledge`, `retry`, and `listInvitations`**

Append before the `// ---- Internal ----` marker:

```ts
  /**
   * The invitee's client confirms it received the invitation → DELIVERED.
   * Idempotent: acknowledging twice is a no-op, so a client that retries its ack
   * after a flaky socket does not produce a second event.
   */
  async acknowledge(
    actor: RoomActor,
    roomId: string,
    invitationId: string,
    ip?: string,
  ): Promise<VideoRoomInvitationView> {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may acknowledge this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (inv.status === VideoRoomInvitationStatus.DELIVERED) {
      return toVideoRoomInvitationView(inv);
    }

    const deliveredAt = new Date();
    const updated = await this.seats.setInvitationStatus(
      inv.id,
      VideoRoomInvitationStatus.DELIVERED,
      actor.id,
      { deliveredAt },
    );
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_delivered',
      payload: { invitationId: inv.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationDeliveredEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: actor.id,
        deliveredAt: deliveredAt.toISOString(),
      }),
    );
    return toVideoRoomInvitationView(updated);
  }

  /** Re-drive a FAILED invitation's seating (invitee only), bounded by attemptCount. */
  async retry(actor: RoomActor, roomId: string, invitationId: string, ip?: string) {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.seats.findInvitationById(invitationId);
    if (!inv || inv.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may retry this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!canTransitionInvitation(inv.status, VideoRoomInvitationStatus.PENDING)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_INVALID_TRANSITION,
        `An invitation in state ${inv.status} cannot be retried.`,
        HttpStatus.CONFLICT,
      );
    }
    if (inv.attemptCount >= VIDEO_ROOM_INVITATION_MAX_ATTEMPTS) {
      throw new BusinessException(
        ERROR_CODES.SEAT_RETRY_EXHAUSTED,
        `This invitation has already used all ${VIDEO_ROOM_INVITATION_MAX_ATTEMPTS} seating attempts.`,
        HttpStatus.CONFLICT,
      );
    }

    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.PENDING, actor.id, {
      lastError: null,
    });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_retried',
      payload: { invitationId: inv.id, attempt: inv.attemptCount + 1, ...(ip ? { ip } : {}) },
    });
    return this.accept(actor, roomId, inv.id, ip);
  }

  /** Outstanding invitations for the room (owner/admin; INVITE_USERS). */
  async listInvitations(actor: RoomActor, roomId: string): Promise<VideoRoomInvitationView[]> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.INVITE_USERS);
    const rows = await this.seats.listPendingInvitations(roomId);
    return rows.map(toVideoRoomInvitationView);
  }
```

- [ ] **Step 8: Widen the repository's pending-invitation query to include DELIVERED**

In `src/modules/video-rooms/repositories/video-room-seats.repository.ts`, update `listPendingInvitations`'s `where.status` so acknowledged invitations still appear as outstanding:

```ts
      where: {
        roomId,
        ...(inviteeUserId ? { inviteeUserId } : {}),
        status: {
          in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED],
        },
      },
```

> Keep the existing optional `inviteeUserId` parameter and its behaviour — `invite`'s duplicate check calls it with a user, `listInvitations` calls it without.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts`

Expected: PASS — 16 tests.

- [ ] **Step 10: Verify**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/services`

Expected: tsc exit 0; all video-room service suites green.

---

### Task 10: `VideoRoomSeatQueueListener` — auto-advance wiring

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-seat-queue.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-seat-queue.listener.spec.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`

**Interfaces:**
- Consumes: `VideoRoomSeatQueueService` (Tasks 5–6); `VideoRoomSeatRequestService.restore` (Task 8); `VIDEO_ROOM_SEAT_EVENTS`, `VIDEO_ROOM_EVENTS`; `VideoRoomsRepository.getSettings`
- Produces: `VideoRoomSeatQueueListener` (an `OnModuleInit` subscriber; no public API)

> **This listener is the entire reason `VideoRoomSeatService` stays clean.** Every queue side effect of a seat/room lifecycle change is wired here, so the seat service never learns that a queue exists. If a future change tempts you to call the queue from inside the seat service, add a subscription here instead.
>
> ### ⚠️ CRITICAL — the seat-freed handler MUST NOT run on the publisher's stack
>
> Discovered during Task 6 review and verified in source. `VideoRoomSeatService.applyVacate`
> publishes `SeatLeftEvent` at
> [video-room-seat.service.ts:691](../../../src/modules/video-rooms/services/video-room-seat.service.ts#L691)
> — and `applyVacate` is the `fn` that `mutateStage` runs **inside**
> `withLock(videoRoomSeatLockKey(roomId))`. `InMemoryEventBus.publish` uses
> `emitAsync`, which **awaits its listeners on the publisher's own stack**.
>
> So a listener that directly `await`s `queue.advance(...)` produces:
>
> ```
> leaveSeat → withLock(video-room:seat:{r})       ← acquired
>   └ applyVacate → bus.publish(SeatLeftEvent)
>       └ (awaited listener) → advance
>           └ withLock(video-room:seatq:lock:{r})  ← fine, different key
>               └ seatUser → mutateStage
>                   └ withLock(video-room:seat:{r}) ← SAME KEY, STILL HELD → deadlock
> ```
>
> `LockService` is not re-entrant (`SET NX`), so the inner acquire burns 21 retries
> × 100 ms ≈ **2.1 s per candidate** and then throws — up to ~42 s for a full
> preview window, inside a blocked "leave seat" request. Worse, both locks carry a
> non-extended 10 s TTL, so the OUTER lock silently expires mid-operation and
> mutual exclusion is lost.
>
> **Using a distinct queue lock key (Task 6) does not prevent this** — the
> collision is transitive, through the event bus.
>
> **Required:** the seat-freed handler must schedule its work OFF the publisher's
> stack so the seat lock is released first. Return synchronously from the
> subscriber and defer with `setImmediate`, which runs after the current
> operation (and therefore after `withLock`'s release) completes:
>
> ```ts
> this.bus.subscribe<SeatLeftEvent>(VIDEO_ROOM_SEAT_EVENTS.LEFT, (e) => {
>   // Deferred: the publisher still holds videoRoomSeatLockKey at this point.
>   setImmediate(() => {
>     void this.guard('seat-left', () =>
>       this.onSeatFreed(e.payload.roomId, e.payload.seatIndex),
>     );
>   });
> });
> ```
>
> Apply the same deferral to the `RELEASED` subscription. The `TAKEN`,
> `USER_LEFT`, `USER_RECONNECTED`, `CLOSED` and `DELETED` handlers do not call
> `seatUser` and so may stay synchronous — but note `TAKEN` is also published from
> inside the seat lock, so if it ever grows a seating call it must be deferred too.
>
> We fix this in the listener rather than by moving `bus.publish` outside
> `mutateStage`, because that file is approved Phase-4 code with several publish
> sites whose ordering other listeners may already depend on.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/listeners/video-room-seat-queue.listener.spec.ts`:

```ts
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatQueueListener } from './video-room-seat-queue.listener';

describe('VideoRoomSeatQueueListener', () => {
  let deps: any;
  let listener: VideoRoomSeatQueueListener;
  let handlers: Record<string, (e: any) => Promise<void>>;

  beforeEach(() => {
    handlers = {};
    deps = {
      bus: {
        subscribe: jest.fn((type: string, fn: (e: any) => Promise<void>) => {
          handlers[type] = fn;
        }),
      },
      queue: {
        advance: jest.fn().mockResolvedValue('u1'),
        dequeue: jest.fn(),
        clear: jest.fn(),
        publishUpdate: jest.fn(),
      },
      requests: { restore: jest.fn().mockResolvedValue(null) },
      rooms: { getSettings: jest.fn().mockResolvedValue({ seatApprovalRequired: false }) },
    };
    listener = new VideoRoomSeatQueueListener(deps.bus, deps.queue, deps.requests, deps.rooms);
    listener.onModuleInit();
  });

  it('auto-advances onto a freed seat when the room does not require approval', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    expect(deps.queue.advance).toHaveBeenCalledWith('r1', 3, expect.any(String));
  });

  it('does NOT auto-advance when the room requires approval — it only refreshes the queue', async () => {
    deps.rooms.getSettings.mockResolvedValue({ seatApprovalRequired: true });
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    expect(deps.queue.advance).not.toHaveBeenCalled();
    expect(deps.queue.publishUpdate).toHaveBeenCalledWith('r1');
  });

  it('defaults to approval-required when a room has no settings row', async () => {
    deps.rooms.getSettings.mockResolvedValue(null);
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    expect(deps.queue.advance).not.toHaveBeenCalled();
  });

  it('auto-advances on a released reservation too', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.RELEASED]({ payload: { roomId: 'r1', seatIndex: 4 } });
    expect(deps.queue.advance).toHaveBeenCalledWith('r1', 4, expect.any(String));
  });

  it('never auto-advances onto the owner seat', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 0 } });
    expect(deps.queue.advance).not.toHaveBeenCalled();
  });

  it('dequeues a user who has just been seated', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.TAKEN]({
      payload: { roomId: 'r1', userId: 'u1', seatIndex: 2 },
    });
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  it('dequeues a user who leaves the room', async () => {
    await handlers['video_room.user_left']({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  it('restores a reconnecting user’s expired request', async () => {
    await handlers['video_room.user_reconnected']({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(deps.requests.restore).toHaveBeenCalledWith('r1', 'u1');
  });

  it('clears the whole projection when the room closes', async () => {
    await handlers['video_room.closed']({ payload: { roomId: 'r1' } });
    expect(deps.queue.clear).toHaveBeenCalledWith('r1');
  });

  it('swallows a queue failure so one bad advance cannot kill the event bus', async () => {
    deps.queue.advance.mockRejectedValue(new Error('redis down'));
    await expect(
      handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-queue.listener.spec.ts`

Expected: FAIL — `Cannot find module './video-room-seat-queue.listener'`.

- [ ] **Step 3: Confirm the exact room event type names before writing the listener**

Run:

```bash
grep -n "user_left\|user_reconnected\|room.closed\|VIDEO_ROOM_EVENTS = " -A 2 src/modules/video-rooms/events/video-room.events.ts | head -40
```

Use the constants this prints (e.g. `VIDEO_ROOM_EVENTS.USER_LEFT`) in Step 4 rather than the raw strings — the test's string keys must match whatever these constants resolve to. If a name differs from the test's literal, update the test literal to match the constant.

- [ ] **Step 4: Write the implementation**

Create `src/modules/video-rooms/listeners/video-room-seat-queue.listener.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_OWNER_SEAT_INDEX } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_EVENTS,
  type RoomClosedEvent,
  type RoomDeletedEvent,
  type UserLeftEvent,
  type UserReconnectedEvent,
} from '../events/video-room.events';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatLeftEvent,
  type SeatReleasedEvent,
  type SeatTakenEvent,
} from '../events/video-room-seat.events';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomSeatQueueService } from '../services/video-room-seat-queue.service';
import { VideoRoomSeatRequestService } from '../services/video-room-seat-request.service';

/** Actor recorded on seatings the system performs with no human behind them. */
const SYSTEM_ACTOR = 'system';

/**
 * VR-8 — the only place seat/room lifecycle changes touch the seat queue.
 *
 * Keeping this in a listener is what lets `VideoRoomSeatService` stay ignorant
 * of the queue entirely: it publishes the same events it always did, and the
 * queue reacts. Every handler is defensive — a queue failure is logged and
 * swallowed, because a Redis blip must not take down the event bus or fail the
 * seat operation that triggered it.
 */
@Injectable()
export class VideoRoomSeatQueueListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomSeatQueueListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly queue: VideoRoomSeatQueueService,
    private readonly requests: VideoRoomSeatRequestService,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatLeftEvent>(VIDEO_ROOM_SEAT_EVENTS.LEFT, (e) =>
      this.guard('seat-left', () => this.onSeatFreed(e.payload.roomId, e.payload.seatIndex)),
    );
    this.bus.subscribe<SeatReleasedEvent>(VIDEO_ROOM_SEAT_EVENTS.RELEASED, (e) =>
      this.guard('seat-released', () => this.onSeatFreed(e.payload.roomId, e.payload.seatIndex)),
    );
    this.bus.subscribe<SeatTakenEvent>(VIDEO_ROOM_SEAT_EVENTS.TAKEN, (e) =>
      this.guard('seat-taken', () => this.queue.dequeue(e.payload.roomId, e.payload.userId)),
    );
    this.bus.subscribe<UserLeftEvent>(VIDEO_ROOM_EVENTS.USER_LEFT, (e) =>
      this.guard('user-left', () => this.queue.dequeue(e.payload.roomId, e.payload.userId)),
    );
    this.bus.subscribe<UserReconnectedEvent>(VIDEO_ROOM_EVENTS.USER_RECONNECTED, (e) =>
      this.guard('user-reconnected', async () => {
        await this.requests.restore(e.payload.roomId, e.payload.userId);
      }),
    );
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) =>
      this.guard('room-closed', () => this.queue.clear(e.payload.roomId)),
    );
    this.bus.subscribe<RoomDeletedEvent>(VIDEO_ROOM_EVENTS.DELETED, (e) =>
      this.guard('room-deleted', () => this.queue.clear(e.payload.roomId)),
    );
  }

  /**
   * A seat became available. Auto-promote the front of the queue only when the
   * room has opted out of approval; otherwise just refresh everyone's position
   * so the UI reflects the newly open seat.
   */
  private async onSeatFreed(roomId: string, seatIndex: number): Promise<void> {
    if (seatIndex === VIDEO_ROOM_OWNER_SEAT_INDEX) return; // the owner seat is never queued for

    const settings = await this.rooms.getSettings(roomId);
    // Absent settings ⇒ platform default ⇒ approval required.
    if (settings?.seatApprovalRequired !== false) {
      await this.queue.publishUpdate(roomId);
      return;
    }
    await this.queue.advance(roomId, seatIndex, SYSTEM_ACTOR);
  }

  /** Run a handler, logging and swallowing any failure. */
  private async guard(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Seat queue listener (${label}) failed: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 5: Confirm `getSettings` exists on the rooms repository**

Run:

```bash
grep -n "async getSettings" src/modules/video-rooms/repositories/video-rooms.repository.ts
```

If it does not exist, add it:

```ts
  /** A room's settings row, or null when it has none. */
  async getSettings(roomId: string) {
    return this.prisma.videoRoomSettings.findUnique({ where: { roomId } });
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-queue.listener.spec.ts`

Expected: PASS — 13 tests (10 policy + 3 degenerate-input guards).

- [ ] **Step 7: Export from the listeners barrel**

In `src/modules/video-rooms/listeners/index.ts`:

```ts
export * from './video-room-seat-queue.listener';
```

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit`

Expected: exit 0.

---

### Task 11: Socket listener — exhaustive status map (fixes a live mislabeling bug)

**Files:**
- Modify: `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts` (extend; create if absent)

**Interfaces:**
- Consumes: the 4 new events + widened unions (Task 3); the 6 new socket names (Task 3)
- Produces: no new public API — the listener's behaviour changes

> **⚠️ This task fixes a bug that is live in production today.** The listener
> currently branches
> `e.payload.status === 'ACCEPTED' ? SEAT_APPROVED : SEAT_REJECTED`
> ([video-room-seat-socket.listener.ts:63](../../../src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts#L63), and again at L77 for invitations).
> So a request the user **cancelled**, or one that **expired**, is broadcast to
> the entire room as `seat_rejected` — every client is told the host rejected
> someone when nothing of the sort happened.
>
> Task 3 widened the union with `PROMOTED` and `FAILED`, which would make it
> worse: a *successful* promotion would also broadcast as "rejected". Replacing
> both ternaries with an exhaustive map is therefore **required**, not optional.

- [ ] **Step 1: Write the failing tests**

Create or extend `src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`:

```ts
import { VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatSocketListener } from './video-room-seat-socket.listener';

describe('VideoRoomSeatSocketListener — VR-8 status routing', () => {
  let deps: any;
  let handlers: Record<string, (e: any) => void>;

  const fire = (type: string, payload: any) => handlers[type]({ payload });
  const emitted = () => deps.sockets.emitToNamespaceRoom.mock.calls.map((c: any[]) => c[2]);

  beforeEach(() => {
    handlers = {};
    deps = {
      bus: { subscribe: jest.fn((t: string, fn: (e: any) => void) => { handlers[t] = fn; }) },
      sockets: { emitToNamespaceRoom: jest.fn() },
    };
    new VideoRoomSeatSocketListener(deps.bus, deps.sockets).onModuleInit();
  });

  describe('request resolutions map to distinct events', () => {
    it.each([
      ['ACCEPTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED],
      ['PROMOTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED],
      ['REJECTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED],
      ['FAILED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED],
      ['CANCELLED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_CANCELLED],
      ['EXPIRED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED],
    ])('routes %s to %s', (status, expected) => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status });
      expect(emitted()).toEqual([expected]);
    });

    it('REGRESSION: a cancelled request is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'CANCELLED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
    });

    it('REGRESSION: an expired request is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'EXPIRED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
    });

    it('REGRESSION: a successful promotion is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'PROMOTED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
    });

    it('emits nothing for a status it does not recognise', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'WAT' });
      expect(deps.sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
    });
  });

  describe('invitation resolutions map to distinct events', () => {
    it.each([
      ['ACCEPTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED],
      ['REJECTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED],
      ['FAILED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED],
      ['CANCELLED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_CANCELLED],
      ['EXPIRED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED],
    ])('routes %s to %s', (status, expected) => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status });
      expect(emitted()).toEqual([expected]);
    });

    it('REGRESSION: a cancelled invitation is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status: 'CANCELLED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED);
    });
  });

  describe('the four new events', () => {
    it('bridges a request expiry', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, { roomId: 'r1', requestId: 'q1', userId: 'u1' });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED]);
    });

    it('bridges an invitation expiry', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED, { roomId: 'r1', invitationId: 'i1', inviteeUserId: 'u2' });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED]);
    });

    it('bridges an invitation delivery ack', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED, { roomId: 'r1', invitationId: 'i1' });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_DELIVERED]);
    });

    it('bridges a queue update', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, { roomId: 'r1', size: 3, top: [] });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_QUEUE_UPDATED]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`

Expected: FAIL — `CANCELLED` currently routes to `SEAT_REJECTED`, and the four new event types have no subscriber.

- [ ] **Step 3: Replace both ternaries with exhaustive maps**

In `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts`, add these module-level maps above the class:

```ts
/**
 * Request resolution → outbound socket event.
 *
 * Declared exhaustively rather than as a ternary: the previous
 * `status === 'ACCEPTED' ? approved : rejected` shape announced CANCELLED and
 * EXPIRED resolutions to the whole room as `seat_rejected`, and would have done
 * the same to VR-8's PROMOTED. An unmapped status emits nothing at all, which is
 * always safer than emitting the wrong thing.
 */
const REQUEST_RESOLUTION_EVENTS: Partial<Record<SeatRequestResolution, string>> = {
  ACCEPTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED,
  PROMOTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED,
  REJECTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED,
  FAILED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED,
  CANCELLED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_CANCELLED,
  EXPIRED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED,
};

/** Invitation resolution → outbound socket event. Same rationale as above. */
const INVITATION_RESOLUTION_EVENTS: Partial<Record<SeatInvitationResolution, string>> = {
  ACCEPTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED,
  REJECTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED,
  FAILED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED,
  CANCELLED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_CANCELLED,
  EXPIRED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED,
};
```

Add `type SeatRequestResolution` and `type SeatInvitationResolution` to the existing import from `'../events/video-room-seat.events'`.

Then replace the two subscriptions:

```ts
    this.bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) => {
      const event = REQUEST_RESOLUTION_EVENTS[e.payload.status];
      if (event) this.emit(e.payload.roomId, event, e.payload);
    });
```

```ts
    this.bus.subscribe<SeatInvitationResolvedEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED,
      (e) => {
        const event = INVITATION_RESOLUTION_EVENTS[e.payload.status];
        if (event) this.emit(e.payload.roomId, event, e.payload);
      },
    );
```

- [ ] **Step 4: Subscribe to the four new events**

Append inside `onModuleInit`:

```ts
    this.bus.subscribe<SeatRequestExpiredEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED, e.payload),
    );
    this.bus.subscribe<SeatInvitationExpiredEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED,
      (e) =>
        this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED, e.payload),
    );
    this.bus.subscribe<SeatInvitationDeliveredEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED,
      (e) =>
        this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_DELIVERED, e.payload),
    );
    this.bus.subscribe<SeatQueueUpdatedEvent>(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_QUEUE_UPDATED, e.payload),
    );
```

Add the four event types to the existing type-only import block.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`

Expected: PASS — 19 tests, including the four REGRESSION guards.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`

Expected: both clean.

---

### Task 12: Expiry monitor — per-row events

**Files:**
- Modify: `src/modules/video-rooms/scheduler/video-room-seat.monitor.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-seat.monitor.spec.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `listExpiredRequests` / `listExpiredInvitations` (Task 4); `SeatRequestExpiredEvent` / `SeatInvitationExpiredEvent` (Task 3); `VideoRoomSeatQueueService.dequeue` (Task 5); `VIDEO_ROOM_EXPIRY_SWEEP_LIMIT` (Task 1)
- Produces: no new public API — `sweep()` now emits per row

- [ ] **Step 1: Write the failing tests**

Create or extend `src/modules/video-rooms/scheduler/video-room-seat.monitor.spec.ts`:

```ts
import { VideoRoomSeatMonitor } from './video-room-seat.monitor';

describe('VideoRoomSeatMonitor — VR-8 per-row expiry', () => {
  let deps: any;
  let monitor: VideoRoomSeatMonitor;

  const runSweep = () => (monitor as any).sweep();

  beforeEach(() => {
    deps = {
      seats: {
        listExpiredRequests: jest.fn().mockResolvedValue([]),
        listExpiredInvitations: jest.fn().mockResolvedValue([]),
        setRequestStatus: jest.fn(),
        setInvitationStatus: jest.fn(),
        listReservedSeats: jest.fn().mockResolvedValue([]),
      },
      reservations: { releaseExpired: jest.fn().mockResolvedValue(false) },
      cache: { get: jest.fn().mockResolvedValue(null) },
      locks: { acquire: jest.fn().mockResolvedValue(async () => undefined) },
      config: { get: jest.fn().mockReturnValue(undefined) },
      queue: { dequeue: jest.fn(), publishUpdate: jest.fn() },
      bus: { publish: jest.fn() },
    };
    monitor = new VideoRoomSeatMonitor(
      deps.seats, deps.reservations, deps.cache, deps.locks,
      deps.config, deps.queue, deps.bus,
    );
  });

  it('publishes one expiry event per expired request', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([
      { id: 'q1', roomId: 'r1', userId: 'u1' },
      { id: 'q2', roomId: 'r1', userId: 'u2' },
    ]);
    await runSweep();
    const names = deps.bus.publish.mock.calls.map((c: any[]) => c[0].name);
    expect(names.filter((n: string) => n === 'video_room.seat_request_expired')).toHaveLength(2);
  });

  it('marks each expired request EXPIRED in the database', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([{ id: 'q1', roomId: 'r1', userId: 'u1' }]);
    await runSweep();
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1', 'EXPIRED', expect.any(String), expect.any(String),
    );
  });

  it('removes each expired requester from the queue', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([{ id: 'q1', roomId: 'r1', userId: 'u1' }]);
    await runSweep();
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  it('publishes one expiry event per expired invitation', async () => {
    deps.seats.listExpiredInvitations.mockResolvedValue([
      { id: 'i1', roomId: 'r1', inviteeUserId: 'u2' },
    ]);
    await runSweep();
    const names = deps.bus.publish.mock.calls.map((c: any[]) => c[0].name);
    expect(names).toContain('video_room.seat_invitation_expired');
  });

  it('bounds each collection by the sweep limit', async () => {
    await runSweep();
    expect(deps.seats.listExpiredRequests).toHaveBeenCalledWith(expect.any(Date), 500);
    expect(deps.seats.listExpiredInvitations).toHaveBeenCalledWith(expect.any(Date), 500);
  });

  it('does nothing when another instance holds the sweep lock', async () => {
    deps.locks.acquire.mockResolvedValue(null);
    await runSweep();
    expect(deps.seats.listExpiredRequests).not.toHaveBeenCalled();
  });

  it('publishes nothing when there is nothing to expire', async () => {
    await runSweep();
    expect(deps.bus.publish).not.toHaveBeenCalled();
  });

  it('keeps sweeping after one row fails', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([
      { id: 'q1', roomId: 'r1', userId: 'u1' },
      { id: 'q2', roomId: 'r1', userId: 'u2' },
    ]);
    deps.seats.setRequestStatus.mockRejectedValueOnce(new Error('row gone'));
    await runSweep();
    expect(deps.seats.setRequestStatus).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/scheduler/video-room-seat.monitor.spec.ts`

Expected: FAIL — constructor arity mismatch; `bus.publish` never called.

- [ ] **Step 3: Add the two new dependencies**

In `src/modules/video-rooms/scheduler/video-room-seat.monitor.ts`, extend the imports and constructor:

```ts
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VideoRoomSeatRequestStatus, VideoRoomInvitationStatus } from '@prisma/client';
import {
  VIDEO_ROOM_EXPIRY_SWEEP_LIMIT,
  VIDEO_ROOM_SEAT_MONITOR_LOCK_KEY,
  videoRoomSeatReservationKey,
} from '../constants/video-room.constants';
import {
  SeatInvitationExpiredEvent,
  SeatRequestExpiredEvent,
} from '../events/video-room-seat.events';
import { VideoRoomSeatQueueService } from '../services/video-room-seat-queue.service';
```

```ts
  constructor(
    private readonly seats: VideoRoomSeatsRepository,
    private readonly reservations: VideoRoomSeatReservationService,
    private readonly cache: CacheService,
    private readonly locks: LockService,
    config: ConfigService,
    private readonly queue: VideoRoomSeatQueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    this.intervalMs = loadVideoRoomConfig(config).cleanupIntervalSeconds * 1000;
  }
```

Add `Inject` to the `@nestjs/common` import.

- [ ] **Step 4: Replace the silent bulk expiry with a per-row pass**

Inside `sweep()`, replace the `Promise.all([this.seats.expireStaleRequests(now), this.seats.expireStaleInvitations(now)])` block with:

```ts
        const now = new Date();
        const expiredRequests = await this.expireRequests(now);
        const expiredInvitations = await this.expireInvitations(now);
```

and add these two private methods to the class:

```ts
  /**
   * Expire stale requests one at a time so each can publish its own event —
   * the previous bulk `updateMany` returned only a count, so clients were never
   * told their request had lapsed. One row's failure does not abort the sweep.
   */
  private async expireRequests(now: Date): Promise<number> {
    const rows = await this.seats.listExpiredRequests(now, VIDEO_ROOM_EXPIRY_SWEEP_LIMIT);
    const touchedRooms = new Set<string>();
    let expired = 0;

    for (const row of rows) {
      try {
        await this.seats.setRequestStatus(
          row.id,
          VideoRoomSeatRequestStatus.EXPIRED,
          SWEEP_ACTOR,
          SWEEP_ACTOR,
        );
        await this.queue.dequeue(row.roomId, row.userId);
        await this.bus.publish(
          new SeatRequestExpiredEvent({
            roomId: row.roomId,
            requestId: row.id,
            userId: row.userId,
          }),
        );
        touchedRooms.add(row.roomId);
        expired += 1;
      } catch (err) {
        this.logger.warn(`Failed to expire seat request ${row.id}: ${(err as Error).message}`);
      }
    }

    for (const roomId of touchedRooms) {
      await this.queue.publishUpdate(roomId).catch(() => undefined);
    }
    return expired;
  }

  /** Expire stale invitations one at a time, publishing per row. */
  private async expireInvitations(now: Date): Promise<number> {
    const rows = await this.seats.listExpiredInvitations(now, VIDEO_ROOM_EXPIRY_SWEEP_LIMIT);
    let expired = 0;

    for (const row of rows) {
      try {
        await this.seats.setInvitationStatus(
          row.id,
          VideoRoomInvitationStatus.EXPIRED,
          SWEEP_ACTOR,
        );
        await this.bus.publish(
          new SeatInvitationExpiredEvent({
            roomId: row.roomId,
            invitationId: row.id,
            inviteeUserId: row.inviteeUserId,
          }),
        );
        expired += 1;
      } catch (err) {
        this.logger.warn(`Failed to expire invitation ${row.id}: ${(err as Error).message}`);
      }
    }
    return expired;
  }
```

Add this constant next to `RESERVATION_SWEEP_LIMIT` at the top of the file:

```ts
/** Actor recorded on rows the sweep expires (no human initiated it). */
const SWEEP_ACTOR = 'system';
```

> Keep `expireStaleRequests` / `expireStaleInvitations` on the repository — they
> remain the bulk fallback for batches beyond the sweep limit, and deleting them
> would break nothing but lose that escape hatch.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/scheduler/video-room-seat.monitor.spec.ts`

Expected: PASS — 8 tests.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`

Expected: exit 0.

---

### Task 13: Metrics and the workflow metrics listener

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts`
- Create: `src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.spec.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`

**Interfaces:**
- Consumes: the events from Task 3 and the widened resolution unions
- Produces, on `VideoRoomsMetrics`:
  - `setSeatQueueSize(size: number): void`
  - `incSeatRequestResolution(status: string): void`
  - `observeSeatApprovalLatency(seconds: number): void`
  - `incSeatInvitationOutcome(status: string): void`
  - `incSeatPromotion(result: 'success' | 'failure'): void`
- Produces: `VideoRoomSeatWorkflowMetricsListener`

> **Five metrics, not six.** An earlier draft also specified
> `incSeatQueueAdvance(result)` / `video_rooms_seat_queue_advance_total`. It is
> dropped: nothing produces that signal. `advance()` resolves its winner to
> `PROMOTED`, which already lands in
> `video_rooms_seat_request_resolutions_total{status="PROMOTED"}`, and the only
> way to feed a separate counter would be for the queue service to call the
> metrics registry directly — precisely the service→metrics coupling this
> listener exists to avoid. Do NOT add the counter or its mutator.

> **Rates are derived, not stored.** Invitation acceptance rate, delivery rate
> and promotion success rate are all ratios of the counters below — compute them
> in Prometheus (`rate(...{status="ACCEPTED"}) / rate(...)`). Tracking rates in
> application state would need per-room memory that never survives a restart.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.spec.ts`:

```ts
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatWorkflowMetricsListener } from './video-room-seat-workflow-metrics.listener';

describe('VideoRoomSeatWorkflowMetricsListener', () => {
  let deps: any;
  let handlers: Record<string, (e: any) => void>;
  const fire = (type: string, payload: any) => handlers[type]({ payload });

  beforeEach(() => {
    handlers = {};
    deps = {
      bus: { subscribe: jest.fn((t: string, fn: (e: any) => void) => { handlers[t] = fn; }) },
      metrics: {
        setSeatQueueSize: jest.fn(),
        incSeatRequestResolution: jest.fn(),
        observeSeatApprovalLatency: jest.fn(),
        incSeatInvitationOutcome: jest.fn(),
        incSeatPromotion: jest.fn(),
      },
    };
    new VideoRoomSeatWorkflowMetricsListener(deps.bus, deps.metrics).onModuleInit();
  });

  it('counts a request resolution by status', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'REJECTED' });
    expect(deps.metrics.incSeatRequestResolution).toHaveBeenCalledWith('REJECTED');
  });

  it('counts a PROMOTED resolution as a promotion success', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'PROMOTED' });
    expect(deps.metrics.incSeatPromotion).toHaveBeenCalledWith('success');
  });

  it('counts a FAILED resolution as a promotion failure', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'FAILED' });
    expect(deps.metrics.incSeatPromotion).toHaveBeenCalledWith('failure');
  });

  it('observes approval latency when the event carries the request creation time', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, {
      roomId: 'r1',
      status: 'PROMOTED',
      requestedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    expect(deps.metrics.observeSeatApprovalLatency).toHaveBeenCalledWith(expect.any(Number));
    const seconds = deps.metrics.observeSeatApprovalLatency.mock.calls[0][0];
    expect(seconds).toBeGreaterThanOrEqual(4);
    expect(seconds).toBeLessThan(10);
  });

  it('does not observe latency when the event omits the creation time', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'PROMOTED' });
    expect(deps.metrics.observeSeatApprovalLatency).not.toHaveBeenCalled();
  });

  it('counts an invitation as SENT when it is created', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, { roomId: 'r1', invitationId: 'i1' });
    expect(deps.metrics.incSeatInvitationOutcome).toHaveBeenCalledWith('SENT');
  });

  it('counts an invitation delivery ack', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED, { roomId: 'r1', invitationId: 'i1' });
    expect(deps.metrics.incSeatInvitationOutcome).toHaveBeenCalledWith('DELIVERED');
  });

  it('counts an invitation resolution by status', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status: 'ACCEPTED' });
    expect(deps.metrics.incSeatInvitationOutcome).toHaveBeenCalledWith('ACCEPTED');
  });

  it('counts a request expiry', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, { roomId: 'r1', requestId: 'q1', userId: 'u1' });
    expect(deps.metrics.incSeatRequestResolution).toHaveBeenCalledWith('EXPIRED');
  });

  it('tracks queue depth from queue updates', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, { roomId: 'r1', size: 7, top: [] });
    expect(deps.metrics.setSeatQueueSize).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.spec.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Add the five metrics**

In `src/modules/video-rooms/video-rooms.metrics.ts`, declare the fields next to the existing seat metrics:

```ts
  private readonly seatQueueSize: Gauge;
  private readonly seatRequestResolutions: Counter<'status'>;
  private readonly seatApprovalLatency: Histogram;
  private readonly seatInvitationOutcomes: Counter<'status'>;
  private readonly seatPromotions: Counter<'result'>;
```

Construct them in the constructor:

```ts
    this.seatQueueSize = new Gauge({
      name: 'video_rooms_seat_queue_size',
      help: 'Users waiting across all video-room seat queues',
      registers,
    });
    this.seatRequestResolutions = new Counter({
      name: 'video_rooms_seat_request_resolutions_total',
      help: 'Seat request resolutions by terminal status',
      labelNames: ['status'] as const,
      registers,
    });
    this.seatApprovalLatency = new Histogram({
      name: 'video_rooms_seat_approval_latency_seconds',
      help: 'Seconds from seat request creation to resolution',
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers,
    });
    this.seatInvitationOutcomes = new Counter({
      name: 'video_rooms_seat_invitation_outcomes_total',
      help: 'Seat invitation outcomes; delivery and acceptance rates derive from this',
      labelNames: ['status'] as const,
      registers,
    });
    this.seatPromotions = new Counter({
      name: 'video_rooms_seat_promotion_total',
      help: 'Viewer→participant promotion attempts by result',
      labelNames: ['result'] as const,
      registers,
    });
```

> **Use the shorthand.** The constructor already opens with
> `const registers = [metrics.registry];` and every existing metric passes bare
> `registers,`. Match that — do not write `registers: [registry]`, which does not
> resolve.

And the five mutators:

```ts
  setSeatQueueSize(size: number): void {
    this.seatQueueSize.set(size);
  }
  incSeatRequestResolution(status: string): void {
    this.seatRequestResolutions.inc({ status });
  }
  observeSeatApprovalLatency(seconds: number): void {
    this.seatApprovalLatency.observe(seconds);
  }
  incSeatInvitationOutcome(status: string): void {
    this.seatInvitationOutcomes.inc({ status });
  }
  incSeatPromotion(result: 'success' | 'failure'): void {
    this.seatPromotions.inc({ result });
  }
```

- [ ] **Step 4: Write the listener**

Create `src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.ts`:

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationDeliveredEvent,
  type SeatInvitationExpiredEvent,
  type SeatInvitationResolvedEvent,
  type SeatInvitationSentEvent,
  type SeatQueueUpdatedEvent,
  type SeatRequestExpiredEvent,
  type SeatRequestResolvedEvent,
} from '../events/video-room-seat.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * VR-8 workflow monitoring, subscribing to the same events the socket listener
 * consumes so metrics stay fully decoupled from the request/invitation services
 * (one event, many independent consumers — the VR-4 pattern).
 *
 * Rates are deliberately NOT tracked here: acceptance rate, delivery rate and
 * promotion success rate are all ratios of these counters and belong in the
 * Prometheus query, not in per-room application state that a restart would lose.
 */
@Injectable()
export class VideoRoomSeatWorkflowMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatRequestResolvedEvent>(
      VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED,
      (e) => {
        const { status, requestedAt } = e.payload as {
          status: string;
          requestedAt?: string;
        };
        this.metrics.incSeatRequestResolution(status);
        if (status === 'PROMOTED') this.metrics.incSeatPromotion('success');
        if (status === 'FAILED') this.metrics.incSeatPromotion('failure');
        if (requestedAt) {
          const seconds = (Date.now() - new Date(requestedAt).getTime()) / 1000;
          if (Number.isFinite(seconds) && seconds >= 0) {
            this.metrics.observeSeatApprovalLatency(seconds);
          }
        }
      },
    );

    this.bus.subscribe<SeatRequestExpiredEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, () =>
      this.metrics.incSeatRequestResolution('EXPIRED'),
    );

    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, () =>
      this.metrics.incSeatInvitationOutcome('SENT'),
    );
    this.bus.subscribe<SeatInvitationDeliveredEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED,
      () => this.metrics.incSeatInvitationOutcome('DELIVERED'),
    );
    this.bus.subscribe<SeatInvitationResolvedEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED,
      (e) => this.metrics.incSeatInvitationOutcome(e.payload.status),
    );
    this.bus.subscribe<SeatInvitationExpiredEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED,
      () => this.metrics.incSeatInvitationOutcome('EXPIRED'),
    );

    this.bus.subscribe<SeatQueueUpdatedEvent>(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, (e) =>
      this.metrics.setSeatQueueSize(e.payload.size),
    );
  }
}
```

- [ ] **Step 5: Carry `requestedAt` on the resolution event**

For approval latency to work, `SeatRequestResolvedEvent` must carry the request's
creation time. In `src/modules/video-rooms/events/video-room-seat.events.ts`, add
to that class's payload type:

```ts
  /** ISO timestamp of the original request — drives the approval-latency histogram. */
  requestedAt?: string;
```

Then in `video-room-seat-request.service.ts`, add `requestedAt: req.createdAt.toISOString()`
to the `SeatRequestResolvedEvent` payloads published from `approve` (both the
PROMOTED and FAILED branches) and from `reject`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-workflow-metrics.listener.spec.ts`

Expected: PASS — 13 tests (10 policy + 3 degenerate-input guards).

- [ ] **Step 7: Export and verify**

Add to `src/modules/video-rooms/listeners/index.ts`:

```ts
export * from './video-room-seat-workflow-metrics.listener';
```

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/listeners`

Expected: tsc exit 0; all listener suites green.

---

### Task 14: DTOs

**Files:**
- Create: `src/modules/video-rooms/dto/seat-queue.dto.ts`
- Test: `src/modules/video-rooms/dto/seat-queue.dto.spec.ts`
- Modify: `src/modules/video-rooms/dto/index.ts`

**Interfaces:**
- Consumes: `VIDEO_ROOM_MAX_SEATS` (existing)
- Produces: `UpdateSeatRequestDto`, `CancelSeatInvitationDto`, `AckSeatInvitationDto`, `RetrySeatInvitationDto`, `QueueEntryDto`, `QueueResponseDto`, `PromotionResponseDto`, `SeatRequestListItemDto`

> Reuse the existing `CreateSeatRequestDto`, `CreateVideoRoomInvitationDto`,
> `AcceptSeatInvitationDto` and `RejectSeatInvitationDto` in `dto/seat.dto.ts` —
> do not redefine them.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/dto/seat-queue.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AckSeatInvitationDto,
  CancelSeatInvitationDto,
  UpdateSeatRequestDto,
} from './seat-queue.dto';

const errorsFor = <T extends object>(cls: new () => T, payload: object) =>
  validateSync(plainToInstance(cls, payload) as object);

describe('UpdateSeatRequestDto', () => {
  it('accepts a valid seat index', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 3 })).toHaveLength(0);
  });

  it('accepts null to clear the seat preference', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: null })).toHaveLength(0);
  });

  it('rejects the owner seat', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 0 }).length).toBeGreaterThan(0);
  });

  it('rejects a seat index beyond the platform maximum', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 999 }).length).toBeGreaterThan(0);
  });

  it('rejects a non-integer seat index', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 2.5 }).length).toBeGreaterThan(0);
  });
});

describe('invitation id DTOs', () => {
  it.each([AckSeatInvitationDto, CancelSeatInvitationDto])(
    '%p accepts a uuid',
    (cls) => {
      expect(
        errorsFor(cls as any, { invitationId: '3f1e4d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f' }),
      ).toHaveLength(0);
    },
  );

  it.each([AckSeatInvitationDto, CancelSeatInvitationDto])(
    '%p rejects a non-uuid',
    (cls) => {
      expect(errorsFor(cls as any, { invitationId: 'nope' }).length).toBeGreaterThan(0);
    },
  );

  it.each([AckSeatInvitationDto, CancelSeatInvitationDto])(
    '%p requires the id',
    (cls) => {
      expect(errorsFor(cls as any, {}).length).toBeGreaterThan(0);
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/dto/seat-queue.dto.spec.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the DTOs**

Create `src/modules/video-rooms/dto/seat-queue.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import {
  VIDEO_ROOM_MAX_SEATS,
  VIDEO_ROOM_OWNER_SEAT_INDEX,
} from '../constants/video-room.constants';

/** Change the preferred seat on your own pending request (null = any seat). */
export class UpdateSeatRequestDto {
  @ApiPropertyOptional({
    description: 'New preferred seat index, or null for any available seat.',
    minimum: VIDEO_ROOM_OWNER_SEAT_INDEX + 1,
    maximum: VIDEO_ROOM_MAX_SEATS - 1,
    nullable: true,
    example: 3,
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(VIDEO_ROOM_OWNER_SEAT_INDEX + 1, { message: 'The owner seat cannot be requested.' })
  @Max(VIDEO_ROOM_MAX_SEATS - 1)
  seatIndex!: number | null;
}

/** Cancel an outstanding invitation (inviter / owner / admin). */
export class CancelSeatInvitationDto {
  @ApiProperty({ description: 'Invitation to cancel.', format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

/** The invitee's client confirms it received the invitation. */
export class AckSeatInvitationDto {
  @ApiProperty({ description: 'Invitation being acknowledged.', format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

/** Re-drive a FAILED invitation's seating. */
export class RetrySeatInvitationDto {
  @ApiProperty({ description: 'Invitation to retry.', format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

/** One waiting user, as returned by the queue endpoint. */
export class QueueEntryDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: '1-based position; 1 is next to be seated.', example: 1 })
  position!: number;

  @ApiProperty({ description: 'VIP tier ordinal (0 = not VIP).', example: 3 })
  vipLevel!: number;
}

/** The room's seat queue plus the caller's own position in it. */
export class QueueResponseDto {
  @ApiProperty({ description: 'Total users waiting.', example: 42 })
  size!: number;

  @ApiProperty({
    type: [QueueEntryDto],
    description: 'The front of the queue, truncated to the preview limit.',
  })
  entries!: QueueEntryDto[];

  @ApiPropertyOptional({
    description: "The caller's own 1-based position, or null if not queued.",
    nullable: true,
    example: 7,
  })
  myPosition!: number | null;
}

/** Result of a promotion (approval, invitation acceptance, or auto-advance). */
export class PromotionResponseDto {
  @ApiProperty({ format: 'uuid' })
  roomId!: string;

  @ApiProperty({ format: 'uuid', description: 'The user who was seated.' })
  userId!: string;

  @ApiProperty({ description: 'Seat they now occupy.', example: 3 })
  seatIndex!: number;

  @ApiProperty({ description: 'Seat-stage version for client reconciliation.', example: 17 })
  version!: number;
}

/** A pending seat request with its queue position, for the moderation list. */
export class SeatRequestListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Requested seat, or null for any.' })
  seatIndex!: number | null;

  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'PROMOTED', 'FAILED'] })
  status!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({ nullable: true, description: '1-based queue position.' })
  position!: number | null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/dto/seat-queue.dto.spec.ts`

Expected: PASS — 11 test cases.

- [ ] **Step 5: Export and verify**

In `src/modules/video-rooms/dto/index.ts`:

```ts
export * from './seat-queue.dto';
```

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/dto`

Expected: tsc exit 0; DTO suites green.

---

### Task 15: Controller — the eight new routes

**Files:**
- Modify: `src/modules/video-rooms/controllers/video-rooms-seats.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts` (extend; create if absent)

**Interfaces:**
- Consumes: the service methods from Tasks 8–9; `VideoRoomSeatQueueService.list` / `position` / `size`; the DTOs from Task 14
- Produces: 8 routes on the existing `/video-rooms` controller

> **Route-ordering trap.** Register `GET :id/seats/requests` and
> `GET :id/seats/invitations` *before* any `:something` wildcard segment under
> `seats/`. Nest matches in declaration order, so a parameterised route declared
> earlier will swallow the literal one and you will get a confusing 400 on a
> UUID-parse pipe instead of the list you asked for.

- [ ] **Step 1: Write the failing tests**

Create or extend `src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts`:

```ts
import { VideoRoomSeatsController } from './video-rooms-seats.controller';

const user = { id: 'u1', roles: [] as never[] } as any;

describe('VideoRoomSeatsController — VR-8 routes', () => {
  let deps: any;
  let ctrl: VideoRoomSeatsController;

  beforeEach(() => {
    deps = {
      seats: {},
      reservations: {},
      requests: {
        listRequests: jest.fn().mockResolvedValue([]),
        updateRequest: jest.fn().mockResolvedValue({ id: 'q1' }),
        retry: jest.fn().mockResolvedValue({ version: 3 }),
      },
      invitations: {
        listInvitations: jest.fn().mockResolvedValue([]),
        cancel: jest.fn(),
        acknowledge: jest.fn().mockResolvedValue({ id: 'i1' }),
        retry: jest.fn().mockResolvedValue({ version: 4 }),
      },
      queue: {
        list: jest.fn().mockResolvedValue([{ userId: 'u2', position: 1, vipLevel: 0, score: 1 }]),
        position: jest.fn().mockResolvedValue(4),
        size: jest.fn().mockResolvedValue(9),
      },
    };
    ctrl = new VideoRoomSeatsController(
      deps.seats, deps.reservations, deps.requests, deps.invitations, deps.queue,
    );
  });

  it('lists pending seat requests', async () => {
    await ctrl.listRequests(user, 'r1');
    expect(deps.requests.listRequests).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1',
    );
  });

  it('lists outstanding invitations', async () => {
    await ctrl.listInvitations(user, 'r1');
    expect(deps.invitations.listInvitations).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1',
    );
  });

  it('cancels an invitation', async () => {
    await ctrl.cancelInvite(user, 'r1', { invitationId: 'i1' } as any, '1.2.3.4');
    expect(deps.invitations.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1', 'i1', '1.2.3.4',
    );
  });

  it('updates a pending request', async () => {
    await ctrl.updateRequest(user, 'r1', { seatIndex: 5 } as any, '1.2.3.4');
    expect(deps.requests.updateRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1', 5, '1.2.3.4',
    );
  });

  it('retries a failed request', async () => {
    await ctrl.retryRequest(user, 'r1', 'q1', '1.2.3.4');
    expect(deps.requests.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1', 'q1', '1.2.3.4',
    );
  });

  it('acknowledges an invitation', async () => {
    await ctrl.ackInvite(user, 'r1', 'i1', '1.2.3.4');
    expect(deps.invitations.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1', 'i1', '1.2.3.4',
    );
  });

  it('retries a failed invitation', async () => {
    await ctrl.retryInvite(user, 'r1', 'i1', '1.2.3.4');
    expect(deps.invitations.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }), 'r1', 'i1', '1.2.3.4',
    );
  });

  it('returns the queue with the caller’s own position', async () => {
    const res = await ctrl.getQueue(user, 'r1');
    expect(res).toEqual({
      size: 9,
      entries: [{ userId: 'u2', position: 1, vipLevel: 0 }],
      myPosition: 4,
    });
  });

  it('reports a null position for a caller who is not queued', async () => {
    deps.queue.position.mockResolvedValue(null);
    const res = await ctrl.getQueue(user, 'r1');
    expect(res.myPosition).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts`

Expected: FAIL — constructor arity mismatch; `ctrl.listRequests is not a function`.

- [ ] **Step 3: Inject the queue service**

In `src/modules/video-rooms/controllers/video-rooms-seats.controller.ts`, add `VideoRoomSeatQueueService` as the last constructor parameter, and import the Task 14 DTOs plus `Patch` from `@nestjs/common`.

- [ ] **Step 4: Add the two list routes — BEFORE any parameterised `seats/:x` route**

Insert immediately after the existing `@Get(':id/seats')` handler:

```ts
  @Get(':id/seats/requests')
  @NotGuest()
  @ApiOperation({
    summary: 'List pending seat requests in queue order (owner/admin; MANAGE_SEATS)',
    description:
      'Ordered by queue priority: VIP tier first, then arrival time, with a ' +
      'fairness cap that pins repeatedly-skipped viewers to the front. Each row ' +
      'carries its 1-based queue position.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [SeatRequestListItemDto] })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'MANAGE_SEATS required.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  listRequests(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.requests.listRequests(this.actor(user), id);
  }

  @Get(':id/seats/invitations')
  @NotGuest()
  @ApiOperation({ summary: 'List outstanding seat invitations (owner/admin; INVITE_USERS)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Invitations still PENDING or DELIVERED.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'INVITE_USERS required.' })
  listInvitations(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.invitations.listInvitations(this.actor(user), id);
  }

  @Get(':id/seats/queue')
  @NotGuest()
  @ApiOperation({
    summary: 'The seat queue and your own position in it (any active member)',
  })
  @ApiResponse({ status: HttpStatus.OK, type: QueueResponseDto })
  async getQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<QueueResponseDto> {
    const [entries, myPosition, size] = await Promise.all([
      this.queue.list(id),
      this.queue.position(id, user.id),
      this.queue.size(id),
    ]);
    return {
      size,
      entries: entries.map((e) => ({
        userId: e.userId,
        position: e.position,
        vipLevel: e.vipLevel,
      })),
      myPosition,
    };
  }
```

- [ ] **Step 5: Add the request update and retry routes**

Insert in the `// ---- Request workflow ----` section:

```ts
  @Patch(':id/seats/request')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the preferred seat on your own pending request' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Request updated.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No pending request / seat not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'That seat is locked.' })
  updateRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateSeatRequestDto,
    @Ip() ip: string,
  ) {
    return this.requests.updateRequest(this.actor(user), id, dto.seatIndex, ip);
  }

  @Post(':id/seats/request/:requestId/retry')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a FAILED seat request (owner/admin; MANAGE_SEATS)',
    description:
      'Re-drives the seating pipeline for a request whose previous attempt threw. ' +
      'Bounded by attemptCount; once the budget is spent the request is terminal.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Retry succeeded; requester seated.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Not FAILED, or retries exhausted.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Request not found.' })
  retryRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
    @Ip() ip: string,
  ) {
    return this.requests.retry(this.actor(user), id, requestId, ip);
  }
```

- [ ] **Step 6: Add the invitation cancel, ack, and retry routes**

Insert in the `// ---- Invitation workflow ----` section:

```ts
  @Delete(':id/seats/invite')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an outstanding invitation (inviter/owner/admin; INVITE_USERS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation cancelled.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Invitation not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Invitation is no longer actionable.' })
  cancelInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CancelSeatInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.cancel(this.actor(user), id, dto.invitationId, ip);
  }

  @Post(':id/seats/invite/:invitationId/ack')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge receipt of an invitation (invitee) → DELIVERED',
    description:
      'Idempotent. Powers the invitation delivery-rate metric and lets the inviter ' +
      'distinguish "not seen yet" from "seen and ignoring".',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation marked delivered.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Only the invitee may acknowledge.' })
  ackInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
    @Ip() ip: string,
  ) {
    return this.invitations.acknowledge(this.actor(user), id, invitationId, ip);
  }

  @Post(':id/seats/invite/:invitationId/retry')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a FAILED invitation acceptance (invitee)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Retry succeeded; invitee seated.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Not FAILED, or retries exhausted.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Only the invitee may retry.' })
  retryInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
    @Ip() ip: string,
  ) {
    return this.invitations.retry(this.actor(user), id, invitationId, ip);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts`

Expected: PASS — 9 tests.

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit && npm run lint`

Expected: both clean.

---

### Task 16: Module wiring and full verification

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`

**Interfaces:**
- Consumes: every provider created in Tasks 5, 10, 13
- Produces: a fully wired module

- [ ] **Step 1: Capture the pre-VR-8 baseline**

Before wiring, record what the suite looked like so "zero regressions" is a
measured claim rather than an assumption:

```bash
npx jest --silent 2>&1 | tail -5
```

Write down the "Tests: N passed, N total" line. This is the baseline the
Definition of Done compares against.

- [ ] **Step 2: Register the three new providers**

In `src/modules/video-rooms/video-rooms.module.ts`, add to the `providers` array:

```ts
    VideoRoomSeatQueueService,
    VideoRoomSeatQueueListener,
    VideoRoomSeatWorkflowMetricsListener,
```

and add their imports at the top of the file.

- [ ] **Step 3: Confirm `VIP_SERVICE` resolves without a module import**

`VipModule` is `@Global()` and exports the `VIP_SERVICE` token
([vip.module.ts:19](../../../src/modules/vip/vip.module.ts#L19)), exactly how
`gifts` consumes it — so `VideoRoomsModule` needs **no** new entry in its
`imports` array. Verify by booting the app:

```bash
npx nest start --debug 2>&1 | head -40
```

Expected: no `Nest can't resolve dependencies of the VideoRoomSeatQueueService`
error. Stop the process once it logs that it is listening.

If it *does* fail to resolve, the cause is almost certainly that `VipModule` is
not registered in `AppModule` — check there before adding an import to
`VideoRoomsModule`.

- [ ] **Step 4: Run the whole video-rooms suite**

Run: `npx jest src/modules/video-rooms`

Expected: every suite passes, including the ~10 pre-existing ones.

- [ ] **Step 5: Run the full project suite and compare against the baseline**

Run: `npx jest --silent 2>&1 | tail -5`

Expected: total passing ≥ the Step 1 baseline, with **zero** newly failing
suites. If anything that passed in Step 1 now fails, fix it before proceeding —
that is a regression, not an acceptable cost.

- [ ] **Step 6: Types and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: tsc exits 0 with no output; eslint passes at `--max-warnings 0`.

- [ ] **Step 7: Confirm the Swagger surface**

Boot the app and check that all 8 new routes are documented:

```bash
npx nest start &
sleep 15
curl -s http://localhost:3000/api-json | python3 -c "
import json,sys
paths = json.load(sys.stdin)['paths']
want = [
  '/video-rooms/{id}/seats/requests',
  '/video-rooms/{id}/seats/invitations',
  '/video-rooms/{id}/seats/queue',
  '/video-rooms/{id}/seats/request',
  '/video-rooms/{id}/seats/invite',
  '/video-rooms/{id}/seats/request/{requestId}/retry',
  '/video-rooms/{id}/seats/invite/{invitationId}/ack',
  '/video-rooms/{id}/seats/invite/{invitationId}/retry',
]
for w in want:
    print(('OK  ' if w in paths else 'MISS'), w, sorted(paths.get(w, {}).keys()))
"
kill %1
```

Expected: every line reads `OK`, and `/seats/request` lists `delete, patch, post`
while `/seats/invite` lists `delete, post`. Adjust the port if this project does
not serve on 3000 (check `main.ts`).

- [ ] **Step 8: Confirm nothing was committed**

Run: `git status --short && git log --oneline -1`

Expected: modified/untracked files listed, and the most recent commit is still
`2a09e28` (the pre-VR-8 HEAD). **Do not commit.**

---

## Definition of Done

- [ ] Queue projection with VIP + FIFO + fairness cap, rebuildable from Postgres
- [ ] Auto-advance gated by `seatApprovalRequired`, driven from the listener, using the dedicated queue lock
- [ ] 7 request states + 7 invitation states, every transition guarded by the table
- [ ] Retry (bounded by `attemptCount`) + restore (reconnect, position-preserving)
- [ ] Expiry emits one event per row
- [ ] Socket listener routes every resolution status distinctly — cancelled/expired/promoted no longer announced as "rejected"
- [ ] 8 new REST routes, fully Swagger-documented
- [ ] 6 new socket events + 4 new domain events
- [ ] 5 new metrics via a decoupled listener
- [ ] Audit entries for every transition
- [ ] `npx tsc --noEmit` and `npm run lint` both clean
- [ ] Full project suite ≥ the Step 1 baseline, zero newly-failing suites
- [ ] Nothing committed — `git log --oneline -1` still shows `2a09e28`
