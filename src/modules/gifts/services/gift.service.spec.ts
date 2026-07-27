import { GiftCategory, GiftContextType, GiftType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { QueueService } from 'src/infra/queue/queue.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { IAudioRoomsService } from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { ITreasureBoxesService } from 'src/modules/treasure-boxes/interfaces/treasure-boxes.service.interface';
import type { IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { SendGiftDto } from '../dto/gift.dto';
import { AudioRoomGiftContextHandler } from 'src/modules/audio-rooms/services/audio-room-gift-context.handler';
import { GiftRepository } from '../repositories/gift.repository';
import { GiftCatalogService } from './gift-catalog.service';
import { GiftContextRegistry } from './gift-context.registry';
import { GiftLeaderboardService } from './gift-leaderboard.service';
import { GiftService } from './gift.service';

const SENDER: RoomActor = { id: 'sender-1', roles: ['USER'] };
const ROOM = 'room-1';
const RECEIVER = 'receiver-1';

const GIFT_CFG = {
  creatorEarningRatePercent: 30,
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
    ...overrides,
  } as SendGiftDto;
}

describe('GiftService', () => {
  let repo: Record<string, jest.Mock>;
  let catalog: { getGift: jest.Mock; getGiftById: jest.Mock };
  let leaderboards: { record: jest.Mock };
  let config: { get: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let wallet: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let vip: Record<string, jest.Mock>;
  let prisma: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let treasure: Record<string, jest.Mock>;
  let registry: GiftContextRegistry;
  let service: GiftService;

  beforeEach(() => {
    repo = {
      findTxnByIdempotencyKey: jest.fn().mockResolvedValue(null),
      hitRateLimit: jest.fn().mockResolvedValue(false),
      comboTick: jest.fn().mockResolvedValue(1),
      createTransaction: jest.fn().mockImplementation((d) =>
        Promise.resolve({
          id: 'gtxn-1',
          status: 'COMPLETED',
          ...d,
          totalCoinValue: d.totalCoinValue,
          creatorEarnings: d.creatorEarnings,
          createdAt: new Date(),
        }),
      ),
      listTransactions: jest.fn().mockResolvedValue([[], 0]),
    };
    catalog = {
      getGift: jest.fn().mockResolvedValue(gift()),
      getGiftById: jest.fn().mockResolvedValue(gift()),
    };
    leaderboards = { record: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn().mockReturnValue(GIFT_CFG) };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    wallet = {
      debit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w-debit', balanceAfter: 900, duplicate: false }),
      credit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w-credit', balanceAfter: 30, duplicate: false }),
    };
    rooms = {
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(true),
      getOwnerId: jest.fn().mockResolvedValue('owner-id'),
    };
    users = { findById: jest.fn().mockResolvedValue({ id: RECEIVER, username: 'bob' }) };
    vip = { getLevelOrdinal: jest.fn().mockResolvedValue(0) };
    prisma = {
      $transaction: jest.fn().mockImplementation((cb) => cb(prisma)),
    };
    // Models the real Redis lock faithfully: it is NON-REENTRANT. A passthrough
    // `(key, cb) => cb()` mock hid a production deadlock — a self-gift put the
    // sender's wallet key into the lock list twice, `withLocks` nested it inside
    // itself, and the inner acquire spun out its retry budget (~2.1s) and threw.
    // Throwing here on a re-entrant acquire keeps that class of bug testable.
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
    treasure = {
      processTreasureContribution: jest
        .fn()
        .mockImplementation((tx, roomId, senderId, receiverId, amount) =>
          Promise.resolve({
            acceptedAmount: amount,
            refundAmount: 0,
            events: [],
            postCommit: undefined,
          }),
        ),
    };

    // VR-10: AUDIO_ROOM validation/economics/treasure now live in the handler,
    // registered on the shared registry rather than injected into GiftService.
    registry = new GiftContextRegistry();
    new AudioRoomGiftContextHandler(
      rooms as unknown as IAudioRoomsService,
      users as unknown as IUsersService,
      registry,
      wallet as unknown as IWalletService,
      treasure as unknown as ITreasureBoxesService,
    ).onModuleInit();

    service = new GiftService(
      repo as unknown as GiftRepository,
      catalog as unknown as GiftCatalogService,
      leaderboards as unknown as GiftLeaderboardService,
      config as unknown as ConfigService,
      queue as unknown as QueueService,
      prisma as unknown as PrismaService,
      locks as unknown as LockService,
      bus,
      wallet as unknown as IWalletService,
      vip as unknown as IVipService,
      registry,
    );
  });

  describe('sendGift', () => {
    it('debits sender 100% GOLD and credits receiver 100% EARNINGS on gift send', async () => {
      const res = await service.sendGift(SENDER, dto());
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: SENDER.id, currency: 'GOLD', amount: 100 }),
        expect.anything(),
      );
      // Universal Settlement Engine: Receiver EARNINGS credited 100% (100 coins)
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: RECEIVER, currency: 'EARNINGS', amount: 100 }),
        expect.anything(),
      );
      // Because 100 <= 1000, Receiver Available Balance (GOLD) is NOT updated.
      expect(wallet.credit).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: RECEIVER, currency: 'GOLD' }),
        expect.anything(),
      );
      expect(repo.createTransaction).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'gift.sent' }));
      expect(res.id).toBe('gtxn-1');
    });

    it('credits receiver 10% Available Balance (GOLD) when gift value > 1000', async () => {
      catalog.getGiftById.mockResolvedValue(gift({ coinValue: 15000 }));
      await service.sendGift(SENDER, dto());

      // Sender debited 15,000 GOLD
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: SENDER.id, currency: 'GOLD', amount: 15000 }),
        expect.anything(),
      );

      // Receiver EARNINGS credited 15,000 (100%)
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: RECEIVER, currency: 'EARNINGS', amount: 15000 }),
        expect.anything(),
      );

      // Receiver Available Balance (GOLD) credited 1,500 (10%)
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: RECEIVER, currency: 'GOLD', amount: 1500 }),
        expect.anything(),
      );
    });

    it('allows gifting yourself', async () => {
      const res = await service.sendGift(SENDER, dto({ receiverId: SENDER.id }));
      expect(res.id).toBe('gtxn-1');
    });

    it('takes the sender wallet lock ONCE on a self-gift instead of deadlocking on itself', async () => {
      await service.sendGift(SENDER, dto({ receiverId: SENDER.id }));

      const senderLockAcquisitions = locks.withLock.mock.calls
        .map((call: unknown[]) => call[0] as string)
        .filter((key: string) => key.includes(SENDER.id));

      // Sender and receiver are the same wallet — locking it twice, nested, can
      // never succeed against a non-reentrant lock.
      expect(senderLockAcquisitions).toHaveLength(1);
    });

    it('runs a self-gift through the identical pipeline: one debit, ledger row, broadcast', async () => {
      await service.sendGift(SENDER, dto({ receiverId: SENDER.id }));

      // Charged exactly once, for the full amount — sender === receiver must not
      // net the debit out, skip it, or double it.
      expect(wallet.debit).toHaveBeenCalledTimes(1);
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: SENDER.id, currency: 'GOLD', amount: 100 }),
        expect.anything(),
      );

      // An immutable ledger row exists with both sides set to the same user, so
      // the send shows up in gift history, wallet history and audit.
      expect(repo.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: SENDER.id, receiverId: SENDER.id }),
        expect.anything(),
      );

      // Broadcast to the room like any other gift — clients animate off this.
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'gift.sent',
          payload: expect.objectContaining({ senderId: SENDER.id, receiverId: SENDER.id }),
        }),
      );
    });

    it('feeds a self-gift into the treasure box and still pays the host their 10%', async () => {
      await service.sendGift(SENDER, dto({ receiverId: SENDER.id }));

      expect(treasure.processTreasureContribution).toHaveBeenCalledTimes(1);
      expect(treasure.processTreasureContribution).toHaveBeenCalledWith(
        expect.anything(),
        ROOM,
        SENDER.id,
        SENDER.id,
        100,
        expect.any(String),
      );
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'owner-id', currency: 'GOLD', amount: 10 }),
        expect.anything(),
      );
    });

    it('records a self-gift on the leaderboards and enqueues ranking + analytics', async () => {
      await service.sendGift(SENDER, dto({ receiverId: SENDER.id }));

      expect(leaderboards.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contextId: ROOM,
          senderId: SENDER.id,
          receiverId: SENDER.id,
          giftValue: 100,
        }),
      );
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        'gift.ranking',
        expect.objectContaining({ contextId: ROOM }),
      );
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        'gift.sent',
        expect.objectContaining({ transactionId: expect.any(String) }),
      );
    });

    it('replays a self-gift idempotently instead of charging twice', async () => {
      const first = await service.sendGift(
        SENDER,
        dto({ receiverId: SENDER.id, idempotencyKey: 'self-idem-1' }),
      );
      repo.findTxnByIdempotencyKey.mockResolvedValue(first);

      const replay = await service.sendGift(
        SENDER,
        dto({ receiverId: SENDER.id, idempotencyKey: 'self-idem-1' }),
      );

      expect(replay.id).toBe(first.id);
      expect(wallet.debit).toHaveBeenCalledTimes(1);
    });

    it('rejects a missing gift', async () => {
      catalog.getGiftById.mockResolvedValue(null);
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_NOT_FOUND',
      });
    });

    it('rejects a disabled gift', async () => {
      catalog.getGiftById.mockResolvedValue(gift({ enabled: false }));
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_DISABLED',
      });
    });

    it('rejects a VIP-exclusive gift below the required tier', async () => {
      catalog.getGiftById.mockResolvedValue(gift({ minVipLevel: 3 }));
      vip.getLevelOrdinal.mockResolvedValue(1);
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_VIP_RESTRICTED',
      });
      expect(wallet.debit).not.toHaveBeenCalled();
    });

    it('allows a VIP-exclusive gift when the sender meets the tier', async () => {
      catalog.getGiftById.mockResolvedValue(gift({ minVipLevel: 3 }));
      vip.getLevelOrdinal.mockResolvedValue(5);
      await service.sendGift(SENDER, dto());
      expect(wallet.debit).toHaveBeenCalled();
    });

    it('is idempotent — a prior send with the same key returns the original', async () => {
      repo.findTxnByIdempotencyKey.mockResolvedValue({ id: 'gtxn-prior' });
      const res = await service.sendGift(SENDER, dto({ idempotencyKey: 'idempotent-key' }));
      expect(res.id).toBe('gtxn-prior');
      expect(wallet.debit).not.toHaveBeenCalled();
    });

    it('rejects when the receiver is not in the room', async () => {
      rooms.isMember.mockResolvedValue(false);
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_RECEIVER_INVALID',
      });
    });

    it('enforces the send rate limit', async () => {
      repo.hitRateLimit.mockResolvedValue(true);
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_RATE_LIMITED',
      });
    });

    it('supports private chat and other contexts via default fallback handler', async () => {
      const res = await service.sendGift(SENDER, dto({ contextType: 'PRIVATE_CHAT' as any }));
      expect(res.id).toBe('gtxn-1');
    });

    it('propagates INSUFFICIENT_BALANCE and does not persist', async () => {
      wallet.debit.mockRejectedValue(
        new BusinessException('INSUFFICIENT_BALANCE' as never, 'no', 409),
      );
      await expect(service.sendGift(SENDER, dto())).rejects.toBeInstanceOf(BusinessException);
      expect(repo.createTransaction).not.toHaveBeenCalled();
    });

    it('multiplies value by quantity', async () => {
      await service.sendGift(SENDER, dto({ quantity: 3 }));
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 300 }),
        expect.anything(),
      );
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'owner-id', currency: 'GOLD', amount: 30 }),
        expect.anything(),
      );
    });

    it('applies combo tier for combo-enabled gifts and emits a combo event', async () => {
      catalog.getGiftById.mockResolvedValue(gift({ comboEnabled: true }));
      repo.comboTick.mockResolvedValue(3);
      await service.sendGift(SENDER, dto());
      expect(repo.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ comboTier: 3 }),
        expect.anything(),
      );
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'gift.combo' }));
    });

    it('rolls back the transaction when the ledger write fails', async () => {
      repo.createTransaction.mockRejectedValue(new Error('db down'));
      await expect(service.sendGift(SENDER, dto())).rejects.toThrow('db down');
      expect(wallet.credit).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: SENDER.id, reason: 'GIFT_REFUND' }),
      );
    });
  });
});
