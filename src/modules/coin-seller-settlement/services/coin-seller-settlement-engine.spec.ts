import { Test, TestingModule } from '@nestjs/testing';
import { WalletCurrency } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CoinSellerAuditService } from './coin-seller-audit.service';
import { CoinSellerCommissionService } from './coin-seller-commission.service';
import { CoinSellerConfigurationService } from './coin-seller-configuration.service';
import { CoinSellerEventService } from './coin-seller-event.service';
import { CoinSellerHistoryService } from './coin-seller-history.service';
import { CoinSellerQueryService } from './coin-seller-query.service';
import { CoinSellerRelationshipService } from './coin-seller-relationship.service';
import { CoinSellerSettlementService } from './coin-seller-settlement.service';
import { CoinSellerStatisticsService } from './coin-seller-statistics.service';
import { CoinSellerValidationService } from './coin-seller-validation.service';

describe('Phase 9: Enterprise Coin Seller Settlement Engine', () => {
  let configService: CoinSellerConfigurationService;
  let commissionService: CoinSellerCommissionService;
  let relationshipService: CoinSellerRelationshipService;
  let validationService: CoinSellerValidationService;
  let settlementService: CoinSellerSettlementService;
  let historyService: CoinSellerHistoryService;
  let auditService: CoinSellerAuditService;
  let statisticsService: CoinSellerStatisticsService;
  let queryService: CoinSellerQueryService;
  let eventService: CoinSellerEventService;

  const mockPrismaService: any = {
    coinSellerRelationship: {
      findFirst: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    coinSellerSettlement: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    coinSellerCommission: {
      create: jest.fn(),
    },
    coinSellerHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coinSellerAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coinSellerStatistics: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    coinSellerConfiguration: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'seller.commission_percentage') return Promise.resolve(5.0);
      return Promise.resolve(null);
    }),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockWalletService = {
    credit: jest.fn().mockResolvedValue({ transactionId: 'w-tx-seller-100', status: 'COMPLETED' }),
  };

  const mockEventBus = {
    subscribe: jest.fn(),
    publish: jest.fn(),
  };

  const mockLockService = {
    withLock: jest.fn().mockImplementation((_key: string, fn: Function) => fn()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinSellerConfigurationService,
        CoinSellerCommissionService,
        CoinSellerRelationshipService,
        CoinSellerValidationService,
        CoinSellerSettlementService,
        CoinSellerHistoryService,
        CoinSellerAuditService,
        CoinSellerStatisticsService,
        CoinSellerQueryService,
        CoinSellerEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: WALLET_SERVICE, useValue: mockWalletService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    configService = module.get<CoinSellerConfigurationService>(CoinSellerConfigurationService);
    commissionService = module.get<CoinSellerCommissionService>(CoinSellerCommissionService);
    relationshipService = module.get<CoinSellerRelationshipService>(CoinSellerRelationshipService);
    validationService = module.get<CoinSellerValidationService>(CoinSellerValidationService);
    settlementService = module.get<CoinSellerSettlementService>(CoinSellerSettlementService);
    historyService = module.get<CoinSellerHistoryService>(CoinSellerHistoryService);
    auditService = module.get<CoinSellerAuditService>(CoinSellerAuditService);
    statisticsService = module.get<CoinSellerStatisticsService>(CoinSellerStatisticsService);
    queryService = module.get<CoinSellerQueryService>(CoinSellerQueryService);
    eventService = module.get<CoinSellerEventService>(CoinSellerEventService);

    jest.clearAllMocks();
  });

  describe('1. Dynamic Commission Calculation', () => {
    it('should calculate 5% coin seller commission for a 10,000 coin purchase', async () => {
      const comm = await commissionService.calculateCommission(BigInt(10_000));
      expect(comm.commissionPercentage).toBe(5.0);
      expect(comm.sellerCommissionCoins).toBe(BigInt(500));
    });
  });

  describe('2. Relationship & Treasury Validation Guards', () => {
    it('should throw ForbiddenException if Treasury Economy is frozen', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValueOnce(true);

      await expect(
        validationService.validateSettlement('purchase-tx-1', 'buyer-1'),
      ).rejects.toThrow();
    });

    it('should return null relationship for independent buyer unassigned to any coin seller', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.coinSellerSettlement.findUnique.mockResolvedValue(null);
      mockPrismaService.coinSellerRelationship.findFirst.mockResolvedValue(null);

      const val = await validationService.validateSettlement('purchase-tx-1', 'buyer-independent');
      expect(val.relationship).toBeNull();
      expect(val.isDuplicate).toBe(false);
    });

    it('should detect duplicate replay for already-settled purchaseTxnId', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.coinSellerSettlement.findUnique.mockResolvedValue({
        id: 'settlement-existing',
        sellerId: 'seller-1',
        sellerCommissionCoins: BigInt(500),
      });

      const val = await validationService.validateSettlement('purchase-tx-1', 'buyer-1');
      expect(val.isDuplicate).toBe(true);
    });
  });

  describe('3. Coin Seller Settlement & Double-Entry Wallet Integration', () => {
    it('should credit seller wallet via IWalletService for mapped buyer purchase', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.coinSellerSettlement.findUnique.mockResolvedValue(null);
      mockPrismaService.coinSellerRelationship.findFirst.mockResolvedValue({
        id: 'rel-1',
        sellerId: 'seller-888',
        buyerId: 'buyer-1',
        status: 'ACTIVE',
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'seller-888', status: 'ACTIVE' });
      mockPrismaService.coinSellerSettlement.create.mockResolvedValue({
        id: 'set-100',
        sellerId: 'seller-888',
        sellerCommissionCoins: BigInt(500),
      });
      mockPrismaService.coinSellerCommission.create.mockResolvedValue({ id: 'comm-100' });
      mockPrismaService.coinSellerHistory.create.mockResolvedValue({ id: 'hist-100' });
      mockPrismaService.coinSellerStatistics.upsert.mockResolvedValue({});
      mockPrismaService.coinSellerAudit.create.mockResolvedValue({});

      const result = await settlementService.processPurchaseSettlement({
        purchaseTxnId: 'purchase-tx-100',
        buyerId: 'buyer-1',
        purchaseAmountCoins: BigInt(10_000),
      });

      expect(result.processed).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(result.sellerId).toBe('seller-888');
      expect(result.sellerCommissionCoins).toBe('500');

      expect(mockWalletService.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'seller-888',
          currency: WalletCurrency.EARNINGS,
          amount: 500,
          reason: 'COIN_SELLER_COMMISSION',
          referenceType: 'coin_purchase',
          referenceId: 'purchase-tx-100',
        }),
      );
    });

    it('should gracefully skip settlement for unassigned independent buyers', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.coinSellerSettlement.findUnique.mockResolvedValue(null);
      mockPrismaService.coinSellerRelationship.findFirst.mockResolvedValue(null);

      const result = await settlementService.processPurchaseSettlement({
        purchaseTxnId: 'purchase-tx-direct',
        buyerId: 'buyer-independent',
        purchaseAmountCoins: BigInt(10_000),
      });

      expect(result.processed).toBe(false);
      expect(result.reason).toBe('INDEPENDENT_BUYER_NO_SELLER');
      expect(mockWalletService.credit).not.toHaveBeenCalled();
    });
  });

  describe('4. Event-Driven Architecture & Domain Events', () => {
    it('should subscribe to payment/purchase completion events upon module init', async () => {
      eventService.onModuleInit();
      expect(mockEventBus.subscribe).toHaveBeenCalledWith(
        'payment.completed',
        expect.any(Function),
      );
      expect(mockEventBus.subscribe).toHaveBeenCalledWith(
        'coin_purchase.completed',
        expect.any(Function),
      );
    });
  });
});
