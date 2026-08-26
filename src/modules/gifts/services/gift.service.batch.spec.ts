import { ConfigService } from '@nestjs/config';
import { GiftCategory, GiftContextType, GiftType, WalletCurrency } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { IWealthService } from 'src/modules/wealth/interfaces/wealth.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { GiftRepository } from '../repositories/gift.repository';
import { GiftCatalogService } from './gift-catalog.service';
import { GiftContextRegistry } from './gift-context.registry';
import { GiftLeaderboardService } from './gift-leaderboard.service';
import { GiftService } from './gift.service';

/**
 * VR-10 multi-receiver send. The critical assertions here are the PER-LEG
 * wallet idempotency keys: a batch that reused one key across N receivers would
 * collapse N credits into one — receiver #1 paid, #2..N silently unpaid, sender
 * charged for all N. That bug is invisible until someone gifts a full stage.
 */

const SENDER: RoomActor = { id: 'sender-1', roles: ['USER'] };
const ROOM = 'video-room-1';
const IDEM = 'idem-1';

const GIFT_CFG = {
  senderExpPerCoin: 1,
  receiverExpPerCoin: 1,
  rateMax: 20,
  rateWindowSeconds: 10,
};

function gift(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gift-1',
    name: 'Rocket',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 100,
    thumbnailUrl: null,
    animationUrl: null,
    soundUrl: null,
    minVipLevel: 0,
    comboEnabled: false,
    comboWindowSeconds: 10,
    luckyMultipliers: [],
    luckyWinChanceBp: 0,
    festivalTag: null,
    enabled: true,
    sortOrder: 0,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A VIDEO_ROOM handler stub: 30% creator earnings, many receivers, no onSend. */
function videoHandler(maxReceivers = 9) {
  return {
    contextType: GiftContextType.VIDEO_ROOM,
    maxReceivers,
    validate: jest.fn().mockResolvedValue(undefined),
    economics: jest.fn().mockReturnValue({ receiverEarningsBps: 3000 }),
  };
}

describe('GiftService.sendGiftBatch (multi-receiver)', () => {
  let repo: Record<string, jest.Mock>;
  let wallet: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let registry: GiftContextRegistry;
  let handler: ReturnType<typeof videoHandler>;
  let service: GiftService;

  const batchDto = (receiverIds: string[], overrides: Record<string, unknown> = {}) =>
    ({
      giftId: 'gift-1',
      receiverIds,
      contextType: GiftContextType.VIDEO_ROOM,
      contextId: ROOM,
      quantity: 1,
      idempotencyKey: IDEM,
      ...overrides,
    }) as never;

  beforeEach(() => {
    const prisma: Record<string, jest.Mock> = {};
    prisma.$transaction = jest.fn().mockImplementation((cb) => cb(prisma));
    repo = {
      findTxnByIdempotencyKey: jest.fn().mockResolvedValue(null),
      hitRateLimit: jest.fn().mockResolvedValue(false),
      comboTick: jest.fn().mockResolvedValue(1),
      createTransaction: jest.fn().mockImplementation((d) =>
        Promise.resolve({
          id: `gtxn-${d.receiverId}`,
          status: 'COMPLETED',
          ...d,
          createdAt: new Date(),
        }),
      ),
    };
    wallet = {
      debit: jest.fn().mockResolvedValue({ transactionId: 'w-debit', duplicate: false }),
      credit: jest.fn().mockResolvedValue({ transactionId: 'w-credit', duplicate: false }),
    };
    // Non-reentrant, like the real Redis lock — a passthrough mock once let a
    // self-gift nest the sender's wallet key inside itself all the way to prod.
    const heldLocks = new Set<string>();
    locks = {
      withLock: jest.fn().mockImplementation(async (key: string, cb: () => Promise<unknown>) => {
        if (heldLocks.has(key)) {
          throw new Error(`Could not acquire lock "${key}" after 20 retries`);
        }
        heldLocks.add(key);
        try {
          return await cb();
        } finally {
          heldLocks.delete(key);
        }
      }),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as never;
    registry = new GiftContextRegistry();
    handler = videoHandler();
    registry.register(handler as never);

    service = new GiftService(
      repo as unknown as GiftRepository,
      {
        getGift: jest.fn().mockResolvedValue(gift()),
        getGiftById: jest.fn().mockResolvedValue(gift()),
      } as unknown as GiftCatalogService,
      { record: jest.fn() } as unknown as GiftLeaderboardService,
      { get: jest.fn().mockReturnValue(GIFT_CFG) } as unknown as ConfigService,
      { enqueue: jest.fn() } as unknown as QueueService,
      prisma as unknown as PrismaService,
      locks as unknown as LockService,
      {
        resolve: jest
          .fn()
          .mockImplementation((k: string) => Promise.resolve(`https://cdn.example.com/${k}`)),
      } as never,
      bus,
      wallet as unknown as IWalletService,
      { getEffectiveLevel: jest.fn().mockResolvedValue(0) } as unknown as IWealthService,
      registry,
      { get: jest.fn().mockResolvedValue(null) },
    );
  });

  it('charges unit x quantity x N in exactly ONE debit', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2', 'r3']));
    expect(wallet.debit).toHaveBeenCalledTimes(1);
    expect(wallet.debit.mock.calls[0][0].amount).toBe(300);
  });

  it('credits N wallets with PER-LEG idempotency keys (double-credit guard)', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2', 'r3']));
    const keys = wallet.credit.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([
      `gift-credit-earnings:${IDEM}:r1`,
      `gift-credit-earnings:${IDEM}:r2`,
      `gift-credit-earnings:${IDEM}:r3`,
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  it('credits each receiver 100% of THEIR gift in EARNINGS', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2', 'r3']));
    const amounts = wallet.credit.mock.calls.map((c) => c[0].amount);
    expect(amounts).toEqual([100, 100, 100]);
    expect(wallet.credit.mock.calls[0][0].currency).toBe(WalletCurrency.DIAMOND);
  });

  it('writes N ledger rows sharing one batchId, with per-leg ledger keys', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2']));
    const rows = repo.createTransaction.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata.batchId).toBe(rows[1].metadata.batchId);
    expect(rows.map((r) => r.idempotencyKey)).toEqual([`${IDEM}:r1`, `${IDEM}:r2`]);
    expect(rows.map((r) => r.totalCoinValue)).toEqual([100n, 100n]);
  });

  it('acquires wallet locks for sender AND every receiver, sorted', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['zzz', 'aaa']));
    const keys = locks.withLock.mock.calls.map((c) => c[0]);
    expect(keys).toHaveLength(3);
    expect(keys).toEqual([...keys].sort());
  });

  it('de-duplicates repeated receiver ids', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2', 'r1']));
    expect(repo.createTransaction).toHaveBeenCalledTimes(2);
    expect(wallet.debit.mock.calls[0][0].amount).toBe(200);
  });

  it('rejects a batch that exceeds the handler maxReceivers', async () => {
    registry = new GiftContextRegistry();
    registry.register(videoHandler(2) as never);
    (service as unknown as { registry: GiftContextRegistry }).registry = registry;
    await expect(service.sendGiftBatch(SENDER, batchDto(['a', 'b', 'c']))).rejects.toMatchObject({
      errorCode: 'GIFT_TOO_MANY_RECEIVERS',
    });
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('allows a batch containing the sender', async () => {
    const res = await service.sendGiftBatch(SENDER, batchDto(['r1', SENDER.id]));
    expect(res).toHaveLength(2);
  });

  it('rate-limits ONCE per API call, not once per receiver', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2', 'r3']));
    expect(repo.hitRateLimit).toHaveBeenCalledTimes(1);
  });

  it('publishes one gift.sent per receiver leg', async () => {
    await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2']));
    const sent = bus.publish.mock.calls
      .map((c) => c[0] as { name: string })
      .filter((e) => e.name === 'gift.sent');
    expect(sent).toHaveLength(2);
  });

  it('returns all rows to the caller', async () => {
    const rows = await service.sendGiftBatch(SENDER, batchDto(['r1', 'r2']));
    expect(rows.map((r) => r.receiverId)).toEqual(['r1', 'r2']);
  });

  describe('single-receiver compatibility', () => {
    it('sendGift delegates to the batch and returns one row', async () => {
      const res = await service.sendGift(SENDER, {
        giftId: 'gift-1',
        receiverId: 'r1',
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: ROOM,
        quantity: 1,
        idempotencyKey: IDEM,
      } as never);
      expect(res.receiverId).toBe('r1');
      expect(repo.createTransaction).toHaveBeenCalledTimes(1);
    });

    it('a single receiver keeps the UNSUFFIXED ledger idempotency key', async () => {
      await service.sendGiftBatch(SENDER, batchDto(['r1']));
      expect(repo.createTransaction.mock.calls[0][0].idempotencyKey).toBe(IDEM);
    });
  });
});
