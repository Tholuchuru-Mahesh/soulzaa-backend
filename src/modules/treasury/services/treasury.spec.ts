import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { FeatureFlagService } from 'src/modules/platform-configuration/services/feature-flag.service';
import { CoinEconomyService } from './coin-economy.service';
import { FinancialHealthService } from './financial-health.service';
import { FinancialPolicyService } from './financial-policy.service';
import { RiskManagementService } from './risk-management.service';
import { TreasuryAuditService } from './treasury-audit.service';
import { TreasurySeederService } from './treasury-seeder.service';
import { TreasuryService } from './treasury.service';

describe('TreasuryModule Shared Services', () => {
  let treasuryService: TreasuryService;
  let economyService: CoinEconomyService;
  let policyService: FinancialPolicyService;
  let healthService: FinancialHealthService;
  let riskService: RiskManagementService;
  let _auditService: TreasuryAuditService;
  let seederService: TreasurySeederService;

  const mockPrismaService = {
    // Circulating, reserved and treasury balances are now summed from the
    // wallet table rather than read off the reserve row; only maxSupply and
    // isFrozen still come from the reserve. These sums reproduce the same
    // figures the assertions below have always described.
    wallet: {
      aggregate: jest.fn().mockImplementation(({ where }: { where: { type: unknown } }) =>
        where.type === 'USER_WALLET'
          ? {
              _sum: {
                availableBalance: BigInt('500000000'),
                lockedBalance: BigInt('60000000'),
                reservedBalance: BigInt('30000000'),
                pendingBalance: BigInt('10000000'),
              },
            }
          : {
              _sum: {
                availableBalance: BigInt('400000000'),
                lockedBalance: BigInt('0'),
              },
            },
      ),
    },
    treasuryReserve: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    financialPolicy: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    treasuryLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockFeatureFlagService = {
    isEnabled: jest.fn(),
    enableFlag: jest.fn(),
    disableFlag: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TreasuryAuditService,
        TreasuryService,
        CoinEconomyService,
        FinancialPolicyService,
        FinancialHealthService,
        RiskManagementService,
        TreasurySeederService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: FeatureFlagService, useValue: mockFeatureFlagService },
      ],
    }).compile();

    treasuryService = module.get<TreasuryService>(TreasuryService);
    economyService = module.get<CoinEconomyService>(CoinEconomyService);
    policyService = module.get<FinancialPolicyService>(FinancialPolicyService);
    healthService = module.get<FinancialHealthService>(FinancialHealthService);
    riskService = module.get<RiskManagementService>(RiskManagementService);
    _auditService = module.get<TreasuryAuditService>(TreasuryAuditService);
    seederService = module.get<TreasurySeederService>(TreasurySeederService);

    jest.clearAllMocks();
  });

  describe('TreasuryService', () => {
    it('should return treasury reserve summary metrics', async () => {
      mockPrismaService.treasuryReserve.findFirst.mockResolvedValue({
        id: 'res-id',
        maxSupply: BigInt('1000000000000'),
        circulatingSupply: BigInt('500000000'),
        reservedSupply: BigInt('100000000'),
        treasuryBalance: BigInt('400000000'),
        isFrozen: false,
        updatedAt: new Date(),
      });

      const summary = await treasuryService.getTreasurySummary();
      expect(summary.maxSupply).toBe('1000000000000');
      expect(summary.circulatingSupply).toBe('500000000');
      expect(summary.treasuryBalance).toBe('400000000');
    });
  });

  describe('CoinEconomyService', () => {
    it('should calculate available mintable supply correctly', async () => {
      mockPrismaService.treasuryReserve.findFirst.mockResolvedValue({
        id: 'res-id',
        maxSupply: BigInt('1000000000000'),
        circulatingSupply: BigInt('500000000'),
        reservedSupply: BigInt('100000000'),
        treasuryBalance: BigInt('400000000'),
        isFrozen: false,
        updatedAt: new Date(),
      });

      const state = await economyService.getCoinEconomyState();
      expect(state.economyStatus).toBe('ACTIVE');
      expect(state.availableMintable).toBe('999000000000');
    });
  });

  describe('FinancialHealthService', () => {
    it('should compute reserve ratio percentage and health status', async () => {
      mockPrismaService.treasuryReserve.findFirst.mockResolvedValue({
        id: 'res-id',
        maxSupply: BigInt('1000000000000'),
        circulatingSupply: BigInt('500000000'),
        reservedSupply: BigInt('100000000'),
        treasuryBalance: BigInt('400000000'),
        isFrozen: false,
        updatedAt: new Date(),
      });

      const health = await healthService.getFinancialHealth();
      expect(health.reserveRatioPercentage).toBe(80);
      expect(health.healthStatus).toBe('HEALTHY');
    });
  });

  describe('FinancialPolicyService', () => {
    it('should validate policy cap correctly', async () => {
      mockPrismaService.financialPolicy.findUnique.mockResolvedValue({
        key: 'max_gift_amount',
        value: BigInt(500000),
        isEditable: true,
        minLimit: null,
        maxLimit: null,
      });

      const isValid = await policyService.validatePolicyLimit('max_gift_amount', 300000);
      expect(isValid).toBe(true);

      const isExceeded = await policyService.validatePolicyLimit('max_gift_amount', 600000);
      expect(isExceeded).toBe(false);
    });
  });

  describe('RiskManagementService', () => {
    it('should execute emergency freeze across economy and feature flags', async () => {
      mockPrismaService.treasuryReserve.findFirst.mockResolvedValue({ id: 'res-id' });
      mockPrismaService.treasuryReserve.update.mockResolvedValue({});
      mockPrismaService.treasuryLog.create.mockResolvedValue({});

      const freezeResult = await riskService.freezeEconomy('ALL', 'Emergency freeze triggered');
      expect(freezeResult.isFrozen).toBe(true);
      expect(mockFeatureFlagService.disableFlag).toHaveBeenCalledWith(
        'feature.wallet.enabled',
        'Emergency freeze triggered',
        undefined,
      );
      expect(mockFeatureFlagService.disableFlag).toHaveBeenCalledWith(
        'feature.gifts.enabled',
        'Emergency freeze triggered',
        undefined,
      );
    });
  });

  describe('TreasurySeederService', () => {
    it('should seed default treasury reserve and policies', async () => {
      mockPrismaService.treasuryReserve.findFirst.mockResolvedValue(null);
      mockPrismaService.treasuryReserve.create.mockResolvedValue({});
      // Policies are seeded find-then-create (not upsert) so a concurrent seeder
      // losing the unique-constraint race can be swallowed.
      mockPrismaService.financialPolicy.findUnique.mockResolvedValue(null);
      mockPrismaService.financialPolicy.create.mockResolvedValue({});

      await seederService.seedDefaults();
      expect(mockPrismaService.treasuryReserve.create).toHaveBeenCalled();
      expect(mockPrismaService.financialPolicy.create).toHaveBeenCalled();
    });
  });
});
