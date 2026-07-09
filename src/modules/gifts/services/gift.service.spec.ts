import { GiftCategory, GiftContextType, GiftType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { QueueService } from 'src/infra/queue/queue.service';
import type { IAudioRoomsService } from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { SendGiftDto } from '../dto/gift.dto';
import { GiftRepository } from '../repositories/gift.repository';
import { GiftCatalogService } from './gift-catalog.service';
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
    category: GiftCategory.STANDARD,
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
  let catalog: { getGift: jest.Mock };
  let leaderboards: { record: jest.Mock };
  let config: { get: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let wallet: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let vip: Record<string, jest.Mock>;
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
    catalog = { getGift: jest.fn().mockResolvedValue(gift()) };
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
    };
    users = { findById: jest.fn().mockResolvedValue({ id: RECEIVER, username: 'bob' }) };
    vip = { getLevelOrdinal: jest.fn().mockResolvedValue(0) };

    service = new GiftService(
      repo as unknown as GiftRepository,
      catalog as unknown as GiftCatalogService,
      leaderboards as unknown as GiftLeaderboardService,
      config as unknown as ConfigService,
      queue as unknown as QueueService,
      bus,
      wallet as unknown as IWalletService,
      rooms as unknown as IAudioRoomsService,
      users as unknown as IUsersService,
      vip as unknown as IVipService,
    );
  });

  describe('sendGift', () => {
    it('debits sender, credits receiver earnings, persists, and broadcasts', async () => {
      const res = await service.sendGift(SENDER, dto());
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: SENDER.id, currency: 'GOLD', amount: 100 }),
      );
      // 30% creator earnings of 100 = 30
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: RECEIVER, currency: 'EARNINGS', amount: 30 }),
      );
      expect(repo.createTransaction).toHaveBeenCalled();
      expect(leaderboards.record).toHaveBeenCalledWith(
        expect.objectContaining({ giftValue: 100, receiverEarnings: 30 }),
      );
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'gift.sent' }));
      expect(res.id).toBe('gtxn-1');
    });

    it('rejects gifting yourself', async () => {
      await expect(service.sendGift(SENDER, dto({ receiverId: SENDER.id }))).rejects.toMatchObject({
        errorCode: 'CANNOT_GIFT_SELF',
      });
    });

    it('rejects a missing gift', async () => {
      catalog.getGift.mockResolvedValue(null);
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_NOT_FOUND',
      });
    });

    it('rejects a disabled gift', async () => {
      catalog.getGift.mockResolvedValue(gift({ enabled: false }));
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_DISABLED',
      });
    });

    it('rejects a VIP-exclusive gift below the required tier', async () => {
      catalog.getGift.mockResolvedValue(gift({ minVipLevel: 3 }));
      vip.getLevelOrdinal.mockResolvedValue(1);
      await expect(service.sendGift(SENDER, dto())).rejects.toMatchObject({
        errorCode: 'GIFT_VIP_RESTRICTED',
      });
      expect(wallet.debit).not.toHaveBeenCalled();
    });

    it('allows a VIP-exclusive gift when the sender meets the tier', async () => {
      catalog.getGift.mockResolvedValue(gift({ minVipLevel: 3 }));
      vip.getLevelOrdinal.mockResolvedValue(5);
      await service.sendGift(SENDER, dto());
      expect(wallet.debit).toHaveBeenCalled();
    });

    it('is idempotent — a prior send with the same key returns the original', async () => {
      repo.findTxnByIdempotencyKey.mockResolvedValue({ id: 'existing' });
      const res = await service.sendGift(SENDER, dto({ idempotencyKey: 'k1' }));
      expect(res).toMatchObject({ id: 'existing' });
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

    it('rejects an unsupported (non audio-room) context', async () => {
      await expect(
        service.sendGift(SENDER, dto({ contextType: GiftContextType.LIVE_STREAM })),
      ).rejects.toMatchObject({ errorCode: 'GIFT_CONTEXT_INVALID' });
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
      expect(wallet.debit).toHaveBeenCalledWith(expect.objectContaining({ amount: 300 }));
      expect(wallet.credit).toHaveBeenCalledWith(expect.objectContaining({ amount: 90 }));
    });

    it('applies combo tier for combo-enabled gifts and emits a combo event', async () => {
      catalog.getGift.mockResolvedValue(gift({ comboEnabled: true }));
      repo.comboTick.mockResolvedValue(3);
      await service.sendGift(SENDER, dto());
      expect(repo.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ comboTier: 3 }),
      );
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'gift.combo' }));
    });

    it('compensates the debit when the ledger write fails', async () => {
      repo.createTransaction.mockRejectedValue(new Error('db down'));
      await expect(service.sendGift(SENDER, dto())).rejects.toBeDefined();
      // sender refunded gold, receiver earnings reversed
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: SENDER.id, reason: 'GIFT_REFUND' }),
      );
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: RECEIVER, reason: 'GIFT_REFUND' }),
      );
    });
  });
});
