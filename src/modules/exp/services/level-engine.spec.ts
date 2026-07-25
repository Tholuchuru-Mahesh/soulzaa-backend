import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { ExperienceHistoryService } from './experience-history.service';
import { ExperienceSourceService } from './experience-source.service';
import { ExperienceService } from './experience.service';
import { LevelAuditService } from './level-audit.service';
import { LevelCalculationService } from './level-calculation.service';
import { LevelConfigurationService } from './level-configuration.service';
import { LevelEventService } from './level-event.service';
import { LevelQueryService } from './level-query.service';
import { LevelService } from './level.service';
import { LevelStatisticsService } from './level-statistics.service';
import { LevelValidationService } from './level-validation.service';

describe('Phase 13: Enterprise Level & Experience Engine', () => {
  let experienceService: ExperienceService;
  let _levelService: LevelService;
  let _calculationService: LevelCalculationService;

  const mockPrismaService: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'user-1', status: 'ACTIVE' }),
    },
    userLevel: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn().mockResolvedValue(100),
      aggregate: jest.fn().mockResolvedValue({
        _avg: { currentLevel: 5.5 },
        _max: { currentLevel: 50 },
        _sum: { lifetimeExp: BigInt(500000) },
      }),
    },
    experienceSource: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ code: 'GIFT_SENT', name: 'Gift Sent', status: 'ACTIVE' }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ code: 'GIFT_SENT', name: 'Gift Sent', status: 'ACTIVE' }]),
    },
    experienceHistory: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hist-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    levelDefinition: {
      findMany: jest.fn().mockResolvedValue([
        { level: 1, requiredExp: BigInt(0), status: 'ACTIVE' },
        { level: 2, requiredExp: BigInt(100), status: 'ACTIVE' },
        { level: 3, requiredExp: BigInt(400), status: 'ACTIVE' },
        { level: 5, requiredExp: BigInt(1600), status: 'ACTIVE' },
        { level: 10, requiredExp: BigInt(8100), status: 'ACTIVE' },
      ]),
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue({ level: 5, requiredExp: BigInt(1600) }),
    },
    levelStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    levelAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    levelConfiguration: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(mockPrismaService);
      }
      return Promise.all(arg);
    }),
  };

  const mockConfigEngine = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'level.max') return Promise.resolve(100);
      if (key === 'level.default') return Promise.resolve(1);
      if (key === 'exp.daily_limit') return Promise.resolve(50000);
      return Promise.resolve(null);
    }),
  };

  const mockEventBus = {
    publish: jest.fn(),
    subscribe: jest.fn(),
  };

  const mockLockService = {
    withLock: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LevelConfigurationService,
        LevelValidationService,
        LevelCalculationService,
        ExperienceSourceService,
        ExperienceService,
        ExperienceHistoryService,
        LevelService,
        LevelAuditService,
        LevelStatisticsService,
        LevelQueryService,
        LevelEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockConfigEngine },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    experienceService = module.get<ExperienceService>(ExperienceService);
    _levelService = module.get<LevelService>(LevelService);
    _calculationService = module.get<LevelCalculationService>(LevelCalculationService);

    jest.clearAllMocks();
  });

  describe('1. EXP Addition & Single Level Up', () => {
    it('should award EXP and trigger a single level-up from Level 1 to Level 2', async () => {
      mockPrismaService.experienceHistory.findUnique.mockResolvedValue(null);
      mockPrismaService.userLevel.findUnique.mockResolvedValue({
        userId: 'user-1',
        currentLevel: 1,
        lifetimeExp: BigInt(0),
        dailyExp: BigInt(0),
      });

      const res = await experienceService.addExp({
        userId: 'user-1',
        amount: 150,
        sourceCode: 'GIFT_SENT',
        idempotencyKey: 'tx-001',
      });

      expect(res.duplicate).toBe(false);
      expect(res.currentLevel).toBe(2);
      expect(res.levelUps).toBe(1);
      expect(mockPrismaService.userLevel.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          data: expect.objectContaining({
            currentLevel: 2,
            lifetimeExp: BigInt(150),
          }),
        }),
      );
    });
  });

  describe('2. Multi-Level Jump Calculation', () => {
    it('should calculate a multi-level jump from Level 1 to Level 10 on a large EXP grant', async () => {
      mockPrismaService.experienceHistory.findUnique.mockResolvedValue(null);
      mockPrismaService.userLevel.findUnique.mockResolvedValue({
        userId: 'user-1',
        currentLevel: 1,
        lifetimeExp: BigInt(0),
        dailyExp: BigInt(0),
      });

      const res = await experienceService.addExp({
        userId: 'user-1',
        amount: 9000,
        sourceCode: 'GIFT_SENT',
        idempotencyKey: 'tx-002',
      });

      expect(res.currentLevel).toBe(10);
      expect(res.levelUps).toBe(9);
    });
  });

  describe('3. Idempotency Key Replay Protection', () => {
    it('should return existing record without double-awarding EXP when idempotency key is replayed', async () => {
      mockPrismaService.experienceHistory.findUnique.mockResolvedValue({
        id: 'hist-1',
        idempotencyKey: 'tx-001',
      });
      mockPrismaService.userLevel.findUnique.mockResolvedValue({
        userId: 'user-1',
        currentLevel: 2,
        lifetimeExp: BigInt(150),
      });

      const res = await experienceService.addExp({
        userId: 'user-1',
        amount: 150,
        sourceCode: 'GIFT_SENT',
        idempotencyKey: 'tx-001',
      });

      expect(res.duplicate).toBe(true);
      expect(res.levelUps).toBe(0);
      expect(mockPrismaService.userLevel.update).not.toHaveBeenCalled();
    });
  });

  describe('4. EXP Removal & Level Recalculation', () => {
    it('should deduct EXP and adjust current level accordingly', async () => {
      mockPrismaService.userLevel.findUnique.mockResolvedValue({
        userId: 'user-1',
        currentLevel: 3,
        lifetimeExp: BigInt(500),
      });

      const res = await experienceService.removeExp({
        userId: 'user-1',
        amount: 450,
        reason: 'Fraud reversal',
      });

      expect(res.currentLevel).toBe(1);
      expect(res.totalExp).toBe('50');
      expect(mockPrismaService.userLevel.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          data: expect.objectContaining({
            currentLevel: 1,
            lifetimeExp: BigInt(50),
          }),
        }),
      );
    });
  });
});
