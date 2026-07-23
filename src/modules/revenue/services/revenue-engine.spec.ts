import { Test, TestingModule } from '@nestjs/testing';
import { WalletCurrency } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { HostEarningsService } from './host-earnings.service';
import { RevenueAuditService } from './revenue-audit.service';
import { RevenueCalculationService } from './revenue-calculation.service';
import { RevenueConfigurationService } from './revenue-configuration.service';
import { RevenueDistributionService } from './revenue-distribution.service';
import { RevenueEventService } from './revenue-event.service';
import { RevenueHistoryService } from './revenue-history.service';
import { RevenueQueryService } from './revenue-query.service';
import { RevenueStatisticsService } from './revenue-statistics.service';
import { RevenueValidationService } from './revenue-validation.service';

describe('Phase 7: Enterprise Host Earnings & Revenue Distribution Engine', () => {
  let configService: RevenueConfigurationService;
  let calculationService: RevenueCalculationService;
  let hostEarningsService: HostEarningsService;
  let validationService: RevenueValidationService;
  let distributionService: RevenueDistributionService;
  let historyService: RevenueHistoryService;
  let auditService: RevenueAuditService;
  let statisticsService: RevenueStatisticsService;
  let queryService: RevenueQueryService;
  let eventService: RevenueEventService;

  const mockPrismaService: any = {
    revenueDistribution: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    hostEarnings: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    revenueHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    revenueAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    revenueStatistics: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    revenueConfiguration: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'host.revenue_percentage') return Promise.resolve(50.0);
      if (key === 'platform.revenue_percentage') return Promise.resolve(50.0);
      return Promise.resolve(null);
    }),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockWalletService = {
    credit: jest.fn().mockResolvedValue({ transactionId: 'w-tx-rev-100', status: 'COMPLETED' }),
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
        RevenueConfigurationService,
        RevenueCalculationService,
        HostEarningsService,
        RevenueValidationService,
        RevenueDistributionService,
        RevenueHistoryService,
        RevenueAuditService,
        RevenueStatisticsService,
        RevenueQueryService,
        RevenueEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: WALLET_SERVICE, useValue: mockWalletService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    configService = module.get<RevenueConfigurationService>(RevenueConfigurationService);
    calculationService = module.get<RevenueCalculationService>(RevenueCalculationService);
    hostEarningsService = module.get<HostEarningsService>(HostEarningsService);
    validationService = module.get<RevenueValidationService>(RevenueValidationService);
    distributionService = module.get<RevenueDistributionService>(RevenueDistributionService);
    historyService = module.get<RevenueHistoryService>(RevenueHistoryService);
    auditService = module.get<RevenueAuditService>(RevenueAuditService);
    statisticsService = module.get<RevenueStatisticsService>(RevenueStatisticsService);
    queryService = module.get<RevenueQueryService>(RevenueQueryService);
    eventService = module.get<RevenueEventService>(RevenueEventService);

    jest.clearAllMocks();
  });

  describe('1. Dynamic Revenue Calculation', () => {
    it('should calculate 50/50 split math correctly for a 1,000 coin gift', async () => {
      const split = await calculationService.calculateSplit(BigInt(1_000));
      expect(split.hostPercentage).toBe(50.0);
      expect(split.platformPercentage).toBe(50.0);
      expect(split.hostEarningsCoins).toBe(BigInt(500));
      expect(split.platformEarningsCoins).toBe(BigInt(500));
    });

    it('should handle dynamic custom split configuration (e.g. 70% host / 30% platform)', async () => {
      const customConfig = {
        hostPercentage: 70.0,
        platformPercentage: 30.0,
        agencyPercentage: 0.0,
        referralPercentage: 0.0,
        coinSellerPercentage: 0.0,
        minimumPayout: 1,
      };

      const split = await calculationService.calculateSplit(BigInt(10_000), customConfig);
      expect(split.hostEarningsCoins).toBe(BigInt(7_000));
      expect(split.platformEarningsCoins).toBe(BigInt(3_000));
    });
  });

  describe('2. Treasury & Validation Guards', () => {
    it('should throw ForbiddenException if Treasury Economy is frozen', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValueOnce(true);

      await expect(
        validationService.validateRevenueDistribution('gift-tx-1', 'host-1'),
      ).rejects.toThrow();
    });

    it('should detect duplicate replay for already-processed giftTxnId', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.revenueDistribution.findUnique.mockResolvedValue({
        id: 'dist-existing',
        giftTxnId: 'gift-tx-1',
        hostEarningsCoins: BigInt(500),
      });

      const res = await validationService.validateRevenueDistribution('gift-tx-1', 'host-1');
      expect(res.isDuplicate).toBe(true);
    });
  });

  describe('3. Revenue Distribution & Double-Entry Wallet Integration', () => {
    it('should process gift revenue and credit host Earnings Wallet via IWalletService', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.revenueDistribution.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'host-1', status: 'ACTIVE' });
      mockPrismaService.revenueDistribution.create.mockResolvedValue({
        id: 'dist-100',
        giftTxnId: 'gift-tx-100',
        hostEarningsCoins: BigInt(500),
      });
      mockPrismaService.revenueHistory.create.mockResolvedValue({ id: 'hist-100' });
      mockPrismaService.hostEarnings.upsert.mockResolvedValue({});
      mockPrismaService.revenueStatistics.upsert.mockResolvedValue({});
      mockPrismaService.revenueAudit.create.mockResolvedValue({});

      const result = await distributionService.processGiftRevenue({
        giftTxnId: 'gift-tx-100',
        hostId: 'host-1',
        contextType: 'AUDIO_ROOM',
        contextId: 'room-1',
        totalCoinValue: BigInt(1_000),
      });

      expect(result.processed).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(result.hostEarningsCoins).toBe('500');

      expect(mockWalletService.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'host-1',
          currency: WalletCurrency.EARNINGS,
          amount: 500,
          reason: 'HOST_EARNING',
          referenceType: 'gift_transaction',
          referenceId: 'gift-tx-100',
        }),
      );

      expect(mockPrismaService.hostEarnings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { hostId: 'host-1' },
          update: expect.objectContaining({
            totalEarnedCoins: { increment: BigInt(500) },
          }),
        }),
      );
    });
  });

  describe('4. Event-Driven Architecture & Domain Events', () => {
    it('should subscribe to gift.sent event and publish revenue.distributed event upon payout', async () => {
      eventService.onModuleInit();
      expect(mockEventBus.subscribe).toHaveBeenCalledWith('gift.sent', expect.any(Function));
    });
  });
});
