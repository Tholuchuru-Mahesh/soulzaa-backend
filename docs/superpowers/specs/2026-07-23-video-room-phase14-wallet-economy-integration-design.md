# Video Room — Phase 14: Wallet & Economy Integration (Design)

- **Date:** 2026-07-23
- **Phase:** VR-14
- **Status:** Approved (design) — ready for implementation plan
- **Author:** Backend
- **Scope decision:** *Integration layer only* (observer / read-model / realtime), on top of the existing wallet. No new wallet service, ledger tables, queues, or balance-mutation paths.

---

## 1. Context & premise correction

The Phase 14 brief reads as "add the wallet calls, make video-room transactions atomic / idempotent / ledgered / recoverable." **Reconnaissance (three independent passes over the financial core, the video-room economy engines, and the audio-room reference flow) established that this core work is already built and already wired by Phases 10–13.** Phase 14 is therefore *not* a wiring phase — it is a thin realtime + read + reconciliation layer.

### What already exists (must be reused, not rebuilt)

| Capability | Where | Status |
|---|---|---|
| Centralized balance-mutation authority | `WALLET_SERVICE` (`@Global`) → `IWalletService.debit(input, tx?)` / `credit(input, tx?)` — `src/modules/wallet/interfaces/wallet.service.interface.ts:10` | ✅ done |
| Atomic movement (Prisma `$transaction`, negative-balance guard) | `WalletRepository.applyMovement` — `src/modules/wallet/repositories/wallet.repository.ts:76` | ✅ done |
| Idempotency (unique key + service replay) | `WalletTransaction.idempotencyKey @unique` + `WalletService.move` replay — `wallet.service.ts:90` | ✅ done |
| Distributed lock (per-user, Redis) | `LockService.withLock(walletLockKey(userId), …)` — `wallet.service.ts:122` | ✅ done |
| Immutable ledger | `wallet_transactions` (append-only, `balanceBefore`/`balanceAfter`) | ✅ done |
| Domain events | `WALLET_EVENTS.DEBITED`/`CREDITED` on `EVENT_BUS`, payload `WalletMovementPayload` — `src/modules/wallet/events/wallet.events.ts` | ✅ done |
| Gift send debit + creator earnings credit | `VideoRoomGiftService.send` → shared `GiftService.sendGiftBatch` — `video-room-gift.service.ts:101` | ✅ done |
| Gift refund / reversal | `VideoRoomGiftReversalService.reverseOne` (debit EARNINGS + credit GOLD) — `video-room-gift-reversal.service.ts:142` | ✅ done |
| Treasure reward payout (minted → credited) | `VideoRoomTreasureUnlockService` → shared `RewardDistributor.distribute` — `video-room-treasure-unlock.service.ts:237` | ✅ done |
| PK reward payout (minted → credited) | `VideoRoomPkSettlementService.payOne` → `wallet.credit(PK_REWARD)` — `video-room-pk-settlement.service.ts:512` | ✅ done |
| Ranking consumes economy (read-only) | `VideoRoomRankingActivityListener` + aggregation service | ✅ done |
| BullMQ + DLQ + job registry | `QueueService`, `QueueJobRegistry.register(queue, job, handler)`, `wallet-processing` queue (processor is a stub) | ✅ infra done |
| Metrics stack | `prom-client` via `MetricsService` / `MonitoringMetrics`; `/metrics` endpoint | ✅ infra done |
| Socket fan-out helpers | `emitToUser`, `emitToRoom`, `emitToUserEverywhere` (Redis-adapter backed) — `src/infra/socket/socket.manager.ts:168` | ✅ done |

### Genuine gaps this phase fills

1. **No realtime wallet/balance/reward push exists anywhere.** Wallet movements publish only to the internal `EVENT_BUS`; nothing bridges them to sockets. (The single existing subscriber is VIP recharge progress.)
2. **Read surface is thin.** Only `GET /wallet/balance` and `GET /wallet/transactions` exist. No earnings / rewards / history / recovery endpoints.
3. **`wallet-processing` queue processor is a stub** — no reconciliation / verification job.
4. **`GiftRefundedPayload` carries no `receiverId`** — a known limitation worked around by two listeners.

---

## 2. Locked design decisions

1. **Scope:** Integration layer only. Strictly additive, fully backward compatible.
2. **Socket delivery:** *User-everywhere + room echo.* Personal wallet events push to the affected user via `emitToUserEverywhere`; room-visible reward / host-earning events additionally echo into the video-room.
3. **Read models:** *Extend the global `/wallet` controller.* Earnings / rewards / history are queries over the `wallet_transactions` ledger (single source of truth), enriched with domain context via `referenceId`.
4. **Recovery:** *Detect + re-drive, never auto-write.* Reconciliation verifies `Σledger == balanceColumn` and re-drives stranded async settlements through the **existing** treasure/PK recovery services. It never writes a balance outside the movement path. `POST /admin/wallet/recovery` = admin-triggered reconcile + drift report.

### Ownership split

- **`wallet` module** owns all user-scoped, cross-cutting concerns: realtime balance push, read models, reconciliation, metrics.
- **`video-rooms` module** owns only room-contextual realtime events: host earnings, treasure rewards, PK rewards, room echoes.
- **`WALLET_SERVICE` remains the ONLY component permitted to mutate balances.** Every new component is an observer or read model.

---

## 3. Architecture & file layout (all additive)

**`src/modules/wallet/` (extend):**
```
listeners/wallet-realtime.listener.ts       # NEW  EVENT_BUS wallet.debited/credited → emitToUserEverywhere (coalesced)
services/wallet-read.service.ts             # NEW  earnings / rewards / history read models
services/wallet-reconciliation.service.ts   # NEW  Σledger==balance verify; re-drive stranded settlements; registers on wallet-processing queue
metrics/wallet.metrics.ts                   # NEW  prom-client counters/histograms into existing MetricsService
controllers/wallet.controller.ts            # EDIT +GET /wallet/earnings, /rewards, /history
controllers/wallet-admin.controller.ts      # EDIT +POST /admin/wallet/recovery
repositories/wallet.repository.ts           # EDIT +aggregate/read query methods (no Prisma leaks into services)
dto/wallet.dto.ts                           # EDIT +WalletEarningsDto, RewardDto, WalletHistoryDto, HostEarningsDto, filter DTOs
constants/wallet.constants.ts               # EDIT +socket event names, job names, coalescing window
wallet.module.ts                            # EDIT wire new providers/listeners
```

**`src/modules/video-rooms/` (extend):**
```
listeners/video-room-economy-socket.listener.ts  # NEW  gift.sent(VIDEO_ROOM)→hostEarningUpdated; treasure/pk reward_distributed→rewardReceived; room echo
video-rooms.module.ts                            # EDIT wire the new listener
```

**`src/modules/gifts/` (contract fix, backward compatible):**
```
events/gift.events.ts   # EDIT add optional receiverId to GiftRefundedPayload; populate at emit sites
```

**Guiding principle:** every new unit is a *listener* or a *read model*. The write path (debit/credit/ledger) is observed and exposed, never duplicated or re-entered. This is what preserves ACID guarantees — no second code path can mutate balance.

---

## 4. Section — Realtime socket bridge

### 4.1 `WalletRealtimeListener` (wallet module, user-scoped)

Subscribes to `WALLET_EVENTS.DEBITED` / `CREDITED` on the `EVENT_BUS`. Payload `WalletMovementPayload` already carries `{ userId, transactionId, currency, amount, balanceAfter, reason, referenceType, referenceId }` — sufficient to push with **no DB read**. Emits to the user everywhere via `socketManager.emitToUserEverywhere(userId, event, payload)`:

| Socket event | Trigger | Payload |
|---|---|---|
| `balanceChanged` | any wallet.debited/credited | `{ currency, balanceAfter }` |
| `walletUpdated` | any wallet movement | full balances snapshot `{ gold, free, earnings }` |
| `transactionCreated` | successful movement | `{ transactionId, reason, type, amount, currency }` |
| `transactionCompleted` | successful movement | same as `transactionCreated` |

### 4.2 Event-semantics clarifications (documented, agreed)

- **`transactionFailed` is an application-layer event, NOT a wallet-domain event.** A failed wallet operation (e.g. `INSUFFICIENT_BALANCE`) throws and rolls back, producing **no committed `WalletTransaction` and no wallet event** — so there is nothing on the `EVENT_BUS` to bridge. `transactionFailed` is therefore emitted by the *operation that failed*, at its existing catch site (e.g. video-room gift send catching `INSUFFICIENT_BALANCE`), and delivered to the initiating user. It is explicitly not owned by the wallet realtime listener.
- **`transactionCreated` and `transactionCompleted` are aliases of the same successful atomic commit** in the current synchronous implementation (there is no async pending state). They are emitted together off one wallet event. They remain distinct event names purely for **forward compatibility** if asynchronous wallet workflows (queued/settlement-pending transactions) are introduced later; at that point `created` would fire on enqueue and `completed` on commit.

### 4.3 Per-user coalescing window (burst optimization)

`walletUpdated` and `balanceChanged` are coalesced per user over a short window (**default 75 ms**, configurable, bounded 50–100 ms). During a burst (e.g. a multi-target gift crediting many receivers, or rapid combo sends), only the **latest** balance snapshot per user is broadcast when the window elapses.

- Correctness-preserving: the coalesced payload always reflects the **most recent `balanceAfter`** (last-writer-wins on a per-user timer), never a stale value. Reconciliation and the ledger remain the source of truth; this only reduces redundant socket broadcasts.
- `transactionCreated` / `transactionCompleted` are **NOT coalesced** — each transaction is an individual, meaningful signal, so per-transaction events fire immediately.
- Implementation: a small in-process per-user debounce map keyed by `userId` (`setTimeout`/`clearTimeout`), cleared on flush. Purely additive; no persistence.

### 4.4 `VideoRoomEconomySocketListener` (video-rooms module, room-contextual)

Subscribes to domain events the engines **already emit** — no new source emissions:

| Socket event | Source event (already emitted) | Delivery |
|---|---|---|
| `rewardReceived` | `VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED` (per recipient), `VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED` | to recipient (`emitToUser`) + echo into room (`emitToRoom`) |
| `hostEarningUpdated` | `GIFT_EVENTS.SENT` filtered `contextType === 'VIDEO_ROOM'` | to host (`emitToUser`) + echo into room |

Filtering mirrors the existing audio/video listener convention (`contextType` guard). This listener performs **no wallet work** — it only maps already-committed domain events to sockets.

---

## 5. Section — Read models & REST (extend `/wallet`)

All read models are **queries over `wallet_transactions`** via new `WalletRepository` methods (services never touch Prisma directly). `WalletReadService` composes them into DTOs.

| Endpoint | Guard | Source | DTO |
|---|---|---|---|
| `GET /wallet/earnings` | JWT (self) | reason breakdown sourced from each reason's ACTUAL currency: `GIFT_RECEIVE` from `EARNINGS`, `TREASURE_BOX` + `PK_REWARD` from `GOLD` (that is how those reasons are credited in production — gifts become creator diamonds, treasure/PK are spendable GOLD prizes). `settlementReady` = current `EARNINGS` balance | `HostEarningsDto` (totalEarned, settlementReady, bySource: gifts/treasure/pk) |
| `GET /wallet/rewards` | JWT (self) | `reason IN (TREASURE_BOX, PK_REWARD, EVENT_REWARD)` enriched with `VideoRoomPkReward` / `TreasureWinner` via `referenceId` | `RewardDto[]` (paginated) |
| `GET /wallet/history` | JWT (self) | unified ledger with filters (date range, reason, currency) | `WalletHistoryDto` (paginated) |
| `POST /admin/wallet/recovery` | existing admin guard | runs reconciliation for a target user | drift report (§6) |

- **Backward compatibility:** existing `GET /wallet/balance` and `GET /wallet/transactions` are untouched and retained. `GET /wallet/history` is a richer superset — not a replacement.
- **Settlement-ready** (from the brief's "Host Earnings / Settlement Ready"): expressed as the current `EARNINGS` balance surfaced in `HostEarningsDto`. Actual withdrawal/settlement gateway stays **out of scope** per the brief.
- Every endpoint gets Swagger (`@ApiOperation` / `@ApiResponse`) + typed DTOs matching existing controller style.

---

## 6. Section — Reconciliation & recovery (never auto-writes)

`WalletReconciliationService` registers handlers on the **existing** `wallet-processing` queue via `QueueJobRegistry.register(QUEUE_NAMES.WALLET_PROCESSING, jobName, handler)` — the pattern PK/treasure/ranking already use. Scheduled with the existing `QueueService.schedule` (cron). Fleet-wide sweeps run behind `LockService.withLock` so only one instance reconciles at a time.

**Job 1 — balance verification.** For a user (or a swept batch): recompute expected balance per currency = `Σ(CREDIT.amount) − Σ(DEBIT.amount)` from `wallet_transactions`; compare to the `Wallet` balance columns. On drift: **log + increment `wallet_reconciliation_drift_total` + write an audit record**. It **never** writes the balance column (honors "never update balances directly"); drift is surfaced for manual repair.

**Job 2 — stranded-settlement re-drive.** Delegates to the **existing, idempotent** `VideoRoomTreasureRecoveryService` / `VideoRoomPkRecoveryService` to re-drive orphaned async payouts. Reused, not reinvented.

**`POST /admin/wallet/recovery`** runs Job 1 synchronously for a target user and returns:
```
{ userId, perCurrency: [{ currency, ledgerComputed, balanceColumn, drift }], strandedSettlements: [...] }
```

> **Note on "transaction engine / create-commit-rollback-retry" from the brief:** these are *already provided* by Prisma `$transaction` (commit/rollback), the unique idempotency key (duplicate prevention / safe retry), and the BullMQ `attempts` + exponential backoff + DLQ (retry/recovery). No standalone transaction-engine component is built; doing so would duplicate the wallet.

---

## 7. Section — Bug fix, monitoring, audit, RBAC

- **Bug fix (`GiftRefundedPayload.receiverId`):** add an optional `receiverId` field to the payload in `gifts/events/gift.events.ts` and populate it at the **single** current emit site (`audio-room-gift-context.handler.ts`, the only publisher of `gift.refunded`), completing the shared contract so consumers (PK-reversal, ranking listeners) can read the receiver when present instead of working around its absence. Additive (optional field) → backward compatible. *Note: this completes the contract; it does not by itself make video-room gift reversals publish `gift.refunded` (they currently publish nothing to the bus) — that broader change is out of Phase 14 scope.*
- **Monitoring:** `wallet.metrics.ts` registers into the existing `prom-client` registry (surfaced on the existing `/metrics` endpoint — no new stack):
  - `wallet_transactions_total{reason,type,currency}` (counter → volume, derives TPS)
  - `wallet_movement_duration_ms` (histogram → latency + TPS)
  - `wallet_transaction_failed_total{reason}` (counter → failures, from the app-layer failure path)
  - `wallet_reconciliation_drift_total` (counter → drift / rollback signal)
  Counters are incremented from the realtime listener (on wallet events) and the reconciliation service.
- **Audit:** reuses existing `audit.util` + the immutable `wallet_transactions` ledger. Reconciliation drift and admin-recovery calls emit an audit record with `{ walletId(=userId), transactionId?, userId, roomId?, referenceId, requestId, timestamp }` (the brief's audit-field set).
- **RBAC:** read endpoints are self-scoped (JWT guard; a user reads only their own wallet). Admin recovery uses the existing admin guard on `WalletAdminController`. Room echoes are already gated by room membership (Phase 7 RBAC). No new permission engine.

---

## 8. Section — Testing

- **Unit:**
  - `WalletRealtimeListener` — correct socket events per movement; coalescing flushes latest snapshot; `transactionCreated`/`Completed` not coalesced.
  - `WalletReadService` — earnings/rewards/history aggregation math; reason/currency filters.
  - `WalletReconciliationService` — drift detection correctness; **asserts it never calls `debit`/`credit` to "fix" a balance** (the core safety invariant); stranded re-drive delegates to existing recovery services.
  - `VideoRoomEconomySocketListener` — event→socket mapping + `VIDEO_ROOM` filter + recipient/room fan-out.
- **Integration:**
  - gift send → asserts `balanceChanged` + `hostEarningUpdated` emitted.
  - treasure / PK payout → asserts `rewardReceived`.
  - reconciliation over a seeded ledger with injected drift → correct drift report, **zero balance writes**.
- **Concurrency:** reuse the wallet's existing concurrency harness to confirm read/reconciliation paths never interleave with movements (read-only).
- No test re-exercises the already-tested write path except through its public surface.

---

## 9. Explicit non-goals (do NOT build)

- ❌ A second wallet / coin / transaction module.
- ❌ A standalone "transaction engine" (create/commit/rollback/retry) — already provided by Prisma `$transaction` + idempotency key + BullMQ retry/DLQ.
- ❌ New `wallet-recovery` / `wallet-settlement` / `wallet-notification` queues — the one `wallet-processing` queue + `QueueJobRegistry` + DLQ cover it.
- ❌ New ledger / balance tables.
- ❌ Any direct balance mutation outside `WALLET_SERVICE`.
- ❌ Payment gateway, coin purchase, withdrawal/settlement gateway, KYC, admin finance dashboard (separate modules, per the brief).

---

## 10. Backward compatibility & additive guarantee

- Every change is **additive**: new files, new endpoints, new optional event field, new metrics. No existing endpoint, event name, DTO field, table, queue, or service signature is removed or changed in a breaking way.
- Existing `GET /wallet/balance` and `GET /wallet/transactions` remain byte-for-byte behavior-compatible.
- The `GiftRefundedPayload.receiverId` addition is an **optional** field; existing consumers are unaffected.
- The wallet write path (debit/credit/ledger/lock) is not modified at all.

---

## 11. File manifest

**New source files (5) + tests:**
- `src/modules/wallet/listeners/wallet-realtime.listener.ts`
- `src/modules/wallet/services/wallet-read.service.ts`
- `src/modules/wallet/services/wallet-reconciliation.service.ts`
- `src/modules/wallet/metrics/wallet.metrics.ts`
- `src/modules/video-rooms/listeners/video-room-economy-socket.listener.ts`
- tests: a `*.spec.ts` alongside each new service/listener, plus one integration spec under the existing video-rooms integration test area

**Modified (8):**
- `src/modules/wallet/controllers/wallet.controller.ts`
- `src/modules/wallet/controllers/wallet-admin.controller.ts`
- `src/modules/wallet/repositories/wallet.repository.ts`
- `src/modules/wallet/dto/wallet.dto.ts`
- `src/modules/wallet/constants/wallet.constants.ts`
- `src/modules/wallet/wallet.module.ts`
- `src/modules/video-rooms/video-rooms.module.ts`
- `src/modules/gifts/events/gift.events.ts` (+ its single emit site in `audio-room-gift-context.handler.ts`)

**Zero** Prisma migrations. **Zero** new queues. **Zero** new balance-mutation paths.

---

## 12. Process constraints

- **No git operations** (project rule + user instruction). The spec is written to the working tree; it will not be committed. Implementation stays uncommitted in the working tree.
- Implementation follows TDD, is strictly additive, and preserves full backward compatibility.
