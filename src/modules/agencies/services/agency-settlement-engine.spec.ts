import { Test, TestingModule } from '@nestjs/testing';
import { WalletCurrency } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { AgencyAuditService } from './agency-audit.service';
import { AgencyCommissionService } from './agency-commission.service';
import { AgencyConfigurationService } from './agency-configuration.service';
import { AgencyEventService } from './agency-event.service';
import { AgencyHistoryService } from './agency-history.service';
import { AgencyQueryService } from './agency-query.service';
import { AgencyRelationshipService } from './agency-relationship.service';
import { AgencySettlementService } from './agency-settlement.service';
import { AgencyStatisticsService } from './agency-statistics.service';
import { AgencyValidationService } from './agency-validation.service';

describe('Phase 8: Enterprise Agency Settlement Engine', () => {
  let configService: AgencyConfigurationService;
  let commissionService: AgencyCommissionService;
  let relationshipService: AgencyRelationshipService;
  let validationService: AgencyValidationService;
  let settlementService: AgencySettlementService;
  let historyService: AgencyHistoryService;
  let auditService: AgencyAuditService;
  let statisticsService: AgencyStatisticsService;
  let queryService: AgencyQueryService;
  let eventService: AgencyEventService;

  const mockPrismaService: any = {
    agencyRelationship: {
      findFirst: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    agencySettlement: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    agencyCommission: {
      create: jest.fn(),
    },
    agencyHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    agencyAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    agencyStatistics: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    agencyConfiguration: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'agency.commission_percentage') return Promise.resolve(10.0);
      return Promise.resolve(null);
    }),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockWalletService = {
    credit: jest.fn().mockResolvedValue({ transactionId: 'w-tx-ag-100', status: 'COMPLETED' }),
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
        AgencyConfigurationService,
        AgencyCommissionService,
        AgencyRelationshipService,
        AgencyValidationService,
        AgencySettlementService,
        AgencyHistoryService,
        AgencyAuditService,
        AgencyStatisticsService,
        AgencyQueryService,
        AgencyEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: WALLET_SERVICE, useValue: mockWalletService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    configService = module.get<AgencyConfigurationService>(AgencyConfigurationService);
    commissionService = module.get<AgencyCommissionService>(AgencyCommissionService);
    relationshipService = module.get<AgencyRelationshipService>(AgencyRelationshipService);
    validationService = module.get<AgencyValidationService>(AgencyValidationService);
    settlementService = module.get<AgencySettlementService>(AgencySettlementService);
    historyService = module.get<AgencyHistoryService>(AgencyHistoryService);
    auditService = module.get<AgencyAuditService>(AgencyAuditService);
    statisticsService = module.get<AgencyStatisticsService>(AgencyStatisticsService);
    queryService = module.get<AgencyQueryService>(AgencyQueryService);
    eventService = module.get<AgencyEventService>(AgencyEventService);

    jest.clearAllMocks();
  });

  describe('1. Dynamic Commission Calculation', () => {
    it('should calculate 10% agency commission for a host earning 5,000 coins', async () => {
      const comm = await commissionService.calculateCommission(BigInt(5_000));
      expect(comm.commissionPercentage).toBe(10.0);
      expect(comm.agencyCommissionCoins).toBe(BigInt(500));
    });
  });

  describe('2. Relationship & Treasury Validation Guards', () => {
    it('should throw ForbiddenException if Treasury Economy is frozen', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValueOnce(true);

      await expect(validationService.validateSettlement('rev-dist-1', 'host-1')).rejects.toThrow();
    });

    it('should return null relationship for independent host unassigned to any agency', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.agencySettlement.findUnique.mockResolvedValue(null);
      mockPrismaService.agencyRelationship.findFirst.mockResolvedValue(null);

      const val = await validationService.validateSettlement('rev-dist-1', 'host-independent');
      expect(val.relationship).toBeNull();
      expect(val.isDuplicate).toBe(false);
    });

    it('should detect duplicate replay for already-settled revenueDistributionId', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.agencySettlement.findUnique.mockResolvedValue({
        id: 'settlement-existing',
        agencyId: 'agency-1',
        agencyCommissionCoins: BigInt(500),
      });

      const val = await validationService.validateSettlement('rev-dist-1', 'host-1');
      expect(val.isDuplicate).toBe(true);
    });
  });

  describe('3. Agency Settlement & Double-Entry Wallet Integration', () => {
    it('should credit agency wallet via IWalletService for affiliated host revenue', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.agencySettlement.findUnique.mockResolvedValue(null);
      mockPrismaService.agencyRelationship.findFirst.mockResolvedValue({
        id: 'rel-1',
        agencyId: 'agency-777',
        hostId: 'host-1',
        status: 'ACTIVE',
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'agency-777', status: 'ACTIVE' });
      mockPrismaService.agencySettlement.create.mockResolvedValue({
        id: 'set-100',
        agencyId: 'agency-777',
        agencyCommissionCoins: BigInt(500),
      });
      mockPrismaService.agencyCommission.create.mockResolvedValue({ id: 'comm-100' });
      mockPrismaService.agencyHistory.create.mockResolvedValue({ id: 'hist-100' });
      mockPrismaService.agencyStatistics.upsert.mockResolvedValue({});
      mockPrismaService.agencyAudit.create.mockResolvedValue({});

      const result = await settlementService.processRevenueSettlement({
        revenueDistributionId: 'rev-dist-100',
        giftTxnId: 'gift-tx-100',
        hostId: 'host-1',
        hostEarningsCoins: BigInt(5_000),
      });

      expect(result.processed).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(result.agencyId).toBe('agency-777');
      expect(result.agencyCommissionCoins).toBe('500');

      expect(mockWalletService.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'agency-777',
          currency: WalletCurrency.EARNINGS,
          amount: 500,
          reason: 'AGENCY_COMMISSION',
          referenceType: 'revenue_distribution',
          referenceId: 'rev-dist-100',
        }),
      );
    });

    it('should gracefully skip settlement for unassigned independent hosts', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.agencySettlement.findUnique.mockResolvedValue(null);
      mockPrismaService.agencyRelationship.findFirst.mockResolvedValue(null);

      const result = await settlementService.processRevenueSettlement({
        revenueDistributionId: 'rev-dist-solo',
        giftTxnId: 'gift-tx-solo',
        hostId: 'host-independent',
        hostEarningsCoins: BigInt(5_000),
      });

      expect(result.processed).toBe(false);
      expect(result.reason).toBe('INDEPENDENT_HOST_NO_AGENCY');
      expect(mockWalletService.credit).not.toHaveBeenCalled();
    });
  });

  describe('4. Event-Driven Architecture & Domain Events', () => {
    it('should subscribe to revenue.distributed event upon module init', async () => {
      eventService.onModuleInit();
      expect(mockEventBus.subscribe).toHaveBeenCalledWith(
        'revenue.distributed',
        expect.any(Function),
      );
    });
  });
});
