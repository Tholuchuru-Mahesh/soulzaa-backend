import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskQueryService } from 'src/modules/tasks/services/task-query.service';
import { ModeratorPerformanceService } from './moderator-performance.service';

const MODERATOR_ID = 'mod-1';
const TODAY = new Date().toISOString().slice(0, 10);

describe('ModeratorPerformanceService', () => {
  let prisma: {
    moderatorDailyStats: {
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let tasks: { moderatorAssignmentSummary: jest.Mock };
  let service: ModeratorPerformanceService;

  beforeEach(() => {
    prisma = {
      moderatorDailyStats: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    tasks = { moderatorAssignmentSummary: jest.fn() };
    service = new ModeratorPerformanceService(
      prisma as unknown as PrismaService,
      tasks as unknown as TaskQueryService,
    );
  });

  describe('recordReportResolution', () => {
    it('creates the row with the raw resolution time when none exists yet today', async () => {
      prisma.moderatorDailyStats.findUnique.mockResolvedValue(null);

      await service.recordReportResolution(MODERATOR_ID, 30);

      expect(prisma.moderatorDailyStats.create).toHaveBeenCalledWith({
        data: {
          moderatorId: MODERATOR_ID,
          dateKey: TODAY,
          reportsResolved: 1,
          avgResolutionMinutes: 30,
          avgResponseTime: 30,
        },
      });
    });

    it('folds a new resolution into the running average, weighted by prior count', async () => {
      prisma.moderatorDailyStats.findUnique.mockResolvedValue({
        reportsResolved: 3,
        avgResolutionMinutes: 10,
      });

      await service.recordReportResolution(MODERATOR_ID, 30);

      // (10*3 + 30) / 4 = 15
      expect(prisma.moderatorDailyStats.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reportsResolved: { increment: 1 },
            avgResolutionMinutes: 15,
            avgResponseTime: 15,
          }),
        }),
      );
    });

    it('swallows errors rather than letting a stats-write failure break the caller', async () => {
      prisma.moderatorDailyStats.findUnique.mockRejectedValue(new Error('db down'));
      await expect(service.recordReportResolution(MODERATOR_ID, 5)).resolves.toBeUndefined();
    });
  });

  describe('recordFalseModeration', () => {
    it('increments falseModerationCount and deducts the penalty from performanceScore', async () => {
      prisma.moderatorDailyStats.findUnique.mockResolvedValue({
        falseModerationCount: 0,
        performanceScore: 10,
      });
      prisma.moderatorDailyStats.update.mockResolvedValue({
        falseModerationCount: 1,
        performanceScore: 10,
      });

      await service.recordFalseModeration(MODERATOR_ID);

      expect(prisma.moderatorDailyStats.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { falseModerationCount: { increment: 1 } },
        }),
      );
      expect(prisma.moderatorDailyStats.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { performanceScore: 7 },
        }),
      );
    });

    it('never drops the score below zero', async () => {
      prisma.moderatorDailyStats.findUnique.mockResolvedValue({
        falseModerationCount: 0,
        performanceScore: 1,
      });
      prisma.moderatorDailyStats.update.mockResolvedValue({
        falseModerationCount: 1,
        performanceScore: 1,
      });

      await service.recordFalseModeration(MODERATOR_ID);

      expect(prisma.moderatorDailyStats.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { performanceScore: 0 } }),
      );
    });

    it('creates a fresh row when the moderator has no stats yet today', async () => {
      prisma.moderatorDailyStats.findUnique.mockResolvedValue(null);
      prisma.moderatorDailyStats.create.mockResolvedValue({
        falseModerationCount: 1,
        performanceScore: 0,
      });

      await service.recordFalseModeration(MODERATOR_ID);

      expect(prisma.moderatorDailyStats.create).toHaveBeenCalledWith({
        data: { moderatorId: MODERATOR_ID, dateKey: TODAY, falseModerationCount: 1 },
      });
    });
  });

  describe('getSummary', () => {
    it('merges task completion and target-vs-actual into the summary', async () => {
      prisma.moderatorDailyStats.findUnique.mockResolvedValue({
        reportsReviewed: 5,
        dailyTarget: 20,
        weeklyTarget: 100,
        monthlyTarget: 400,
      });
      prisma.moderatorDailyStats.findMany.mockResolvedValue([]);
      tasks.moderatorAssignmentSummary.mockResolvedValue({
        assigned: 10,
        completed: 6,
        pending: 4,
        overdue: 1,
        overduePercentage: 10,
      });

      const summary = await service.getSummary(MODERATOR_ID);

      expect(summary.taskCompletion).toEqual({
        assigned: 10,
        completed: 6,
        pending: 4,
        overdue: 1,
        overduePercentage: 10,
      });
      expect(summary.targets.daily).toEqual({ target: 20, actual: 5 });
      expect(tasks.moderatorAssignmentSummary).toHaveBeenCalledWith(MODERATOR_ID);
    });

    it('reports null task completion when TaskQueryService is not wired', async () => {
      const bareService = new ModeratorPerformanceService(prisma as unknown as PrismaService);
      prisma.moderatorDailyStats.findUnique.mockResolvedValue(null);
      prisma.moderatorDailyStats.findMany.mockResolvedValue([]);

      const summary = await bareService.getSummary(MODERATOR_ID);

      expect(summary.taskCompletion).toBeNull();
      expect(summary.targets.daily).toEqual({ target: 20, actual: 0 });
    });
  });
});
