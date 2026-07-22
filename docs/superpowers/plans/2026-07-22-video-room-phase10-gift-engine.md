# VR-10 Enterprise Virtual Gift Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable virtual gifting in Video Rooms by making the existing AR-5 gift pipeline context-polymorphic, then building the video-room gift engine (multi-receiver, combo lifecycle, prioritised animation delivery, history, statistics) on top of it.

**Architecture:** A pluggable `IGiftContextHandler` registry makes `GiftService` context-agnostic; audio-room logic *moves* into an audio-owned handler, video-rooms provides its own. Money moves synchronously inside one `prisma.$transaction`; BullMQ owns animation delivery via a generic job registry. Zero new tables — everything projects onto `gift_transactions`, `video_room_statistics`, `video_room_events` and Redis.

**Tech Stack:** NestJS · Prisma/PostgreSQL · Redis (ioredis) · BullMQ · Socket.IO · Jest

**Spec:** [`docs/superpowers/specs/2026-07-22-video-room-phase10-gift-engine-design.md`](../specs/2026-07-22-video-room-phase10-gift-engine-design.md)

## Global Constraints

### Release-blocking gates

> **Task 1 and Task 22 are RELEASE GATES.** If either fails, implementation
> **STOPS** until the regression is fixed. Never adjust a baseline assertion or a
> BC expectation to make a gate pass — a failing gate means production behaviour
> changed, and the code is what must change back.

| Gate | Task | Blocks |
| --- | --- | --- |
| **G1 — BC baseline captured** | Task 1 | Task 3 onward. No extraction may begin until the baseline is green against unmodified code. |
| **G2 — Full BC verification** | Task 22 Step 3 | Release. All of BC-1…BC-12 must pass. |
| **G3 — Constraint audit** | Task 22 Step 5 | Release. Zero migrations, infra limited to the 4 approved files, `error-codes.ts` additions only. |

### Immutability contract — Audio Rooms

Audio Room behaviour is **immutable** through this phase. The handler extraction
must not alter: wallet movements (amounts, currencies, reasons, ordering),
treasure-box logic, host rewards, refunds, idempotency key shapes, published
events (set, payloads, ordering), enqueued jobs, API response bodies, or ledger
semantics. Any observed difference is a defect in the extraction, not an
improvement.

### Strictly additive

- **No** schema or migration changes.
- **No** refactoring of `src/common/` or `src/infra/` beyond the explicitly approved additive changes (Task 6's two files; `error-codes.ts` appends).
- **No** expansion of public cross-module APIs (`IVideoRoomsService`, `IGiftsService`, `IWalletService`) unless a task cannot proceed without it — in which case stop and escalate rather than widening silently.

### Transaction contract (enforced per task)

| Inside `prisma.$transaction` | Outside (pre-flight or post-commit) |
| --- | --- |
| idempotency re-check | Redis reads/writes (combo, rate limit, leaderboards, feeds, stats) |
| `wallet.debit` (sender) | BullMQ `queue.enqueue` |
| `wallet.credit` × N (receivers) | Socket.IO emits |
| ledger `createTransaction` × N | EVENT_BUS publish |
| `handler.onSend()` — Postgres only | metrics inc/observe |
| `video_room_statistics` increment | `handler.postCommit()` |

A handler that needs a non-Postgres effect returns it via `events` / `postCommit`.
Task 13 Step 1 contains an explicit test asserting no queue or Redis call occurs
before the batch returns.

### Other constraints

- **NO GIT OPERATIONS.** No commit, push, branch, stash, rebase. Every task ends with a verification step instead of a commit. Leave all work in the working tree.
- **ZERO database migrations.** No new models, no column changes, no `prisma migrate`. If a task appears to need one, stop and escalate.
- **Infra changes limited to exactly two files:** `src/infra/queue/workers/queue-job.registry.ts` (new) and `src/infra/queue/processors/gift-processing.processor.ts` (modified). No other file under `src/infra/` may change.
- **`src/common/exceptions/error-codes.ts` may only be appended to** — adding new constant entries. No edits to existing entries.
- **BC baselines before extraction.** Task 1 must complete before Task 3 begins.
- **Audio-room gifting must remain behaviourally identical** (spec §12, BC-1…BC-12).
- **Transaction boundary is normative** (spec §4.6): only Postgres work inside `prisma.$transaction`. No Redis, queue, socket, metrics or cache calls inside it — ever.
- **Test conventions:** Jest, `*.spec.ts` colocated beside the source file. Services are instantiated directly with plain-object mocks cast `as never` — do NOT use `Test.createTestingModule`. `locks.withLock` mocks must actually invoke the callback: `jest.fn((_key, fn) => fn())`.
- **Commands:** test `npx jest <path>`; typecheck `npx tsc --noEmit`; lint `npx eslint <files-you-touched> --max-warnings 0`.
- **Lint standard — measured baseline, not zero.** `npm run lint` reports **192 pre-existing problems (191 errors, 1 warning)** on an untouched tree, 62 of them in `gift.service.ts` alone. A repo-wide clean lint is therefore NOT a valid gate. The standard is:
  1. every file this phase **creates** is lint-clean, and
  2. the repo-wide problem count **does not increase** above 192.

  Editing `gift.service.ts` (Tasks 4–5) will make prettier reformat pre-existing lines; that is acceptable and *reduces* the count. Never "fix" lint in files this phase does not otherwise touch — that inflates the diff and buries the real change.
- **Typecheck is a hard gate:** `npx tsc --noEmit` is clean on the untouched tree and must stay clean.
- **Wallet idempotency key shapes are production data.** Single-receiver key shapes must not change (BC-2).

---

## File Structure

**Modify — gifts module (refactor):**
- `src/modules/gifts/services/gift.service.ts` — becomes economy-only; loses 3 deps; `compensate()` deleted; gains `sendGiftBatch()`
- `src/modules/gifts/gifts.module.ts` — register the registry

**Create — gifts module:**
- `src/modules/gifts/interfaces/gift-context-handler.interface.ts` — the port
- `src/modules/gifts/services/gift-context.registry.ts` + `.spec.ts`

**Create — audio-rooms (receives moved logic):**
- `src/modules/audio-rooms/services/audio-room-gift-context.handler.ts` + `.spec.ts`
- `src/modules/audio-rooms/services/audio-room-gift-baseline.spec.ts` — BC characterization tests

**Infra (exactly two files):**
- `src/infra/queue/workers/queue-job.registry.ts` + `.spec.ts` (new)
- `src/infra/queue/processors/gift-processing.processor.ts` (modified — routing only)

**Create — video-rooms:**
- `constants/video-room-gift.constants.ts` — Redis keys, socket events, queue job name, priority map
- `config/video-room-gift.config.ts` — typed config accessor
- `dto/send-video-room-gift.dto.ts`, `dto/video-room-gift-query.dto.ts`
- `events/video-room-gift.events.ts`
- `services/video-room-gift-target.resolver.ts`
- `services/video-room-gift-context.handler.ts`
- `services/video-room-gift-combo.service.ts`
- `services/video-room-gift.service.ts`
- `services/video-room-gift-delivery.service.ts`
- `services/video-room-gift-query.service.ts`
- `services/video-room-gift-statistics.service.ts`
- `listeners/video-room-gift-socket.listener.ts`
- `scheduler/video-room-gift.monitor.ts`
- `controllers/video-rooms-gifts.controller.ts`
- `video-rooms-gift.integration.spec.ts`

Each with a colocated `.spec.ts`.

**Append-only:**
- `src/common/exceptions/error-codes.ts` — 6 new codes
- `src/config/env.validation.ts` + `src/config/configuration.ts` — 6 new knobs
- `src/modules/video-rooms/video-rooms.metrics.ts` — VR-10 metric family
- `src/modules/video-rooms/video-rooms.module.ts` — wiring
- `.env.example`

---

## Task 1: Capture backward-compatibility baselines 🚦 GATE G1

> **RELEASE-BLOCKING GATE.** This task must complete and be green **before Task 3
> begins**. If the baseline cannot be made to pass against unmodified code, STOP —
> the mock wiring is wrong, and proceeding would mean extracting logic with no
> safety net. Do not weaken an assertion to get past this.

It records how `GiftService` behaves *today* so the extraction can be proven non-breaking.

**Files:**
- Test: `src/modules/audio-rooms/services/audio-room-gift-baseline.spec.ts`

**Interfaces:**
- Consumes: current `GiftService.sendGift(actor, dto)` as-is
- Produces: `AUDIO_BASELINE` scenario fixtures reused by Task 4's verification

- [ ] **Step 1: Write the baseline characterization test**

Create `src/modules/audio-rooms/services/audio-room-gift-baseline.spec.ts`. This asserts *current* behaviour — it must pass against unmodified code.

```ts
import { GiftContextType, GiftType, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { GiftService } from 'src/modules/gifts/services/gift.service';

const GIFT = {
  id: 'g1', name: 'Rose', type: GiftType.STATIC, coinValue: 100,
  enabled: true, minVipLevel: 0, comboEnabled: false, comboWindowSeconds: 10,
  luckyMultipliers: [], luckyWinChanceBp: 0,
};
const ACTOR = { id: 'sender-1', roles: [] };
const DTO = {
  giftId: 'g1', receiverId: 'receiver-1', quantity: 1,
  contextType: GiftContextType.AUDIO_ROOM, contextId: 'room-1',
  idempotencyKey: 'idem-1',
};

/**
 * BC-1..BC-12 baseline. Captures the CURRENT audio-room gift behaviour so the
 * VR-10 handler extraction can be proven behaviourally identical. If a value
 * here changes, audio-room gifting has regressed — do not "update the baseline".
 */
describe('AUDIO_ROOM gift baseline (BC gate)', () => {
  let wallet: { debit: jest.Mock; credit: jest.Mock };
  let repo: Record<string, jest.Mock>;
  let bus: { publish: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let service: GiftService;

  beforeEach(() => {
    wallet = {
      debit: jest.fn().mockResolvedValue({ transactionId: 'wtx-debit', duplicate: false }),
      credit: jest.fn().mockResolvedValue({ transactionId: 'wtx-credit', duplicate: false }),
    };
    repo = {
      findTxnByIdempotencyKey: jest.fn().mockResolvedValue(null),
      hitRateLimit: jest.fn().mockResolvedValue(false),
      comboTick: jest.fn().mockResolvedValue(1),
      createTransaction: jest.fn().mockImplementation((d) => ({
        ...d, id: 'txn-1', status: 'COMPLETED', createdAt: new Date('2026-01-01T00:00:00Z'),
      })),
    };
    bus = { publish: jest.fn() };
    queue = { enqueue: jest.fn() };
    // Build the service with the mocks the current constructor requires.
    // NOTE: after Task 4 the constructor arity changes — update the wiring here
    // ONLY, never the assertions below.
    service = buildGiftService({ wallet, repo, bus, queue });
  });

  it('BC-1/BC-2: debit uses gift-debit:{key} with GOLD/GIFT_SEND', async () => {
    await service.sendGift(ACTOR as never, DTO as never);
    expect(wallet.debit).toHaveBeenCalledTimes(1);
    expect(wallet.debit.mock.calls[0][0]).toMatchObject({
      userId: 'sender-1',
      currency: WalletCurrency.GOLD,
      amount: 100,
      reason: WalletTxnReason.GIFT_SEND,
      idempotencyKey: 'gift-debit:idem-1',
      referenceType: 'gift',
    });
  });

  it('BC-6: AUDIO_ROOM writes creatorEarnings = 0n', async () => {
    await service.sendGift(ACTOR as never, DTO as never);
    expect(repo.createTransaction.mock.calls[0][0].creatorEarnings).toBe(0n);
  });

  it('BC-7: publishes gift.sent exactly once', async () => {
    await service.sendGift(ACTOR as never, DTO as never);
    const names = bus.publish.mock.calls.map((c) => c[0].name);
    expect(names.filter((n) => n === 'gift.sent')).toHaveLength(1);
  });

  it('BC-8: enqueues the 4 known jobs', async () => {
    await service.sendGift(ACTOR as never, DTO as never);
    const jobs = queue.enqueue.mock.calls.map((c) => `${c[0]}:${c[1]}`);
    expect(jobs).toEqual([
      'gift-processing:gift.sent',
      'notifications:gift.received',
      'ranking-processing:gift.ranking',
      'analytics-processing:gift.sent',
    ]);
  });
});
```

- [ ] **Step 2: Implement the `buildGiftService` helper**

At the top of the same file, add a helper that wires the current constructor. This is the **only** part Task 4 may edit.

```ts
function buildGiftService(m: {
  wallet: unknown; repo: unknown; bus: unknown; queue: unknown;
}): GiftService {
  const catalog = { getGift: jest.fn().mockResolvedValue(GIFT) };
  const leaderboards = { record: jest.fn() };
  const config = { get: jest.fn().mockReturnValue({
    creatorEarningRatePercent: 30, senderExpPerCoin: 1, receiverExpPerCoin: 1,
    rateMax: 20, rateWindowSeconds: 10,
  }) };
  const prisma = { $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({})) };
  const locks = { withLock: jest.fn((_k: string, fn: () => unknown) => fn()) };
  const rooms = {
    isRoomLive: jest.fn().mockResolvedValue(true),
    isMember: jest.fn().mockResolvedValue(true),
    assertMember: jest.fn(),
    getOwnerId: jest.fn().mockResolvedValue('owner-1'),
  };
  const users = { findById: jest.fn().mockResolvedValue({ id: 'receiver-1' }) };
  const vip = { getLevelOrdinal: jest.fn().mockResolvedValue(0) };
  const treasure = { processTreasureContribution: jest.fn().mockResolvedValue({
    acceptedAmount: 100, refundAmount: 0, events: [], boxId: null, level: null,
  }) };
  return new GiftService(
    m.repo as never, catalog as never, leaderboards as never, config as never,
    m.queue as never, prisma as never, locks as never, m.bus as never,
    m.wallet as never, rooms as never, users as never, vip as never, treasure as never,
  );
}
```

- [ ] **Step 3: Run the baseline against unmodified code**

Run: `npx jest src/modules/audio-rooms/services/audio-room-gift-baseline.spec.ts`
Expected: **PASS** — all 4 tests green. These describe existing behaviour, so failure means the helper wiring is wrong, not the production code.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. Do not commit (global constraint).

---

## Task 2: The handler port and registry

**Files:**
- Create: `src/modules/gifts/interfaces/gift-context-handler.interface.ts`
- Create: `src/modules/gifts/services/gift-context.registry.ts`
- Test: `src/modules/gifts/services/gift-context.registry.spec.ts`
- Modify: `src/modules/gifts/interfaces/index.ts`, `src/modules/gifts/services/index.ts`, `src/modules/gifts/gifts.module.ts`

**Interfaces:**
- Produces: `IGiftContextHandler`, `GiftContextRequest`, `GiftEconomics`, `GiftSendEffects`, `GiftSendContext`, `GiftContextRegistry.register(h)`, `GiftContextRegistry.for(type)`

- [ ] **Step 1: Write the failing registry test**

```ts
import { GiftContextType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { GiftContextRegistry } from './gift-context.registry';

const handler = (contextType: GiftContextType) => ({
  contextType,
  maxReceivers: 1,
  validate: jest.fn(),
  economics: jest.fn().mockReturnValue({ receiverEarningsBps: 3000 }),
});

describe('GiftContextRegistry', () => {
  let registry: GiftContextRegistry;
  beforeEach(() => { registry = new GiftContextRegistry(); });

  it('resolves a registered handler by context type', () => {
    const h = handler(GiftContextType.AUDIO_ROOM);
    registry.register(h as never);
    expect(registry.for(GiftContextType.AUDIO_ROOM)).toBe(h);
  });

  it('throws GIFT_CONTEXT_INVALID for an unregistered context', () => {
    expect(() => registry.for(GiftContextType.LIVE_STREAM)).toThrow(
      expect.objectContaining({ errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID }),
    );
  });

  it('rejects double registration of the same context type', () => {
    registry.register(handler(GiftContextType.VIDEO_ROOM) as never);
    expect(() => registry.register(handler(GiftContextType.VIDEO_ROOM) as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/gifts/services/gift-context.registry.spec.ts`
Expected: FAIL — `Cannot find module './gift-context.registry'`

- [ ] **Step 3: Write the port**

Create `src/modules/gifts/interfaces/gift-context-handler.interface.ts`:

```ts
import type { Gift, GiftContextType, GiftTransaction, Prisma } from '@prisma/client';
import type { DomainEvent } from 'src/common/events';

/** The send being validated, before any money moves. */
export interface GiftContextRequest {
  contextType: GiftContextType;
  contextId: string;
  senderId: string;
  receiverIds: string[];
  gift: Gift;
  quantity: number;
}

/** Per-receiver revenue split for this context. */
export interface GiftEconomics {
  /** Basis points of totalCoinValue credited to each receiver's EARNINGS. */
  receiverEarningsBps: number;
}

/** State handed to onSend, inside the transaction. */
export interface GiftSendContext extends GiftContextRequest {
  transactionId: string;
  batchId: string;
  idempotencyKey: string;
  totalCoinValue: number;
}

/**
 * Effects a handler contributes from inside the send transaction. A handler MUST
 * NOT perform Redis / socket / queue / metrics work in onSend — the transaction
 * boundary is Postgres-only (spec §4.6). Return events and postCommit instead.
 */
export interface GiftSendEffects {
  acceptedAmount: number;
  refundAmount: number;
  events: DomainEvent<unknown>[];
  postCommit?: () => Promise<void>;
}

export interface IGiftContextHandler {
  readonly contextType: GiftContextType;
  /** Max receivers one send may target. AUDIO_ROOM: 1. */
  readonly maxReceivers: number;
  /** Throws BusinessException when the send is not permitted. */
  validate(req: GiftContextRequest): Promise<void>;
  economics(req: GiftContextRequest): GiftEconomics;
  /** In-transaction hook, after debit and before the ledger write. Postgres only. */
  onSend?(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects>;
  /** Post-commit hook — statistics, queue enqueue, room counters. */
  afterCommit?(txns: GiftTransaction[]): Promise<void>;
}
```

- [ ] **Step 4: Write the registry**

Create `src/modules/gifts/services/gift-context.registry.ts`:

```ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { IGiftContextHandler } from '../interfaces/gift-context-handler.interface';

/**
 * Resolves the handler for a gift context. Each context's owning module
 * registers its handler on init, which is what keeps GiftService free of
 * room-type dependencies and free of an if-chain (spec D1).
 */
@Injectable()
export class GiftContextRegistry {
  private readonly logger = new Logger(GiftContextRegistry.name);
  private readonly handlers = new Map<GiftContextType, IGiftContextHandler>();

  register(handler: IGiftContextHandler): void {
    if (this.handlers.has(handler.contextType)) {
      throw new Error(`Gift context handler already registered for ${handler.contextType}`);
    }
    this.handlers.set(handler.contextType, handler);
    this.logger.log(`registered gift context handler: ${handler.contextType}`);
  }

  for(contextType: GiftContextType): IGiftContextHandler {
    const handler = this.handlers.get(contextType);
    if (!handler) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'Gifting is not supported in this context.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return handler;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/gifts/services/gift-context.registry.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Export and register the provider**

Add to `src/modules/gifts/interfaces/index.ts`:
```ts
export * from './gift-context-handler.interface';
```
Add to `src/modules/gifts/services/index.ts`:
```ts
export * from './gift-context.registry';
```
In `src/modules/gifts/gifts.module.ts`, add `GiftContextRegistry` to `providers` and to `exports` (audio-rooms and video-rooms must inject it).

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

---

## Task 3: The audio-room handler (validation + economics only)

Moves validation and economics. Treasure/host-reward/refund move in Task 4 — split so a reviewer can gate the pure-validation move separately from the money move.

**Files:**
- Create: `src/modules/audio-rooms/services/audio-room-gift-context.handler.ts`
- Test: `src/modules/audio-rooms/services/audio-room-gift-context.handler.spec.ts`
- Modify: `src/modules/audio-rooms/audio-rooms.module.ts`

**Interfaces:**
- Consumes: `IGiftContextHandler`, `GiftContextRegistry` (Task 2)
- Produces: `AudioRoomGiftContextHandler` — `contextType = AUDIO_ROOM`, `maxReceivers = 1`

- [ ] **Step 1: Write the failing handler test**

```ts
import { GiftContextType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { AudioRoomGiftContextHandler } from './audio-room-gift-context.handler';

const REQ = {
  contextType: GiftContextType.AUDIO_ROOM, contextId: 'room-1',
  senderId: 'sender-1', receiverIds: ['receiver-1'],
  gift: { id: 'g1', coinValue: 100 }, quantity: 1,
};

describe('AudioRoomGiftContextHandler', () => {
  let rooms: Record<string, jest.Mock>;
  let users: { findById: jest.Mock };
  let registry: { register: jest.Mock };
  let handler: AudioRoomGiftContextHandler;

  beforeEach(() => {
    rooms = {
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn(),
      isMember: jest.fn().mockResolvedValue(true),
      getOwnerId: jest.fn().mockResolvedValue('owner-1'),
    };
    users = { findById: jest.fn().mockResolvedValue({ id: 'receiver-1' }) };
    registry = { register: jest.fn() };
    handler = new AudioRoomGiftContextHandler(
      rooms as never, users as never, registry as never,
    );
  });

  it('registers itself on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('declares AUDIO_ROOM with maxReceivers = 1', () => {
    expect(handler.contextType).toBe(GiftContextType.AUDIO_ROOM);
    expect(handler.maxReceivers).toBe(1);
  });

  it('BC-6: economics credit the receiver nothing (treasure takes the coins)', () => {
    expect(handler.economics(REQ as never)).toEqual({ receiverEarningsBps: 0 });
  });

  it('rejects a send when the room is not live', async () => {
    rooms.isRoomLive.mockResolvedValue(false);
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
    });
  });

  it('rejects a receiver who is not in the room', async () => {
    rooms.isMember.mockResolvedValue(false);
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
    });
  });

  it('rejects more than one receiver', async () => {
    await expect(
      handler.validate({ ...REQ, receiverIds: ['a', 'b'] } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/audio-rooms/services/audio-room-gift-context.handler.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the `GIFT_TOO_MANY_RECEIVERS` error code**

Append to `src/common/exceptions/error-codes.ts` beside the existing `GIFT_*` block (append only — do not edit existing entries):

```ts
  GIFT_TOO_MANY_RECEIVERS: 'GIFT_TOO_MANY_RECEIVERS',
```

- [ ] **Step 4: Write the handler**

Create `src/modules/audio-rooms/services/audio-room-gift-context.handler.ts`. The `validate()` body is **moved verbatim** from `GiftService.assertContext()` (`gift.service.ts:341-372`) — same checks, same error codes, same order.

```ts
import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  GiftContextRegistry,
  type GiftContextRequest,
  type GiftEconomics,
  type IGiftContextHandler,
} from 'src/modules/gifts';
import { AUDIO_ROOMS_SERVICE, type IAudioRoomsService } from '../interfaces/audio-rooms.service.interface';
import { USERS_SERVICE, type IUsersService } from 'src/modules/users/interfaces/users.service.interface';

/**
 * AUDIO_ROOM gift context (moved out of GiftService in VR-10). Validation is the
 * former assertContext(); economics return 0 bps because audio-room coins route
 * to the Treasure Box + host reward instead of creator earnings (BC-6).
 */
@Injectable()
export class AudioRoomGiftContextHandler implements IGiftContextHandler, OnModuleInit {
  readonly contextType = GiftContextType.AUDIO_ROOM;
  readonly maxReceivers = 1;

  constructor(
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    private readonly registry: GiftContextRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async validate(req: GiftContextRequest): Promise<void> {
    if (req.receiverIds.length > this.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        'Audio room gifts support a single recipient.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!(await this.rooms.isRoomLive(req.contextId))) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    await this.rooms.assertMember(req.contextId, req.senderId);
    const receiverId = req.receiverIds[0];
    const inRoom = await this.rooms.isMember(req.contextId, receiverId);
    const exists = inRoom && (await this.users.findById(receiverId));
    if (!exists) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'The recipient is not in this room.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  economics(_req: GiftContextRequest): GiftEconomics {
    return { receiverEarningsBps: 0 };
  }
}
```

The constructor takes exactly 3 dependencies at this stage. Task 4 adds `WALLET_SERVICE` and `TREASURE_BOXES_SERVICE` as positions 4 and 5, and updates every `new AudioRoomGiftContextHandler(...)` call site (this spec file, and the baseline helper) accordingly.

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/audio-rooms/services/audio-room-gift-context.handler.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Register the provider**

Add `AudioRoomGiftContextHandler` to `providers` in `src/modules/audio-rooms/audio-rooms.module.ts`.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint && npx jest src/modules/audio-rooms src/modules/gifts`
Expected: all pass. Baseline from Task 1 still green (nothing has been removed from `GiftService` yet).

---

## Task 4: Move treasure/host-reward/refund into `onSend`; slim `GiftService`

The highest-risk task. The BC gate from Task 1 is the acceptance test.

**Files:**
- Modify: `src/modules/audio-rooms/services/audio-room-gift-context.handler.ts`
- Modify: `src/modules/audio-rooms/services/audio-room-gift-context.handler.spec.ts`
- Modify: `src/modules/gifts/services/gift.service.ts:130-318` (assertContext call, audio branch, deps), delete `compensate()` at `:469-504`
- Modify: `src/modules/audio-rooms/services/audio-room-gift-baseline.spec.ts` — **helper wiring only**

**Interfaces:**
- Consumes: `GiftSendContext`, `GiftSendEffects` (Task 2)
- Produces: `AudioRoomGiftContextHandler.onSend(tx, ctx) => GiftSendEffects`

- [ ] **Step 1: Write the failing onSend test**

Append to `audio-room-gift-context.handler.spec.ts`:

```ts
describe('onSend (treasure + host reward + refund)', () => {
  const CTX = {
    ...REQ, transactionId: 'txn-1', batchId: 'batch-1',
    idempotencyKey: 'idem-1', totalCoinValue: 100,
  };

  it('BC-3: routes the total through the treasure box', async () => {
    treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 100, refundAmount: 0, events: [], boxId: 'box-1', level: 2,
    });
    const effects = await handler.onSend({} as never, CTX as never);
    expect(treasure.processTreasureContribution).toHaveBeenCalledWith(
      {}, 'room-1', 'sender-1', 'receiver-1', 100, 'txn-1',
    );
    expect(effects.acceptedAmount).toBe(100);
  });

  it('BC-4: credits the host 10% of the accepted amount', async () => {
    treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 100, refundAmount: 0, events: [], boxId: 'box-1', level: 2,
    });
    await handler.onSend({} as never, CTX as never);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1', amount: 10,
        idempotencyKey: 'gift-host-reward:idem-1',
      }),
      {},
    );
  });

  it('BC-5: refunds the excess to the sender', async () => {
    treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 60, refundAmount: 40, events: [], boxId: 'box-1', level: 2,
    });
    const effects = await handler.onSend({} as never, CTX as never);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sender-1', amount: 40,
        idempotencyKey: 'gift-refund:idem-1',
      }),
      {},
    );
    expect(effects.events.map((e) => e.name)).toContain('gift.refunded');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/audio-rooms/services/audio-room-gift-context.handler.spec.ts -t onSend`
Expected: FAIL — `handler.onSend is not a function`

- [ ] **Step 3: Move the logic into `onSend`**

Add to the handler (constructor gains `WALLET_SERVICE` and `TREASURE_BOXES_SERVICE`). The body is **moved from** `gift.service.ts:194-260` unchanged in behaviour:

```ts
  async onSend(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects> {
    const receiverId = ctx.receiverIds[0];
    const events: DomainEvent<unknown>[] = [];

    const contribution = await this.treasure.processTreasureContribution(
      tx, ctx.contextId, ctx.senderId, receiverId, ctx.totalCoinValue, ctx.transactionId,
    );
    events.push(...contribution.events);

    const hostId = await this.rooms.getOwnerId(ctx.contextId);
    const hostReward = Math.floor(contribution.acceptedAmount * 0.1);
    if (hostId && hostReward > 0) {
      const credit = await this.wallet.credit({
        userId: hostId,
        currency: WalletCurrency.GOLD,
        amount: hostReward,
        reason: WalletTxnReason.TREASURE_BOX,
        idempotencyKey: `gift-host-reward:${ctx.idempotencyKey}`,
        referenceType: GIFT_WALLET_REFERENCE_TYPE,
        referenceId: ctx.transactionId,
        actorId: ctx.senderId,
      }, tx);
      events.push(new TreasureReceiverRewardEvent({
        roomId: ctx.contextId,
        boxId: contribution.boxId ?? ctx.transactionId,
        level: contribution.level ?? 0,
        hostId,
        rewardAmount: hostReward,
        walletTxnId: credit.transactionId,
      }));
    }

    if (contribution.refundAmount > 0) {
      await this.wallet.credit({
        userId: ctx.senderId,
        currency: WalletCurrency.GOLD,
        amount: contribution.refundAmount,
        reason: WalletTxnReason.GIFT_REFUND,
        idempotencyKey: `gift-refund:${ctx.idempotencyKey}`,
        referenceType: GIFT_WALLET_REFERENCE_TYPE,
        referenceId: ctx.transactionId,
        actorId: ctx.senderId,
      }, tx);
      events.push(new GiftRefundedEvent({
        transactionId: ctx.transactionId,
        senderId: ctx.senderId,
        roomId: ctx.contextId,
        giftId: ctx.gift.id,
        giftName: ctx.gift.name,
        totalRefundAmount: contribution.refundAmount,
        createdAt: new Date().toISOString(),
      }));
    }

    return {
      acceptedAmount: contribution.acceptedAmount,
      refundAmount: contribution.refundAmount,
      events,
      postCommit: contribution.postCommit,
    };
  }
```

- [ ] **Step 4: Slim `GiftService`**

In `src/modules/gifts/services/gift.service.ts`:
1. Replace the `assertContext(...)` call at `:130` with:
   ```ts
   const handler = this.registry.for(dto.contextType);
   await handler.validate({
     contextType: dto.contextType, contextId: dto.contextId,
     senderId, receiverIds: [dto.receiverId], gift, quantity: dto.quantity,
   });
   ```
2. Delete the private `assertContext()` method (`:341-372`).
3. Replace the `if (dto.contextType === GiftContextType.AUDIO_ROOM) { … } else { … }` block (`:195-276`) with:
   ```ts
   const effects = handler.onSend
     ? await handler.onSend(tx, { ...req, transactionId: txnId, batchId, idempotencyKey, totalCoinValue: totalNum })
     : { acceptedAmount: totalNum, refundAmount: 0, events: [] };
   eventsToPublish.push(...effects.events);
   postCommitFn = effects.postCommit;

   const bps = handler.economics(req).receiverEarningsBps;
   const earningsNum = Math.floor((totalNum * bps) / 10_000);
   let creditTxnId: string | null = null;
   if (earningsNum > 0) {
     const credit = await this.wallet.credit({ /* …as today… */ }, tx);
     creditTxnId = credit.transactionId;
   }
   ```
4. Replace the `creatorEarnings` computation at `:150-152` with `BigInt(earningsNum)` derived from the handler.
5. Delete `compensate()` (`:469-504`) — unreachable since the `$transaction` refactor.
6. Remove `AUDIO_ROOMS_SERVICE`, `USERS_SERVICE` and `TREASURE_BOXES_SERVICE` from the constructor; add `private readonly registry: GiftContextRegistry`.

- [ ] **Step 5: Update ONLY the baseline helper wiring**

In `audio-room-gift-baseline.spec.ts`, update `buildGiftService` to the new constructor arity. **Do not touch any assertion.** The handler must be constructed and registered inside the helper so the baseline exercises the full path:

```ts
  const registry = new GiftContextRegistry();
  const audioHandler = new AudioRoomGiftContextHandler(
    rooms as never, users as never, registry as never,
    m.wallet as never, treasure as never,
  );
  audioHandler.onModuleInit();
  return new GiftService(
    m.repo as never, catalog as never, leaderboards as never, config as never,
    m.queue as never, prisma as never, locks as never, m.bus as never,
    m.wallet as never, vip as never, registry as never,
  );
```

- [ ] **Step 6: Run the BC gate**

Run: `npx jest src/modules/audio-rooms/services/audio-room-gift-baseline.spec.ts`
Expected: **PASS — all 4 tests, unchanged assertions.** Any failure here is a real audio-room regression; fix the code, never the assertion.

- [ ] **Step 7: Run the full gift + audio suite**

Run: `npx jest src/modules/gifts src/modules/audio-rooms src/modules/treasure-boxes`
Expected: PASS. Then `npx tsc --noEmit && npm run lint`.

---

## Task 5: `sendGiftBatch()` with per-leg idempotency keys

**Files:**
- Modify: `src/modules/gifts/services/gift.service.ts`
- Test: `src/modules/gifts/services/gift.service.spec.ts` (append)

**Interfaces:**
- Produces: `GiftService.sendGiftBatch(actor, dto): Promise<GiftTransaction[]>` where `dto` extends `SendGiftDto` with `receiverIds: string[]` and optional `batchId`. `sendGift()` delegates with `[dto.receiverId]` and returns `result[0]`.

- [ ] **Step 1: Write the failing multi-receiver test**

```ts
describe('sendGiftBatch (multi-receiver)', () => {
  it('charges unit × quantity × N in ONE debit', async () => {
    await service.sendGiftBatch(ACTOR as never, {
      ...DTO, contextType: GiftContextType.VIDEO_ROOM,
      receiverIds: ['r1', 'r2', 'r3'],
    } as never);
    expect(wallet.debit).toHaveBeenCalledTimes(1);
    expect(wallet.debit.mock.calls[0][0].amount).toBe(300); // 100 × 1 × 3
  });

  it('credits N wallets with PER-LEG idempotency keys (double-credit guard)', async () => {
    await service.sendGiftBatch(ACTOR as never, {
      ...DTO, contextType: GiftContextType.VIDEO_ROOM,
      receiverIds: ['r1', 'r2', 'r3'],
    } as never);
    const keys = wallet.credit.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([
      'gift-credit:idem-1:r1',
      'gift-credit:idem-1:r2',
      'gift-credit:idem-1:r3',
    ]);
    expect(new Set(keys).size).toBe(3); // all distinct — this is the bug guard
  });

  it('writes N ledger rows sharing one batchId', async () => {
    await service.sendGiftBatch(ACTOR as never, {
      ...DTO, contextType: GiftContextType.VIDEO_ROOM,
      receiverIds: ['r1', 'r2'],
    } as never);
    const rows = repo.createTransaction.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata.batchId).toBe(rows[1].metadata.batchId);
  });

  it('BC-2: single-receiver credit key shape is unchanged', async () => {
    await service.sendGift(ACTOR as never, { ...DTO, contextType: GiftContextType.VIDEO_ROOM } as never);
    expect(wallet.credit.mock.calls[0][0].idempotencyKey).toBe('gift-credit:idem-1:receiver-1');
  });

  it('sorts lock keys across sender + all receivers', async () => {
    await service.sendGiftBatch(ACTOR as never, {
      ...DTO, contextType: GiftContextType.VIDEO_ROOM,
      receiverIds: ['zzz', 'aaa'],
    } as never);
    const keys = locks.withLock.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([...keys].sort());
  });
});
```

**Note on BC-2:** the single-receiver credit key *does* change shape (`gift-credit:{k}` → `gift-credit:{k}:{receiverId}`). This is safe **only** because `AUDIO_ROOM` economics are 0 bps, so no `gift-credit:*` row is ever written for audio rooms in production. Verify this claim by querying production for `idempotencyKey LIKE 'gift-credit:%'` before release; if any rows exist, keep the un-suffixed key when `receiverIds.length === 1`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/gifts/services/gift.service.spec.ts -t sendGiftBatch`
Expected: FAIL — `service.sendGiftBatch is not a function`

- [ ] **Step 3: Implement `sendGiftBatch`**

Rewrite the send path so `sendGift` is a wrapper:

```ts
  async sendGift(actor: RoomActor, dto: SendGiftDto): Promise<GiftTransaction> {
    const [txn] = await this.sendGiftBatch(actor, { ...dto, receiverIds: [dto.receiverId] });
    return txn;
  }

  async sendGiftBatch(actor: RoomActor, dto: SendGiftBatchDto): Promise<GiftTransaction[]> {
    const senderId = actor.id;
    const receiverIds = [...new Set(dto.receiverIds)];
    if (receiverIds.includes(senderId)) {
      throw new BusinessException(ERROR_CODES.CANNOT_GIFT_SELF, 'You cannot send a gift to yourself.', HttpStatus.BAD_REQUEST);
    }
    // …catalog + enabled + VIP gate + idempotency pre-check (unchanged)…

    const handler = this.registry.for(dto.contextType);
    if (receiverIds.length > handler.maxReceivers) {
      throw new BusinessException(ERROR_CODES.GIFT_TOO_MANY_RECEIVERS, 'Too many recipients for this context.', HttpStatus.BAD_REQUEST);
    }
    const req = { contextType: dto.contextType, contextId: dto.contextId, senderId, receiverIds, gift, quantity: dto.quantity };
    await handler.validate(req);

    // rate limit: ONE tick per API call, not per receiver (spec §4.3)
    if (await this.repo.hitRateLimit(senderId, cfg.rateMax, cfg.rateWindowSeconds)) { throw …; }

    const comboTier = gift.comboEnabled ? await this.repo.comboTick(...) : 1;
    const lucky = this.rollLucky(gift);
    const batchId = dto.batchId ?? randomUUID();
    const perReceiver = BigInt(gift.coinValue) * BigInt(dto.quantity) * BigInt(lucky.multiplier);
    const totalNum = Number(perReceiver) * receiverIds.length;
    const bps = handler.economics(req).receiverEarningsBps;

    const lockKeys = [senderId, ...receiverIds].sort().map(walletLockKey);
    return this.withLocks(lockKeys, () => this.prisma.$transaction(async (tx) => {
      const prior = await this.repo.findTxnByIdempotencyKey(idempotencyKey, tx);
      if (prior) return [prior];

      const debit = await this.wallet.debit({
        userId: senderId, currency: WalletCurrency.GOLD, amount: totalNum,
        reason: WalletTxnReason.GIFT_SEND, idempotencyKey: `gift-debit:${idempotencyKey}`,
        referenceType: GIFT_WALLET_REFERENCE_TYPE, actorId: senderId,
        metadata: { giftId: gift.id, quantity: dto.quantity, contextId: dto.contextId, batchId },
      }, tx);

      const effects = handler.onSend
        ? await handler.onSend(tx, { ...req, transactionId: batchId, batchId, idempotencyKey, totalCoinValue: totalNum })
        : { acceptedAmount: totalNum, refundAmount: 0, events: [] };

      const rows: GiftTransaction[] = [];
      for (const receiverId of receiverIds) {
        const earnings = (perReceiver * BigInt(bps)) / 10_000n;
        let creditTxnId: string | null = null;
        if (earnings > 0n) {
          const credit = await this.wallet.credit({
            userId: receiverId, currency: WalletCurrency.EARNINGS, amount: Number(earnings),
            reason: WalletTxnReason.GIFT_RECEIVE,
            idempotencyKey: `gift-credit:${idempotencyKey}:${receiverId}`,  // PER-LEG
            referenceType: GIFT_WALLET_REFERENCE_TYPE,
            metadata: { giftId: gift.id, senderId, batchId }, actorId: senderId,
          }, tx);
          creditTxnId = credit.transactionId;
        }
        rows.push(await this.repo.createTransaction({
          senderId, receiverId, giftId: gift.id, giftType: gift.type,
          contextType: dto.contextType, contextId: dto.contextId,
          quantity: dto.quantity, comboTier,
          unitCoinValue: gift.coinValue, totalCoinValue: perReceiver,
          creatorEarnings: earnings, luckyMultiplier: lucky.multiplier, isLuckyWin: lucky.win,
          senderExp: Math.floor(Number(perReceiver) * cfg.senderExpPerCoin),
          receiverExp: Math.floor(Number(perReceiver) * cfg.receiverExpPerCoin),
          idempotencyKey: receiverIds.length === 1 ? idempotencyKey : `${idempotencyKey}:${receiverId}`,
          senderWalletTxnId: debit.transactionId, receiverWalletTxnId: creditTxnId,
          metadata: { giftName: gift.name, batchId, ...effects },
        }, tx));
      }
      return rows;
    }));
  }
```

Add a private `withLocks(keys, fn)` helper that folds `locks.withLock` recursively, replacing the hand-nested three-deep calls.

**Why `onSend` receives `transactionId: batchId` — not a BC break.** In the current
code `txnId = randomUUID()` is generated *before* the transaction (`gift.service.ts:166`)
and passed to `processTreasureContribution` and the host credit's `referenceId`.
It is **not** the ledger row's id — `createTransaction` never sets `id`, so Prisma
generates a different uuid for the row. `txnId` was always a standalone correlation
uuid, so `batchId` fills exactly the same role with identical behaviour. Do not
"fix" this by threading the real ledger id in: the ledger rows do not exist yet
when `onSend` runs.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/gifts/services/gift.service.spec.ts`
Expected: PASS — including the 5 new tests.

- [ ] **Step 5: Re-run the BC gate**

Run: `npx jest src/modules/audio-rooms src/modules/gifts src/modules/treasure-boxes`
Expected: PASS — the baseline must still be green.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 6: The queue job registry (infra seam)

**Files:**
- Create: `src/infra/queue/workers/queue-job.registry.ts`
- Test: `src/infra/queue/workers/queue-job.registry.spec.ts`
- Modify: `src/infra/queue/processors/gift-processing.processor.ts`
- Modify: `src/infra/queue/queue.module.ts` (provide + export the registry)

**These are the only permitted infra changes.**

**Interfaces:**
- Produces: `QueueJobRegistry.register(queue, jobName, handler)`, `QueueJobRegistry.dispatch(queue, job)`

- [ ] **Step 1: Write the failing registry test**

```ts
import { QUEUE_NAMES } from '../queue.constants';
import { QueueJobRegistry } from './queue-job.registry';

describe('QueueJobRegistry', () => {
  let registry: QueueJobRegistry;
  beforeEach(() => { registry = new QueueJobRegistry(); });

  it('dispatches to the registered handler', async () => {
    const handler = jest.fn().mockResolvedValue({ done: true });
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'video-room.gift.deliver', handler);
    const job = { name: 'video-room.gift.deliver', data: { batchId: 'b1' } };
    await expect(registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job as never))
      .resolves.toEqual({ done: true });
    expect(handler).toHaveBeenCalledWith({ batchId: 'b1' }, job);
  });

  // REGRESSION GUARD: GiftService enqueues `gift.sent` on every audio-room gift
  // and nothing handles it. A throwing registry would dead-letter every audio gift.
  it('returns unhandled (NEVER throws) for an unregistered job name', async () => {
    const job = { name: 'gift.sent', data: { transactionId: 't1' } };
    await expect(registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job as never))
      .resolves.toEqual({ ok: true, unhandled: true });
  });

  it('keys handlers by queue AND job name', async () => {
    const a = jest.fn().mockResolvedValue('a');
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'x', a);
    await expect(registry.dispatch(QUEUE_NAMES.NOTIFICATIONS, { name: 'x', data: {} } as never))
      .resolves.toEqual({ ok: true, unhandled: true });
    expect(a).not.toHaveBeenCalled();
  });

  it('propagates handler errors so BullMQ can retry', async () => {
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'boom', jest.fn().mockRejectedValue(new Error('nope')));
    await expect(registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, { name: 'boom', data: {} } as never))
      .rejects.toThrow('nope');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/infra/queue/workers/queue-job.registry.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';

export type QueueJobHandler = (data: unknown, job: Job) => Promise<unknown>;

/**
 * Routes a queue job to the domain handler that owns it, keyed by
 * `${queue}:${jobName}`. Domain modules register on init; processors stay pure
 * transport. Generic on purpose — future contexts register without editing any
 * processor.
 *
 * dispatch() MUST NOT throw on an unknown job name: GiftService already enqueues
 * `gift.sent` to gift-processing with no handler, and throwing would exhaust its
 * retries and dead-letter every audio-room gift.
 */
@Injectable()
export class QueueJobRegistry {
  private readonly logger = new Logger(QueueJobRegistry.name);
  private readonly handlers = new Map<string, QueueJobHandler>();

  private key(queue: string, jobName: string): string { return `${queue}:${jobName}`; }

  register(queue: string, jobName: string, handler: QueueJobHandler): void {
    const key = this.key(queue, jobName);
    if (this.handlers.has(key)) throw new Error(`Queue job handler already registered: ${key}`);
    this.handlers.set(key, handler);
    this.logger.log(`registered queue job handler: ${key}`);
  }

  async dispatch(queue: string, job: Job): Promise<unknown> {
    const handler = this.handlers.get(this.key(queue, job.name));
    if (!handler) {
      this.logger.debug(`no handler for ${this.key(queue, job.name)} — skipping`);
      return { ok: true, unhandled: true };
    }
    return handler(job.data, job);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/infra/queue/workers/queue-job.registry.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Wire the processor (routing only)**

Replace the body of `src/infra/queue/processors/gift-processing.processor.ts`:

```ts
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueJobRegistry } from '../workers/queue-job.registry';
import { QueueSupport } from '../workers/queue-support.service';

/** Gift queue transport. Routes jobs to domain handlers; owns no business logic. */
@Processor(QUEUE_NAMES.GIFT_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class GiftProcessingProcessor extends BaseQueueWorker {
  constructor(support: QueueSupport, private readonly registry: QueueJobRegistry) {
    super(QUEUE_NAMES.GIFT_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    return this.registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job);
  }
}
```

Add `QueueJobRegistry` to `providers` **and** `exports` in `src/infra/queue/queue.module.ts`.

- [ ] **Step 6: Verify no other infra file changed**

Run: `git status --short src/infra/`
Expected: exactly 3 entries — `queue-job.registry.ts`, `queue-job.registry.spec.ts`, `gift-processing.processor.ts`, plus `queue.module.ts`. (4 including the module.) If anything else appears, revert it.

Run: `npx jest src/infra/queue && npx tsc --noEmit && npm run lint`

---

## Task 7: Video-room gift constants, config and error codes

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-gift.constants.ts`
- Create: `src/modules/video-rooms/config/video-room-gift.config.ts`
- Test: `src/modules/video-rooms/constants/video-room-gift.constants.spec.ts`
- Modify: `src/common/exceptions/error-codes.ts` (append), `src/config/env.validation.ts`, `src/config/configuration.ts`, `.env.example`, `src/modules/video-rooms/constants/index.ts`

**Interfaces:**
- Produces: `VIDEO_ROOM_GIFT_SOCKET_EVENTS`, `VIDEO_ROOM_GIFT_QUEUE_JOB`, `GIFT_CATEGORY_PRIORITY`, `giftDeliverLockKey(roomId)`, `giftComboKey(roomId, senderId, giftId)`, `GIFT_COMBO_INDEX_KEY`, `giftRecentKey(roomId)`, `giftStatsKey(roomId)`, `giftTopKey(roomId)`, `GIFT_MONITOR_LOCK_KEY`, `GIFT_CATALOG_CACHE_KEY`

- [ ] **Step 1: Write the failing constants test**

```ts
import { GiftCategory } from '@prisma/client';
import {
  GIFT_CATEGORY_PRIORITY, giftComboKey, giftDeliverLockKey, giftRecentKey,
} from './video-room-gift.constants';

describe('video-room gift constants', () => {
  it('gives LUXURY and VIP_EXCLUSIVE the highest priority', () => {
    expect(GIFT_CATEGORY_PRIORITY[GiftCategory.LUXURY]).toBe(1);
    expect(GIFT_CATEGORY_PRIORITY[GiftCategory.VIP_EXCLUSIVE]).toBe(1);
    expect(GIFT_CATEGORY_PRIORITY[GiftCategory.STANDARD]).toBe(4);
  });

  it('covers every GiftCategory (no undefined priority)', () => {
    for (const c of Object.values(GiftCategory)) {
      expect(GIFT_CATEGORY_PRIORITY[c]).toBeGreaterThan(0);
    }
  });

  it('namespaces every key under video-room:', () => {
    expect(giftDeliverLockKey('r1')).toBe('video-room:gift:deliver:r1');
    expect(giftComboKey('r1', 's1', 'g1')).toBe('video-room:r1:gift:combo:s1:g1');
    expect(giftRecentKey('r1')).toBe('video-room:r1:gifts:recent');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/constants/video-room-gift.constants.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the constants**

```ts
import { GiftCategory } from '@prisma/client';

/** Outbound `/video-room` socket events for VR-10. */
export const VIDEO_ROOM_GIFT_SOCKET_EVENTS = {
  GIFT_SENT: 'video_room.gift_sent',
  GIFT_DELIVERED: 'video_room.gift_delivered',
  GIFT_ANIMATION: 'video_room.gift_animation',
  GIFT_COMBO_STARTED: 'video_room.gift_combo_started',
  GIFT_COMBO_UPDATED: 'video_room.gift_combo_updated',
  GIFT_COMBO_ENDED: 'video_room.gift_combo_ended',
  GIFT_QUEUE_UPDATED: 'video_room.gift_queue_updated',
  GIFT_FAILED: 'video_room.gift_failed',
  GIFT_RECOVERED: 'video_room.gift_recovered',
} as const;

/** BullMQ job name registered on QUEUE_NAMES.GIFT_PROCESSING. */
export const VIDEO_ROOM_GIFT_QUEUE_JOB = 'video-room.gift.deliver';

/** BullMQ priority (lower = sooner). Luxury/VIP jump the queue. */
export const GIFT_CATEGORY_PRIORITY: Record<GiftCategory, number> = {
  [GiftCategory.VIP_EXCLUSIVE]: 1,
  [GiftCategory.LUXURY]: 1,
  [GiftCategory.PREMIUM]: 2,
  [GiftCategory.EVENT]: 3,
  [GiftCategory.STANDARD]: 4,
};

/** Attempts per category — luxury gets more retries; a lost animation is visible. */
export const GIFT_CATEGORY_ATTEMPTS: Record<GiftCategory, number> = {
  [GiftCategory.VIP_EXCLUSIVE]: 5,
  [GiftCategory.LUXURY]: 5,
  [GiftCategory.PREMIUM]: 5,
  [GiftCategory.EVENT]: 5,
  [GiftCategory.STANDARD]: 3,
};

export const giftRecentKey = (roomId: string) => `video-room:${roomId}:gifts:recent`;
export const giftComboKey = (roomId: string, senderId: string, giftId: string) =>
  `video-room:${roomId}:gift:combo:${senderId}:${giftId}`;
export const GIFT_COMBO_INDEX_KEY = 'video-room:gift:combos';
export const giftStatsKey = (roomId: string) => `video-room:${roomId}:gift:stats`;
export const giftTopKey = (roomId: string) => `video-room:${roomId}:gift:top`;
export const giftDeliverLockKey = (roomId: string) => `video-room:gift:deliver:${roomId}`;
export const GIFT_MONITOR_LOCK_KEY = 'video-room:gift:monitor';
export const GIFT_CATALOG_CACHE_KEY = 'gifts:catalog:active';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/constants/video-room-gift.constants.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Append the error codes**

Append to `src/common/exceptions/error-codes.ts` (append only):
```ts
  GIFT_QUEUE_ERROR: 'GIFT_QUEUE_ERROR',
  GIFT_DELIVERY_FAILED: 'GIFT_DELIVERY_FAILED',
  GIFT_COMBO_ERROR: 'GIFT_COMBO_ERROR',
  WALLET_TRANSACTION_FAILED: 'WALLET_TRANSACTION_FAILED',
  VIDEO_ROOM_GIFTS_DISABLED: 'VIDEO_ROOM_GIFTS_DISABLED',
```
(`GIFT_TOO_MANY_RECEIVERS` was added in Task 3.)

- [ ] **Step 6: Add the config knobs**

`src/config/env.validation.ts`:
```ts
  VIDEO_ROOM_GIFT_MAX_RECEIVERS: z.coerce.number().int().positive().max(50).default(9),
  VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL: z.coerce.boolean().default(false),
  VIDEO_ROOM_GIFT_ALLOW_VIEWER_DEFAULT: z.coerce.boolean().default(true),
  VIDEO_ROOM_GIFT_RECENT_FEED_SIZE: z.coerce.number().int().positive().default(50),
  VIDEO_ROOM_GIFT_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  VIDEO_ROOM_GIFT_RECOVERY_ENABLED: z.coerce.boolean().default(false),
```

⚠️ **`z.coerce.boolean()` is a known trap** — it coerces the *string* `"false"` to `true`. Use the project's existing boolean-env pattern instead: grep for an existing boolean env in `env.validation.ts` and copy that exact idiom. If none exists, use:
```ts
  VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
```
Add a test asserting `VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL=false` parses to `false`.

Mirror into `src/config/configuration.ts` under the `videoRoom` namespace, and document all 6 in `.env.example`.

- [ ] **Step 7: Verify**

Run: `npx jest src/config src/modules/video-rooms/constants && npx tsc --noEmit && npm run lint`

---

## Task 8: DTOs and the target enum

**Files:**
- Create: `src/modules/video-rooms/dto/send-video-room-gift.dto.ts`
- Create: `src/modules/video-rooms/dto/video-room-gift-query.dto.ts`
- Test: `src/modules/video-rooms/dto/send-video-room-gift.dto.spec.ts`
- Modify: `src/modules/video-rooms/dto/index.ts`

**Interfaces:**
- Produces: `VideoRoomGiftTarget` enum (`SINGLE|MULTI|SEAT_ALL|ROOM_ALL`), `SendVideoRoomGiftDto { giftId, target, receiverId?, receiverIds?, quantity, idempotencyKey? }`, `VideoRoomGiftHistoryQueryDto`

- [ ] **Step 1: Write the failing validation test**

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendVideoRoomGiftDto, VideoRoomGiftTarget } from './send-video-room-gift.dto';

const build = (o: Partial<SendVideoRoomGiftDto>) =>
  validate(plainToInstance(SendVideoRoomGiftDto, { quantity: 1, ...o }));

describe('SendVideoRoomGiftDto', () => {
  it('accepts a SINGLE send with a receiverId', async () => {
    expect(await build({
      giftId: '11111111-1111-4111-8111-111111111111',
      target: VideoRoomGiftTarget.SINGLE,
      receiverId: '22222222-2222-4222-8222-222222222222',
    })).toHaveLength(0);
  });

  it('rejects SINGLE without a receiverId', async () => {
    const errors = await build({
      giftId: '11111111-1111-4111-8111-111111111111',
      target: VideoRoomGiftTarget.SINGLE,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects MULTI with an empty receiverIds array', async () => {
    const errors = await build({
      giftId: '11111111-1111-4111-8111-111111111111',
      target: VideoRoomGiftTarget.MULTI, receiverIds: [],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects quantity below 1', async () => {
    const errors = await build({
      giftId: '11111111-1111-4111-8111-111111111111',
      target: VideoRoomGiftTarget.SEAT_ALL, quantity: 0,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/send-video-room-gift.dto.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the DTO**

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional,
  IsUUID, Max, Min, ValidateIf,
} from 'class-validator';

/** Who a video-room gift is aimed at. */
export enum VideoRoomGiftTarget {
  SINGLE = 'SINGLE',
  MULTI = 'MULTI',
  SEAT_ALL = 'SEAT_ALL',
  /** Future-ready; rejected unless VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL is enabled. */
  ROOM_ALL = 'ROOM_ALL',
}

export class SendVideoRoomGiftDto {
  @ApiProperty({ format: 'uuid', description: 'Catalog gift id.' })
  @IsUUID()
  giftId!: string;

  @ApiProperty({ enum: VideoRoomGiftTarget, example: VideoRoomGiftTarget.SINGLE })
  @IsEnum(VideoRoomGiftTarget)
  target!: VideoRoomGiftTarget;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required when target = SINGLE.' })
  @ValidateIf((o) => o.target === VideoRoomGiftTarget.SINGLE)
  @IsUUID()
  receiverId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Required when target = MULTI.' })
  @ValidateIf((o) => o.target === VideoRoomGiftTarget.MULTI)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('4', { each: true })
  receiverIds?: string[];

  @ApiProperty({ minimum: 1, maximum: 999, default: 1 })
  @IsInt() @Min(1) @Max(999)
  quantity = 1;

  @ApiPropertyOptional({ description: 'Client-supplied key making the send exactly-once.' })
  @IsOptional()
  idempotencyKey?: string;
}
```

Create `VideoRoomGiftHistoryQueryDto` extending the shared pagination DTO (copy the pattern from `video-rooms/dto/` chat history), with optional `senderId`, `receiverId`, `giftId`, `from`, `to`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/dto/send-video-room-gift.dto.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 9: Target resolver

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift-target.resolver.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-target.resolver.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomGiftTarget` (Task 8), `VideoRoomSeatStateService.getSnapshot(roomId)`
- Produces: `VideoRoomGiftTargetResolver.resolve(roomId, dto, senderId): Promise<string[]>`

- [ ] **Step 1: Write the failing resolver test**

```ts
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomGiftTarget } from '../dto/send-video-room-gift.dto';
import { VideoRoomGiftTargetResolver } from './video-room-gift-target.resolver';

describe('VideoRoomGiftTargetResolver', () => {
  let seats: { getSnapshot: jest.Mock };
  let config: { get: jest.Mock };
  let resolver: VideoRoomGiftTargetResolver;

  beforeEach(() => {
    seats = { getSnapshot: jest.fn().mockResolvedValue({
      seats: [
        { index: 0, userId: 'u1' }, { index: 1, userId: null },
        { index: 2, userId: 'u2' }, { index: 3, userId: 'sender-1' },
      ],
    }) };
    config = { get: jest.fn().mockReturnValue({ maxReceivers: 9, allowRoomAll: false }) };
    resolver = new VideoRoomGiftTargetResolver(seats as never, config as never);
  });

  it('SINGLE returns the one receiver', async () => {
    await expect(resolver.resolve('r1', {
      target: VideoRoomGiftTarget.SINGLE, receiverId: 'u1',
    } as never, 'sender-1')).resolves.toEqual(['u1']);
  });

  it('MULTI de-duplicates receiver ids', async () => {
    await expect(resolver.resolve('r1', {
      target: VideoRoomGiftTarget.MULTI, receiverIds: ['u1', 'u2', 'u1'],
    } as never, 'sender-1')).resolves.toEqual(['u1', 'u2']);
  });

  it('SEAT_ALL returns occupied seats, excluding the sender', async () => {
    await expect(resolver.resolve('r1', {
      target: VideoRoomGiftTarget.SEAT_ALL,
    } as never, 'sender-1')).resolves.toEqual(['u1', 'u2']);
  });

  it('SEAT_ALL on an empty stage throws GIFT_RECEIVER_INVALID', async () => {
    seats.getSnapshot.mockResolvedValue({ seats: [{ index: 0, userId: null }] });
    await expect(resolver.resolve('r1', {
      target: VideoRoomGiftTarget.SEAT_ALL,
    } as never, 'sender-1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
    });
  });

  it('ROOM_ALL is rejected while the flag is off', async () => {
    await expect(resolver.resolve('r1', {
      target: VideoRoomGiftTarget.ROOM_ALL,
    } as never, 'sender-1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
    });
  });

  it('caps the resolved set at maxReceivers', async () => {
    config.get.mockReturnValue({ maxReceivers: 1, allowRoomAll: false });
    await expect(resolver.resolve('r1', {
      target: VideoRoomGiftTarget.SEAT_ALL,
    } as never, 'sender-1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-target.resolver.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the resolver**

A `switch` over `VideoRoomGiftTarget` returning `string[]`; `SEAT_ALL` reads `getSnapshot()`, filters `userId != null`, excludes `senderId`; `ROOM_ALL` throws `GIFT_CONTEXT_INVALID` unless `allowRoomAll`; every branch de-duplicates via `[...new Set(ids)]`, throws `GIFT_RECEIVER_INVALID` when empty, and throws `GIFT_TOO_MANY_RECEIVERS` when `ids.length > maxReceivers`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-target.resolver.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 10: Video-room gift context handler

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift-context.handler.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`

**Interfaces:**
- Consumes: `IGiftContextHandler`, `GiftContextRegistry` (Task 2)
- Produces: `VideoRoomGiftContextHandler` — `contextType = VIDEO_ROOM`; `economics()` returns `{ receiverEarningsBps: creatorEarningRatePercent × 100 }`; no `onSend` (video rooms have no in-transaction side effects)

- [ ] **Step 1: Write the failing validation test**

Cover each rule from spec §4.5 as its own `it`:

```ts
describe('VideoRoomGiftContextHandler.validate', () => {
  it('rejects when the room is not LIVE', async () => { /* status: OFFLINE → VIDEO_ROOM_INVALID_STATE */ });
  it('rejects when settings.allowGifts is false', async () => { /* → VIDEO_ROOM_GIFTS_DISABLED */ });
  it('rejects a sender who is not an active member', async () => { /* → NOT_ROOM_MEMBER */ });
  it('rejects a receiver who is not an active member', async () => { /* → GIFT_RECEIVER_INVALID */ });
  it('rejects a viewer receiver when allowViewerGifts is off', async () => { /* → GIFT_RECEIVER_INVALID */ });
  it('allows a viewer receiver when allowViewerGifts is on', async () => { /* resolves */ });
  it('rejects a blocked sender', async () => { /* → VIDEO_ROOM_USER_BLOCKED */ });
  it('rejects more receivers than maxReceivers', async () => { /* → GIFT_TOO_MANY_RECEIVERS */ });

  it('economics return the configured creator rate in bps', () => {
    expect(handler.economics(REQ)).toEqual({ receiverEarningsBps: 3000 });
  });

  it('declares no onSend (no in-transaction side effects)', () => {
    expect(handler.onSend).toBeUndefined();
  });
});
```

Write each body fully, following the mock style in `video-room-chat-pin.service.spec.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler**

Injects the rooms repository, settings repository, member repository, moderation repository and `GiftContextRegistry`; registers itself in `onModuleInit`. `maxReceivers` reads `VIDEO_ROOM_GIFT_MAX_RECEIVERS`. `economics()` returns `{ receiverEarningsBps: Math.round(config.get('gift').creatorEarningRatePercent * 100) }`. **No `onSend`** — the transaction boundary stays empty of video-room work.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 11: Video-room gift events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-gift.events.ts`
- Test: `src/modules/video-rooms/events/video-room-gift.events.spec.ts`
- Modify: `src/modules/video-rooms/events/index.ts`

**Interfaces:**
- Produces: `VIDEO_ROOM_GIFT_EVENTS`, `GiftDeliveryCorrelation`, and event classes `VideoRoomGiftDeliveredEvent`, `VideoRoomGiftFailedEvent`, `VideoRoomGiftRecoveredEvent`, `VideoRoomGiftAnimationEvent`, `VideoRoomGiftComboStartedEvent`, `VideoRoomGiftComboUpdatedEvent`, `VideoRoomGiftComboEndedEvent`

- [ ] **Step 1: Write the failing event test**

```ts
import {
  VIDEO_ROOM_GIFT_EVENTS,
  VideoRoomGiftAnimationEvent,
  VideoRoomGiftDeliveredEvent,
} from './video-room-gift.events';

describe('video-room gift events', () => {
  it('carries the full correlation envelope on a delivery event', () => {
    const e = new VideoRoomGiftDeliveredEvent({
      batchId: 'b1', transactionId: 't1', roomId: 'r1', senderId: 's1',
      receiverId: 'u1', giftId: 'g1', jobId: 'j1', attempt: 1,
    });
    expect(e.name).toBe(VIDEO_ROOM_GIFT_EVENTS.DELIVERED);
    expect(Object.keys(e.payload).sort()).toEqual([
      'attempt', 'batchId', 'giftId', 'jobId', 'receiverId', 'roomId', 'senderId', 'transactionId',
    ]);
  });

  it('animation is batch-level: arrays, no singular receiverId', () => {
    const e = new VideoRoomGiftAnimationEvent({
      batchId: 'b1', transactionIds: ['t1', 't2'], receiverIds: ['u1', 'u2'],
      roomId: 'r1', senderId: 's1', giftId: 'g1', jobId: 'j1', attempt: 1,
    });
    expect(e.payload).not.toHaveProperty('receiverId');
    expect(e.payload.receiverIds).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room-gift.events.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the events**

Define `GiftDeliveryCorrelation` exactly as spec §6, then one `DomainEvent` subclass per name, following `src/modules/gifts/events/gift.events.ts`. `VideoRoomGiftAnimationEvent` uses `transactionIds: string[]` + `receiverIds: string[]` in place of the singular pair.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room-gift.events.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 12: Combo lifecycle service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift-combo.service.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-combo.service.spec.ts`

**Interfaces:**
- Produces: `VideoRoomGiftComboService.tick(roomId, senderId, gift, coins): Promise<{ tier, started }>`, `.sweepExpired(now): Promise<number>`, `.listActive(roomId): Promise<VideoRoomGiftComboView[]>`

- [ ] **Step 1: Write the failing combo test**

```ts
describe('VideoRoomGiftComboService', () => {
  it('tier 1 publishes ComboStarted', async () => {
    cache.increment.mockResolvedValue(1);
    await service.tick('r1', 's1', GIFT, 100);
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.gift.combo_started');
  });

  it('tier > 1 publishes ComboUpdated', async () => {
    cache.increment.mockResolvedValue(4);
    await service.tick('r1', 's1', GIFT, 100);
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.gift.combo_updated');
  });

  it('registers the combo in the expiry index with score = now + window', async () => {
    cache.increment.mockResolvedValue(1);
    await service.tick('r1', 's1', GIFT, 100);   // comboWindowSeconds = 10
    expect(cache.setScore).toHaveBeenCalledWith(
      'video-room:gift:combos', expect.any(String), NOW_MS + 10_000,
    );
  });

  it('sweepExpired publishes ComboEnded once and removes the entry', async () => {
    cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1']);
    const ended = await service.sweepExpired(NOW_MS);
    expect(ended).toBe(1);
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.gift.combo_ended');
    expect(cache.sortedRemove).toHaveBeenCalledWith('video-room:gift:combos', 'r1|s1|g1');
  });

  it('sweepExpired publishes nothing when no combo has expired', async () => {
    cache.sortedRangeByScore.mockResolvedValue([]);
    expect(await service.sweepExpired(NOW_MS)).toBe(0);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does NOT multiply cost — tick returns tier only', async () => {
    cache.increment.mockResolvedValue(7);
    const r = await service.tick('r1', 's1', GIFT, 100);
    expect(r).toEqual({ tier: 7, started: false });
    expect(r).not.toHaveProperty('multiplier');
  });
});
```

Inject a clock (`() => number`) rather than calling `Date.now()` so the sweep is deterministic.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-combo.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`tick()` calls `cache.increment(giftComboKey(...), { ttlSeconds: gift.comboWindowSeconds })`, publishes started (tier 1) or updated (tier > 1), and `cache.setScore(GIFT_COMBO_INDEX_KEY, member, now + window*1000)` where `member = ${roomId}|${senderId}|${giftId}`.
`sweepExpired(now)` calls `cache.sortedRangeByScore(GIFT_COMBO_INDEX_KEY, -Infinity, now)`, publishes `ComboEnded` per member, then `cache.sortedRemove(...)`, returning the count.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-combo.service.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 13: The orchestration service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift.service.ts`
- Test: `src/modules/video-rooms/services/video-room-gift.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomGiftTargetResolver.resolve` (T9), `GiftService.sendGiftBatch` (T5), `VideoRoomGiftComboService.tick` (T12)
- Produces: `VideoRoomGiftService.send(actor, roomId, dto): Promise<VideoRoomGiftBatchView>`

- [ ] **Step 1: Write the failing orchestration test**

```ts
describe('VideoRoomGiftService.send', () => {
  it('resolves the target then delegates to sendGiftBatch with VIDEO_ROOM context', async () => {
    await service.send(ACTOR, 'r1', { target: 'SEAT_ALL', giftId: 'g1', quantity: 1 } as never);
    expect(resolver.resolve).toHaveBeenCalledWith('r1', expect.anything(), 'sender-1');
    expect(gifts.sendGiftBatch).toHaveBeenCalledWith(ACTOR, expect.objectContaining({
      contextType: 'VIDEO_ROOM', contextId: 'r1', receiverIds: ['u1', 'u2'],
    }));
  });

  it('performs NO Redis/queue/socket work before the batch returns', async () => {
    gifts.sendGiftBatch.mockImplementation(async () => {
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(cache.addScore).not.toHaveBeenCalled();
      return [TXN];
    });
    await service.send(ACTOR, 'r1', DTO as never);
  });

  it('enqueues ONE delivery job per batch with category priority', async () => {
    await service.send(ACTOR, 'r1', DTO as never);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const [q, name, data, opts] = queue.enqueue.mock.calls[0];
    expect(q).toBe('gift-processing');
    expect(name).toBe('video-room.gift.deliver');
    expect(data.batchId).toBe(TXN.metadata.batchId);
    expect(opts.priority).toBe(1);          // LUXURY
    expect(opts.attempts).toBe(5);
  });

  it('ticks the combo once per send, not once per receiver', async () => {
    gifts.sendGiftBatch.mockResolvedValue([TXN, { ...TXN, receiverId: 'u2' }]);
    await service.send(ACTOR, 'r1', DTO as never);
    expect(combo.tick).toHaveBeenCalledTimes(1);
  });

  it('propagates a batch failure without enqueueing delivery', async () => {
    gifts.sendGiftBatch.mockRejectedValue(new Error('insufficient'));
    await expect(service.send(ACTOR, 'r1', DTO as never)).rejects.toThrow('insufficient');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`send()`: resolve receivers → build the batch DTO with `contextType: VIDEO_ROOM` → `await gifts.sendGiftBatch(...)` → **then** (post-commit only) tick the combo, push the recent feed, bump Redis stats, increment `video_room_statistics`, publish `GiftSent` relay data, and `queue.enqueue(GIFT_PROCESSING, VIDEO_ROOM_GIFT_QUEUE_JOB, { batchId, roomId, senderId, giftId, transactionIds, receiverIds }, { priority: GIFT_CATEGORY_PRIORITY[gift.category], attempts: GIFT_CATEGORY_ATTEMPTS[gift.category], backoff: { type: 'exponential', delay: 500 } })`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift.service.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 14: Statistics writes

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift-statistics.service.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-statistics.service.spec.ts`

**Interfaces:**
- Produces: `.record(roomId, txns)`, `.summary(roomId)`, `.breakdown(roomId, query)`

- [ ] **Step 1: Write the failing statistics test**

```ts
it('increments video_room_statistics totals by the batch sum', async () => {
  await service.record('r1', [{ totalCoinValue: 100n }, { totalCoinValue: 200n }] as never);
  expect(repo.incrementGiftTotals).toHaveBeenCalledWith('r1', 2, 300n);
});

it('adds each gift to the room top-gift ZSET', async () => {
  await service.record('r1', [{ giftId: 'g1', totalCoinValue: 100n }] as never);
  expect(cache.addScore).toHaveBeenCalledWith('video-room:r1:gift:top', 'g1', 1);
});

it('caps the recent feed at the configured size', async () => {
  await service.record('r1', [TXN] as never);
  expect(cache.listTrim).toHaveBeenCalledWith('video-room:r1:gifts:recent', 0, 49);
});

it('summary reads the durable counters, not Redis', async () => {
  repo.findStatistics.mockResolvedValue({ totalGifts: 5n, totalGiftCoins: 500n });
  const s = await service.summary('r1');
  expect(s).toMatchObject({ totalGifts: 5, totalGiftCoins: 500 });
});
```

If `CacheService` lacks a list-trim helper, use `REDIS_CLIENT` directly inside this service (permitted — it is a domain service, not infra).

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-statistics.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service and the repository method**

Add `incrementGiftTotals(roomId, count, coins)` to `VideoRoomsRepository` using a single `videoRoomStatistics.update` with `{ increment }` — **no migration**, the columns already exist.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-statistics.service.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 15: Delivery service (queue handler)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift-delivery.service.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-delivery.service.spec.ts`

**Interfaces:**
- Consumes: `QueueJobRegistry.register` (T6), `VIDEO_ROOM_GIFT_QUEUE_JOB` (T7), events (T11)
- Produces: `VideoRoomGiftDeliveryService.handle(data, job): Promise<{ delivered: number }>`

- [ ] **Step 1: Write the failing delivery test**

```ts
describe('VideoRoomGiftDeliveryService', () => {
  const DATA = {
    batchId: 'b1', roomId: 'r1', senderId: 's1', giftId: 'g1',
    transactionIds: ['t1', 't2'], receiverIds: ['u1', 'u2'],
  };
  const JOB = { id: 'j1', attemptsMade: 0, name: 'video-room.gift.deliver' };

  it('registers itself on the gift queue at init', () => {
    service.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      'gift-processing', 'video-room.gift.deliver', expect.any(Function),
    );
  });

  it('serialises on the per-room delivery lock', async () => {
    await service.handle(DATA, JOB as never);
    expect(locks.withLock.mock.calls[0][0]).toBe('video-room:gift:deliver:r1');
  });

  it('emits ONE batch-level animation event', async () => {
    await service.handle(DATA, JOB as never);
    const animations = bus.publish.mock.calls
      .map((c) => c[0]).filter((e) => e.name.endsWith('animation'));
    expect(animations).toHaveLength(1);
    expect(animations[0].payload.receiverIds).toEqual(['u1', 'u2']);
  });

  it('emits ONE delivered event PER LEG with the full envelope', async () => {
    await service.handle(DATA, JOB as never);
    const delivered = bus.publish.mock.calls
      .map((c) => c[0]).filter((e) => e.name.endsWith('delivered'));
    expect(delivered).toHaveLength(2);
    expect(delivered[0].payload).toMatchObject({
      batchId: 'b1', transactionId: 't1', receiverId: 'u1', jobId: 'j1', attempt: 1,
    });
  });

  it('appends gift.delivered rows to video_room_events with correlationId = batchId', async () => {
    await service.handle(DATA, JOB as never);
    expect(events.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'r1', eventType: 'gift.delivered',
      correlationId: 'b1', referenceId: 't1',
    }));
  });

  it('rethrows so BullMQ can retry when the broadcast fails', async () => {
    bus.publish.mockRejectedValueOnce(new Error('socket down'));
    await expect(service.handle(DATA, JOB as never)).rejects.toThrow('socket down');
  });

  it('reports attempt = attemptsMade + 1', async () => {
    await service.handle(DATA, { ...JOB, attemptsMade: 2 } as never);
    const d = bus.publish.mock.calls.map((c) => c[0]).find((e) => e.name.endsWith('delivered'));
    expect(d.payload.attempt).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-delivery.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`onModuleInit()` registers `(data, job) => this.handle(data, job)`. `handle()` wraps everything in `locks.withLock(giftDeliverLockKey(roomId), …)`, publishes one animation event, then per leg publishes a delivered event and appends a `video_room_events` row. Errors propagate (BullMQ retries; `BaseQueueWorker.onFailed` dead-letters on exhaustion).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-delivery.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 16: Socket listener

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-gift-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-gift-socket.listener.spec.ts`

**Interfaces:**
- Produces: `VideoRoomGiftSocketListener` — subscribes on `onModuleInit`, relays to `/video-room`

- [ ] **Step 1: Write the failing listener test**

Model on `src/modules/audio-rooms/listeners/gift-socket.listener.ts`:

```ts
it('relays a VIDEO_ROOM gift.sent to the room namespace', () => {
  listener.onModuleInit();
  handlers['gift.sent']({ payload: { contextType: 'VIDEO_ROOM', contextId: 'r1' } });
  expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
    '/video-room', 'r1', 'video_room.gift_sent', expect.anything(),
  );
});

it('IGNORES an AUDIO_ROOM gift.sent (no cross-namespace leak)', () => {
  listener.onModuleInit();
  handlers['gift.sent']({ payload: { contextType: 'AUDIO_ROOM', contextId: 'r1' } });
  expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
});

it('notifies the receiver cross-room on delivery', () => { /* emitToUserEverywhere */ });
it('relays all three combo lifecycle events', () => { /* started/updated/ended */ });
it('relays gift_failed and gift_recovered', () => { /* … */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-gift-socket.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the listener**

Subscribe to reused gift events (`GIFT_EVENTS.SENT`, `.COMBO`, `.LUCKY_WIN`) **filtering `contextType === VIDEO_ROOM`**, plus all `VIDEO_ROOM_GIFT_EVENTS`. Emit via `sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-gift-socket.listener.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 17: Monitor (combo sweep + DLQ replay)

**Files:**
- Create: `src/modules/video-rooms/scheduler/video-room-gift.monitor.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-gift.monitor.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomGiftComboService.sweepExpired` (T12), `QueueService.getDeadLetterJobs/replayDeadLetter`
- Produces: `VideoRoomGiftMonitor.tick(): Promise<void>`

- [ ] **Step 1: Write the failing monitor test**

Model on `src/modules/video-rooms/scheduler/video-room-media.monitor.ts`:

```ts
it('guards the tick with the monitor lock', async () => {
  await monitor.tick();
  expect(locks.withLock.mock.calls[0][0]).toBe('video-room:gift:monitor');
});

it('sweeps expired combos every tick', async () => {
  await monitor.tick();
  expect(combo.sweepExpired).toHaveBeenCalled();
});

it('does NOT replay the DLQ while recovery is disabled', async () => {
  config.get.mockReturnValue({ recoveryEnabled: false, monitorIntervalSeconds: 15 });
  await monitor.tick();
  expect(queue.replayDeadLetter).not.toHaveBeenCalled();
});

it('replays only video-room gift jobs when recovery is enabled', async () => {
  config.get.mockReturnValue({ recoveryEnabled: true, monitorIntervalSeconds: 15 });
  queue.getDeadLetterJobs.mockResolvedValue([
    { id: 'd1', data: { name: 'video-room.gift.deliver', data: { roomId: 'r1' } } },
    { id: 'd2', data: { name: 'gift.sent', data: {} } },
  ]);
  await monitor.tick();
  expect(queue.replayDeadLetter).toHaveBeenCalledTimes(1);
  expect(queue.replayDeadLetter).toHaveBeenCalledWith('d1');
});

it('publishes GiftRecovered for each replayed job', async () => { /* … */ });

it('continues sweeping when a replay throws', async () => {
  queue.replayDeadLetter.mockRejectedValue(new Error('gone'));
  await expect(monitor.tick()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/scheduler/video-room-gift.monitor.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the monitor**

`@Interval` driven by `VIDEO_ROOM_GIFT_MONITOR_INTERVAL_SECONDS`, wrapped in `locks.withLock(GIFT_MONITOR_LOCK_KEY, …)`. Calls `combo.sweepExpired(Date.now())`, then — only when `recoveryEnabled` — filters DLQ jobs to `name === VIDEO_ROOM_GIFT_QUEUE_JOB`, replays each in a try/catch, and publishes `VideoRoomGiftRecoveredEvent`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/scheduler/video-room-gift.monitor.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 18: Query service (history / recent / combo)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-gift-query.service.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-query.service.spec.ts`

**Interfaces:**
- Produces: `.history(roomId, query)`, `.recent(roomId)`, `.combos(roomId)`

- [ ] **Step 1: Write the failing query test**

```ts
it('scopes history to VIDEO_ROOM + this room', async () => {
  await service.history('r1', { page: 1, limit: 20, skip: 0 } as never);
  expect(repo.listTransactions.mock.calls[0][0]).toMatchObject({
    contextType: 'VIDEO_ROOM', contextId: 'r1',
  });
});

it('applies sender/receiver/gift filters', async () => { /* … */ });

it('returns a paginated envelope', async () => {
  repo.listTransactions.mockResolvedValue([[TXN], 1]);
  const r = await service.history('r1', { page: 1, limit: 20, skip: 0 } as never);
  expect(r).toMatchObject({ total: 1, page: 1 });
});

it('recent reads Redis, never Postgres', async () => {
  await service.recent('r1');
  expect(cache.listRange).toHaveBeenCalledWith('video-room:r1:gifts:recent', 0, 49);
  expect(repo.listTransactions).not.toHaveBeenCalled();
});

it('combos returns an empty list on cold Redis (not an error)', async () => {
  cache.sortedRangeByScore.mockResolvedValue([]);
  await expect(service.combos('r1')).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-query.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Reuse `GiftRepository.listTransactions` with a `VIDEO_ROOM`-scoped `where`, and `buildPaginated` from `src/common/utils/pagination.util`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-query.service.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 19: Controller (5 routes + Swagger)

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-gifts.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-gifts.controller.spec.ts`
- Modify: `src/modules/video-rooms/controllers/index.ts`

**Interfaces:**
- Consumes: T13 `VideoRoomGiftService`, T18 `VideoRoomGiftQueryService`, T14 `VideoRoomGiftStatisticsService`

- [ ] **Step 1: Write the failing controller test**

Follow `video-rooms-chat.controller.spec.ts`:

```ts
it('POST /send delegates to the gift service with the actor and roomId', async () => {
  await controller.send(ACTOR as never, 'r1', DTO as never);
  expect(gifts.send).toHaveBeenCalledWith(ACTOR, 'r1', DTO);
});

it('GET /history passes the query through', async () => { /* … */ });
it('GET /recent returns the Redis feed', async () => { /* … */ });
it('GET /combo returns active combos', async () => { /* … */ });

it('GET /statistics returns the summary for a plain member', async () => {
  permissions.hasPermission.mockResolvedValue(false);
  const r = await controller.statistics(ACTOR as never, 'r1');
  expect(stats.breakdown).not.toHaveBeenCalled();
  expect(r).toEqual(SUMMARY);
});

it('GET /statistics adds the breakdown for VIEW_ANALYTICS holders', async () => {
  permissions.hasPermission.mockResolvedValue(true);
  await controller.statistics(ACTOR as never, 'r1');
  expect(stats.breakdown).toHaveBeenCalledWith('r1', undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-gifts.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the controller**

`@Controller('video-rooms/:id/gifts')`, `@ApiTags('Video Rooms — Gifts')`, `@UseGuards(JwtAuthGuard)`. `POST /send` carries `@NotGuest()`. Every route documents `@ApiOperation`, `@ApiParam`, `@ApiOkResponse`/`@ApiCreatedResponse` with an example, and `@ApiResponse` for 400 / 401 / 403 / 404 / 409 / 429 naming the error codes from Task 7.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-gifts.controller.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 20: Metrics

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (append a VR-10 block)
- Test: `src/modules/video-rooms/video-rooms.metrics.spec.ts` (append)

**Interfaces:**
- Produces: `incGiftSent(category, coins)`, `observeGiftSendLatency(s)`, `observeGiftWalletLatency(s)`, `setGiftQueueDepth(n)`, `incGiftFailure()`, `incGiftRecovery(result)`

- [ ] **Step 1: Write the failing metrics test**

```ts
it('registers the VR-10 gift metric families', () => {
  const names = registry.getMetricsAsArray().map((m) => m.name);
  expect(names).toEqual(expect.arrayContaining([
    'video_room_gifts_sent_total', 'video_room_gift_coins_total',
    'video_room_gift_send_latency_seconds', 'video_room_gift_queue_depth',
  ]));
});

it('does NOT label any metric by giftId (cardinality guard)', () => {
  const gift = registry.getSingleMetric('video_room_gifts_sent_total');
  expect(JSON.stringify(gift)).not.toContain('giftId');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/video-rooms/video-rooms.metrics.spec.ts -t VR-10`
Expected: FAIL.

- [ ] **Step 3: Add the metric family**

Append a `// ---- VR-10 gifts ----` block following the existing VR-5 style. `giftsSentC` is `Counter<'category'>` — **never** labelled by `giftId` (unbounded cardinality; top-gifts is served from the ZSET).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/video-rooms/video-rooms.metrics.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 21: Module wiring

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/video-rooms/services/index.ts`, `listeners/index.ts`, `controllers/index.ts`, `dto/index.ts`, `events/index.ts`

- [ ] **Step 1: Register every VR-10 provider**

Add to `providers`: `VideoRoomGiftTargetResolver`, `VideoRoomGiftContextHandler`, `VideoRoomGiftComboService`, `VideoRoomGiftService`, `VideoRoomGiftDeliveryService`, `VideoRoomGiftQueryService`, `VideoRoomGiftStatisticsService`, `VideoRoomGiftSocketListener`, `VideoRoomGiftMonitor`. Add `VideoRoomsGiftsController` to `controllers`. Add barrel exports.

- [ ] **Step 2: Boot the application**

Run: `npm run build && node -e "require('./dist/main.js')" 2>&1 | head -40`
Expected: no Nest DI resolution errors. Common failure: `GiftContextRegistry` not exported from `GiftsModule` (Task 2 Step 6) or `QueueJobRegistry` not exported from `QueueModule` (Task 6 Step 5).

- [ ] **Step 3: Verify handler registration at runtime**

Confirm the boot log contains both:
```
registered gift context handler: AUDIO_ROOM
registered gift context handler: VIDEO_ROOM
registered queue job handler: gift-processing:video-room.gift.deliver
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint`

---

## Task 22: Integration tests, performance validation and the full BC gate 🚦 GATES G2 + G3

> **RELEASE-BLOCKING.** Steps 4 and 6 are gates G2 and G3. A failure in either
> blocks release outright. A BC failure means audio-room gifting regressed — fix
> the code, never the expectation.

**Files:**
- Create: `src/modules/video-rooms/video-rooms-gift.integration.spec.ts`
- Create: `test/benchmarks/video-room-gift.bench.ts`

- [ ] **Step 1: Write the end-to-end integration test**

Following `video-rooms-chat.integration.spec.ts`:

```ts
it('single-receiver send: ledger → statistics → animation → delivered', async () => { /* … */ });

it('SEAT_ALL send debits once, credits N, writes N rows sharing a batchId', async () => { /* … */ });

it('rolls the whole batch back when one receiver leaves mid-send', async () => {
  // all-or-nothing (D3): no debit, no credit, no ledger row survives
});

it('an idempotent replay returns the original batch without re-charging', async () => { /* … */ });

it('concurrent identical idempotency keys produce exactly one batch', async () => { /* … */ });

it('a gift to a viewer is rejected when allowViewerGifts is off', async () => { /* … */ });

it('LUXURY enqueues at priority 1 ahead of a STANDARD gift', async () => { /* … */ });

it('combo started → updated → ended fires across the window', async () => { /* fake timers */ });
```

- [ ] **Step 2: Run the integration suite**

Run: `npx jest src/modules/video-rooms/video-rooms-gift.integration.spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 3: Performance validation (benchmark against real infra)**

⚠️ **This CANNOT be a Jest assertion in the integration suite.** Those tests mock
Prisma, Redis and BullMQ, so a `expect(elapsed).toBeLessThan(100)` would measure
mock-call overhead — it would pass at ~1 ms regardless of whether the real system
meets the target, i.e. it would be theatre, not verification. Worse, it would be
flaky on loaded CI. Latency targets require a benchmark against real PostgreSQL,
Redis and BullMQ.

Create `test/benchmarks/video-room-gift.bench.ts` — run **manually against a real
stack**, not part of `npx jest`:

```ts
/**
 * VR-10 performance validation. Requires real Postgres + Redis + BullMQ.
 * Run: npx ts-node test/benchmarks/video-room-gift.bench.ts
 * NOT part of the unit suite — mocked tests cannot measure latency.
 */
const TARGETS = {
  singleReceiverP95Ms: 100,
  multiReceiverP95Ms: 300,      // at VIDEO_ROOM_GIFT_MAX_RECEIVERS
  queueDeliveryP95Ms: 1_000,    // commit → giftAnimation broadcast
  replaySuccessRate: 0.999,
};

// 1. Warm up (200 sends), then measure 1 000 single-receiver sends → p50/p95/p99
// 2. Measure 500 SEAT_ALL sends at max receivers → p50/p95/p99
// 3. Measure commit-timestamp → animation-broadcast-timestamp delta
// 4. Dead-letter 1 000 jobs, replay all, assert success rate
// Print a table; exit non-zero if any p95 exceeds its target.
```

Record the measured p50/p95/p99 in spec §13, replacing the initial estimates.

**If a target is missed**, escalate rather than tuning silently — the two known
serialisation points are the per-room delivery lock and the sender's wallet row,
and relaxing either is an architectural decision, not an implementation detail.

- [ ] **Step 4: Re-run the complete BC gate** 🚦 **GATE G2**

Run: `npx jest src/modules/audio-rooms src/modules/gifts src/modules/treasure-boxes src/modules/exp src/modules/rankings src/modules/notification src/modules/analytics src/modules/social`
Expected: **PASS.** Confirm BC-1…BC-12 explicitly; any failure is an audio-room regression that **blocks release**.

- [ ] **Step 5: Full suite + static checks**

Run: `npx jest && npx tsc --noEmit`
Expected: all tests pass; typecheck clean.

Run: `npm run lint 2>&1 | tail -3`
Expected: problem count **≤ 192** (the measured pre-existing baseline). It should
land *below* 192, since editing `gift.service.ts` lets prettier fix ~62 of them.
An increase means this phase introduced lint debt — fix it in the files this
phase touched.

- [ ] **Step 6: Confirm the global constraints held** 🚦 **GATE G3**

Run: `git status --short`
Verify: no `prisma/schema/**` changes · no `prisma/migrations/**` additions · `src/infra/` shows only the 4 files from Task 6 · `src/common/exceptions/error-codes.ts` shows additions only (`git diff src/common/exceptions/error-codes.ts` must contain no `-` lines other than context).

**Do not commit.** Leave everything in the working tree.

- [ ] **Step 7: Update the module README**

Append a `## VR-10 — Virtual Gift Engine` section to `src/modules/video-rooms/README.md` covering the REST surface, socket events, Redis keys, the handler-registry seam and the "zero migrations" note, matching the VR-5 section's depth.

---

## Self-Review Notes

**Spec coverage:** §4.1 → T2 · §4.2 → T3, T4 · §4.3 → T5 · §4.4 → T9 · §4.5 → T10 · §4.6 → Global Constraints + enforced in T13 (explicit test) · §5.1 → T6 · §5.2–5.4 → T13, T15 · §5.5 → T17 · §6 → T11, T15 · §7 → T12, T17 · §8 → T7, T14 · §9 → T8, T16, T19 · §10 → T7, T20 · §11 → T7 · §12 → T1 (G1), T4, T22 (G2) · §13 → T22 Step 3 (benchmark, 4 validated targets) · §14 → every task.

**Known deviations from the skill template:** every task ends in a verification step rather than `git commit`, per the no-git global constraint.

**Carried risks:**
- Task 5 Step 1 flags that the single-receiver *credit* key shape changes. Safe only because `AUDIO_ROOM` economics are 0 bps (no `gift-credit:*` row is written for audio). **Verify against production before release**; if legacy rows exist, keep the un-suffixed key when `receiverIds.length === 1`.
- Task 7 Step 6 flags `z.coerce.boolean()` coercing `"false"` → `true`. Copy the project's existing boolean-env idiom and assert it in a test.
