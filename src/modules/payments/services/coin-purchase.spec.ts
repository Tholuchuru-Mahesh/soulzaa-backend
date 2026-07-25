import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentProvider, PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { AppleIapAdapter } from '../adapters/apple-iap.adapter';
import { GooglePlayAdapter } from '../adapters/google-play.adapter';
import { MockGatewayAdapter } from '../adapters/mock-gateway.adapter';
import { PaymentProviderFactory } from '../adapters/payment-provider.factory';
import { RazorpayAdapter } from '../adapters/razorpay.adapter';
import { StripeAdapter } from '../adapters/stripe.adapter';
import { CoinPackageSeederService } from './coin-package-seeder.service';
import { CoinPackageService } from './coin-package.service';
import { PurchaseAuditService } from './purchase-audit.service';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseQueryService } from './purchase-query.service';
import { PurchaseReconciliationService } from './purchase-reconciliation.service';
import { ReceiptVerificationService } from './receipt-verification.service';

describe('Phase 4: Coin Purchase & Payment Infrastructure', () => {
  let packageService: CoinPackageService;
  let orderService: PurchaseOrderService;
  let verificationService: ReceiptVerificationService;
  let _queryService: PurchaseQueryService;

  const mockPrismaService: any = {
    coinPackage: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    purchaseOrder: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    paymentReceipt: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    purchaseAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockWalletTxService = {
    creditWallet: jest.fn(),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockFinancialPolicyService = {
    validatePolicyLimit: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GooglePlayAdapter,
        AppleIapAdapter,
        RazorpayAdapter,
        StripeAdapter,
        MockGatewayAdapter,
        PaymentProviderFactory,
        PurchaseAuditService,
        CoinPackageService,
        PurchaseOrderService,
        ReceiptVerificationService,
        PurchaseQueryService,
        PurchaseReconciliationService,
        CoinPackageSeederService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WalletTransactionService, useValue: mockWalletTxService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: FinancialPolicyService, useValue: mockFinancialPolicyService },
      ],
    }).compile();

    packageService = module.get<CoinPackageService>(CoinPackageService);
    orderService = module.get<PurchaseOrderService>(PurchaseOrderService);
    verificationService = module.get<ReceiptVerificationService>(ReceiptVerificationService);
    _queryService = module.get<PurchaseQueryService>(PurchaseQueryService);

    jest.clearAllMocks();
  });

  describe('CoinPackageService', () => {
    it('should list active coin packages', async () => {
      mockPrismaService.coinPackage.findMany.mockResolvedValue([
        {
          id: 'pkg-1',
          code: 'PKG_100',
          name: '100 Coins',
          coins: BigInt(100),
          bonusCoins: BigInt(0),
          priceAmount: 0.99,
          isActive: true,
        },
      ]);

      const packages = await packageService.listPackages({});
      expect(packages.length).toBe(1);
      expect(packages[0].coins).toBe('100');
    });
  });

  describe('PurchaseOrderService', () => {
    it('should create a purchase order with unique orderNumber and total coins', async () => {
      mockPrismaService.purchaseOrder.findUnique.mockResolvedValue(null);
      mockPrismaService.coinPackage.findFirst.mockResolvedValue({
        id: 'pkg-1',
        name: '100 Coins',
        coins: BigInt(100),
        bonusCoins: BigInt(10),
        priceAmount: 0.99,
        currency: 'USD',
        isActive: true,
      });

      mockPrismaService.purchaseOrder.create.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'ORD-12345',
        userId: 'user-1',
        packageId: 'pkg-1',
        provider: PaymentProvider.GOOGLE_PLAY,
        coinsAmount: BigInt(100),
        bonusCoinsAmount: BigInt(10),
        totalCoins: BigInt(110),
        priceAmount: 0.99,
        currency: 'USD',
        status: PurchaseOrderStatus.CREATED,
        idempotencyKey: 'idemp-ord-1',
      });

      const order = await orderService.createPurchaseOrder('user-1', {
        packageId: 'pkg-1',
        provider: PaymentProvider.GOOGLE_PLAY,
        idempotencyKey: 'idemp-ord-1',
      });

      expect(order.id).toBe('order-1');
      expect(order.totalCoins).toBe('110');
    });
  });

  describe('ReceiptVerificationService', () => {
    it('should verify receipt and credit user wallet via WalletTransactionService', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockFinancialPolicyService.validatePolicyLimit.mockResolvedValue(true);

      mockPrismaService.purchaseOrder.findFirst.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'ORD-12345',
        userId: 'user-1',
        provider: PaymentProvider.MOCK_GATEWAY,
        status: PurchaseOrderStatus.CREATED,
        coinsAmount: BigInt(100),
        bonusCoinsAmount: BigInt(0),
        totalCoins: BigInt(100),
        priceAmount: 0.99,
        currency: 'USD',
      });

      mockPrismaService.paymentReceipt.findUnique.mockResolvedValue(null);
      mockPrismaService.paymentReceipt.create.mockResolvedValue({ id: 'receipt-1' });

      mockWalletTxService.creditWallet.mockResolvedValue({
        transactionId: 'wallet-tx-100',
      });

      mockPrismaService.purchaseOrder.update.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'ORD-12345',
        status: PurchaseOrderStatus.COMPLETED,
        totalCoins: BigInt(100),
        priceAmount: 0.99,
        completedAt: new Date(),
      });

      const result = await verificationService.verifyAndFulfillPurchase({
        orderId: 'order-1',
        receiptData: 'mock_receipt_data',
      });

      expect(result.isVerified).toBe(true);
      expect(result.status).toBe(PurchaseOrderStatus.COMPLETED);
      expect(mockWalletTxService.creditWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          amount: 100,
        }),
        undefined,
      );
    });

    it('should reject duplicate receipts (Anti-Replay Protection)', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);

      mockPrismaService.purchaseOrder.findFirst.mockResolvedValue({
        id: 'order-1',
        status: PurchaseOrderStatus.CREATED,
        provider: PaymentProvider.MOCK_GATEWAY,
        coinsAmount: BigInt(100),
        totalCoins: BigInt(100),
        priceAmount: 0.99,
      });

      mockPrismaService.paymentReceipt.findUnique.mockResolvedValue({
        id: 'existing-receipt',
        isVerified: true,
      });

      await expect(
        verificationService.verifyAndFulfillPurchase({
          orderId: 'order-1',
          receiptData: 'mock_data',
          providerTxnId: 'dup_txn_id',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
