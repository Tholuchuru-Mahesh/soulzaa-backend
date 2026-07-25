import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import { LeaderboardService } from './leaderboard.service';
import { RankingAggregationService } from './ranking-aggregation.service';
import { RankingAuditService } from './ranking-audit.service';
import { RankingCalculationService } from './ranking-calculation.service';
import { RankingConfigurationService } from './ranking-configuration.service';
import { RankingEventService } from './ranking-event.service';
import { RankingQueryService } from './ranking-query.service';
import { RankingService } from './ranking.service';
import { RankingSnapshotService } from './ranking-snapshot.service';
import { RankingStatisticsService } from './ranking-statistics.service';
import { RankingValidationService } from './ranking-validation.service';

describe('Phase 15: Enterprise Ranking Engine', () => {
  let rankingService: RankingService;
  let calculationService: RankingCalculationService;
  let aggregationService: RankingAggregationService;
  let snapshotService: RankingSnapshotService;
  let leaderboardService: LeaderboardService;
  let validationService: RankingValidationService;
  let _configService: RankingConfigurationService;
  let statisticsService: RankingStatisticsService;
  let auditService: RankingAuditService;
  let _queryService: RankingQueryService;

  const mockPrismaService: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
    userStatistics: { findMany: jest.fn().mockResolvedValue([]) },
    family: { findMany: jest.fn().mockResolvedValue([]) },
    rankingDefinition: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(5),
    },
    rankingEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'entry-1', score: BigInt(100), rank: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      $transaction: jest.fn().mockResolvedValue([]),
    },
    enterpriseRankingSnapshot: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    rankingHistory: {
      create: jest.fn().mockResolvedValue({ id: 'hist-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    rankingStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rankingAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    rankingConfiguration: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn().mockImplementation((promises) => Promise.all(promises)),
  };

  const mockConfigEngine = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'ranking.refresh_interval') return Promise.resolve(300);
      if (key === 'ranking.snapshot_interval') return Promise.resolve(86400);
      if (key === 'ranking.max_entries') return Promise.resolve(1000);
      return Promise.resolve(null);
    }),
  };

  const mockLeaderboardStore = {
    top: jest.fn().mockResolvedValue([]),
  };

  const mockEventBus = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RankingConfigurationService,
        RankingValidationService,
        RankingAuditService,
        RankingEventService,
        RankingStatisticsService,
        RankingCalculationService,
        RankingAggregationService,
        RankingSnapshotService,
        RankingService,
        LeaderboardService,
        RankingQueryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockConfigEngine },
        { provide: LeaderboardStore, useValue: mockLeaderboardStore },
        { provide: EVENT_BUS, useValue: mockEventBus },
      ],
    }).compile();

    rankingService = module.get<RankingService>(RankingService);
    calculationService = module.get<RankingCalculationService>(RankingCalculationService);
    aggregationService = module.get<RankingAggregationService>(RankingAggregationService);
    snapshotService = module.get<RankingSnapshotService>(RankingSnapshotService);
    leaderboardService = module.get<LeaderboardService>(LeaderboardService);
    validationService = module.get<RankingValidationService>(RankingValidationService);
    _configService = module.get<RankingConfigurationService>(RankingConfigurationService);
    statisticsService = module.get<RankingStatisticsService>(RankingStatisticsService);
    auditService = module.get<RankingAuditService>(RankingAuditService);
    _queryService = module.get<RankingQueryService>(RankingQueryService);

    jest.clearAllMocks();
  });

  // ─── 1. Ranking Definition Creation ──────────────────────────────────────

  describe('1. Ranking Definition Creation', () => {
    it('should create a ranking definition with valid category', async () => {
      const created = {
        id: 'rank-1',
        code: 'DAILY_GIFTERS',
        name: 'Daily Top Gifters',
        category: 'GIFT_SENDER',
        status: 'ACTIVE',
      };
      mockPrismaService.rankingDefinition.create.mockResolvedValue(created);

      const result = await rankingService.createRanking({
        code: 'DAILY_GIFTERS',
        name: 'Daily Top Gifters',
        category: 'GIFT_SENDER',
      });

      expect(result.code).toBe('DAILY_GIFTERS');
      expect(mockPrismaService.rankingDefinition.create).toHaveBeenCalled();
    });

    it('should throw on invalid category', async () => {
      await expect(
        rankingService.createRanking({
          code: 'BAD',
          name: 'Bad',
          category: 'INVALID_CATEGORY' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── 2. Calculation Engine & Scoring Formulas ─────────────────────────────

  describe('2. Scoring Calculation Engine', () => {
    it('should apply multiplier from JSON score formula', async () => {
      const rankingDef = {
        id: 'rank-1',
        code: 'GIFTERS',
        status: 'ACTIVE',
        timeWindow: 'DAILY',
        category: 'GIFT_SENDER',
        scoreFormula: { multiplier: 2.0 },
      };
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue(rankingDef);
      mockPrismaService.rankingEntry.findUnique.mockResolvedValue(null);
      mockPrismaService.rankingEntry.findMany.mockResolvedValue([
        { id: 'entry-1', entityId: 'user-1', score: BigInt(200), rank: 0 },
      ]);

      const result = await calculationService.applyScore({
        rankingId: 'rank-1',
        entityId: 'user-1',
        entityType: 'USER',
        eventCode: 'GIFT_SENT',
        scoreDelta: 100,
      });

      expect(result.scoreAfter).toBe(BigInt(200)); // 100 * 2.0
    });

    it('should calculate promotion/demotion correctly', async () => {
      const rankingDef = {
        id: 'rank-1',
        status: 'ACTIVE',
        timeWindow: 'DAILY',
        category: 'GIFT_SENDER',
        scoreFormula: null,
      };
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue(rankingDef);
      // Entity was previously rank 5
      mockPrismaService.rankingEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        score: BigInt(100),
        rank: 5,
      });
      // After update, entity moves to rank 1
      mockPrismaService.rankingEntry.findMany.mockResolvedValue([
        { id: 'entry-1', entityId: 'user-1', score: BigInt(500), rank: 5 },
        { id: 'entry-2', entityId: 'user-2', score: BigInt(300), rank: 1 },
      ]);

      const result = await calculationService.applyScore({
        rankingId: 'rank-1',
        entityId: 'user-1',
        entityType: 'USER',
        eventCode: 'GIFT_SENT',
        scoreDelta: 400,
      });

      expect(result.promoted).toBe(true);
      expect(result.demoted).toBe(false);
    });
  });

  // ─── 3. Aggregation Engine (Fan-out) ─────────────────────────────────────

  describe('3. Aggregation Engine', () => {
    it('should aggregate an event across matching ranking definitions', async () => {
      const def1 = {
        id: 'rank-1',
        status: 'ACTIVE',
        timeWindow: 'DAILY',
        category: 'GIFT_SENDER',
        scoreFormula: { eventCodes: ['GIFT_SENT'] },
      };
      mockPrismaService.rankingDefinition.findMany.mockResolvedValue([def1]);
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue(def1);

      const results = await aggregationService.aggregateByEventCode({
        entityId: 'user-1',
        entityType: 'USER',
        eventCode: 'GIFT_SENT',
        rawScore: 50,
      });

      expect(results).toHaveLength(1);
    });

    it('should enforce max entries limit', async () => {
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue({
        id: 'rank-1',
        maxEntries: 10,
      });
      mockPrismaService.rankingEntry.count.mockResolvedValue(15);
      mockPrismaService.rankingEntry.findMany.mockResolvedValue([
        { id: 'e-11' },
        { id: 'e-12' },
        { id: 'e-13' },
        { id: 'e-14' },
        { id: 'e-15' },
      ]);

      await aggregationService.enforceMaxEntries('rank-1', '20260723');

      expect(mockPrismaService.rankingEntry.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['e-11', 'e-12', 'e-13', 'e-14', 'e-15'] } },
      });
    });
  });

  // ─── 4. Snapshot Engine ──────────────────────────────────────────────────

  describe('4. Snapshot Engine', () => {
    it('should create snapshot from active ranking entries', async () => {
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue({
        id: 'rank-1',
        status: 'ACTIVE',
      });
      mockPrismaService.enterpriseRankingSnapshot.count.mockResolvedValue(0);
      mockPrismaService.rankingEntry.findMany.mockResolvedValue([
        { entityId: 'user-1', entityType: 'USER', rank: 1, score: BigInt(500) },
      ]);

      const result = await snapshotService.takeSnapshot({
        rankingId: 'rank-1',
        period: 'DAILY',
        dateKey: '20260723',
      });

      expect(result.skipped).toBe(false);
      expect(result.count).toBe(1);
      expect(mockPrismaService.enterpriseRankingSnapshot.createMany).toHaveBeenCalled();
    });

    it('should skip snapshot if dateKey already exists', async () => {
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue({
        id: 'rank-1',
        status: 'ACTIVE',
      });
      mockPrismaService.enterpriseRankingSnapshot.count.mockResolvedValue(10); // exists

      const result = await snapshotService.takeSnapshot({
        rankingId: 'rank-1',
        period: 'DAILY',
        dateKey: '20260723',
      });

      expect(result.skipped).toBe(true);
    });
  });

  // ─── 5. Leaderboard Service ──────────────────────────────────────────────

  describe('5. Leaderboard Service', () => {
    it('should return paginated hydrated leaderboard entries', async () => {
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue({
        id: 'rank-1',
        status: 'ACTIVE',
        timeWindow: 'DAILY',
        entityType: 'USER',
      });
      mockPrismaService.rankingEntry.findMany.mockResolvedValue([
        {
          rank: 1,
          previousRank: null,
          rankDelta: 0,
          entityId: 'user-1',
          entityType: 'USER',
          score: BigInt(1000),
        },
      ]);
      mockPrismaService.rankingEntry.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([
        { id: 'user-1', username: 'john', fullName: 'John Doe' },
      ]);

      const result = await leaderboardService.getLeaderboard('rank-1', '20260723', 10, 0);

      expect(result.total).toBe(1);
      expect(result.items[0].entityDetails?.username).toBe('john');
    });
  });

  // ─── 6. Validation Service ────────────────────────────────────────────────

  describe('6. Validation Service', () => {
    it('should throw NotFoundException for missing ranking', async () => {
      mockPrismaService.rankingDefinition.findUnique.mockResolvedValue(null);
      await expect(
        validationService.validateRankingDefinitionExists('missing-rank'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid time window', () => {
      expect(() => validationService.validateTimeWindow('INVALID_WINDOW')).toThrow(
        BadRequestException,
      );
    });
  });

  // ─── 7. Statistics & Audit ────────────────────────────────────────────────

  describe('7. Statistics & Audit', () => {
    it('should log audit entries', async () => {
      await auditService.logAudit('RANKING_CREATED', 'rank-1', 'admin-1', { code: 'TEST' });
      expect(mockPrismaService.rankingAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'RANKING_CREATED' }),
        }),
      );
    });

    it('should return platform summary', async () => {
      const summary = await statisticsService.getPlatformSummary();
      expect(summary.totalDefinitions).toBe(5);
    });
  });
});
