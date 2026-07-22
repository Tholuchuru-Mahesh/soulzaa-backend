# VR-10 — Enterprise Virtual Gift Engine (Video Rooms)

**Date:** 2026-07-22
**Phase:** Video Room Phase 10
**Status:** Approved design — ready for implementation planning

Prior phases: [VR-0](2026-07-20-video-room-phase0-design.md) · [VR-1](2026-07-20-video-room-phase1-database-design.md) ·
[VR-2](2026-07-20-video-room-phase2-lifecycle-design.md) · [VR-3](2026-07-20-video-room-phase3-member-lifecycle-design.md) ·
[VR-4](2026-07-20-video-room-phase4-seat-management-design.md) · [VR-5](2026-07-20-video-room-phase5-media-engine-design.md) ·
[VR-6](2026-07-20-video-room-phase6-viewer-mode-design.md) · [VR-7](2026-07-21-video-room-phase7-role-permission-engine-design.md) ·
[VR-8](2026-07-21-video-room-phase8-seat-request-invitation-workflow-design.md) · [VR-9](2026-07-21-video-room-phase9-chat-system-design.md)

---

## 1. Objective

Enable virtual gifting inside Video Rooms — validation, atomic wallet movement, an
immutable ledger, combo lifecycle, prioritised animation delivery with retry and
recovery, history, statistics and revenue tracking — **by opening the existing
AR-5 gift pipeline to a second context rather than building a parallel one**.

### Out of scope (explicit)

Treasure Boxes · PK Battles · Rankings · Seasonal/Rocket events · Family rewards ·
Moderation logic · Analytics dashboards · Live-stream and private-chat gifting
(the registry makes them drop-in later, but no handler ships in this phase).

---

## 2. What already exists (reuse map)

The audit below is the reason this phase adds **zero new tables**.

| Requirement | Existing asset | Gap |
| --- | --- | --- |
| Gift catalog, 5 categories, VIP gating | `Gift` model + `GiftCatalogService` | none |
| Gift ledger + history | `GiftTransaction` — already context-generic | none |
| Atomic, idempotent, non-negative wallet moves | `IWalletService.debit/credit(input, tx)` | none |
| Combo tier + window | `GiftRepository.comboTick()` (Redis `INCR` + TTL) | no started/updated/**ended** lifecycle |
| Rate limit · idempotency · lucky roll | `GiftService` | none |
| Queue, retry, backoff, DLQ, replay | `BaseQueueWorker` + `QueueService.replayDeadLetter()` | `GiftProcessingProcessor` is an unwired stub |
| Room gift counters | `video_room_statistics.totalGifts` / `.totalGiftCoins` | columns exist, nothing writes them |
| Room gift toggle | `video_room_settings.allowGifts` | nothing reads it |
| Socket relay pattern | `GiftSocketListener` (audio) — EVENT_BUS → namespace | needs a `/video-room` twin |
| Event store for delivery/animation log | `video_room_events` (`eventType`/`payload`/`correlationId`/`referenceId`) | none |
| Multi-receiver gifting | — | entirely new |

`GiftContextType.VIDEO_ROOM` was reserved in AR-5 with the comment *"the others are
reserved so the same pipeline serves live/video/private-chat gifting later."*
This phase cashes that in.

---

## 3. Locked decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Pluggable context handlers.** `GiftService` becomes context-agnostic; each context's validation + economics move into a handler owned by that context's module, resolved through a registry. | Open/Closed; no if-chain growth; prevents two gift pipelines drifting. |
| D2 | **Money synchronous, queue drives fan-out only.** `POST /send` validates, debits, credits and writes the ledger inside one `prisma.$transaction` and returns the completed transaction(s). The queue owns animation, delivery tracking, retry, DLQ and recovery — never the money. | Instant truthful balance; a queue outage delays animations, never coins. |
| D3 | **Multi-receiver = full price each, N ledger rows, all-or-nothing.** `total = unitPrice × quantity × N`; one debit, N credits, N `GiftTransaction` rows sharing a `batchId`; any receiver failing validation rolls the whole send back. | Preserves ledger shape/indexes and audio-room economic comparability; the sender is never charged an amount other than the quote. |
| D4 | **Zero new tables.** Project every "persist" requirement onto existing storage. | Matches the zero-migration pattern held across VR-2/4/5. |
| D5 | **Creator earnings only.** Receiver credited `GIFT_CREATOR_EARNING_RATE_PERCENT` (default 30%) to `EARNINGS`; no room-owner commission. | Reuses the pipeline's existing non-audio branch verbatim; the `economics()` hook makes an owner cut a handler-local change later. |
| D6 | **Wire the reserved queue stub** with a generic, job-name-keyed registry. | Reuses BullMQ retry/backoff/DLQ/replay/Bull Board; no duplicated queue logic in video-rooms; future contexts register without touching the processor again. |
| D7 | **No separate `deliveryId`.** `batchId` (lifecycle) + BullMQ `jobId` (run) + `attemptsMade` (attempt) + `transactionId` (per-receiver leg). | Independent runs exist (DLQ replay) but BullMQ already mints a durable unique id per run; a new identifier would be redundant. |

---

## 4. Architecture

### 4.1 The handler registry (gifts module)

```
                    ┌──────────────────────────────┐
   audio-rooms ────►│  GiftContextRegistry         │◄──── video-rooms
   registers        │  Map<GiftContextType,        │      registers
   AUDIO_ROOM       │      IGiftContextHandler>    │      VIDEO_ROOM
   handler          └──────────────┬───────────────┘      handler
                                   │ for(contextType)
                                   ▼
                          ┌────────────────┐
                          │  GiftService   │  catalog · VIP gate · idempotency
                          │  (economy only)│  rate limit · combo · lucky
                          └────────────────┘  wallet · ledger
```

`GiftsModule` is already `@Global`, so dependency flow is one-way:
`audio-rooms → gifts` and `video-rooms → gifts`. Gifts never imports either.

```ts
// gifts/interfaces/gift-context-handler.interface.ts
export interface GiftContextRequest {
  contextType: GiftContextType;
  contextId: string;
  senderId: string;
  receiverIds: string[];
  gift: Gift;
  quantity: number;
}

export interface GiftEconomics {
  /** Basis points of totalCoinValue credited to each receiver's EARNINGS. */
  receiverEarningsBps: number;
}

/** Effects a handler contributes from inside the send transaction. */
export interface GiftSendEffects {
  acceptedAmount: number;
  refundAmount: number;
  events: DomainEvent[];
  postCommit?: () => Promise<void>;
}

export interface IGiftContextHandler {
  readonly contextType: GiftContextType;
  /**
   * Max receivers one send may target. AUDIO_ROOM: 1.
   * VIDEO_ROOM: min(VIDEO_ROOM_GIFT_MAX_RECEIVERS, occupied seat count).
   */
  readonly maxReceivers: number;

  /** Throws BusinessException when the send is not permitted. */
  validate(req: GiftContextRequest): Promise<void>;

  economics(req: GiftContextRequest): GiftEconomics;

  /** In-transaction hook, after debit and before the ledger write. */
  onSend?(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects>;

  /** Post-commit hook — statistics, queue enqueue, room counters. */
  afterCommit?(txns: GiftTransaction[]): Promise<void>;
}
```

```ts
// gifts/services/gift-context.registry.ts
@Injectable()
export class GiftContextRegistry {
  private readonly handlers = new Map<GiftContextType, IGiftContextHandler>();

  register(h: IGiftContextHandler): void { this.handlers.set(h.contextType, h); }

  for(t: GiftContextType): IGiftContextHandler {
    const h = this.handlers.get(t);
    if (!h) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'Gifting is not supported in this context.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return h;
  }
}
```

Handlers self-register from their owning module's `onModuleInit`.

### 4.2 What moves out of `GiftService`

This is a **move, not a copy**. Audio-room behaviour must remain byte-identical.

| Currently in `gift.service.ts` | Moves to |
| --- | --- |
| `assertContext()` audio branch (room live, `assertMember`, receiver-in-room) | `AudioRoomGiftContextHandler.validate()` |
| Treasure-box contribution + accepted/refund split | `AudioRoomGiftContextHandler.onSend()` |
| 10% host reward credit + `TreasureReceiverRewardEvent` | `AudioRoomGiftContextHandler.onSend()` |
| Excess-coin refund + `GiftRefundedEvent` | `AudioRoomGiftContextHandler.onSend()` |
| `creatorEarnings = 0n` for `AUDIO_ROOM` | `AudioRoomGiftContextHandler.economics()` → `{ receiverEarningsBps: 0 }` |
| `compensate()` — **dead code** since the `$transaction` refactor | deleted |

Resulting dependency reduction in `GiftService`: `AUDIO_ROOMS_SERVICE`,
`TREASURE_BOXES_SERVICE` and `USERS_SERVICE` are dropped. It retains
`WALLET_SERVICE` (economy) and `VIP_SERVICE` (catalog-level gating, genuinely shared).

### 4.3 Send pipeline

`sendGift()` becomes a thin wrapper over a new `sendGiftBatch()`; audio-room calls
pass a single-element receiver list, so their behaviour is unchanged.

```
POST /video-rooms/:id/gifts/send  { giftId, target, receiverIds?, quantity, idempotencyKey }
  │
  ├─ VideoRoomGiftService.send()                       ← video-rooms orchestration
  │    └─ VideoRoomGiftTargetResolver → receiverIds[]
  │
  └─ GiftService.sendGiftBatch()                       ← gifts owns the money
       ├─ catalog lookup · enabled · VIP gate                       (shared)
       ├─ idempotency replay check                                  (shared)
       ├─ handler.validate()                                        ← VIDEO_ROOM handler
       ├─ rate limit · comboTick · lucky roll                       (shared)
       ├─ locks: [senderId, ...receiverIds].sort()                  ← deadlock-safe
       └─ prisma.$transaction:
            re-check idempotency inside the transaction
            wallet.debit(sender, unit × quantity × N)               ← ONE debit
            handler.onSend?(tx, …)                                  ← no-op for VIDEO_ROOM
            for each receiver: wallet.credit(receiver, earnings)    ← N credits
            giftTransaction.create() × N   (metadata.batchId)
  ↓ 201 GiftTransaction[]
  ↓ post-commit: handler.afterCommit() → statistics · queue enqueue · EVENT_BUS
```

Lock keys are sorted across the **full** participant set (sender + all receivers)
before acquisition — with N receivers, unsorted acquisition across concurrent
sends is a guaranteed deadlock.

#### Per-leg wallet idempotency keys (correctness-critical)

The existing single-receiver pipeline derives wallet keys as
`gift-credit:${idempotencyKey}`. Under D3 that is **unsafe**: all N credits in a
batch would share one key, so the wallet's exactly-once guarantee collapses them
into a single credit — receiver #1 is paid, receivers #2..N silently receive
nothing, and the sender is debited for all N. Keys must therefore be per-leg:

| Movement | Idempotency key | Cardinality |
| --- | --- | --- |
| Sender debit | `gift-debit:${idempotencyKey}` | 1 per send |
| Receiver credit | `gift-credit:${idempotencyKey}:${receiverId}` | N per send |

The single-receiver case still produces one credit key, so audio-room keys remain
stable in shape. **A multi-receiver double-credit test is mandatory.**

#### Rate limiting and EXP under batching

- **Rate limit:** one `hitRateLimit` tick per **API call**, not per receiver — a
  `SEAT_ALL` send is one user action. Cost control for large batches is
  `VIDEO_ROOM_GIFT_MAX_RECEIVERS`, not the rate limiter.
- **EXP:** unchanged. `senderExp` / `receiverExp` are computed per ledger row from
  that row's `totalCoinValue` and ride the existing published-event seam consumed
  by `exp/listeners/exp-activity.listener.ts`. VR-10 adds no EXP logic.

### 4.4 Target resolution (video-rooms)

| Target | Receivers | Source |
| --- | --- | --- |
| `SINGLE` | `[receiverId]` | DTO |
| `MULTI` | `receiverIds[]`, capped at `maxReceivers` | DTO |
| `SEAT_ALL` | every occupied seat | `VideoRoomSeatStateService.getSnapshot()` |
| `ROOM_ALL` | resolver implemented, **disabled by config** (`VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL=false`) | future-ready |

### 4.5 Validation (`VideoRoomGiftContextHandler.validate()`)

Room exists · not soft-deleted · status `LIVE` · `settings.allowGifts` ·
sender is an active member · sender not blocked · every receiver is an active member ·
a receiver who is a viewer is permitted only when `settings.metadata.allowViewerGifts` ·
no self-gift · `receiverIds.length ≤ maxReceivers` · no duplicate receiver ids.
Any failure throws before the transaction opens — all-or-nothing (D3).

**RBAC note.** No `SEND_GIFT` entry is added to `VIDEO_ROOM_PERMISSION_MATRIX`.
That matrix is deliberately management-only (`HOST`/`PARTICIPANT`/`VIEWER` map to
empty sets); gifting is a member capability, so encoding it there would require
granting it to all six roles and would express nothing. The gate is membership +
settings, as listed above.

### 4.6 Transaction boundaries (normative)

D2 says "money synchronous, queue drives fan-out". This section makes that
enforceable, so a future change cannot quietly widen the transaction. **Only
PostgreSQL work may happen inside `prisma.$transaction`.** Every Redis, queue,
socket, metrics and cache operation is either a pre-flight read or a post-commit
effect.

```
┌─ BEFORE the transaction ───────────────────────────────────────────┐
│  catalog read (may hit the hot-gift Redis cache)                   │
│  VIP tier lookup                                                   │
│  idempotency pre-check                                             │
│  handler.validate()          — Redis/Postgres reads, no writes     │
│  rate limit tick             — Redis INCR                          │
│  comboTick                   — Redis INCR                          │
│  lucky roll                  — crypto RNG, pure                    │
│  LockService.withLock(...)   — Redis locks WRAP the transaction    │
├─ INSIDE prisma.$transaction ───────────────────────────────────────┤
│  idempotency re-check                                              │
│  wallet.debit(sender)                          ← Postgres only     │
│  handler.onSend()                              ← Postgres only     │
│  wallet.credit(receiver) × N                   ← Postgres only     │
│  giftTransaction.create() × N                  ← Postgres only     │
│  video_room_statistics increment               ← Postgres only     │
├─ AFTER commit ─────────────────────────────────────────────────────┤
│  leaderboard ZSET writes                                           │
│  recent-gift feed LIST push                                        │
│  hot stats HASH increment                                          │
│  combo index ZSET upsert                                           │
│  EVENT_BUS publish (incl. handler-returned events)                 │
│  queue.enqueue(video-room.gift.deliver, …)                         │
│  handler postCommit()                                              │
│  metrics inc/observe                                               │
└────────────────────────────────────────────────────────────────────┘
```

**Why this matters, concretely:**

- **Redis writes inside a DB transaction cannot roll back.** A `$transaction` that
  aborts after a leaderboard `ZINCRBY` leaves permanently inflated scores with no
  ledger row behind them — silent, unreconcilable drift.
- **Socket emits inside a transaction can broadcast a gift that never commits.**
  Clients would animate a gift that does not exist.
- **`queue.enqueue` inside a transaction can deliver before commit.** BullMQ workers
  run in a different process; a job can be picked up and read the ledger row
  before the transaction that wrote it has committed, producing a spurious
  `GIFT_NOT_FOUND`.
- **Non-Postgres I/O inflates transaction duration.** Prisma's interactive
  transactions carry a **5 s default timeout**; a Redis or socket stall inside the
  boundary converts a slow dependency into a rolled-back payment.

**Handler contract consequence.** `handler.onSend()` runs *inside* the boundary, so
a handler must never touch Redis, sockets, the queue or metrics there. That is
precisely why it returns `events` and an optional `postCommit` callback rather
than performing effects itself — the pattern the audio-room treasure/host-reward
flow already uses today. This is the single most important rule for anyone adding
a future context handler.

**Bounding N.** Because N credits + N ledger inserts share one 5 s budget,
`VIDEO_ROOM_GIFT_MAX_RECEIVERS` is a *transaction-safety* control, not merely a
product limit. Raising it materially requires re-benchmarking §13.

---

## 5. Delivery queue

### 5.1 The infra seam (2 files)

```ts
// NEW  infra/queue/workers/queue-job.registry.ts — generic, queue-agnostic
export type QueueJobHandler = (data: unknown, job: Job) => Promise<unknown>;

@Injectable()
export class QueueJobRegistry {
  private readonly handlers = new Map<string, QueueJobHandler>();   // `${queue}:${jobName}`

  register(queue: string, jobName: string, h: QueueJobHandler): void;

  async dispatch(queue: string, job: Job): Promise<unknown>;
}
```

```ts
// MODIFIED  infra/queue/processors/gift-processing.processor.ts — routing only
async handle(job: Job): Promise<unknown> {
  return this.registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job);
}
```

**`dispatch()` on an unregistered job name MUST NOT throw.** `GiftService.afterSend()`
already enqueues `gift.sent` to `GIFT_PROCESSING` on every audio-room gift and
nothing handles it — today the stub swallows it. A throwing registry would burn
that job's retries and dead-letter **every existing audio-room gift**. Unknown job
name → log at debug, return `{ ok: true, unhandled: true }`. **This is a required
regression test.**

### 5.2 Priority lanes

BullMQ `priority` (lower = sooner), satisfying the brief's "Luxury Priority":

| `GiftCategory` | priority | attempts | backoff |
| --- | --- | --- | --- |
| `VIP_EXCLUSIVE`, `LUXURY` | 1 | 5 | exponential, 500 ms |
| `PREMIUM` | 2 | 5 | exponential, 500 ms |
| `EVENT` | 3 | 5 | exponential, 500 ms |
| `STANDARD` | 4 | 3 | exponential, 500 ms |

### 5.3 Sequential per room, parallel across rooms

The delivery handler acquires `video-room:gift:deliver:{roomId}` before broadcasting.
Ordering within a room is guaranteed; `QUEUE_CONCURRENCY` still applies across rooms.

### 5.4 Delivery flow — `VideoRoomGiftDeliveryService`

One job per **batch** (one send → one animation), registered on the queue at
`onModuleInit` under job name `video-room.gift.deliver`.

1. **at enqueue** — append `gift.animation.queued` → `video_room_events`
2. emit `giftAnimation` → `/video-room` room (batch-level)
3. per leg: append `gift.delivered` → `video_room_events`; emit `giftDelivered`; bump metrics
4. on throw → BullMQ retries → exhaustion → `BaseQueueWorker.onFailed` dead-letters →
   emit `giftFailed` + append `gift.delivery.failed` (carrying `jobId`)

### 5.5 Recovery

Reuses `QueueService.replayDeadLetter()` — no reimplementation in video-rooms.
A config-gated `VideoRoomGiftMonitor` (mirroring the four existing monitors in
`scheduler/`) decides *when* to replay and emits `giftRecovered`. Replay mints a
new BullMQ `jobId` (verified: `replayDeadLetter` re-enqueues the payload), which
is what discriminates independent runs per D7.

---

## 6. Correlation model (D7)

| Level | Identifier | Source | Cardinality |
| --- | --- | --- | --- |
| Send (delivery lifecycle) | `batchId` | minted at send; `GiftTransaction.metadata.batchId`; `video_room_events.correlationId` | 1 per API call |
| Run (independent attempt-run) | `jobId` | BullMQ — new id on every replay | 1 + replays, per batch |
| Attempt (retry within a run) | `attemptsMade` | BullMQ | N per run |
| Leg (per receiver) | `transactionId` ↔ `receiverId` | ledger row; `video_room_events.referenceId` | N per batch |

```ts
interface GiftDeliveryCorrelation {
  batchId: string;
  transactionId: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  jobId: string;
  attempt: number;
}
```

Carried on every gift delivery event — socket payload **and** `video_room_events.payload`.

**Documented cardinality exception:** `giftAnimation` is the single batch-level
event (one animation per send, by design) and carries `batchId`, `transactionIds[]`
and `receiverIds[]` in place of the singular pair. `giftDelivered`, `giftFailed`
and `giftRecovered` are emitted **per leg** with the full singular envelope. An
N-receiver send therefore produces 1 animation event and N delivery events.

---

## 7. Combo lifecycle

The shared `comboTick` stays the tier authority. `VideoRoomGiftComboService` adds
the lifecycle around it.

| Transition | Trigger | Event |
| --- | --- | --- |
| tier 1 | first tick in window | `giftComboStarted` |
| tier n > 1 | tick within window | `giftComboUpdated` |
| expiry | **sweep** (below) | `giftComboEnded` |

A TTL'd Redis key expiring emits nothing. Rather than enable keyspace
notifications (a Redis-server config change, out of bounds), an index ZSET
`video-room:gift:combos` scored by expiry timestamp is swept on each
`VideoRoomGiftMonitor` tick: `ZRANGEBYSCORE -inf now` → emit ended → `ZREM`.
Deterministic and unit-testable with an injected clock.

**Explicit scope call — combo does not multiply cost.** `comboTier` is recorded on
the ledger row and broadcast for display; only `luckyMultiplier` affects
`totalCoinValue`, exactly as in Audio Rooms. Changing this would silently diverge
the two economies.

Combo state is inherently ephemeral (≤ `gift.comboWindowSeconds`). On cold Redis
combos are simply absent; there is nothing to recover, and `GET /combo` returns an
empty set. This is correct, not a gap.

---

## 8. Storage (zero migrations)

| Brief's "persist" item | Home |
| --- | --- |
| Gift transactions, gift history, gift metadata | `gift_transactions` (existing; `metadata.batchId`) |
| Gift queue | BullMQ / Redis (already durable) |
| Gift combo | Redis (10 s-lived; durability past the window is meaningless) |
| Gift statistics | `video_room_statistics.totalGifts` / `.totalGiftCoins` + Redis hot counters; deep stats aggregated from `gift_transactions` |
| Gift delivery log, animation events | `video_room_events` rows (`correlationId` = `batchId`, `referenceId` = `transactionId`) |
| Viewer-gifting flag | `video_room_settings.metadata.allowViewerGifts` (VR-2 access-policy precedent) |

### Redis keys (all new, `video-room:` namespaced)

| Key | Type | Purpose |
| --- | --- | --- |
| `video-room:{id}:gifts:recent` | capped LIST | `GET /recent` feed |
| `video-room:{id}:gift:combo:{sender}:{gift}` | HASH + TTL | combo state |
| `video-room:gift:combos` | ZSET | expiry index → combo-ended sweep |
| `video-room:{id}:gift:stats` | HASH | hot counters (count, coins) |
| `video-room:{id}:gift:top` | ZSET | top gifts / top gifters |
| `video-room:gift:deliver:{id}` | LOCK | per-room delivery ordering |
| `video-room:gift:monitor` | LOCK | monitor sweep guard |
| `gifts:catalog:active` | STRING (JSON) | hot gift cache — memoises `listActiveGifts()` |

---

## 9. API surface

### REST — base `video-rooms/:id/gifts`, JWT-guarded, fully Swagger-documented

| Method | Route | Guard | Returns |
| --- | --- | --- | --- |
| POST | `/send` | `@NotGuest` | 201 — the batch of created transactions |
| GET | `/history` | member | paginated; filters sender/receiver/gift/date |
| GET | `/recent` | member | Redis feed, N most recent |
| GET | `/combo` | member | active combos |
| GET | `/statistics` | member (summary) / `VIEW_ANALYTICS` (breakdown) | room aggregates |

`GET /statistics` returns — **summary** (any member): `totalGifts`, `totalGiftCoins`,
`topGifts[]` (giftId + count, from the `:gift:top` ZSET), `topGifters[]`.
**Breakdown** (adds, requires `VIEW_ANALYTICS`): per-receiver earnings totals,
per-category coin split, and a time-bucketed send series — all aggregated from
`gift_transactions` filtered on `contextType = VIDEO_ROOM AND contextId = roomId`,
never from a separate rollup table.

### Socket — `/video-room` namespace

Bridged by `VideoRoomGiftSocketListener` from EVENT_BUS. **No gateway** — matching
the VR-5/VR-9 pattern where inbound is served by the shared `BaseGateway` and
outbound is EVENT_BUS-driven.

`gift_sent` · `gift_delivered` · `gift_animation` · `gift_combo_started` ·
`gift_combo_updated` · `gift_combo_ended` · `gift_queue_updated` · `gift_failed` ·
`gift_recovered`

### EVENT_BUS — which events are reused vs. new

Ambiguity resolved explicitly, because the gifts module already publishes some of
these and duplicating them would double-fire every downstream listener
(notifications, EXP, rankings, social, analytics).

| Event | Ownership |
| --- | --- |
| `GiftSentEvent` (`GIFT_EVENTS.SENT`) | **reused unchanged** from the gifts module — emitted once per ledger row with `contextType = VIDEO_ROOM`; existing listeners already filter by context |
| `GiftLuckyWinEvent`, `GiftRefundedEvent` | **reused unchanged** |
| `GiftComboEvent` (`GIFT_EVENTS.COMBO`) | **reused** for the tier tick; the started/updated/ended *lifecycle* is video-room-owned (below) |
| `GiftDelivered` · `GiftFailed` · `GiftRecovered` | **new**, owned by video-rooms (`VIDEO_ROOM_GIFT_EVENTS`) — delivery is a video-room concept and has no audio-room counterpart |
| `GiftComboStarted` · `GiftComboUpdated` · `GiftComboEnded` | **new**, owned by video-rooms |
| `WalletDebited` · `ReceiverCredited` | already published by the wallet module — **not** duplicated |

`VideoRoomGiftSocketListener` filters `GiftContextType.VIDEO_ROOM` on every reused
event, exactly as the audio bridge filters `AUDIO_ROOM`.

### DTOs

`SendVideoRoomGiftDto` (giftId, target, receiverIds?, quantity, idempotencyKey) ·
`VideoRoomGiftHistoryQueryDto` · `VideoRoomGiftStatisticsDto` ·
`VideoRoomGiftComboDto` · `VideoRoomGiftResponseDto`.

---

## 10. Observability

### Metrics — appended to `VideoRoomsMetrics` under `// ---- VR-10 gifts ----`

`giftsSentC` · `giftCoinsC` (revenue) · `giftSendLatencyH` · `giftWalletLatencyH` ·
`giftQueueDepthG` · `giftAnimationQueueDepthG` · `giftFailuresC` ·
`giftRecoveryC<'result'>`.

**Top Gifts is deliberately not a Prometheus metric** — a per-`giftId` label is
unbounded cardinality. It is served from the `video-room:{id}:gift:top` ZSET.

### Audit logging

Every gift send, wallet debit, receiver credit, failure, recovery and animation
trigger appends to `video_room_events` with: roomId · giftId · transactionId ·
batchId · senderId · receiverId · walletTxnId · jobId · timestamp · requestId.

### Error codes

Project convention is `BusinessException` + `ERROR_CODES`, **not** exception classes.
Five of the brief's eight named exceptions map to existing codes: `GIFT_NOT_FOUND`,
`GIFT_DISABLED`, `INSUFFICIENT_BALANCE`, `GIFT_RECEIVER_INVALID`, `GIFT_CONTEXT_INVALID`.

New, purely additive entries in `src/common/exceptions/error-codes.ts`:
`GIFT_QUEUE_ERROR` · `GIFT_DELIVERY_FAILED` · `GIFT_COMBO_ERROR` ·
`WALLET_TRANSACTION_FAILED` · `VIDEO_ROOM_GIFTS_DISABLED` · `GIFT_TOO_MANY_RECEIVERS`.

*Constraint note:* the "do not modify shared/common code" rule is read as
*do not refactor*, not *never append* — all 46 existing `VIDEO_ROOM_*` codes were
added the same way by prior phases. Appending constants introduces no behavioural
change to shared code.

---

## 11. Configuration

New env knobs under the `videoRoom` namespace (`.env.example` + `video-room.config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIDEO_ROOM_GIFT_MAX_RECEIVERS` | 9 | cap for `MULTI` / `SEAT_ALL` |
| `VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL` | `false` | future-ready `ROOM_ALL` target |
| `VIDEO_ROOM_GIFT_ALLOW_VIEWER_DEFAULT` | `true` | default for `settings.metadata.allowViewerGifts` |
| `VIDEO_ROOM_GIFT_RECENT_FEED_SIZE` | 50 | capped LIST length |
| `VIDEO_ROOM_GIFT_MONITOR_INTERVAL_SECONDS` | 15 | combo-ended sweep + DLQ replay tick |
| `VIDEO_ROOM_GIFT_RECOVERY_ENABLED` | `false` | gates automatic DLQ replay |

Reused unchanged: `GIFT_CREATOR_EARNING_RATE_PERCENT` (30) · `GIFT_RATE_MAX` ·
`GIFT_RATE_WINDOW_SECONDS` · `GIFT_SENDER_EXP_PER_COIN` · `GIFT_RECEIVER_EXP_PER_COIN`.

---

## 12. Backward compatibility — mandatory release gate

The handler extraction (§4.2) moves live, money-handling code out of a service
that is in production for Audio Rooms. **Audio-room gifting must be behaviourally
identical after the refactor.** This is a release gate, not a test aspiration: if
any row below is unverified, VR-10 does not ship.

| # | Invariant | How it is verified |
| --- | --- | --- |
| BC-1 | Wallet movements identical — same currencies, amounts, reasons, `referenceType`, ordering | Assert the full `WalletTransaction` sequence for a fixed audio send, before vs after |
| BC-2 | Idempotency key **shapes** unchanged for single-receiver sends (`gift-debit:{k}`, `gift-credit:{k}`, `gift-host-reward:{k}`, `gift-refund:{k}`) | Exact-string assertions — a changed key silently breaks replay dedup against rows already in production |
| BC-3 | Treasure-box contribution unchanged — accepted/refund split, box level, `boxId` | Golden-value test through `processTreasureContribution` |
| BC-4 | 10% host reward unchanged — recipient resolution, floor rounding, `TreasureReceiverRewardEvent` payload | Assert credit amount + event payload |
| BC-5 | Excess-coin refund unchanged — amount and `GiftRefundedEvent` payload | Assert credit + event |
| BC-6 | `creatorEarnings = 0` for `AUDIO_ROOM`; receiver is **not** credited `EARNINGS` | Assert ledger row + absence of an EARNINGS movement |
| BC-7 | Event publication set, payloads and **ordering** unchanged (`GiftSent`, `GiftCombo`, `GiftLuckyWin`, treasure/refund events) | Record published events in order; compare to a captured baseline |
| BC-8 | Queue jobs unchanged — `gift.sent`, `gift.received`, `gift.ranking`, `gift.sent`(analytics) still enqueued with identical payloads | Assert enqueue calls |
| BC-9 | Downstream listeners still fire — notifications, EXP, rankings, social, analytics, treasure | Integration test across the 6 consuming modules |
| BC-10 | `POST /gifts/send` (audio) response body byte-identical | Snapshot the serialised response |
| BC-11 | Combo tier, lucky roll and rate-limit behaviour unchanged | Seeded-RNG + fake-clock tests |
| BC-12 | Audio-room gifts still dead-letter nothing — the new `QueueJobRegistry` returns `{ ok: true, unhandled: true }` for `gift.sent` | Assert DLQ depth is 0 after N audio sends (§5.1) |

**Method.** Capture a baseline from the current `GiftService` **before** the
refactor begins — record wallet movements, published events, enqueued jobs and the
API response for a fixed set of audio-room scenarios. The extraction is then
verified by re-running the identical scenarios against the refactored code and
diffing. Writing these baselines is the first implementation task, not the last.

**Rollback posture.** The registry is additive: reverting VR-10 means unregistering
the `VIDEO_ROOM` handler. No schema change, no data migration, and no wallet or
ledger shape change means there is nothing to un-migrate.

---

## 13. Performance targets (non-functional)

**Revised 2026-07-22 — the four starred targets are now validated, not merely
monitored.** They are verified by the benchmark in plan Task 22 Step 3, run
against real PostgreSQL/Redis/BullMQ. They are **not** Jest assertions: the
integration suite mocks its dependencies, so an in-suite latency assertion would
measure mock overhead rather than system behaviour. A missed target escalates as
an architectural decision rather than being tuned away silently.

The unstarred rows remain monitoring/alerting baselines with no pass-fail gate.

| Metric | Target | Notes |
| --- | --- | --- |
| ★ `POST /send` latency (single receiver) | **p95 < 100 ms** | excludes animation delivery |
| ★ `POST /send` latency (`SEAT_ALL`, max receivers) | **p95 < 300 ms** | N credits + N inserts in one transaction |
| ★ Commit → `giftAnimation` broadcast | **p95 < 1 s** | queue hop + per-room lock |
| ★ DLQ replay success rate | **> 99.9 %** | `replayDeadLetter` over 1 000 parked jobs |
| Wallet movement | p95 < 50 ms | `giftWalletLatencyH` |
| Transaction duration | p99 < 1 s | against Prisma's 5 s ceiling (§4.6) — a leading indicator |
| Sustained throughput | ≥ 1 000 gift sends/sec platform-wide | horizontal; per-room ordering is the serialisation point |
| Per-room send rate | ≥ 50/sec sustained | bounded by `video-room:gift:deliver:{roomId}` |
| Delivery queue depth | steady-state < 100; alert > 1 000 | `giftQueueDepthG` |
| DLQ depth | steady-state 0; alert on any growth | dead-lettered gifts are user-visible missing animations |
| Combo sweep tick | < 100 ms | `ZRANGEBYSCORE` over the expiry index |
| Hot-gift cache hit rate | > 95 % | catalog reads on the send path |

**Note on the single-receiver target.** p95 < 100 ms is aggressive for a request
that performs a Redis rate-limit tick, a Redis combo tick, two Redis lock
acquisitions, and a Postgres transaction containing a debit, a credit and an
insert. It is achievable with co-located Redis/Postgres and a warm pool, but it
leaves little headroom. If the benchmark misses it, the realistic levers are
pipelining the pre-flight Redis calls and reducing lock round-trips — not
widening the transaction.

**Known serialisation point.** The per-room delivery lock bounds a single room's
animation throughput. This is deliberate — ordering matters more than raw rate
inside one room — but it is the first thing to revisit if a high-traffic room
saturates. Cross-room throughput scales with `QUEUE_CONCURRENCY` and instance count.

**Known hot row.** The sender's wallet is the contention point under combo
spamming, which is why D3 batches N receivers into a single debit. The rate
limiter (`GIFT_RATE_MAX` / `GIFT_RATE_WINDOW_SECONDS`) is the primary control.

---

## 14. Testing strategy

| Layer | Coverage |
| --- | --- |
| **Regression (critical)** | The full BC-1…BC-12 backward-compatibility gate — see §12. Baselines are captured **before** the refactor starts |
| **Regression (critical)** | `QueueJobRegistry.dispatch()` on an unregistered job name returns `{ ok: true, unhandled: true }` and never throws — protects the existing `gift.sent` job |
| **Regression (critical)** | multi-receiver batch credits N distinct wallets — asserts per-leg idempotency keys, guarding the double-credit collapse (§4.3) |
| Registry | resolution, unknown context throws `GIFT_CONTEXT_INVALID`, double registration |
| Handler | every validation rule; `maxReceivers`; viewer gating; economics bps |
| Target resolver | `SINGLE` / `MULTI` / `SEAT_ALL`; `ROOM_ALL` gated off; duplicate ids |
| Wallet/transaction | one debit + N credits; rollback on any receiver failure; idempotent replay returns originals; balance never negative |
| Concurrency | parallel sends to overlapping receiver sets do not deadlock (sorted locks); concurrent identical idempotency keys yield one batch |
| Queue | priority ordering; retry/backoff; DLQ on exhaustion; replay mints a new `jobId`; per-room lock serialises delivery |
| Combo | started/updated/ended; window reset; sweep emits ended exactly once; cost unaffected by tier |
| Socket | each of the 9 events fires with the correct correlation envelope; animation is batch-level, delivery per-leg |
| API | all 5 routes — auth, permission, validation, pagination, error codes |
| Integration | end-to-end send → ledger → statistics → animation → delivered, single and multi-receiver |

---

## 15. Deliverables

**gifts** (refactor) — `gift-context-handler.interface.ts`, `gift-context.registry.ts`,
`sendGiftBatch()`, dependency reduction, `compensate()` deleted.

**audio-rooms** (move) — `AudioRoomGiftContextHandler` carrying the audio validation,
treasure/host-reward/refund `onSend`, and `{ receiverEarningsBps: 0 }` economics.

**infra/queue** (seam) — `queue-job.registry.ts` (new), `gift-processing.processor.ts` (route-only).

**video-rooms** (new) — `VideoRoomGiftContextHandler` · `VideoRoomGiftService` ·
`VideoRoomGiftTargetResolver` · `VideoRoomGiftComboService` ·
`VideoRoomGiftDeliveryService` · `VideoRoomGiftQueryService` ·
`VideoRoomGiftStatisticsService` · `VideoRoomGiftSocketListener` ·
`VideoRoomGiftMonitor` · `VideoRoomsGiftsController` · DTOs · events · constants ·
config · metrics.

**Migrations: 0. Git operations: none.**
