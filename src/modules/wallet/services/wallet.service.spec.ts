import { HttpStatus } from '@nestjs/common';
import { WalletCurrency, WalletEntryType, WalletTxnReason } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletService } from './wallet.service';

function txn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    userId: 'user-1',
    currency: WalletCurrency.GOLD,
    type: WalletEntryType.DEBIT,
    reason: WalletTxnReason.GIFT_SEND,
    amount: 100n,
    balanceBefore: 500n,
    balanceAfter: 400n,
    referenceType: 'gift',
    referenceId: null,
    idempotencyKey: 'key-1',
    metadata: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('WalletService', () => {
  let repo: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let service: WalletService;

  const debitInput = {
    userId: 'user-1',
    currency: WalletCurrency.GOLD,
    amount: 100,
    reason: WalletTxnReason.GIFT_SEND,
    idempotencyKey: 'key-1',
  };

  beforeEach(() => {
    repo = {
      getWallet: jest.fn().mockResolvedValue({
        goldBalance: 500n,
        freeBalance: 0n,
        earningsBalance: 0n,
      }),
      ensureWallet: jest.fn().mockResolvedValue(undefined),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      applyMovement: jest.fn().mockResolvedValue(txn()),
      listTransactions: jest.fn().mockResolvedValue([[], 0]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new WalletService(
      repo as unknown as WalletRepository,
      locks as unknown as LockService,
      bus,
    );
  });

  describe('debit', () => {
    it('applies the movement and publishes a debited event', async () => {
      const res = await service.debit(debitInput);
      expect(repo.applyMovement).toHaveBeenCalledWith(
        expect.objectContaining({ type: WalletEntryType.DEBIT, amount: 100n }),
      );
      expect(res).toMatchObject({ transactionId: 'txn-1', balanceAfter: 400, duplicate: false });
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'wallet.debited' }));
    });

    it('is idempotent — a replay returns the stored result without re-applying', async () => {
      repo.findByIdempotencyKey.mockResolvedValue(txn({ id: 'existing', balanceAfter: 400n }));
      const res = await service.debit(debitInput);
      expect(res).toMatchObject({ transactionId: 'existing', duplicate: true });
      expect(repo.applyMovement).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('rejects a non-positive amount', async () => {
      await expect(service.debit({ ...debitInput, amount: 0 })).rejects.toMatchObject({
        errorCode: ERROR_CODES.INVALID_AMOUNT,
      });
    });

    it('propagates INSUFFICIENT_BALANCE from the atomic apply', async () => {
      repo.applyMovement.mockRejectedValue(
        new BusinessException(ERROR_CODES.INSUFFICIENT_BALANCE, 'no', HttpStatus.CONFLICT),
      );
      await expect(service.debit(debitInput)).rejects.toMatchObject({
        errorCode: ERROR_CODES.INSUFFICIENT_BALANCE,
      });
    });
  });

  describe('credit', () => {
    it('applies the movement and publishes a credited event', async () => {
      repo.applyMovement.mockResolvedValue(
        txn({
          type: WalletEntryType.CREDIT,
          reason: WalletTxnReason.GIFT_RECEIVE,
          balanceAfter: 600n,
        }),
      );
      const res = await service.credit({ ...debitInput, reason: WalletTxnReason.GIFT_RECEIVE });
      expect(res).toMatchObject({ balanceAfter: 600, duplicate: false });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'wallet.credited' }),
      );
    });
  });

  describe('getBalance', () => {
    it('returns Number-safe balances', async () => {
      expect(await service.getBalance('user-1')).toEqual({ gold: 500, free: 0, earnings: 0 });
    });

    it('returns zeros when the wallet does not exist', async () => {
      repo.getWallet.mockResolvedValue(null);
      expect(await service.getBalance('user-x')).toEqual({ gold: 0, free: 0, earnings: 0 });
    });
  });
});
