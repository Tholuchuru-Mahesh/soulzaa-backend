import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { AchievementAuditService } from './achievement-audit.service';
import { AchievementConfigurationService } from './achievement-configuration.service';
import { AchievementEvaluationService } from './achievement-evaluation.service';
import { AchievementEventService } from './achievement-event.service';
import { AchievementProgressService } from './achievement-progress.service';
import { AchievementQueryService } from './achievement-query.service';
import { AchievementRewardService } from './achievement-reward.service';
import { AchievementService } from './achievement.service';
import { AchievementStatisticsService } from './achievement-statistics.service';
import { AchievementValidationService } from './achievement-validation.service';
import { BadgeService } from './badge.service';

describe('Phase 14: Enterprise Badge & Achievement Engine', () => {
  let achievementService: AchievementService;
  let badgeService: BadgeService;
  let progressService: AchievementProgressService;
  let evaluationService: AchievementEvaluationService;
  let rewardService: AchievementRewardService;
  let validationService: AchievementValidationService;
  let configService: AchievementConfigurationService;
  let statisticsService: AchievementStatisticsService;
  let auditService: AchievementAuditService;
  let queryService: AchievementQueryService;

  // ─── Mock Prisma ──────────────────────────────────────────────────────────

  const mockPrismaService: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'user-1', status: 'ACTIVE' }),
    },
    achievementDefinition: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(10),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    achievementProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    userAchievement: {
      create: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    badgeDefinition: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    badgeInventory: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    achievementHistory: {
      create: jest.fn().mockResolvedValue({ id: 'hist-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    achievementStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    achievementAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    achievementConfiguration: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const mockConfigEngine = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'achievement.max_progress') return Promise.resolve(10000);
      if (key === 'achievement.auto_claim') return Promise.resolve(true);
      if (key === 'badge.default_visibility') return Promise.resolve('PUBLIC');
      if (key === 'reward.claim_window') return Promise.resolve(30);
      return Promise.resolve(null);
    }),
  };

  const mockEventBus = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AchievementConfigurationService,
        AchievementValidationService,
        AchievementAuditService,
        AchievementEventService,
        AchievementStatisticsService,
        AchievementProgressService,
        AchievementRewardService,
        AchievementService,
        BadgeService,
        AchievementEvaluationService,
        AchievementQueryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockConfigEngine },
        { provide: EVENT_BUS, useValue: mockEventBus },
      ],
    }).compile();

    achievementService = module.get<AchievementService>(AchievementService);
    badgeService = module.get<BadgeService>(BadgeService);
    progressService = module.get<AchievementProgressService>(AchievementProgressService);
    evaluationService = module.get<AchievementEvaluationService>(AchievementEvaluationService);
    rewardService = module.get<AchievementRewardService>(AchievementRewardService);
    validationService = module.get<AchievementValidationService>(AchievementValidationService);
    configService = module.get<AchievementConfigurationService>(AchievementConfigurationService);
    statisticsService = module.get<AchievementStatisticsService>(AchievementStatisticsService);
    auditService = module.get<AchievementAuditService>(AchievementAuditService);
    queryService = module.get<AchievementQueryService>(AchievementQueryService);

    jest.clearAllMocks();
  });

  // ─── 1. Achievement Definition ────────────────────────────────────────────

  describe('1. Achievement Definition Creation', () => {
    it('should create a new achievement definition', async () => {
      const createdDef = {
        id: 'ach-1',
        code: 'GIFT_MASTER',
        name: 'Gift Master',
        category: 'GIFT',
        requiredProgress: 100,
        status: 'ACTIVE',
      };
      mockPrismaService.achievementDefinition.create.mockResolvedValue(createdDef);

      const result = await achievementService.createAchievement({
        code: 'GIFT_MASTER',
        name: 'Gift Master',
        category: 'GIFT',
        requiredProgress: 100,
        actorId: 'admin-1',
      });

      expect(result.code).toBe('GIFT_MASTER');
      expect(mockPrismaService.achievementDefinition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'GIFT_MASTER', category: 'GIFT' }),
        }),
      );
    });
  });

  // ─── 2. Achievement Unlock ────────────────────────────────────────────────

  describe('2. Achievement Unlock', () => {
    it('should unlock a non-repeatable achievement and publish event', async () => {
      const achDef = {
        id: 'ach-1',
        code: 'GIFT_MASTER',
        category: 'GIFT',
        requiredProgress: 100,
        status: 'ACTIVE',
        repeatable: false,
        badgeCode: null,
        rewardDefinition: {},
      };
      const unlockRecord = {
        id: 'unlock-1',
        userId: 'user-1',
        achievementId: 'ach-1',
        unlockedAt: new Date(),
        unlockIteration: 1,
      };

      mockPrismaService.achievementDefinition.findUnique.mockResolvedValue(achDef);
      mockPrismaService.userAchievement.findFirst.mockResolvedValue(null); // not yet unlocked
      mockPrismaService.userAchievement.count.mockResolvedValue(0);
      mockPrismaService.userAchievement.create.mockResolvedValue(unlockRecord);
      mockPrismaService.achievementProgress.updateMany.mockResolvedValue({});
      mockPrismaService.achievementStatistics.upsert.mockResolvedValue({});

      const result = await achievementService.unlockAchievement('user-1', 'ach-1');

      expect(result.id).toBe('unlock-1');
      expect(result.unlockIteration).toBe(1);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'achievement.unlocked' }),
      );
    });

    it('should throw if non-repeatable achievement is already unlocked', async () => {
      const achDef = {
        id: 'ach-1',
        status: 'ACTIVE',
        repeatable: false,
      };
      mockPrismaService.achievementDefinition.findUnique.mockResolvedValue(achDef);
      mockPrismaService.userAchievement.findFirst.mockResolvedValue({ id: 'existing-unlock' });

      await expect(achievementService.unlockAchievement('user-1', 'ach-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── 3. Achievement Progress Tracking ────────────────────────────────────

  describe('3. Progress Tracking', () => {
    it('should increment progress and detect threshold completion', async () => {
      mockPrismaService.achievementProgress.findUnique.mockResolvedValue({
        currentProgress: 90,
        requiredProgress: 100,
        isCompleted: false,
      });

      const result = await progressService.incrementProgress({
        userId: 'user-1',
        achievementId: 'ach-1',
        requiredProgress: 100,
        incrementBy: 15,
        eventCode: 'GIFT_SENT',
      });

      expect(result.progressAfter).toBe(100); // capped at required
      expect(result.justCompleted).toBe(true);
      expect(result.percentComplete).toBe(100);
    });

    it('should not re-complete already completed progress', async () => {
      mockPrismaService.achievementProgress.findUnique.mockResolvedValue({
        currentProgress: 100,
        requiredProgress: 100,
        isCompleted: true,
      });

      const result = await progressService.incrementProgress({
        userId: 'user-1',
        achievementId: 'ach-1',
        requiredProgress: 100,
        incrementBy: 10,
        eventCode: 'GIFT_SENT',
      });

      expect(result.justCompleted).toBe(false);
      expect(result.isCompleted).toBe(true);
    });

    it('should initialize progress from zero when no existing record', async () => {
      mockPrismaService.achievementProgress.findUnique.mockResolvedValue(null);

      const result = await progressService.incrementProgress({
        userId: 'user-1',
        achievementId: 'ach-1',
        requiredProgress: 10,
        incrementBy: 3,
        eventCode: 'GIFT_SENT',
      });

      expect(result.progressBefore).toBe(0);
      expect(result.progressAfter).toBe(3);
      expect(result.justCompleted).toBe(false);
    });
  });

  // ─── 4. Evaluation Engine ────────────────────────────────────────────────

  describe('4. Event Evaluation Engine', () => {
    it('should evaluate event and increment matching achievements', async () => {
      const achDef = {
        id: 'ach-1',
        code: 'GIFT_MASTER',
        category: 'GIFT',
        requiredProgress: 10,
        status: 'ACTIVE',
        repeatable: false,
        badgeCode: null,
        rewardDefinition: {},
        unlockRule: { eventCodes: ['GIFT_SENT'], operator: 'ANY' },
      };

      mockPrismaService.achievementDefinition.findMany.mockResolvedValue([achDef]);
      mockPrismaService.achievementProgress.findUnique.mockResolvedValue({
        currentProgress: 5,
        requiredProgress: 10,
        isCompleted: false,
      });

      const result = await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'GIFT_SENT',
        metadata: {},
      });

      expect(result.evaluated).toBe(1);
      expect(result.progressed).toBe(1);
    });

    it('should filter out achievements that do not listen to the event', async () => {
      const achDef = {
        id: 'ach-2',
        unlockRule: { eventCodes: ['LEVEL_UP'], operator: 'ANY' },
        status: 'ACTIVE',
        requiredProgress: 5,
        repeatable: false,
        badgeCode: null,
        rewardDefinition: {},
      };

      mockPrismaService.achievementDefinition.findMany.mockResolvedValue([achDef]);

      const result = await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'GIFT_SENT',
        metadata: {},
      });

      expect(result.evaluated).toBe(0);
      expect(result.progressed).toBe(0);
    });

    it('should apply GTE operator filtering', async () => {
      const achDef = {
        id: 'ach-3',
        unlockRule: { eventCodes: ['GIFT_SENT'], operator: 'GTE', field: 'amount', value: 100 },
        status: 'ACTIVE',
        requiredProgress: 1,
        repeatable: false,
        badgeCode: null,
        rewardDefinition: {},
      };

      mockPrismaService.achievementDefinition.findMany.mockResolvedValue([achDef]);
      mockPrismaService.achievementProgress.findUnique.mockResolvedValue(null);

      // amount below threshold — should NOT match
      const noMatch = await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'GIFT_SENT',
        metadata: { amount: 50 },
      });
      expect(noMatch.evaluated).toBe(0);

      // amount at threshold — should match
      mockPrismaService.achievementDefinition.findMany.mockResolvedValue([achDef]);
      const match = await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'GIFT_SENT',
        metadata: { amount: 100 },
      });
      expect(match.evaluated).toBe(1);
    });
  });

  // ─── 5. Badge Service ────────────────────────────────────────────────────

  describe('5. Badge Service', () => {
    it('should create a badge definition', async () => {
      const badgeDef = {
        code: 'GIFT_MASTER_GOLD',
        name: 'Gift Master (Gold)',
        tier: 'GOLD',
        badgeType: 'STANDARD',
      };
      mockPrismaService.badgeDefinition.create.mockResolvedValue(badgeDef);

      const result = await badgeService.createBadge({
        code: 'GIFT_MASTER_GOLD',
        name: 'Gift Master (Gold)',
        tier: 'GOLD',
      });

      expect(result.code).toBe('GIFT_MASTER_GOLD');
      expect(result.tier).toBe('GOLD');
    });

    it('should equip a badge from user inventory', async () => {
      const existingInventory = {
        id: 'inv-1',
        userId: 'user-1',
        badgeCode: 'GIFT_MASTER_GOLD',
        equipped: false,
      };
      const equippedInventory = { ...existingInventory, equipped: true, equippedAt: new Date() };

      mockPrismaService.badgeInventory.findUnique.mockResolvedValue(existingInventory);
      mockPrismaService.badgeInventory.updateMany.mockResolvedValue({});
      mockPrismaService.badgeInventory.update.mockResolvedValue(equippedInventory);

      const result = await badgeService.equipBadge('user-1', 'GIFT_MASTER_GOLD');

      expect(result.equipped).toBe(true);
      expect(mockPrismaService.badgeInventory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', equipped: true } }),
      );
    });

    it('should throw if user does not own badge being equipped', async () => {
      mockPrismaService.badgeInventory.findUnique.mockResolvedValue(null);

      await expect(badgeService.equipBadge('user-1', 'MISSING_BADGE')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── 6. Reward Claim Service ─────────────────────────────────────────────

  describe('6. Reward Claim', () => {
    it('should claim a reward and publish event', async () => {
      const unlockRecord = {
        id: 'unlock-1',
        rewardClaimed: false,
        userId: 'user-1',
        achievementId: 'ach-1',
      };
      mockPrismaService.userAchievement.findUnique.mockResolvedValue(unlockRecord);
      mockPrismaService.userAchievement.update.mockResolvedValue({
        ...unlockRecord,
        rewardClaimed: true,
        claimedAt: new Date(),
      });

      const result = await rewardService.claimReward(
        'user-1',
        'unlock-1',
        { type: 'EXP', amount: 500 },
        'admin-1',
      );

      expect(result).toBeTruthy();
      expect((result as any).alreadyClaimed).toBe(false);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'achievement.reward_claimed' }),
      );
    });

    it('should return alreadyClaimed: true if reward is already claimed', async () => {
      mockPrismaService.userAchievement.findUnique.mockResolvedValue({
        id: 'unlock-1',
        rewardClaimed: true,
      });

      const result = await rewardService.claimReward('user-1', 'unlock-1', { type: 'EXP' });
      expect((result as any).alreadyClaimed).toBe(true);
    });
  });

  // ─── 7. Validation Service ────────────────────────────────────────────────

  describe('7. Validation Service', () => {
    it('should throw NotFoundException for missing user', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      await expect(validationService.validateUserExists('missing-user')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for missing achievement', async () => {
      mockPrismaService.achievementDefinition.findUnique.mockResolvedValue(null);
      await expect(validationService.validateAchievementExists('missing-ach')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for inactive achievement', async () => {
      mockPrismaService.achievementDefinition.findUnique.mockResolvedValue({
        id: 'ach-1',
        status: 'INACTIVE',
      });
      await expect(validationService.validateAchievementExists('ach-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── 8. Configuration Service ─────────────────────────────────────────────

  describe('8. Configuration Service', () => {
    it('should return configuration parameters from platform config', async () => {
      const params = await configService.getParameters();
      expect(params.maxProgress).toBe(10000);
      expect(params.autoClaim).toBe(true);
      expect(params.rewardClaimWindowDays).toBe(30);
    });
  });

  // ─── 9. Statistics Service ────────────────────────────────────────────────

  describe('9. Statistics Service', () => {
    it('should increment unlock count in statistics', async () => {
      await statisticsService.incrementUnlocks();
      expect(mockPrismaService.achievementStatistics.upsert).toHaveBeenCalled();
    });

    it('should return platform statistics summary', async () => {
      mockPrismaService.achievementDefinition.count.mockResolvedValue(50);
      mockPrismaService.userAchievement.count.mockResolvedValue(1200);
      mockPrismaService.badgeInventory.count.mockResolvedValue(800);
      mockPrismaService.badgeDefinition.count.mockResolvedValue(5);
      mockPrismaService.achievementStatistics.findMany.mockResolvedValue([]);
      mockPrismaService.userAchievement.groupBy.mockResolvedValue([]);

      const summary = await statisticsService.getPlatformSummary();

      expect(summary.totalDefinitions).toBe(50);
      expect(summary.totalUnlocks).toBe(1200);
    });
  });

  // ─── 10. Audit Service ────────────────────────────────────────────────────

  describe('10. Audit Service', () => {
    it('should create an audit log entry', async () => {
      await auditService.logAudit('ACHIEVEMENT_UNLOCKED', 'user-1', 'admin-1', { code: 'TEST' });
      expect(mockPrismaService.achievementAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACHIEVEMENT_UNLOCKED' }),
        }),
      );
    });

    it('should return paginated audit logs', async () => {
      mockPrismaService.achievementAudit.findMany.mockResolvedValue([{ id: 'audit-1' }]);
      mockPrismaService.achievementAudit.count.mockResolvedValue(1);

      const result = await auditService.getAuditLogs('user-1', undefined, 10, 0);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });
  });

  // ─── 11. Query Service ────────────────────────────────────────────────────

  describe('11. Query Service', () => {
    it('should return top achievers', async () => {
      mockPrismaService.userAchievement.groupBy.mockResolvedValue([
        { userId: 'user-1', _count: { achievementId: 25 } },
      ]);

      const result = await queryService.getTopAchievers(10);
      expect(result).toHaveLength(1);
    });
  });

  // ─── 12. Concurrency: Duplicate Unlock Guard ─────────────────────────────

  describe('12. Concurrency & Duplicate Unlock Guard', () => {
    it('should not allow double-unlock of non-repeatable achievement', async () => {
      const achDef = {
        id: 'ach-1',
        status: 'ACTIVE',
        repeatable: false,
      };
      // Achievement already unlocked
      mockPrismaService.achievementDefinition.findUnique.mockResolvedValue(achDef);
      mockPrismaService.userAchievement.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(achievementService.unlockAchievement('user-1', 'ach-1')).rejects.toThrow(
        BadRequestException,
      );

      // Should NOT create duplicate unlock
      expect(mockPrismaService.userAchievement.create).not.toHaveBeenCalled();
    });
  });
});
