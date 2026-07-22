import { WalletCurrency } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomGiftReversalService } from './video-room-gift-reversal.service';

const ROOM = 'r1';
const ADMIN = 'admin-1';

const txn = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    senderId: 's1',
    receiverId: 'u1',
    giftId: 'g1',
    status: 'COMPLETED',
    totalCoinValue: 100n,
    creatorEarnings: 30n,
    metadata: { batchId: 'b1', giftName: 'Rocket' },
    ...overrides,
  }) as never;

describe('VideoRoomGiftReversalService', () => {
  let repo: Record<string, jest.Mock>;
  let events: { appendEvent: jest.Mock };
  let prisma: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let wallet: Record<string, jest.Mock>;
  let service: VideoRoomGiftReversalService;

  beforeEach(() => {
    repo = {
      findRoomTransaction: jest.fn().mockResolvedValue(txn()),
      findBatch: jest.fn().mockResolvedValue([txn(), txn({ id: 't2', receiverId: 'u2' })]),
      markReversed: jest.fn().mockResolvedValue(true),
    };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    prisma = { $transaction: jest.fn().mockImplementation((cb) => cb(prisma)) };
    locks = { withLock: jest.fn().mockImplementation((_key, cb) => cb()) };
    wallet = {
      debit: jest.fn().mockResolvedValue({ transactionId: 'w1', duplicate: false }),
      credit: jest.fn().mockResolvedValue({ transactionId: 'w2', duplicate: false }),
    };
    service = new VideoRoomGiftReversalService(
      repo as never,
      events as never,
      prisma as never,
      locks as never,
      wallet as never,
    );
  });

  describe('reverseTransaction', () => {
    it('refunds the sender and claws back the receiver earnings', async () => {
      const result = await service.reverseTransaction(ROOM, 't1', ADMIN, 'chargeback');

      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 's1',
          currency: WalletCurrency.GOLD,
          amount: 100,
          idempotencyKey: 'gift-reversal-refund:t1',
        }),
        expect.anything(),
      );
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          currency: WalletCurrency.EARNINGS,
          amount: 30,
          idempotencyKey: 'gift-reversal-clawback:t1',
        }),
        expect.anything(),
      );
      expect(result).toEqual({
        transactionId: 't1',
        receiverId: 'u1',
        refundedToSender: 100,
        clawedBackFromReceiver: 30,
      });
    });

    /**
     * Order matters: if the receiver has already spent the earnings the debit
     * fails and the whole thing rolls back, rather than handing the sender coins
     * the platform never recovered.
     */
    it('claws back BEFORE refunding, so an unrecoverable clawback aborts', async () => {
      const order: string[] = [];
      wallet.debit.mockImplementation(async () => {
        order.push('debit');
        return { transactionId: 'w1' };
      });
      wallet.credit.mockImplementation(async () => {
        order.push('credit');
        return { transactionId: 'w2' };
      });
      await service.reverseTransaction(ROOM, 't1', ADMIN, 'chargeback');
      expect(order).toEqual(['debit', 'credit']);
    });

    it('refunds nothing when the clawback fails', async () => {
      wallet.debit.mockRejectedValue(new Error('INSUFFICIENT_BALANCE'));
      await expect(service.reverseTransaction(ROOM, 't1', ADMIN, 'x')).rejects.toThrow();
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('marks the row REVERSED, preserving existing metadata', async () => {
      await service.reverseTransaction(ROOM, 't1', ADMIN, 'chargeback');
      expect(repo.markReversed).toHaveBeenCalledWith(
        't1',
        'chargeback',
        ADMIN,
        { batchId: 'b1', giftName: 'Rocket' },
        expect.anything(),
      );
    });

    it('takes sorted wallet locks, as the send does', async () => {
      await service.reverseTransaction(ROOM, 't1', ADMIN, 'x');
      const keys = locks.withLock.mock.calls.map((c) => c[0]);
      expect(keys).toEqual([...keys].sort());
    });

    it('404s for a transaction outside this room', async () => {
      repo.findRoomTransaction.mockResolvedValue(null);
      await expect(service.reverseTransaction(ROOM, 't9', ADMIN, 'x')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_TRANSACTION_NOT_FOUND,
      });
    });

    it('409s on an already-reversed transaction without moving coins', async () => {
      repo.findRoomTransaction.mockResolvedValue(txn({ status: 'REVERSED' }));
      await expect(service.reverseTransaction(ROOM, 't1', ADMIN, 'x')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_ALREADY_REVERSED,
      });
      expect(wallet.credit).not.toHaveBeenCalled();
      expect(wallet.debit).not.toHaveBeenCalled();
    });

    /** Two admins clicking reverse at once must not double-refund. */
    it('409s when the conditional claim loses a race, before moving coins', async () => {
      repo.markReversed.mockResolvedValue(false);
      await expect(service.reverseTransaction(ROOM, 't1', ADMIN, 'x')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_ALREADY_REVERSED,
      });
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('skips the clawback when the gift paid no earnings', async () => {
      repo.findRoomTransaction.mockResolvedValue(txn({ creatorEarnings: 0n }));
      await service.reverseTransaction(ROOM, 't1', ADMIN, 'x');
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(wallet.credit).toHaveBeenCalled();
    });

    it('writes an audit row correlated by batchId', async () => {
      await service.reverseTransaction(ROOM, 't1', ADMIN, 'chargeback');
      expect(events.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM,
          eventType: 'gift.reversed',
          correlationId: 'b1',
          referenceId: 't1',
          actorId: ADMIN,
        }),
      );
    });

    it('still reverses when the audit append fails', async () => {
      events.appendEvent.mockRejectedValue(new Error('db down'));
      await expect(service.reverseTransaction(ROOM, 't1', ADMIN, 'x')).resolves.toBeDefined();
    });
  });

  describe('reverseBatch', () => {
    it('reverses every leg of the batch', async () => {
      const results = await service.reverseBatch(ROOM, 'b1', ADMIN, 'fraud');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.transactionId)).toEqual(['t1', 't2']);
      expect(wallet.credit).toHaveBeenCalledTimes(2);
    });

    it('404s for an unknown batch', async () => {
      repo.findBatch.mockResolvedValue([]);
      await expect(service.reverseBatch(ROOM, 'b9', ADMIN, 'x')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_TRANSACTION_NOT_FOUND,
      });
    });

    it('uses a distinct idempotency key per leg', async () => {
      await service.reverseBatch(ROOM, 'b1', ADMIN, 'fraud');
      const keys = wallet.credit.mock.calls.map((c) => c[0].idempotencyKey);
      expect(keys).toEqual(['gift-reversal-refund:t1', 'gift-reversal-refund:t2']);
      expect(new Set(keys).size).toBe(2);
    });
  });
});
