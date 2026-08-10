import { ConfigService } from '@nestjs/config';
import {
  GiftCategory,
  GiftContextType,
  GiftType,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { IAudioRoomsService } from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { ITreasureBoxesService } from 'src/modules/treasure-boxes/interfaces/treasure-boxes.service.interface';
import type { SendGiftDto } from 'src/modules/gifts/dto/gift.dto';
import { GiftRepository } from 'src/modules/gifts/repositories/gift.repository';
import { GiftCatalogService } from 'src/modules/gifts/services/gift-catalog.service';
import { GiftContextRegistry } from 'src/modules/gifts/services/gift-context.registry';
import { GiftLeaderboardService } from 'src/modules/gifts/services/gift-leaderboard.service';
import { GiftService } from 'src/modules/gifts/services/gift.service';
import { AudioRoomGiftContextHandler } from './audio-room-gift-context.handler';

/**
 * VR-10 BACKWARD-COMPATIBILITY GATE (BC-1 … BC-12).
 *
 * Captures the audio-room gift behaviour that existed BEFORE the VR-10 handler
 * extraction, so the refactor can be proven behaviourally identical.
 *
 * !! If an assertion in this file fails, audio-room gifting has REGRESSED. !!
 * Fix the production code — never "update the baseline". The only part of this
 * file the refactor may edit is `buildGiftService()`, which wires the
 * constructor; every expectation below must survive untouched.
 */

const SENDER: RoomActor = { id: 'sender-1', roles: ['USER'] };
const ROOM = 'room-1';
const RECEIVER = 'receiver-1';
const HOST = 'owner-id';
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
    name: 'Rose',
    category: GiftCategory.CLASSIC,
    type: GiftType.STATIC,
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

function dto(overrides: Partial<SendGiftDto> = {}): SendGiftDto {
  return {
    giftId: 'gift-1',
    receiverId: RECEIVER,
    contextType: GiftContextType.AUDIO_ROOM,
    contextId: ROOM,
    quantity: 1,
    idempotencyKey: IDEM,
    ...overrides,
  } as SendGiftDto;
}

/** Collaborator mocks, rebuilt per test. */
interface Mocks {
  repo: Record<string, jest.Mock>;
  catalog: { getGiftById: jest.Mock; getGift: jest.Mock };
  leaderboards: { record: jest.Mock };
  config: { get: jest.Mock };
  queue: { enqueue: jest.Mock };
  bus: jest.Mocked<IEventBus>;
  wallet: Record<string, jest.Mock>;
  rooms: Record<string, jest.Mock>;
  users: Record<string, jest.Mock>;
  vip: Record<string, jest.Mock>;
  prisma: Record<string, jest.Mock>;
  locks: Record<string, jest.Mock>;
  treasure: Record<string, jest.Mock>;
}

function buildMocks(): Mocks {
  const prisma: Record<string, jest.Mock> = {};
  prisma.$transaction = jest.fn().mockImplementation((cb) => cb(prisma));
  return {
    repo: {
      findTxnByIdempotencyKey: jest.fn().mockResolvedValue(null),
      hitRateLimit: jest.fn().mockResolvedValue(false),
      comboTick: jest.fn().mockResolvedValue(1),
      createTransaction: jest.fn().mockImplementation((d) =>
        Promise.resolve({
          id: 'gtxn-1',
          status: 'COMPLETED',
          ...d,
          totalCoinValue: d.totalCoinValue?.toString() ?? '100',
          creatorEarnings: d.creatorEarnings?.toString() ?? '100',
          createdAt: new Date(),
        }),
      ),
      listTransactions: jest.fn().mockResolvedValue([[], 0]),
    },
    catalog: {
      getGiftById: jest.fn().mockResolvedValue(gift()),
      getGift: jest.fn().mockResolvedValue(gift()),
    },
    leaderboards: { record: jest.fn().mockResolvedValue(undefined) },
    config: { get: jest.fn().mockReturnValue(GIFT_CFG) },
    queue: { enqueue: jest.fn().mockResolvedValue(undefined) },
    bus: { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as never,
    wallet: {
      debit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w-debit', balanceAfter: 900, duplicate: false }),
      credit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w-credit', balanceAfter: 30, duplicate: false }),
    },
    rooms: {
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(true),
      getOwnerId: jest.fn().mockResolvedValue(HOST),
    },
    users: { findById: jest.fn().mockResolvedValue({ id: RECEIVER, username: 'bob' }) },
    vip: { getLevelOrdinal: jest.fn().mockResolvedValue(0) },
    prisma,
    locks: { withLock: jest.fn().mockImplementation((_key, cb) => cb()) },
    treasure: {
      processTreasureContribution: jest
        .fn()
        .mockImplementation((_tx, _roomId, _senderId, _receiverId, amount) =>
          Promise.resolve({
            acceptedAmount: amount,
            refundAmount: 0,
            events: [],
            boxId: null,
            level: null,
            postCommit: undefined,
          }),
        ),
    },
  };
}

/**
 * Wires GiftService with the mocks. THE ONLY PART VR-10 MAY EDIT — when the
 * constructor arity changes, update the wiring here and nothing else.
 */
function buildGiftService(m: Mocks): GiftService {
  // VR-10: the AUDIO_ROOM behaviour now lives in a handler registered on the
  // shared registry, so the baseline drives the full extracted path end to end.
  const registry = new GiftContextRegistry();
  const audioHandler = new AudioRoomGiftContextHandler(
    m.rooms as unknown as IAudioRoomsService,
    m.users as unknown as IUsersService,
    registry,
    m.wallet as unknown as IWalletService,
    m.treasure as unknown as ITreasureBoxesService,
  );
  audioHandler.onModuleInit();

  return new GiftService(
    m.repo as unknown as GiftRepository,
    m.catalog as unknown as GiftCatalogService,
    m.leaderboards as unknown as GiftLeaderboardService,
    m.config as unknown as ConfigService,
    m.queue as unknown as QueueService,
    m.prisma as unknown as PrismaService,
    m.locks as unknown as LockService,
    m.bus,
    m.wallet as unknown as IWalletService,
    m.vip as unknown as IVipService,
    registry,
    { get: jest.fn().mockResolvedValue(null) },
  );
}

describe('AUDIO_ROOM gift baseline (VR-10 BC gate)', () => {
  let m: Mocks;
  let service: GiftService;

  beforeEach(() => {
    m = buildMocks();
    service = buildGiftService(m);
  });

  it('BC-1/BC-2: debits the sender GOLD via gift-debit:{key}', async () => {
    await service.sendGift(SENDER, dto());
    expect(m.wallet.debit).toHaveBeenCalledTimes(1);
    expect(m.wallet.debit.mock.calls[0][0]).toMatchObject({
      userId: SENDER.id,
      currency: WalletCurrency.GOLD,
      amount: 100,
      reason: WalletTxnReason.GIFT_SEND,
      idempotencyKey: `gift-debit:${IDEM}`,
      referenceType: 'gift',
      actorId: SENDER.id,
    });
  });

  it('BC-3: routes the full amount through the treasure box', async () => {
    await service.sendGift(SENDER, dto());
    expect(m.treasure.processTreasureContribution).toHaveBeenCalledTimes(1);
    const [, roomId, senderId, receiverId, amount] =
      m.treasure.processTreasureContribution.mock.calls[0];
    expect({ roomId, senderId, receiverId, amount }).toEqual({
      roomId: ROOM,
      senderId: SENDER.id,
      receiverId: RECEIVER,
      amount: 100,
    });
  });

  it('BC-4: credits the host 10% of the accepted amount via gift-host-reward:{key}', async () => {
    await service.sendGift(SENDER, dto());
    expect(m.wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: HOST,
        currency: WalletCurrency.GOLD,
        amount: 10,
        reason: WalletTxnReason.TREASURE_BOX,
        idempotencyKey: `gift-host-reward:${IDEM}`,
        referenceType: 'gift',
      }),
      expect.anything(),
    );
  });

  it('BC-5: refunds excess coins to the sender via gift-refund:{key}', async () => {
    m.treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 60,
      refundAmount: 40,
      events: [],
      boxId: 'box-1',
      level: 2,
      postCommit: undefined,
    });
    await service.sendGift(SENDER, dto());
    expect(m.wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SENDER.id,
        currency: WalletCurrency.GOLD,
        amount: 40,
        reason: WalletTxnReason.GIFT_REFUND,
        idempotencyKey: `gift-refund:${IDEM}`,
      }),
      expect.anything(),
    );
    const names = m.bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain('gift.refunded');
  });

  it('writes creatorEarnings = 100n and credits 100% DIAMOND to receiver', async () => {
    await service.sendGift(SENDER, dto());
    expect(m.repo.createTransaction.mock.calls[0][0].creatorEarnings).toBe(100n);
    const earningsCredits = m.wallet.credit.mock.calls.filter(
      (c) => c[0].currency === WalletCurrency.DIAMOND,
    );
    expect(earningsCredits).toHaveLength(1);
    expect(earningsCredits[0][0].amount).toBe(100);
  });

  it('persists the ledger row with the audio-room shape', async () => {
    await service.sendGift(SENDER, dto());
    expect(m.repo.createTransaction.mock.calls[0][0]).toMatchObject({
      senderId: SENDER.id,
      receiverId: RECEIVER,
      giftId: 'gift-1',
      contextType: GiftContextType.AUDIO_ROOM,
      contextId: ROOM,
      quantity: 1,
      comboTier: 1,
      unitCoinValue: 100,
      totalCoinValue: 100n,
      creatorEarnings: 100n,
      luckyMultiplier: 1,
      isLuckyWin: false,
      idempotencyKey: IDEM,
      senderWalletTxnId: 'w-debit',
    });
  });

  it('BC-7: publishes gift.sent exactly once', async () => {
    await service.sendGift(SENDER, dto());
    const names = m.bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names.filter((n) => n === 'gift.sent')).toHaveLength(1);
  });

  it('records the leaderboard with receiver earnings', async () => {
    await service.sendGift(SENDER, dto());
    expect(m.leaderboards.record).toHaveBeenCalledWith(
      expect.objectContaining({ giftValue: 100, receiverEarnings: 100 }),
    );
  });

  it('BC-8: enqueues the four known jobs, in order', async () => {
    await service.sendGift(SENDER, dto());
    const jobs = m.queue.enqueue.mock.calls.map((c) => `${c[0]}:${c[1]}`);
    expect(jobs).toEqual([
      'gift-processing:gift.sent',
      'notifications:gift.received',
      'ranking-processing:gift.ranking',
      'analytics-processing:gift.sent',
    ]);
  });

  it('BC-11: an idempotent replay returns the original row without re-charging', async () => {
    m.repo.findTxnByIdempotencyKey.mockResolvedValue({ id: 'prior', idempotencyKey: IDEM });
    const res = await service.sendGift(SENDER, dto());
    expect(res).toMatchObject({ id: 'prior' });
    expect(m.wallet.debit).not.toHaveBeenCalled();
  });

  it('BC-11: rate limiting rejects before any money moves', async () => {
    m.repo.hitRateLimit.mockResolvedValue(true);
    await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
      errorCode: 'GIFT_RATE_LIMITED',
    });
    expect(m.wallet.debit).not.toHaveBeenCalled();
  });

  it('BC-11: a non-live room is rejected before any money moves', async () => {
    m.rooms.isRoomLive.mockResolvedValue(false);
    await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
      errorCode: 'GIFT_CONTEXT_INVALID',
    });
    expect(m.wallet.debit).not.toHaveBeenCalled();
  });

  it('BC-11: a receiver outside the room is rejected before any money moves', async () => {
    m.rooms.isMember.mockResolvedValue(false);
    await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
      errorCode: 'GIFT_RECEIVER_INVALID',
    });
    expect(m.wallet.debit).not.toHaveBeenCalled();
  });

  it('BC-10: returns the persisted transaction to the caller', async () => {
    const res = await service.sendGift(SENDER, dto());
    expect(res).toMatchObject({ id: 'gtxn-1', status: 'COMPLETED' });
  });
});
