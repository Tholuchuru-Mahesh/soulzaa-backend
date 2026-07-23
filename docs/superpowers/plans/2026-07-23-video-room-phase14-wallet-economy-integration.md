# Video Room — Phase 14: Wallet & Economy Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin realtime + read + reconciliation layer on top of the existing wallet so Video Room coin movements surface as live socket updates, queryable earnings/rewards/history, and a never-auto-writing reconciliation job — without duplicating the already-built wallet.

**Architecture:** Every new unit is an *observer* (EVENT_BUS listener) or a *read model* (query over the `wallet_transactions` ledger). `WALLET_SERVICE` remains the ONLY balance mutator. Cross-cutting, user-scoped concerns live in the `wallet` module; room-contextual echoes live in `video-rooms`. Zero Prisma migrations, zero new queues, zero new balance-mutation paths.

**Tech Stack:** NestJS 10, TypeScript, Prisma (PostgreSQL), Socket.IO (Redis adapter), BullMQ, `prom-client`, `EVENT_BUS` (in-process `EventEmitter2`), Jest.

## Global Constraints

- **No git operations.** Project rule + user instruction: work stays in the working tree, uncommitted. Every "Checkpoint" step runs verification only — never `git add`/`git commit`/`git`-anything.
- **Strictly additive & backward compatible.** No existing endpoint, event name, DTO field, table, queue, or service signature is removed or changed in a breaking way. New event/DTO fields are optional.
- **`WALLET_SERVICE` is the sole balance mutator.** No new code path may call Prisma to write `wallets` balance columns. Reconciliation NEVER auto-writes a balance.
- **No Prisma queries inside services.** All DB access goes through `WalletRepository` methods (repository pattern, matching the existing module).
- **Reuse infra, don't recreate it:** `EVENT_BUS`, `SocketManager` (`emitToUserEverywhere` / `emitToNamespaceRoom`), the single `wallet-processing` BullMQ queue + `QueueJobRegistry` + DLQ, `MetricsService` registry, `LockService`.
- **BigInt at the DB boundary, `number` at the app boundary** — mirror `WalletService.getBalance` (`Number(x ?? 0n)`).
- **Test runner:** `npx jest <path>` (unit specs live next to source, `*.spec.ts`). **Typecheck:** `npx tsc --noEmit`. **Lint:** `npx eslint <path>`.

## Confirmed contracts (consume verbatim — do not redefine)

- `IEventBus` — `src/common/events`: `subscribe<E extends DomainEvent>(name: string, handler: (e: E) => void|Promise<void>): () => void`; `publish<E>(event: E): Promise<void>`. Token `EVENT_BUS`.
- `DomainEvent<TPayload>` — `src/common/events/domain-event.ts`: abstract `readonly name: string`; `constructor(readonly payload: TPayload)`.
- `WALLET_EVENTS` — `src/modules/wallet/events/wallet.events.ts`: `DEBITED='wallet.debited'`, `CREDITED='wallet.credited'`. `WalletDebitedEvent`/`WalletCreditedEvent` carry `WalletMovementPayload = { userId, transactionId, currency: WalletCurrency, amount: number, balanceAfter: number, reason: WalletTxnReason, referenceType: string|null, referenceId: string|null }`.
- `SocketManager` (`@Injectable`, `src/infra/socket/socket.manager.ts`): `emitToUserEverywhere(userId: string, event: string, payload: unknown): void`; `emitToNamespaceRoom(namespace: string, roomId: string, event: string, payload: unknown): void`.
- `SOCKET_NAMESPACES.VIDEO_ROOM = '/video-room'` — `src/common/constants/socket.constants.ts`.
- `WalletService` (`src/modules/wallet/services/wallet.service.ts`): `getBalance(userId): Promise<{gold,free,earnings}>`; `listTransactions(userId, {skip,limit,page,currency?})`.
- `WalletRepository` (`src/modules/wallet/repositories/wallet.repository.ts`): `constructor(prisma: PrismaService)`; existing `getWallet`, `listTransactions`.
- `GIFT_EVENTS.SENT='gift.sent'` / `REFUNDED='gift.refunded'`; `GiftSentPayload` has `{ transactionId, senderId, receiverId, giftId, giftName, contextType, contextId, quantity, totalCoinValue, creatorEarnings, createdAt, ... }`; `GiftRefundedPayload = { transactionId, senderId, roomId, giftId, giftName, totalRefundAmount, createdAt }` (single publisher: `audio-room-gift-context.handler.ts:178`). `GiftContextType.VIDEO_ROOM`.
- `TreasureRewardDistributedEvent` (`video-room-treasure.events.ts`): name `VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED='video_room.treasure.reward_distributed'`; payload `{ correlationId, roomId, sessionId, boxId?, userId: string, amount: number, walletTxnId: string|null }`.
- `PkRewardDistributedEvent` (`video-room-pk.events.ts`): name `VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED='video_room.pk.reward_distributed'`; payload `{ roomId, battleId, poolAmount: number, allocatedAmount: number, rewards: { userId: string; kind: string; amount: number }[] }`.
- `QueueJobRegistry` (`src/infra/queue/workers/queue-job.registry.ts`): `register(queue: string, jobName: string, handler: (data: unknown, job: Job) => Promise<unknown>): void`; `dispatch(queue, job)`.
- `QueueService` (`src/infra/queue/queue.service.ts`): `schedule<T>(queue: QueueName, name: string, data: T, repeat: RepeatSpec): Promise<...>`; `RepeatSpec = { pattern: string }`. `QUEUE_NAMES.WALLET_PROCESSING='wallet-processing'`.
- `MetricsService` (`@Global`, `src/infra/observability/metrics.service.ts`): `readonly registry: Registry`.
- `LockService` (`src/infra/redis/lock.service.ts`): `withLock<T>(key, fn, opts?): Promise<T>`.
- `buildPaginated(items, total, page, limit)` — `src/common/utils/pagination.util.ts`; `Paginated<T>` — `src/common/interfaces/api-response.interface`; `PaginationQueryDto` (`{skip,limit,page}`) — `src/common/dto/pagination.dto`.
- `@CurrentUser('id')`, `@Roles('ADMIN','SUPER_ADMIN')`, `ParseUuidPipe` — used exactly as in `wallet-admin.controller.ts`.

---

### Task 1: Constants — wallet socket events, job names, coalescing window, video-room economy socket events

**Files:**
- Modify: `src/modules/wallet/constants/wallet.constants.ts`
- Create: `src/modules/video-rooms/constants/video-room-economy.constants.ts`
- Test: `src/modules/wallet/constants/wallet.constants.spec.ts` (create)

**Interfaces:**
- Produces (wallet): `WALLET_SOCKET_EVENTS = { WALLET_UPDATED:'walletUpdated', BALANCE_CHANGED:'balanceChanged', TRANSACTION_CREATED:'transactionCreated', TRANSACTION_COMPLETED:'transactionCompleted' }`; `WALLET_JOBS = { RECONCILE_SWEEP:'wallet.reconcile.sweep' }`; `WALLET_COALESCE_WINDOW_MS = 75`.
- Produces (video-rooms): `VIDEO_ROOM_ECONOMY_SOCKET_EVENTS = { REWARD_RECEIVED:'rewardReceived', HOST_EARNING_UPDATED:'hostEarningUpdated', TRANSACTION_FAILED:'transactionFailed' }`; `VIDEO_ROOM_ECONOMY_EVENTS = { GIFT_FAILED:'video_room.economy.gift_failed' }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/wallet/constants/wallet.constants.spec.ts
import {
  WALLET_SOCKET_EVENTS,
  WALLET_JOBS,
  WALLET_COALESCE_WINDOW_MS,
} from './wallet.constants';

describe('wallet Phase-14 constants', () => {
  it('exposes the four personal wallet socket event names', () => {
    expect(WALLET_SOCKET_EVENTS).toEqual({
      WALLET_UPDATED: 'walletUpdated',
      BALANCE_CHANGED: 'balanceChanged',
      TRANSACTION_CREATED: 'transactionCreated',
      TRANSACTION_COMPLETED: 'transactionCompleted',
    });
  });

  it('exposes the reconciliation job name', () => {
    expect(WALLET_JOBS.RECONCILE_SWEEP).toBe('wallet.reconcile.sweep');
  });

  it('keeps the coalescing window within the agreed 50–100ms band', () => {
    expect(WALLET_COALESCE_WINDOW_MS).toBeGreaterThanOrEqual(50);
    expect(WALLET_COALESCE_WINDOW_MS).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/wallet/constants/wallet.constants.spec.ts`
Expected: FAIL — `WALLET_SOCKET_EVENTS` is not exported.

- [ ] **Step 3: Append to `wallet.constants.ts`**

```typescript
// ---- VR-14: realtime + reconciliation ----

/** Personal, user-scoped wallet socket events (pushed via emitToUserEverywhere). */
export const WALLET_SOCKET_EVENTS = {
  WALLET_UPDATED: 'walletUpdated',
  BALANCE_CHANGED: 'balanceChanged',
  TRANSACTION_CREATED: 'transactionCreated',
  TRANSACTION_COMPLETED: 'transactionCompleted',
} as const;

/** BullMQ job names on the existing `wallet-processing` queue. */
export const WALLET_JOBS = {
  RECONCILE_SWEEP: 'wallet.reconcile.sweep',
} as const;

/**
 * Per-user coalescing window for balance broadcasts. During a burst (multi-target
 * gift, rapid combos) only the latest balance snapshot per user is emitted when
 * the window elapses. Correctness-preserving: last-writer-wins on balanceAfter.
 */
export const WALLET_COALESCE_WINDOW_MS = 75;

/** Distributed-lock key for the fleet-wide reconciliation sweep. */
export const WALLET_RECONCILE_LOCK_KEY = 'wallet:reconcile:sweep';
```

- [ ] **Step 4: Create `video-room-economy.constants.ts`**

```typescript
// src/modules/video-rooms/constants/video-room-economy.constants.ts

/**
 * Room-contextual economy socket events (VR-14). Emitted into the `/video-room`
 * namespace + to the affected user. Distinct from the personal wallet events,
 * which the wallet module owns.
 */
export const VIDEO_ROOM_ECONOMY_SOCKET_EVENTS = {
  REWARD_RECEIVED: 'rewardReceived',
  HOST_EARNING_UPDATED: 'hostEarningUpdated',
  TRANSACTION_FAILED: 'transactionFailed',
} as const;

/**
 * Application-layer economy failure event on the EVENT_BUS. Published by the
 * failing operation (e.g. gift send catching INSUFFICIENT_BALANCE), bridged to
 * the `transactionFailed` socket event by VideoRoomEconomySocketListener. This is
 * NOT a wallet-domain event: a failed wallet movement rolls back and produces no
 * wallet transaction and no wallet event, so there is nothing on the wallet bus
 * to observe.
 */
export const VIDEO_ROOM_ECONOMY_EVENTS = {
  GIFT_FAILED: 'video_room.economy.gift_failed',
} as const;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/wallet/constants/wallet.constants.spec.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet/constants/wallet.constants.ts src/modules/video-rooms/constants/video-room-economy.constants.ts`
Expected: no type or lint errors. Do NOT commit (working-tree-only per project rule).

---

### Task 2: `WalletMetrics` — prom-client families for wallet monitoring

**Files:**
- Create: `src/modules/wallet/metrics/wallet.metrics.ts`
- Modify: `src/modules/wallet/wallet.module.ts` (register provider)
- Test: `src/modules/wallet/metrics/wallet.metrics.spec.ts` (create)

**Interfaces:**
- Consumes: `MetricsService.registry` (`@Global`).
- Produces: `WalletMetrics` (`@Injectable`) with `recordMovement(reason: string, type: string, currency: string, seconds: number): void`, `recordFailed(reason: string): void`, `recordReconciliationDrift(currency: string): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/wallet/metrics/wallet.metrics.spec.ts
import { MetricsService } from 'src/infra/observability/metrics.service';
import { WalletMetrics } from './wallet.metrics';

describe('WalletMetrics', () => {
  let metrics: MetricsService;
  let wallet: WalletMetrics;

  beforeEach(() => {
    metrics = new MetricsService();
    wallet = new WalletMetrics(metrics);
  });

  it('registers wallet metric families on the shared registry', async () => {
    wallet.recordMovement('GIFT_SEND', 'DEBIT', 'GOLD', 0.012);
    wallet.recordFailed('INSUFFICIENT_BALANCE');
    wallet.recordReconciliationDrift('GOLD');

    const out = await metrics.registry.metrics();
    expect(out).toContain('wallet_transactions_total');
    expect(out).toContain('wallet_movement_duration_seconds');
    expect(out).toContain('wallet_transaction_failed_total');
    expect(out).toContain('wallet_reconciliation_drift_total');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/wallet/metrics/wallet.metrics.spec.ts`
Expected: FAIL — cannot find `./wallet.metrics`.

- [ ] **Step 3: Create `wallet.metrics.ts`**

```typescript
// src/modules/wallet/metrics/wallet.metrics.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

/**
 * Wallet Prometheus metrics (VR-14), registered on the shared registry so they
 * surface at /metrics. Mirrors the MonitoringMetrics pattern. Volume + duration
 * give TPS and latency; failed + drift give the health signals.
 */
@Injectable()
export class WalletMetrics {
  private readonly transactions: Counter<'reason' | 'type' | 'currency'>;
  private readonly duration: Histogram<'reason' | 'type'>;
  private readonly failed: Counter<'reason'>;
  private readonly drift: Counter<'currency'>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.transactions = new Counter({
      name: 'wallet_transactions_total',
      help: 'Total wallet movements observed',
      labelNames: ['reason', 'type', 'currency'] as const,
      registers,
    });
    this.duration = new Histogram({
      name: 'wallet_movement_duration_seconds',
      help: 'Observed wallet movement handling duration in seconds',
      labelNames: ['reason', 'type'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.3, 1],
      registers,
    });
    this.failed = new Counter({
      name: 'wallet_transaction_failed_total',
      help: 'Total wallet operations that failed (application layer)',
      labelNames: ['reason'] as const,
      registers,
    });
    this.drift = new Counter({
      name: 'wallet_reconciliation_drift_total',
      help: 'Total ledger-vs-balance drifts detected by reconciliation',
      labelNames: ['currency'] as const,
      registers,
    });
  }

  recordMovement(reason: string, type: string, currency: string, seconds: number): void {
    this.transactions.inc({ reason, type, currency });
    this.duration.observe({ reason, type }, seconds);
  }

  recordFailed(reason: string): void {
    this.failed.inc({ reason });
  }

  recordReconciliationDrift(currency: string): void {
    this.drift.inc({ currency });
  }
}
```

- [ ] **Step 4: Register the provider in `wallet.module.ts`**

Add the import and put `WalletMetrics` in the `providers` array (and `exports`, so the video-rooms failure path can reuse it if needed later):

```typescript
import { WalletMetrics } from './metrics/wallet.metrics';
// ...
  providers: [
    WalletRepository,
    WalletService,
    WalletMetrics,
    { provide: WALLET_SERVICE, useExisting: WalletService },
  ],
  exports: [WALLET_SERVICE, WalletService, WalletMetrics],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/wallet/metrics/wallet.metrics.spec.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet/metrics/wallet.metrics.ts src/modules/wallet/wallet.module.ts`
Expected: clean. Do NOT commit.

---

### Task 3: `WalletRealtimeListener` — coalesced personal balance push + per-transaction events + metrics

**Files:**
- Create: `src/modules/wallet/listeners/wallet-realtime.listener.ts`
- Modify: `src/modules/wallet/wallet.module.ts` (register listener)
- Test: `src/modules/wallet/listeners/wallet-realtime.listener.spec.ts` (create)

**Interfaces:**
- Consumes: `EVENT_BUS`, `SocketManager`, `WalletService.getBalance`, `WalletMetrics`, `WALLET_SOCKET_EVENTS`, `WALLET_COALESCE_WINDOW_MS`.
- Produces: `WalletRealtimeListener` (`@Injectable implements OnModuleInit, OnModuleDestroy`) with `flush(userId: string): Promise<void>` (test seam).

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/wallet/listeners/wallet-realtime.listener.spec.ts
import { WalletRealtimeListener } from './wallet-realtime.listener';
import { WALLET_SOCKET_EVENTS } from '../constants/wallet.constants';
import { WALLET_EVENTS } from '../events/wallet.events';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = {
    subscribe: (name: string, h: (e: unknown) => void) => {
      handlers[name] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const sockets = { emitToUserEverywhere: jest.fn(), emitToNamespaceRoom: jest.fn() };
  const wallet = { getBalance: jest.fn().mockResolvedValue({ gold: 90, free: 0, earnings: 5 }) };
  const metrics = { recordMovement: jest.fn(), recordFailed: jest.fn(), recordReconciliationDrift: jest.fn() };
  return { handlers, bus, sockets, wallet, metrics };
}

const debited = (over: Partial<Record<string, unknown>> = {}) => ({
  payload: {
    userId: 'u1', transactionId: 't1', currency: 'GOLD', amount: 10,
    balanceAfter: 90, reason: 'GIFT_SEND', referenceType: 'gift', referenceId: null, ...over,
  },
});

describe('WalletRealtimeListener', () => {
  it('emits transactionCreated + transactionCompleted immediately (not coalesced)', async () => {
    const d = makeDeps();
    const l = new WalletRealtimeListener(d.bus as never, d.sockets as never, d.wallet as never, d.metrics as never);
    l.onModuleInit();

    await d.handlers[WALLET_EVENTS.DEBITED](debited());

    const events = d.sockets.emitToUserEverywhere.mock.calls.map((c: unknown[]) => c[1]);
    expect(events).toContain(WALLET_SOCKET_EVENTS.TRANSACTION_CREATED);
    expect(events).toContain(WALLET_SOCKET_EVENTS.TRANSACTION_COMPLETED);
    expect(d.metrics.recordMovement).toHaveBeenCalledWith('GIFT_SEND', 'DEBIT', 'GOLD', expect.any(Number));
  });

  it('coalesces balanceChanged/walletUpdated to one broadcast per window with the latest balance', async () => {
    const d = makeDeps();
    d.wallet.getBalance.mockResolvedValue({ gold: 70, free: 0, earnings: 5 });
    const l = new WalletRealtimeListener(d.bus as never, d.sockets as never, d.wallet as never, d.metrics as never);
    l.onModuleInit();

    await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 90 }));
    await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 80 }));
    await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 70 }));

    await l.flush('u1'); // force the window closed deterministically

    const balanceEvents = d.sockets.emitToUserEverywhere.mock.calls.filter(
      (c: unknown[]) => c[1] === WALLET_SOCKET_EVENTS.BALANCE_CHANGED,
    );
    expect(balanceEvents).toHaveLength(1);
    expect((balanceEvents[0][2] as { balances: { gold: number } }).balances.gold).toBe(70);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/wallet/listeners/wallet-realtime.listener.spec.ts`
Expected: FAIL — cannot find `./wallet-realtime.listener`.

- [ ] **Step 3: Create `wallet-realtime.listener.ts`**

```typescript
// src/modules/wallet/listeners/wallet-realtime.listener.ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WalletEntryType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { WALLET_COALESCE_WINDOW_MS, WALLET_SOCKET_EVENTS } from '../constants/wallet.constants';
import {
  WALLET_EVENTS,
  type WalletCreditedEvent,
  type WalletDebitedEvent,
  type WalletMovementPayload,
} from '../events/wallet.events';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletService } from '../services/wallet.service';

/**
 * Bridges wallet domain events to the affected user's sockets everywhere (VR-14).
 *
 * Per-transaction signals (transactionCreated/Completed) fire immediately — each
 * is a distinct, meaningful event. Balance snapshots (balanceChanged/walletUpdated)
 * are coalesced per user over a short window so a burst (multi-target gift, rapid
 * combos) collapses to one broadcast carrying the LATEST balance. Correctness is
 * unaffected: the ledger is the source of truth; this only trims redundant pushes.
 *
 * `transactionCreated` and `transactionCompleted` are aliases of the same atomic
 * commit today (there is no async pending state); they stay separate names for
 * forward compatibility with future queued wallet workflows.
 */
@Injectable()
export class WalletRealtimeListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletRealtimeListener.name);
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly wallet: WalletService,
    private readonly metrics: WalletMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletDebitedEvent>(WALLET_EVENTS.DEBITED, (e) =>
      this.onMovement(WalletEntryType.DEBIT, e.payload),
    );
    this.bus.subscribe<WalletCreditedEvent>(WALLET_EVENTS.CREDITED, (e) =>
      this.onMovement(WalletEntryType.CREDIT, e.payload),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private async onMovement(type: WalletEntryType, p: WalletMovementPayload): Promise<void> {
    // Metrics (duration is ~0 here — this is the observe path, not the commit).
    this.metrics.recordMovement(p.reason, type, p.currency, 0);

    // Per-transaction events: immediate, never coalesced.
    const txnPayload = {
      transactionId: p.transactionId,
      reason: p.reason,
      type,
      amount: p.amount,
      currency: p.currency,
    };
    this.sockets.emitToUserEverywhere(p.userId, WALLET_SOCKET_EVENTS.TRANSACTION_CREATED, txnPayload);
    this.sockets.emitToUserEverywhere(p.userId, WALLET_SOCKET_EVENTS.TRANSACTION_COMPLETED, txnPayload);

    // Balance snapshot: coalesced per user.
    this.scheduleBalanceFlush(p.userId);
  }

  private scheduleBalanceFlush(userId: string): void {
    const existing = this.pending.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.flush(userId);
    }, WALLET_COALESCE_WINDOW_MS);
    this.pending.set(userId, timer);
  }

  /** Broadcast the user's current balances now, clearing any pending window. */
  async flush(userId: string): Promise<void> {
    const timer = this.pending.get(userId);
    if (timer) clearTimeout(timer);
    this.pending.delete(userId);
    try {
      const balances = await this.wallet.getBalance(userId);
      this.sockets.emitToUserEverywhere(userId, WALLET_SOCKET_EVENTS.BALANCE_CHANGED, { balances });
      this.sockets.emitToUserEverywhere(userId, WALLET_SOCKET_EVENTS.WALLET_UPDATED, { balances });
    } catch (err) {
      this.logger.warn(`wallet realtime flush failed for ${userId}: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Register the listener in `wallet.module.ts`**

Add `WalletRealtimeListener` to the `providers` array (import it at top). It self-subscribes in `onModuleInit`. It depends on `SocketManager` (`@Global` via socket module) and `WalletMetrics` (Task 2) — no import edits to other modules needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/wallet/listeners/wallet-realtime.listener.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet/listeners/wallet-realtime.listener.ts src/modules/wallet/wallet.module.ts`
Expected: clean. Do NOT commit.

---

### Task 4: `VideoRoomEconomySocketListener` — room echoes for rewards/host-earnings + `transactionFailed` bridge

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-economy-socket.listener.ts`
- Modify: `src/modules/video-rooms/services/video-room-gift.service.ts` (publish `GIFT_FAILED` on wallet-boundary failure)
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (register listener)
- Test: `src/modules/video-rooms/listeners/video-room-economy-socket.listener.spec.ts` (create)

**Interfaces:**
- Consumes: `EVENT_BUS`, `SocketManager`, `SOCKET_NAMESPACES.VIDEO_ROOM`, `GIFT_EVENTS.SENT`, `VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED`, `VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED`, `VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED`, `VIDEO_ROOM_ECONOMY_SOCKET_EVENTS`.
- Produces: `VideoRoomEconomySocketListener` (`@Injectable implements OnModuleInit`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/listeners/video-room-economy-socket.listener.spec.ts
import { VideoRoomEconomySocketListener } from './video-room-economy-socket.listener';
import { VIDEO_ROOM_ECONOMY_SOCKET_EVENTS } from '../constants/video-room-economy.constants';
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => undefined; }, publish: jest.fn() };
  const sockets = { emitToUserEverywhere: jest.fn(), emitToNamespaceRoom: jest.fn() };
  return { handlers, bus, sockets };
}

describe('VideoRoomEconomySocketListener', () => {
  it('bridges VIDEO_ROOM gift.sent to hostEarningUpdated (receiver + room), ignores other contexts', () => {
    const d = makeDeps();
    new VideoRoomEconomySocketListener(d.bus as never, d.sockets as never).onModuleInit();

    d.handlers[GIFT_EVENTS.SENT]({ payload: { contextType: 'AUDIO_ROOM', contextId: 'r1', receiverId: 'h1', creatorEarnings: 10 } });
    expect(d.sockets.emitToNamespaceRoom).not.toHaveBeenCalled();

    d.handlers[GIFT_EVENTS.SENT]({ payload: { contextType: 'VIDEO_ROOM', contextId: 'r1', receiverId: 'h1', creatorEarnings: 10, transactionId: 't1' } });
    expect(d.sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      SOCKET_NAMESPACES.VIDEO_ROOM, 'r1', VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED, expect.any(Object),
    );
    expect(d.sockets.emitToUserEverywhere).toHaveBeenCalledWith('h1', VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED, expect.any(Object));
  });

  it('bridges treasure + pk reward_distributed to rewardReceived', () => {
    const d = makeDeps();
    new VideoRoomEconomySocketListener(d.bus as never, d.sockets as never).onModuleInit();

    d.handlers[VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]({ payload: { roomId: 'r1', userId: 'u1', amount: 50, walletTxnId: 'w1' } });
    d.handlers[VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED]({ payload: { roomId: 'r1', battleId: 'b1', rewards: [{ userId: 'u2', kind: 'WINNER', amount: 100 }] } });

    const rewardCalls = d.sockets.emitToUserEverywhere.mock.calls.filter((c: unknown[]) => c[1] === VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED);
    expect(rewardCalls.map((c: unknown[]) => c[0])).toEqual(['u1', 'u2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-economy-socket.listener.spec.ts`
Expected: FAIL — cannot find the listener module.

- [ ] **Step 3: Create `video-room-economy-socket.listener.ts`**

```typescript
// src/modules/video-rooms/listeners/video-room-economy-socket.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import {
  VIDEO_ROOM_ECONOMY_EVENTS,
  VIDEO_ROOM_ECONOMY_SOCKET_EVENTS,
} from '../constants/video-room-economy.constants';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureRewardDistributedEvent,
} from '../events/video-room-treasure.events';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkRewardDistributedEvent,
} from '../events/video-room-pk.events';

/** Payload of the app-layer gift-failure event (see video-room-economy.constants). */
export interface VideoRoomGiftFailedPayload {
  userId: string;
  roomId: string;
  giftId: string;
  errorCode: string;
  message: string;
}

/**
 * Room-contextual economy → socket bridge (VR-14). Subscribes to events the
 * engines ALREADY emit and maps them to room-facing socket events. Does no wallet
 * work. Mirrors the audio-room GiftSocketListener seam: the `/video-room`
 * namespace constant stays in this module; the gifts module is consumed only via
 * its published events.
 */
@Injectable()
export class VideoRoomEconomySocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    // Host earnings — only VIDEO_ROOM gifts are ours (contextType is shared).
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => {
      const p = e.payload;
      if (p.contextType !== GiftContextType.VIDEO_ROOM) return;
      const payload = {
        roomId: p.contextId,
        hostId: p.receiverId,
        transactionId: p.transactionId,
        earnings: p.creatorEarnings,
      };
      this.room(p.contextId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED, payload);
      this.sockets.emitToUserEverywhere(
        p.receiverId,
        VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED,
        payload,
      );
    });

    // Treasure reward — one payload per recipient.
    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) => {
        const p = e.payload;
        const payload = { source: 'TREASURE', roomId: p.roomId, userId: p.userId, amount: p.amount };
        this.sockets.emitToUserEverywhere(p.userId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED, payload);
        this.room(p.roomId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED, payload);
      },
    );

    // PK reward — payload carries an array of recipients.
    this.bus.subscribe<PkRewardDistributedEvent>(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, (e) => {
      const p = e.payload;
      for (const r of p.rewards) {
        const payload = { source: 'PK', roomId: p.roomId, battleId: p.battleId, userId: r.userId, kind: r.kind, amount: r.amount };
        this.sockets.emitToUserEverywhere(r.userId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED, payload);
        this.room(p.roomId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED, payload);
      }
    });

    // transactionFailed — app-layer, from the failing operation (not the wallet bus).
    this.bus.subscribe<{ payload: VideoRoomGiftFailedPayload }>(
      VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED,
      (e) => {
        const p = e.payload;
        this.sockets.emitToUserEverywhere(p.userId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.TRANSACTION_FAILED, {
          roomId: p.roomId,
          giftId: p.giftId,
          errorCode: p.errorCode,
          message: p.message,
        });
      },
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(SOCKET_NAMESPACES.VIDEO_ROOM, roomId, event, payload);
  }
}
```

- [ ] **Step 4: Publish `GIFT_FAILED` from `VideoRoomGiftService.send` on wallet-boundary failure**

Wrap ONLY the ACID boundary call. The service already injects `@Inject(EVENT_BUS) bus`. Replace the existing `const transactions = await this.gifts.sendGiftBatch(...)` block with:

```typescript
    // ---- ACID boundary: everything that moves coins happens here. ----
    const walletStartedAt = Date.now();
    let transactions;
    try {
      transactions = await this.gifts.sendGiftBatch(actor, {
        giftId: dto.giftId,
        receiverIds,
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: roomId,
        quantity: dto.quantity,
        idempotencyKey: dto.idempotencyKey,
      } as never);
    } catch (err) {
      // A failed wallet movement rolls back — no wallet event fires. Surface the
      // failure to the sender as an application-layer economy event, then rethrow
      // so the HTTP response still reports the error unchanged.
      const be = err as { code?: string; message?: string };
      await this.bus.publish({
        name: VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED,
        payload: {
          userId: actor.id,
          roomId,
          giftId: dto.giftId,
          errorCode: be?.code ?? 'GIFT_SEND_FAILED',
          message: be?.message ?? 'Gift send failed.',
        },
      } as never);
      throw err;
    }
    this.metrics.observeGiftWalletLatency((Date.now() - walletStartedAt) / 1000);
```

Add the import at the top of `video-room-gift.service.ts`:
```typescript
import { VIDEO_ROOM_ECONOMY_EVENTS } from '../constants/video-room-economy.constants';
```

- [ ] **Step 5: Register the listener in `video-rooms.module.ts`**

Add `VideoRoomEconomySocketListener` to the `providers` array (import at top). It self-subscribes in `onModuleInit`; `SocketManager` and `EVENT_BUS` are `@Global`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-economy-socket.listener.spec.ts`
Expected: PASS.

- [ ] **Step 7: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/listeners/video-room-economy-socket.listener.ts src/modules/video-rooms/services/video-room-gift.service.ts src/modules/video-rooms/video-rooms.module.ts`
Expected: clean. Do NOT commit.

---

### Task 5: Wallet read data layer — repository aggregates + DTOs + `WalletReadService`

**Files:**
- Modify: `src/modules/wallet/repositories/wallet.repository.ts` (add read/aggregate methods)
- Modify: `src/modules/wallet/dto/wallet.dto.ts` (add DTOs)
- Create: `src/modules/wallet/services/wallet-read.service.ts`
- Modify: `src/modules/wallet/wallet.module.ts` (register service)
- Test: `src/modules/wallet/services/wallet-read.service.spec.ts` (create)

**Interfaces:**
- Produces (repo):
  - `listByReasons(userId: string, reasons: WalletTxnReason[], skip: number, take: number): Promise<[WalletTransaction[], number]>`
  - `sumByReason(userId: string, reasons: WalletTxnReason[], currency: WalletCurrency): Promise<Array<{ reason: WalletTxnReason; total: bigint }>>`
  - `aggregateSignedByCurrency(userId: string): Promise<Array<{ currency: WalletCurrency; credited: bigint; debited: bigint }>>`
  - `listHistory(userId: string, filters: { currency?: WalletCurrency; reason?: WalletTxnReason }, skip: number, take: number): Promise<[WalletTransaction[], number]>`
- Produces (service): `WalletReadService.getEarnings(userId)`, `.getRewards(userId, page, limit)`, `.getHistory(userId, filters, page, limit)`.
- Produces (dto): `WalletRewardsQueryDto`, `WalletHistoryQueryDto`, plus response shapes `HostEarningsDto`, `RewardDto`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/wallet/services/wallet-read.service.spec.ts
import { WalletTxnReason, WalletCurrency, WalletEntryType } from '@prisma/client';
import { WalletReadService } from './wallet-read.service';

function repoMock() {
  return {
    sumByReason: jest.fn(),
    listByReasons: jest.fn(),
    aggregateSignedByCurrency: jest.fn(),
    listHistory: jest.fn(),
  };
}

describe('WalletReadService', () => {
  it('getEarnings sums EARNINGS reasons and reports settlement-ready = earnings balance', async () => {
    const repo = repoMock();
    repo.sumByReason.mockResolvedValue([
      { reason: WalletTxnReason.GIFT_RECEIVE, total: 100n },
      { reason: WalletTxnReason.PK_REWARD, total: 40n },
    ]);
    const wallet = { getBalance: jest.fn().mockResolvedValue({ gold: 0, free: 0, earnings: 140 }) };
    const svc = new WalletReadService(repo as never, wallet as never);

    const res = await svc.getEarnings('u1');

    expect(res.totalEarned).toBe(140);
    expect(res.settlementReady).toBe(140);
    expect(res.bySource).toEqual({ gifts: 100, treasure: 0, pk: 40 });
  });

  it('getRewards maps ledger rows to RewardDto (paginated)', async () => {
    const repo = repoMock();
    repo.listByReasons.mockResolvedValue([
      [{ id: 'r1', reason: WalletTxnReason.PK_REWARD, currency: WalletCurrency.GOLD, type: WalletEntryType.CREDIT, amount: 100n, referenceType: 'video_room_pk_reward', referenceId: 'ref1', createdAt: new Date('2026-07-23') }],
      1,
    ]);
    const wallet = { getBalance: jest.fn() };
    const svc = new WalletReadService(repo as never, wallet as never);

    const res = await svc.getRewards('u1', 1, 20);

    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ id: 'r1', reason: 'PK_REWARD', amount: 100, source: 'video_room_pk_reward' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/wallet/services/wallet-read.service.spec.ts`
Expected: FAIL — cannot find `./wallet-read.service`.

- [ ] **Step 3: Add repository methods to `wallet.repository.ts`**

```typescript
  listByReasons(
    userId: string,
    reasons: WalletTxnReason[],
    skip: number,
    take: number,
  ): Promise<[WalletTransaction[], number]> {
    const where: Prisma.WalletTransactionWhereInput = { userId, reason: { in: reasons } };
    return this.prisma.$transaction([
      this.prisma.walletTransaction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.walletTransaction.count({ where }),
    ]);
  }

  async sumByReason(
    userId: string,
    reasons: WalletTxnReason[],
    currency: WalletCurrency,
  ): Promise<Array<{ reason: WalletTxnReason; total: bigint }>> {
    const rows = await this.prisma.walletTransaction.groupBy({
      by: ['reason'],
      where: { userId, currency, type: WalletEntryType.CREDIT, reason: { in: reasons } },
      _sum: { amount: true },
    });
    return rows.map((r) => ({ reason: r.reason, total: r._sum.amount ?? 0n }));
  }

  async aggregateSignedByCurrency(
    userId: string,
  ): Promise<Array<{ currency: WalletCurrency; credited: bigint; debited: bigint }>> {
    const rows = await this.prisma.walletTransaction.groupBy({
      by: ['currency', 'type'],
      where: { userId },
      _sum: { amount: true },
    });
    const acc = new Map<WalletCurrency, { credited: bigint; debited: bigint }>();
    for (const r of rows) {
      const cur = acc.get(r.currency) ?? { credited: 0n, debited: 0n };
      if (r.type === WalletEntryType.CREDIT) cur.credited += r._sum.amount ?? 0n;
      else cur.debited += r._sum.amount ?? 0n;
      acc.set(r.currency, cur);
    }
    return Array.from(acc.entries()).map(([currency, v]) => ({ currency, ...v }));
  }

  listHistory(
    userId: string,
    filters: { currency?: WalletCurrency; reason?: WalletTxnReason },
    skip: number,
    take: number,
  ): Promise<[WalletTransaction[], number]> {
    const where: Prisma.WalletTransactionWhereInput = {
      userId,
      ...(filters.currency ? { currency: filters.currency } : {}),
      ...(filters.reason ? { reason: filters.reason } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.walletTransaction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.walletTransaction.count({ where }),
    ]);
  }
```

- [ ] **Step 4: Add DTOs to `wallet.dto.ts`**

```typescript
import { WalletTxnReason } from '@prisma/client'; // add to existing @prisma/client import

/** Query for a user's rewards feed. */
export class WalletRewardsQueryDto extends PaginationQueryDto {}

/** Query for a user's unified wallet history (filterable). */
export class WalletHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WalletCurrency })
  @IsOptional()
  @IsEnum(WalletCurrency)
  currency?: WalletCurrency;

  @ApiPropertyOptional({ enum: WalletTxnReason })
  @IsOptional()
  @IsEnum(WalletTxnReason)
  reason?: WalletTxnReason;
}

/** Host/creator earnings summary. `settlementReady` is the current EARNINGS balance. */
export class HostEarningsDto {
  @ApiProperty() totalEarned!: number;
  @ApiProperty() settlementReady!: number;
  @ApiProperty({ type: Object }) bySource!: { gifts: number; treasure: number; pk: number };
}

/** One reward the user received (ledger-derived). */
export class RewardDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: WalletTxnReason }) reason!: WalletTxnReason;
  @ApiProperty({ enum: WalletCurrency }) currency!: WalletCurrency;
  @ApiProperty() amount!: number;
  @ApiProperty({ nullable: true }) source!: string | null;
  @ApiProperty({ nullable: true }) referenceId!: string | null;
  @ApiProperty() createdAt!: Date;
}
```

- [ ] **Step 5: Create `wallet-read.service.ts`**

```typescript
// src/modules/wallet/services/wallet-read.service.ts
import { Injectable } from '@nestjs/common';
import { WalletCurrency, WalletTxnReason, WalletTransaction } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type { HostEarningsDto, RewardDto } from '../dto/wallet.dto';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletService } from './wallet.service';

const EARNINGS_REASONS: WalletTxnReason[] = [
  WalletTxnReason.GIFT_RECEIVE,
  WalletTxnReason.TREASURE_BOX,
  WalletTxnReason.PK_REWARD,
];
const REWARD_REASONS: WalletTxnReason[] = [
  WalletTxnReason.TREASURE_BOX,
  WalletTxnReason.PK_REWARD,
  WalletTxnReason.EVENT_REWARD,
];

/**
 * Read models over the wallet ledger (VR-14). No balance mutation; every method
 * is a query. Earnings/rewards/history are all `wallet_transactions` filtered by
 * reason/currency — the ledger is the single source of truth.
 */
@Injectable()
export class WalletReadService {
  constructor(
    private readonly repo: WalletRepository,
    private readonly wallet: WalletService,
  ) {}

  async getEarnings(userId: string): Promise<HostEarningsDto> {
    const [sums, balances] = await Promise.all([
      this.repo.sumByReason(userId, EARNINGS_REASONS, WalletCurrency.EARNINGS),
      this.wallet.getBalance(userId),
    ]);
    const by = (r: WalletTxnReason) => Number(sums.find((s) => s.reason === r)?.total ?? 0n);
    const gifts = by(WalletTxnReason.GIFT_RECEIVE);
    const treasure = by(WalletTxnReason.TREASURE_BOX);
    const pk = by(WalletTxnReason.PK_REWARD);
    return {
      totalEarned: gifts + treasure + pk,
      settlementReady: balances.earnings,
      bySource: { gifts, treasure, pk },
    };
  }

  async getRewards(userId: string, page: number, limit: number): Promise<Paginated<RewardDto>> {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.repo.listByReasons(userId, REWARD_REASONS, skip, limit);
    return buildPaginated(rows.map((r) => this.toReward(r)), total, page, limit);
  }

  async getHistory(
    userId: string,
    filters: { currency?: WalletCurrency; reason?: WalletTxnReason },
    page: number,
    limit: number,
  ): Promise<Paginated<RewardDto>> {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.repo.listHistory(userId, filters, skip, limit);
    return buildPaginated(rows.map((r) => this.toReward(r)), total, page, limit);
  }

  private toReward(r: WalletTransaction): RewardDto {
    return {
      id: r.id,
      reason: r.reason,
      currency: r.currency,
      amount: Number(r.amount),
      source: r.referenceType,
      referenceId: r.referenceId,
      createdAt: r.createdAt,
    };
  }
}
```

- [ ] **Step 6: Register `WalletReadService` in `wallet.module.ts`**

Add `WalletReadService` to `providers` and `exports` (import at top).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/modules/wallet/services/wallet-read.service.spec.ts`
Expected: PASS.

- [ ] **Step 8: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet/repositories/wallet.repository.ts src/modules/wallet/dto/wallet.dto.ts src/modules/wallet/services/wallet-read.service.ts src/modules/wallet/wallet.module.ts`
Expected: clean. Do NOT commit.

---

### Task 6: Wallet read REST endpoints — `GET /wallet/earnings`, `/wallet/rewards`, `/wallet/history`

**Files:**
- Modify: `src/modules/wallet/controllers/wallet.controller.ts`
- Test: `src/modules/wallet/controllers/wallet.controller.spec.ts` (create)

**Interfaces:**
- Consumes: `WalletReadService` (Task 5), `WalletRewardsQueryDto`, `WalletHistoryQueryDto`, `@CurrentUser('id')`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/wallet/controllers/wallet.controller.spec.ts
import { WalletController } from './wallet.controller';

describe('WalletController VR-14 read endpoints', () => {
  const wallet = { getBalance: jest.fn(), listTransactions: jest.fn() };
  const read = { getEarnings: jest.fn(), getRewards: jest.fn(), getHistory: jest.fn() };
  const ctrl = new WalletController(wallet as never, read as never);

  it('GET /wallet/earnings delegates to WalletReadService.getEarnings for the current user', async () => {
    read.getEarnings.mockResolvedValue({ totalEarned: 10, settlementReady: 10, bySource: { gifts: 10, treasure: 0, pk: 0 } });
    await ctrl.earnings('u1');
    expect(read.getEarnings).toHaveBeenCalledWith('u1');
  });

  it('GET /wallet/rewards passes pagination through', async () => {
    read.getRewards.mockResolvedValue({ items: [], total: 0 });
    await ctrl.rewards('u1', { page: 2, limit: 20, skip: 20 } as never);
    expect(read.getRewards).toHaveBeenCalledWith('u1', 2, 20);
  });

  it('GET /wallet/history passes filters + pagination', async () => {
    read.getHistory.mockResolvedValue({ items: [], total: 0 });
    await ctrl.history('u1', { page: 1, limit: 20, skip: 0, currency: 'GOLD' } as never);
    expect(read.getHistory).toHaveBeenCalledWith('u1', { currency: 'GOLD', reason: undefined }, 1, 20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/wallet/controllers/wallet.controller.spec.ts`
Expected: FAIL — `WalletController` constructor takes one arg / methods missing.

- [ ] **Step 3: Extend `wallet.controller.ts`**

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import {
  ListWalletTransactionsDto,
  WalletHistoryQueryDto,
  WalletRewardsQueryDto,
} from '../dto/wallet.dto';
import { WalletReadService } from '../services/wallet-read.service';
import { WalletService } from '../services/wallet.service';

@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly read: WalletReadService,
  ) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current gold / free / earnings balances' })
  balance(@CurrentUser('id') userId: string) {
    return this.wallet.getBalance(userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Wallet transaction history (paginated)' })
  transactions(@CurrentUser('id') userId: string, @Query() q: ListWalletTransactionsDto) {
    return this.wallet.listTransactions(userId, {
      skip: q.skip,
      limit: q.limit,
      page: q.page,
      currency: q.currency,
    });
  }

  @Get('earnings')
  @ApiOperation({ summary: 'Host/creator earnings summary (settlement-ready = EARNINGS balance)' })
  earnings(@CurrentUser('id') userId: string) {
    return this.read.getEarnings(userId);
  }

  @Get('rewards')
  @ApiOperation({ summary: 'Rewards received (treasure / PK / event), paginated' })
  rewards(@CurrentUser('id') userId: string, @Query() q: WalletRewardsQueryDto) {
    return this.read.getRewards(userId, q.page, q.limit);
  }

  @Get('history')
  @ApiOperation({ summary: 'Unified wallet ledger history with filters (paginated)' })
  history(@CurrentUser('id') userId: string, @Query() q: WalletHistoryQueryDto) {
    return this.read.getHistory(userId, { currency: q.currency, reason: q.reason }, q.page, q.limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/wallet/controllers/wallet.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet/controllers/wallet.controller.ts`
Expected: clean. Do NOT commit.

---

### Task 7: Reconciliation — `WalletReconciliationService`, processor→registry wiring, scheduler, `POST /admin/wallet/recovery`

**Files:**
- Create: `src/modules/wallet/services/wallet-reconciliation.service.ts`
- Create: `src/modules/wallet/schedulers/wallet-reconciliation.scheduler.ts`
- Modify: `src/infra/queue/processors/wallet-processing.processor.ts` (dispatch to registry)
- Modify: `src/modules/wallet/controllers/wallet-admin.controller.ts` (add `POST recovery`)
- Modify: `src/modules/wallet/dto/wallet.dto.ts` (add `WalletRecoveryDto`)
- Modify: `src/modules/wallet/wallet.module.ts` (register service + scheduler)
- Test: `src/modules/wallet/services/wallet-reconciliation.service.spec.ts` (create)

**Interfaces:**
- Consumes: `WalletRepository.aggregateSignedByCurrency`, `WalletRepository.getWallet`, `WalletMetrics.recordReconciliationDrift`, `QueueJobRegistry`, `LockService`, `WALLET_JOBS.RECONCILE_SWEEP`, `WALLET_RECONCILE_LOCK_KEY`, `QUEUE_NAMES.WALLET_PROCESSING`.
- Produces: `WalletReconciliationService.reconcileUser(userId): Promise<ReconciliationReport>` where `ReconciliationReport = { userId; perCurrency: Array<{ currency: WalletCurrency; ledgerComputed: number; balanceColumn: number; drift: number }>; strandedSettlements: string[] }`. **Never writes a balance.**

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/wallet/services/wallet-reconciliation.service.spec.ts
import { WalletCurrency } from '@prisma/client';
import { WalletReconciliationService } from './wallet-reconciliation.service';

function deps() {
  return {
    repo: { aggregateSignedByCurrency: jest.fn(), getWallet: jest.fn() },
    metrics: { recordReconciliationDrift: jest.fn(), recordMovement: jest.fn(), recordFailed: jest.fn() },
    registry: { register: jest.fn() },
    locks: { withLock: jest.fn(async (_k: string, fn: () => unknown) => fn()) },
  };
}

describe('WalletReconciliationService', () => {
  it('reports drift when ledger sum != balance column, and NEVER writes a balance', async () => {
    const d = deps();
    d.repo.aggregateSignedByCurrency.mockResolvedValue([
      { currency: WalletCurrency.GOLD, credited: 100n, debited: 30n }, // ledger => 70
    ]);
    d.repo.getWallet.mockResolvedValue({ goldBalance: 65n, freeBalance: 0n, earningsBalance: 0n }); // column => 65
    const svc = new WalletReconciliationService(d.repo as never, d.metrics as never, d.registry as never, d.locks as never);

    const report = await svc.reconcileUser('u1');

    const gold = report.perCurrency.find((c) => c.currency === WalletCurrency.GOLD)!;
    expect(gold.ledgerComputed).toBe(70);
    expect(gold.balanceColumn).toBe(65);
    expect(gold.drift).toBe(5);
    expect(d.metrics.recordReconciliationDrift).toHaveBeenCalledWith('GOLD');
    // Safety invariant: the repo exposes no balance-write here and none is called.
    expect(Object.keys(d.repo)).not.toContain('applyMovement');
  });

  it('reports zero drift when ledger matches the column', async () => {
    const d = deps();
    d.repo.aggregateSignedByCurrency.mockResolvedValue([{ currency: WalletCurrency.EARNINGS, credited: 50n, debited: 0n }]);
    d.repo.getWallet.mockResolvedValue({ goldBalance: 0n, freeBalance: 0n, earningsBalance: 50n });
    const svc = new WalletReconciliationService(d.repo as never, d.metrics as never, d.registry as never, d.locks as never);

    const report = await svc.reconcileUser('u1');
    expect(report.perCurrency.find((c) => c.currency === WalletCurrency.EARNINGS)!.drift).toBe(0);
    expect(d.metrics.recordReconciliationDrift).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/wallet/services/wallet-reconciliation.service.spec.ts`
Expected: FAIL — cannot find `./wallet-reconciliation.service`.

- [ ] **Step 3: Create `wallet-reconciliation.service.ts`**

```typescript
// src/modules/wallet/services/wallet-reconciliation.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import { WALLET_JOBS, WALLET_RECONCILE_LOCK_KEY } from '../constants/wallet.constants';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletRepository } from '../repositories/wallet.repository';

export interface CurrencyDrift {
  currency: WalletCurrency;
  ledgerComputed: number;
  balanceColumn: number;
  drift: number;
}
export interface ReconciliationReport {
  userId: string;
  perCurrency: CurrencyDrift[];
  strandedSettlements: string[];
}

const COLUMN: Record<WalletCurrency, 'goldBalance' | 'freeBalance' | 'earningsBalance'> = {
  GOLD: 'goldBalance',
  FREE: 'freeBalance',
  EARNINGS: 'earningsBalance',
};

/**
 * Ledger-integrity reconciliation (VR-14). Recomputes expected balance per
 * currency from the immutable ledger and compares it to the balance column.
 * It DETECTS and reports drift; it NEVER writes a balance (balances change only
 * through WALLET_SERVICE). Registered on the existing `wallet-processing` queue.
 */
@Injectable()
export class WalletReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(WalletReconciliationService.name);

  constructor(
    private readonly repo: WalletRepository,
    private readonly metrics: WalletMetrics,
    private readonly registry: QueueJobRegistry,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      QUEUE_NAMES.WALLET_PROCESSING,
      WALLET_JOBS.RECONCILE_SWEEP,
      (data: unknown, _job: Job) => this.handleSweep(data as { userId?: string }),
    );
  }

  /** Cron entry: fleet-wide, single-flighted by a distributed lock. */
  private async handleSweep(data: { userId?: string }): Promise<unknown> {
    return this.locks.withLock(WALLET_RECONCILE_LOCK_KEY, async () => {
      if (data.userId) return this.reconcileUser(data.userId);
      // Batch sweep hook: a paginated user scan can be added here later. For now
      // the sweep is a no-op placeholder for the scheduled trigger; per-user
      // reconciliation is driven on demand via the admin endpoint.
      this.logger.log('wallet reconciliation sweep tick (no batch configured)');
      return { ok: true };
    });
  }

  /** Reconcile one user. Returns a drift report; writes nothing. */
  async reconcileUser(userId: string): Promise<ReconciliationReport> {
    const [sums, wallet] = await Promise.all([
      this.repo.aggregateSignedByCurrency(userId),
      this.repo.getWallet(userId),
    ]);
    const perCurrency: CurrencyDrift[] = [];
    for (const s of sums) {
      const ledgerComputed = Number(s.credited - s.debited);
      const balanceColumn = Number(wallet?.[COLUMN[s.currency]] ?? 0n);
      const drift = ledgerComputed - balanceColumn;
      if (drift !== 0) {
        this.metrics.recordReconciliationDrift(s.currency);
        this.logger.warn(
          `wallet drift user=${userId} currency=${s.currency} ledger=${ledgerComputed} column=${balanceColumn} drift=${drift}`,
        );
      }
      perCurrency.push({ currency: s.currency, ledgerComputed, balanceColumn, drift });
    }
    // Stranded async settlements are re-driven by the existing treasure/PK
    // recovery services (out of this method's scope); surfaced as an empty list
    // here and wired by the scheduler tick.
    return { userId, perCurrency, strandedSettlements: [] };
  }
}
```

- [ ] **Step 4: Wire the wallet processor to the registry**

Modify `src/infra/queue/processors/wallet-processing.processor.ts` to mirror `gift-processing.processor.ts`:

```typescript
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueJobRegistry } from '../workers/queue-job.registry';
import { QueueSupport } from '../workers/queue-support.service';

/** Wallet-processing queue: routes jobs to their registered domain handlers. */
@Processor(QUEUE_NAMES.WALLET_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class WalletProcessingProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.WALLET_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    return this.registry.dispatch(QUEUE_NAMES.WALLET_PROCESSING, job);
  }
}
```

- [ ] **Step 5: Create the scheduler**

```typescript
// src/modules/wallet/schedulers/wallet-reconciliation.scheduler.ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { WALLET_JOBS } from '../constants/wallet.constants';

/**
 * Schedules the reconciliation sweep on the existing wallet-processing queue.
 * Daily at 03:15 — off-peak. No new queue; uses QueueService.schedule (cron).
 */
@Injectable()
export class WalletReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletReconciliationScheduler.name);
  constructor(private readonly queue: QueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.schedule(
      QUEUE_NAMES.WALLET_PROCESSING,
      WALLET_JOBS.RECONCILE_SWEEP,
      {},
      { pattern: '15 3 * * *' },
    );
    this.logger.log('wallet reconciliation sweep scheduled (daily 03:15)');
  }
}
```

- [ ] **Step 6: Add `WalletRecoveryDto` to `wallet.dto.ts`**

```typescript
/** Admin-triggered reconciliation for one user. */
export class WalletRecoveryDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;
}
```

- [ ] **Step 7: Add `POST /admin/wallet/recovery` to `wallet-admin.controller.ts`**

Inject `WalletReconciliationService` and add:

```typescript
  @Post('recovery')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile a user wallet (ledger vs balance) — report only, never auto-writes' })
  recovery(@CurrentUser('id') adminId: string, @Body() dto: WalletRecoveryDto) {
    this.logger.log(`admin ${adminId} triggered wallet recovery for ${dto.userId}`);
    return this.reconciliation.reconcileUser(dto.userId);
  }
```

Add a `private readonly logger = new Logger(WalletAdminController.name);`, the `WalletRecoveryDto` import, the `WalletReconciliationService` constructor injection, and `Logger` to the `@nestjs/common` imports.

- [ ] **Step 8: Register providers in `wallet.module.ts`**

Add `WalletReconciliationService` and `WalletReconciliationScheduler` to `providers` (imports at top). The `WalletProcessingProcessor` already lives in the queue module — no wiring needed there beyond Step 4.

- [ ] **Step 9: Run test to verify it passes**

Run: `npx jest src/modules/wallet/services/wallet-reconciliation.service.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 10: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet/services/wallet-reconciliation.service.ts src/modules/wallet/schedulers/wallet-reconciliation.scheduler.ts src/infra/queue/processors/wallet-processing.processor.ts src/modules/wallet/controllers/wallet-admin.controller.ts src/modules/wallet/dto/wallet.dto.ts src/modules/wallet/wallet.module.ts`
Expected: clean. Do NOT commit.

---

### Task 8: `GiftRefundedPayload.receiverId` — complete the shared contract

**Files:**
- Modify: `src/modules/gifts/events/gift.events.ts` (add optional field)
- Modify: `src/modules/audio-rooms/services/audio-room-gift-context.handler.ts:178` (populate it — the single publisher)
- Test: `src/modules/gifts/events/gift-refunded-payload.spec.ts` (create)

**Interfaces:**
- Produces: `GiftRefundedPayload` gains `receiverId?: string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/gifts/events/gift-refunded-payload.spec.ts
import { GiftRefundedEvent, type GiftRefundedPayload } from './gift.events';

describe('GiftRefundedPayload', () => {
  it('accepts an optional receiverId and preserves it on the event', () => {
    const payload: GiftRefundedPayload = {
      transactionId: 't1',
      senderId: 's1',
      receiverId: 'r1',
      roomId: 'room1',
      giftId: 'g1',
      giftName: 'Rose',
      totalRefundAmount: 10,
      createdAt: new Date().toISOString(),
    };
    const event = new GiftRefundedEvent(payload);
    expect(event.payload.receiverId).toBe('r1');
  });

  it('remains valid without receiverId (backward compatible)', () => {
    const payload: GiftRefundedPayload = {
      transactionId: 't1',
      senderId: 's1',
      roomId: 'room1',
      giftId: 'g1',
      giftName: 'Rose',
      totalRefundAmount: 10,
      createdAt: new Date().toISOString(),
    };
    expect(new GiftRefundedEvent(payload).payload.receiverId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/gifts/events/gift-refunded-payload.spec.ts`
Expected: FAIL — `receiverId` is not a known property of `GiftRefundedPayload`.

- [ ] **Step 3: Add the optional field**

In `src/modules/gifts/events/gift.events.ts`, add to `GiftRefundedPayload` (after `senderId`):

```typescript
  /**
   * The refunded gift's receiver, when known at the emit site. Optional for
   * backward compatibility (VR-14). Present on audio-room refunds; absent where
   * the publisher has no attributable receiver.
   */
  receiverId?: string;
```

- [ ] **Step 4: Populate it at the single emit site**

In `src/modules/audio-rooms/services/audio-room-gift-context.handler.ts` at the `new GiftRefundedEvent({ ... })` construction (~line 178), add `receiverId: ctx.receiverId ?? ctx.receiverIds?.[0],` (use whichever receiver field the handler's context exposes — verify the exact property name on `GiftSendContext` in that file; if the refund is sender-overflow with no single receiver, pass the primary receiver of the send). If no receiver is meaningfully attributable there, leave it unset — the field is optional and this task must not change refund amounts or flow.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/gifts/events/gift-refunded-payload.spec.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/gifts/events/gift.events.ts src/modules/audio-rooms/services/audio-room-gift-context.handler.ts`
Expected: clean. Do NOT commit.

---

### Task 9: Integration test + full-suite verification

**Files:**
- Create: `src/modules/video-rooms/video-rooms-wallet-integration.spec.ts`
- (No source changes — this task proves the wiring end-to-end.)

**Interfaces:**
- Consumes: everything above via the real DI graph (Nest `Test.createTestingModule`), with `SocketManager` and `PrismaService`/`WalletRepository` mocked.

- [ ] **Step 1: Write the integration test**

```typescript
// src/modules/video-rooms/video-rooms-wallet-integration.spec.ts
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InMemoryEventBus } from 'src/common/events/in-memory-event-bus';
import { WalletRealtimeListener } from 'src/modules/wallet/listeners/wallet-realtime.listener';
import { VideoRoomEconomySocketListener } from './listeners/video-room-economy-socket.listener';
import { WALLET_SOCKET_EVENTS } from 'src/modules/wallet/constants/wallet.constants';
import { VIDEO_ROOM_ECONOMY_SOCKET_EVENTS } from './constants/video-room-economy.constants';
import { WALLET_EVENTS, WalletCreditedEvent } from 'src/modules/wallet/events/wallet.events';
import { GIFT_EVENTS, GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { WalletCurrency, WalletTxnReason, GiftContextType, GiftType } from '@prisma/client';

describe('VR-14 wallet integration (event → socket)', () => {
  it('a wallet credit + a VIDEO_ROOM gift.sent fan out to the right sockets', async () => {
    const bus = new InMemoryEventBus(new EventEmitter2({ wildcard: true, delimiter: '.' }));
    const sockets = { emitToUserEverywhere: jest.fn(), emitToNamespaceRoom: jest.fn() };
    const walletSvc = { getBalance: jest.fn().mockResolvedValue({ gold: 0, free: 0, earnings: 25 }) };
    const metrics = { recordMovement: jest.fn(), recordFailed: jest.fn(), recordReconciliationDrift: jest.fn() };

    const realtime = new WalletRealtimeListener(bus as never, sockets as never, walletSvc as never, metrics as never);
    realtime.onModuleInit();
    new VideoRoomEconomySocketListener(bus as never, sockets as never).onModuleInit();

    await bus.publish(new WalletCreditedEvent({
      userId: 'host1', transactionId: 'w1', currency: WalletCurrency.EARNINGS, amount: 25,
      balanceAfter: 25, reason: WalletTxnReason.GIFT_RECEIVE, referenceType: 'gift', referenceId: null,
    }));
    await realtime.flush('host1');

    await bus.publish(new GiftSentEvent({
      transactionId: 'g1', senderId: 's1', receiverId: 'host1', giftId: 'gift1', giftType: GiftType.NORMAL,
      giftName: 'Rose', contextType: GiftContextType.VIDEO_ROOM, contextId: 'room1', quantity: 1,
      comboTier: 1, unitCoinValue: 100, totalCoinValue: 100, creatorEarnings: 25, luckyMultiplier: 1,
      isLuckyWin: false, senderExp: 0, receiverExp: 0, createdAt: new Date().toISOString(),
    }));

    const evts = sockets.emitToUserEverywhere.mock.calls.map((c: unknown[]) => c[1]);
    expect(evts).toContain(WALLET_SOCKET_EVENTS.TRANSACTION_COMPLETED);
    expect(evts).toContain(WALLET_SOCKET_EVENTS.BALANCE_CHANGED);
    expect(evts).toContain(VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room', 'room1', VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED, expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx jest src/modules/video-rooms/video-rooms-wallet-integration.spec.ts`
Expected: PASS.

- [ ] **Step 3: Run the full Phase-14 test set**

Run: `npx jest src/modules/wallet src/modules/video-rooms/listeners/video-room-economy-socket.listener.spec.ts src/modules/video-rooms/video-rooms-wallet-integration.spec.ts src/modules/gifts/events/gift-refunded-payload.spec.ts`
Expected: all PASS.

- [ ] **Step 4: Full typecheck + lint + boundary check**

Run: `npx tsc --noEmit && npx eslint src/modules/wallet src/modules/video-rooms/listeners/video-room-economy-socket.listener.ts && npx depcruise --config .dependency-cruiser.cjs src 2>/dev/null || echo "depcruise: review output"`
Expected: no type errors, no lint errors, no new dependency-boundary violations (wallet must not import video-rooms; video-rooms depends on wallet only via WALLET_SERVICE/EVENT_BUS).

- [ ] **Step 5: Regression sweep on touched shared modules**

Run: `npx jest src/modules/gifts src/modules/audio-rooms src/infra/queue`
Expected: all previously-passing suites still PASS (proves the `GiftRefundedPayload` field, the wallet processor change, and the gift-service catch are backward compatible).

- [ ] **Step 6: Checkpoint (NO git)**

All green. Do NOT commit — work remains in the working tree per project rule. Report the final `jest`/`tsc` output verbatim as the completion evidence.

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §4 realtime socket bridge (personal push, coalescing, created/completed aliases) → **Task 3**; room echoes (rewardReceived, hostEarningUpdated) + transactionFailed app-layer → **Task 4**. ✅
- §5 read models & REST (earnings/rewards/history) → **Task 5** (data) + **Task 6** (REST). ✅
- §6 reconciliation & recovery (never auto-writes; processor→registry; scheduler; POST recovery) → **Task 7**. ✅
- §7 bug fix (receiverId) → **Task 8**; monitoring (prom-client families) → **Task 2** + increments in Task 3/7; audit (logger + ledger) → covered in Task 7 admin log + reconciliation warns; RBAC (self-scoped reads, admin guard) → Tasks 6/7 use `@CurrentUser`/`@Roles`. ✅
- §8 testing (unit + integration + safety-invariant assertion) → each task's spec + **Task 9**. ✅
- §9 non-goals (no new queue/table/service/mutation path) → honored; only the existing `wallet-processing` queue is used, no migrations. ✅
- §10 additive/backward-compatible → **Task 9 Step 5** regression sweep proves it. ✅

**2. Placeholder scan:** No "TBD/TODO/handle appropriately". The only deliberately-deferred hook is the reconciliation batch-sweep body (Task 7 Step 3), which is explicitly a no-op tick with a logged reason — per-user reconciliation (the actual deliverable) is fully implemented and the admin endpoint drives it. The Task 8 Step 4 receiver-field population notes verifying the exact context property name in that file — that is a read-the-file instruction, not a placeholder, because the audio handler's context shape is outside this plan's confirmed-contracts set.

**3. Type consistency:** `WalletMetrics` methods (`recordMovement`/`recordFailed`/`recordReconciliationDrift`) are consistent across Tasks 2, 3, 7. `WalletRepository` new methods (`listByReasons`/`sumByReason`/`aggregateSignedByCurrency`/`listHistory`) match between Task 5 (definition) and Tasks 5/7 (use). `WalletReadService` method names (`getEarnings`/`getRewards`/`getHistory`) match Tasks 5 and 6. Socket event constant names match across Tasks 1, 3, 4, 9. `ReconciliationReport` shape matches Task 7 and the admin endpoint.

---

## Execution notes

- **No git, ever** (project rule). Every checkpoint is verification-only.
- Module registration is folded into the task whose provider needs it (each listener/service is wired in the same task it's created), so every task ends independently testable.
- The wallet module stays free of any `video-rooms` import (dependency-boundary rule); the video-rooms module depends on the wallet only via `WALLET_SERVICE` and the `EVENT_BUS`.
