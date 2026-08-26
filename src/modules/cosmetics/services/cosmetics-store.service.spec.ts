import { CosmeticType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { QueueService } from 'src/infra/queue/queue.service';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CosmeticsRepository } from '../repositories/cosmetics.repository';
import { CosmeticsService } from './cosmetics.service';
import { CosmeticsStoreService } from './cosmetics-store.service';

function cosmetic(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    type: CosmeticType.THEME,
    name: 'Galaxy',
    enabled: true,
    isPremium: true,
    price: 1000,
    ...overrides,
  };
}

describe('CosmeticsStoreService', () => {
  let repo: Record<string, jest.Mock>;
  let cosmetics: { grantToUser: jest.Mock };
  let wallet: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let queue: { enqueue: jest.Mock };
  let media: { resolve: jest.Mock };
  let prisma: any;
  let service: CosmeticsStoreService;

  beforeEach(() => {
    repo = {
      getById: jest.fn().mockResolvedValue(cosmetic()),
      findPurchaseByKey: jest.fn().mockResolvedValue(null),
      createPurchase: jest.fn().mockResolvedValue({ id: 'p1' }),
      listStore: jest.fn().mockResolvedValue([]),
      listPurchases: jest.fn().mockResolvedValue([[], 0]),
    };
    cosmetics = {
      grantToUser: jest.fn().mockResolvedValue({ backpackItemId: 'i1', duplicate: false }),
    };
    wallet = {
      debit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w1', balanceAfter: 0, duplicate: false }),
      credit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w2', balanceAfter: 1000, duplicate: false }),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    media = {
      resolve: jest
        .fn()
        .mockImplementation((key: string | null | undefined) => Promise.resolve(key ?? null)),
    };
    // listStore seeds the default animated frames through prisma before reading
    // the catalogue; the upsert is best-effort in the service, so a stub that
    // resolves is all the store behaviour under test needs.
    prisma = { cosmetic: { upsert: jest.fn().mockResolvedValue(null) } };
    service = new CosmeticsStoreService(
      repo as unknown as CosmeticsRepository,
      cosmetics as unknown as CosmeticsService,
      wallet as unknown as IWalletService,
      bus,
      queue as unknown as QueueService,
      media as any,
      prisma as any,
    );
  });

  describe('purchase', () => {
    it('debits gold, grants the cosmetic, records + broadcasts', async () => {
      const res = await service.purchase('u1', 'c1');
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'GOLD', amount: 1000, reason: 'COSMETIC_PURCHASE' }),
      );
      expect(cosmetics.grantToUser).toHaveBeenCalledWith(
        expect.objectContaining({ cosmeticId: 'c1', source: 'PURCHASE' }),
      );
      expect(repo.createPurchase).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'cosmetic.purchased' }),
      );
      expect(res).toMatchObject({ purchaseId: 'p1', duplicate: false });
    });

    it('rejects a non-premium / free cosmetic', async () => {
      repo.getById.mockResolvedValue(cosmetic({ isPremium: false }));
      await expect(service.purchase('u1', 'c1')).rejects.toMatchObject({
        errorCode: 'COSMETIC_NOT_PURCHASABLE',
      });
    });

    it('is idempotent — a prior purchase returns the original', async () => {
      repo.findPurchaseByKey.mockResolvedValue({ id: 'existing', backpackItemId: 'i0' });
      const res = await service.purchase('u1', 'c1', 'k1');
      expect(res).toMatchObject({ purchaseId: 'existing', duplicate: true });
      expect(wallet.debit).not.toHaveBeenCalled();
    });

    it('refunds the debit when the grant/ledger fails', async () => {
      repo.createPurchase.mockRejectedValue(new Error('db down'));
      await expect(service.purchase('u1', 'c1')).rejects.toBeInstanceOf(Error);
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'GOLD', amount: 1000 }),
      );
    });

    it('propagates INSUFFICIENT_BALANCE without recording', async () => {
      wallet.debit.mockRejectedValue(
        new BusinessException('INSUFFICIENT_BALANCE' as never, 'no', 409),
      );
      await expect(service.purchase('u1', 'c1')).rejects.toBeInstanceOf(BusinessException);
      expect(repo.createPurchase).not.toHaveBeenCalled();
    });
  });

  describe('gift', () => {
    it('debits sender gold and grants cosmetic to recipient with source GIFT and non-transferable', async () => {
      const res = await service.gift('u1', 'c1', 'u2');
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          currency: 'GOLD',
          amount: 1000,
          reason: 'COSMETIC_PURCHASE',
        }),
      );
      expect(cosmetics.grantToUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u2',
          cosmeticId: 'c1',
          source: 'GIFT',
          transferable: false,
        }),
      );
      expect(repo.createPurchase).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          cosmeticId: 'c1',
        }),
      );
      expect(res).toMatchObject({ purchaseId: 'p1', duplicate: false });
    });

    it('rejects gifting to self', async () => {
      await expect(service.gift('u1', 'c1', 'u1')).rejects.toMatchObject({
        errorCode: 'CANNOT_TRANSFER_SELF',
      });
      expect(wallet.debit).not.toHaveBeenCalled();
    });
  });
});
