import { Test, TestingModule } from '@nestjs/testing';
import { WalletCurrency } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CoinSellerInventoryService } from './coin-seller-inventory.service';
import { CoinSellerUserSaleService } from './coin-seller-user-sale.service';

/**
 * Coin Seller inventory & sale invariants (PRD §17, §18, §19, §20, §32).
 *
 * These cover the four properties that make the seller flow safe to run with
 * real money behind it: inventory originates from the platform treasury, it
 * cannot go negative under concurrency, a retried request settles exactly once,
 * and a seller can only sell inside their own country.
 */
describe('Coin Seller inventory and user sale', () => {
  let inventoryService: CoinSellerInventoryService;
  let saleService: CoinSellerUserSaleService;

  const SELLER = '11111111-1111-1111-1111-111111111111';
  const BUYER = '22222222-2222-2222-2222-222222222222';
  const INVENTORY = '33333333-3333-3333-3333-333333333333';

  let mockPrisma: any;
  let mockWallet: any;
  let mockBus: any;
  let tx: any;

  beforeEach(async () => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: INVENTORY }]),
      coinSellerInventory: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      coinSellerInventoryPurchaseOrder: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      coinSellerUserSaleTransaction: {
        create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'sale-1', ...data })),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      coinSellerInventoryAudit: {
        create: jest.fn().mockResolvedValue({}),
      },
      treasuryReserve: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    mockPrisma = {
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      coinSellerInventory: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      coinSellerInventoryPackage: {
        findUnique: jest.fn(),
      },
      coinSellerInventoryPurchaseOrder: {
        create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'po-1', ...data })),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      coinSellerUserSaleTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: jest.fn(),
      },
      // The country resolver consults the countries table so a normalised
      // countryId and a free-text name collapse to the same code.
      country: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    mockBus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };

    mockWallet = {
      credit: jest.fn().mockResolvedValue({
        transactionId: 'wtx-1',
        currency: WalletCurrency.GOLD,
        balanceAfter: 1000,
        duplicate: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinSellerInventoryService,
        CoinSellerUserSaleService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WALLET_SERVICE, useValue: mockWallet },
        // The sale announces itself on the bus once committed; these tests are
        // about inventory and country rules, so a no-op publisher is enough.
        { provide: EVENT_BUS, useValue: mockBus },
      ],
    }).compile();

    inventoryService = module.get(CoinSellerInventoryService);
    saleService = module.get(CoinSellerUserSaleService);
  });

  // ── PRD §20: country restriction ───────────────────────────────
  describe('seller country (PRD §20)', () => {
    it('creates inventory using the seller own country, never a GLOBAL placeholder', async () => {
      mockPrisma.coinSellerInventoryPackage.findUnique.mockResolvedValue({
        id: 'pkg-1',
        code: 'INV_100K',
        coinAmount: BigInt(100000),
        priceAmount: 10000,
        priceCurrency: 'INR',
        isActive: true,
      });
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue(null);
      mockPrisma.coinSellerInventory.create.mockImplementation(({ data }: any) => ({
        id: INVENTORY,
        availableBalance: BigInt(0),
        ...data,
      }));
      mockPrisma.user.findUnique.mockResolvedValue({ country: 'IN', countryId: null });

      await inventoryService.createPurchaseOrder(SELLER, 'pkg-1', 'po-key-1');

      expect(mockPrisma.coinSellerInventory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ country: 'IN' }) }),
      );
    });

    it('refuses to create inventory for a seller with no country on file', async () => {
      mockPrisma.coinSellerInventoryPackage.findUnique.mockResolvedValue({
        id: 'pkg-1',
        code: 'INV_100K',
        coinAmount: BigInt(100000),
        priceAmount: 10000,
        priceCurrency: 'INR',
        isActive: true,
      });
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ country: null, countryId: null });

      await expect(
        inventoryService.createPurchaseOrder(SELLER, 'pkg-1', 'po-key-1'),
      ).rejects.toThrow(/country/i);
    });

    it('allows a sale when seller and buyer share a country', async () => {
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({ country: 'IN', countryId: null });
      tx.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      tx.coinSellerInventory.update.mockResolvedValue({
        id: INVENTORY,
        availableBalance: BigInt(40000),
      });

      const sale = await saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1');

      expect(sale).toBeDefined();
      expect(mockWallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ currency: WalletCurrency.GOLD, amount: 10000 }),
        tx,
      );
    });

    it('rejects a cross-country sale', async () => {
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({ country: 'US' });

      await expect(saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1')).rejects.toThrow(
        /cannot sell/i,
      );
      expect(mockWallet.credit).not.toHaveBeenCalled();
    });
  });

  // ── PRD §32: idempotency ───────────────────────────────────────
  describe('idempotency (PRD §32)', () => {
    it('returns the original sale on replay instead of crediting twice', async () => {
      const existing = {
        id: 'sale-1',
        sellerId: SELLER,
        buyerId: BUYER,
        coinAmount: BigInt(10000),
      };
      mockPrisma.coinSellerUserSaleTransaction.findUnique.mockResolvedValue(existing);

      const result = await saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1');

      expect(result).toEqual(existing);
      expect(mockWallet.credit).not.toHaveBeenCalled();
      expect(tx.coinSellerInventory.update).not.toHaveBeenCalled();
    });

    it('derives the wallet idempotency key from the caller key, not a random UUID', async () => {
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({ country: 'IN', countryId: null });
      tx.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      tx.coinSellerInventory.update.mockResolvedValue({
        id: INVENTORY,
        availableBalance: BigInt(40000),
      });

      await saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1');

      const walletArgs = mockWallet.credit.mock.calls[0][0];
      expect(walletArgs.idempotencyKey).toContain('sale-key-1');
      // A second identical call must produce the SAME wallet key so the wallet
      // layer's own idempotency can collapse it.
      mockWallet.credit.mockClear();
      mockPrisma.coinSellerUserSaleTransaction.findUnique.mockResolvedValue(null);
      await saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1');
      expect(mockWallet.credit.mock.calls[0][0].idempotencyKey).toBe(walletArgs.idempotencyKey);
    });

    it('returns the existing purchase order on replay', async () => {
      const existing = { id: 'po-1', sellerId: SELLER, coinAmount: BigInt(100000) };
      mockPrisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(existing);

      const result = await inventoryService.createPurchaseOrder(SELLER, 'pkg-1', 'po-key-1');

      expect(result).toEqual(existing);
      expect(mockPrisma.coinSellerInventoryPurchaseOrder.create).not.toHaveBeenCalled();
    });
  });

  // ── PRD §18, §33: concurrency ──────────────────────────────────
  describe('inventory concurrency (PRD §18)', () => {
    it('takes a row lock on the inventory before deducting', async () => {
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({ country: 'IN', countryId: null });
      tx.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      tx.coinSellerInventory.update.mockResolvedValue({
        id: INVENTORY,
        availableBalance: BigInt(40000),
      });

      await saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1');

      expect(tx.$queryRaw).toHaveBeenCalled();
      const sql = tx.$queryRaw.mock.calls[0][0].join('');
      expect(sql).toMatch(/FOR UPDATE/i);
    });

    it('rejects when the locked balance is short, even if the pre-read looked sufficient', async () => {
      // Pre-read sees plenty; by the time the lock is taken a concurrent sale
      // has drained it. This is the exact race that drove inventory negative.
      mockPrisma.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(50000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({ country: 'IN', countryId: null });
      tx.coinSellerInventory.findUnique.mockResolvedValue({
        id: INVENTORY,
        country: 'IN',
        availableBalance: BigInt(1000),
      });

      await expect(saleService.sellCoinsToUser(SELLER, BUYER, 10000, 'sale-key-1')).rejects.toThrow(
        /insufficient/i,
      );
      expect(tx.coinSellerInventory.update).not.toHaveBeenCalled();
      expect(mockWallet.credit).not.toHaveBeenCalled();
    });
  });

  // ── PRD §17: inventory must originate from the platform ────────
  describe('inventory provenance (PRD §17)', () => {
    it('debits the platform treasury when crediting seller inventory', async () => {
      tx.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue({
        id: 'po-1',
        sellerId: SELLER,
        inventoryId: INVENTORY,
        coinAmount: BigInt(100000),
        status: 'PAYMENT_VERIFIED',
        inventory: { availableBalance: BigInt(0) },
      });
      tx.coinSellerInventoryPurchaseOrder.update.mockResolvedValue({ id: 'po-1' });
      tx.treasuryReserve.findFirst.mockResolvedValue({
        id: 'tr-1',
        treasuryBalance: BigInt(1000000),
      });
      tx.treasuryReserve.update.mockResolvedValue({ id: 'tr-1' });
      tx.coinSellerInventory.update.mockResolvedValue({
        id: INVENTORY,
        availableBalance: BigInt(100000),
      });

      await inventoryService.approvePurchaseOrder('po-1', 'admin-1');

      expect(tx.treasuryReserve.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            treasuryBalance: { decrement: BigInt(100000) },
          }),
        }),
      );
    });

    it('refuses to mint inventory the treasury cannot cover', async () => {
      tx.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue({
        id: 'po-1',
        sellerId: SELLER,
        inventoryId: INVENTORY,
        coinAmount: BigInt(100000),
        status: 'PAYMENT_VERIFIED',
        inventory: { availableBalance: BigInt(0) },
      });
      tx.treasuryReserve.findFirst.mockResolvedValue({
        id: 'tr-1',
        treasuryBalance: BigInt(500),
      });

      await expect(inventoryService.approvePurchaseOrder('po-1', 'admin-1')).rejects.toThrow(
        /treasury/i,
      );
      expect(tx.coinSellerInventory.update).not.toHaveBeenCalled();
    });
  });
});
