import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { MissionProgressService } from './mission-progress.service';
import { MissionService } from './mission.service';
import { TaskAuditService } from './task-audit.service';
import { TaskConfigurationService } from './task-configuration.service';
import { TaskEvaluationService } from './task-evaluation.service';
import { TaskEventService } from './task-event.service';
import { TaskProgressService } from './task-progress.service';
import { TaskQueryService } from './task-query.service';
import { TaskRewardService } from './task-reward.service';
import { TaskService } from './task.service';
import { TaskStatisticsService } from './task-statistics.service';
import { TaskValidationService } from './task-validation.service';

describe('Phase 17: Enterprise Tasks & Missions Engine', () => {
  let taskService: TaskService;
  let missionService: MissionService;
  let progressService: TaskProgressService;
  let missionProgressService: MissionProgressService;
  let evaluationService: TaskEvaluationService;
  let rewardService: TaskRewardService;
  let validationService: TaskValidationService;
  let _configService: TaskConfigurationService;
  let statisticsService: TaskStatisticsService;
  let auditService: TaskAuditService;
  let _queryService: TaskQueryService;

  const mockPrismaService: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
    },
    missionDefinition: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    taskDefinition: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(10),
    },
    taskProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({
        id: 'prog-1',
        currentProgress: 1,
        percentComplete: 100,
        isCompleted: true,
        completionCount: 1,
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    missionProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'mprog-1', isCompleted: true }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    taskReward: {
      create: jest.fn().mockResolvedValue({ id: 'rew-1', claimed: true }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    taskHistory: {
      create: jest.fn().mockResolvedValue({ id: 'hist-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    taskStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    taskAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    taskConfiguration: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const mockConfigEngine = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'task.daily_reset') return Promise.resolve('00:00');
      if (key === 'task.max_progress') return Promise.resolve(1000000);
      if (key === 'task.auto_claim') return Promise.resolve(true);
      return Promise.resolve(null);
    }),
  };

  const mockEventBus = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskConfigurationService,
        TaskValidationService,
        TaskAuditService,
        TaskEventService,
        TaskStatisticsService,
        TaskProgressService,
        MissionProgressService,
        TaskRewardService,
        TaskEvaluationService,
        TaskService,
        MissionService,
        TaskQueryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockConfigEngine },
        { provide: EVENT_BUS, useValue: mockEventBus },
      ],
    }).compile();

    taskService = module.get<TaskService>(TaskService);
    missionService = module.get<MissionService>(MissionService);
    progressService = module.get<TaskProgressService>(TaskProgressService);
    missionProgressService = module.get<MissionProgressService>(MissionProgressService);
    evaluationService = module.get<TaskEvaluationService>(TaskEvaluationService);
    rewardService = module.get<TaskRewardService>(TaskRewardService);
    validationService = module.get<TaskValidationService>(TaskValidationService);
    _configService = module.get<TaskConfigurationService>(TaskConfigurationService);
    statisticsService = module.get<TaskStatisticsService>(TaskStatisticsService);
    auditService = module.get<TaskAuditService>(TaskAuditService);
    _queryService = module.get<TaskQueryService>(TaskQueryService);

    jest.clearAllMocks();
  });

  // ─── 1. Task & Mission Definition Creation ────────────────────────────────

  describe('1. Task & Mission Definition Creation', () => {
    it('should create a task definition', async () => {
      const created = {
        id: 'task-1',
        code: 'DAILY_GIFT',
        name: 'Send 1 Gift',
        category: 'DAILY_TASK',
        status: 'ACTIVE',
      };
      mockPrismaService.taskDefinition.create.mockResolvedValue(created);

      const result = await taskService.createTask({
        code: 'DAILY_GIFT',
        name: 'Send 1 Gift',
        category: 'DAILY_TASK',
        objective: 'Send 1 gift in any room',
      });

      expect(result.code).toBe('DAILY_GIFT');
      expect(mockPrismaService.taskDefinition.create).toHaveBeenCalled();
    });

    it('should create a mission definition', async () => {
      const createdMission = {
        id: 'mission-1',
        code: 'WEEKLY_MASTER',
        name: 'Weekly Master',
        category: 'WEEKLY_MISSION',
        status: 'ACTIVE',
      };
      mockPrismaService.missionDefinition.create.mockResolvedValue(createdMission);

      const result = await missionService.createMission({
        code: 'WEEKLY_MASTER',
        name: 'Weekly Master',
        category: 'WEEKLY_MISSION',
      });

      expect(result.code).toBe('WEEKLY_MASTER');
      expect(mockPrismaService.missionDefinition.create).toHaveBeenCalled();
    });

    it('should throw on invalid category', async () => {
      await expect(
        taskService.createTask({
          code: 'BAD_CAT',
          name: 'Bad',
          category: 'INVALID_CATEGORY' as any,
          objective: 'Test',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── 2. Progress Tracking & Threshold Completion ─────────────────────────

  describe('2. Progress Tracking', () => {
    it('should increment task progress and detect completion', async () => {
      mockPrismaService.taskProgress.findUnique.mockResolvedValue({
        currentProgress: 4,
        requiredProgress: 5,
        percentComplete: 80,
        isCompleted: false,
        completionCount: 0,
      });

      const result = await progressService.incrementProgress({
        userId: 'user-1',
        taskId: 'task-1',
        requiredProgress: 5,
        incrementBy: 1,
        eventCode: 'GIFT_SENT',
      });

      expect(result.progressAfter).toBe(5);
      expect(result.percentComplete).toBe(100);
      expect(result.justCompleted).toBe(true);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'task.completed' }),
      );
    });

    it('should build correct period keys for reset policies', () => {
      const dailyKey = progressService.buildPeriodKey('DAILY');
      expect(dailyKey).toMatch(/^\d{8}$/);

      const weeklyKey = progressService.buildPeriodKey('WEEKLY');
      expect(weeklyKey).toMatch(/^\d{4}W\d{2}$/);

      const noneKey = progressService.buildPeriodKey('NONE');
      expect(noneKey).toBe('alltime');
    });
  });

  // ─── 3. Mission Progress ──────────────────────────────────────────────────

  describe('3. Mission Progress', () => {
    it('should complete mission when required task count is met', async () => {
      const missionDef = {
        id: 'mission-1',
        requiredTaskCount: 2,
        tasks: [{ id: 'task-1' }, { id: 'task-2' }],
      };
      mockPrismaService.missionDefinition.findUnique.mockResolvedValue(missionDef);
      mockPrismaService.taskProgress.count.mockResolvedValue(2); // 2 completed tasks

      const result = await missionProgressService.evaluateMissionProgress('user-1', 'mission-1');

      expect(result?.isCompleted).toBe(true);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mission.completed' }),
      );
    });
  });

  // ─── 4. Event Evaluation Engine ─────────────────────────────────────────

  describe('4. Event-Driven Evaluation Engine', () => {
    it('should evaluate matching tasks and increment progress', async () => {
      const taskDef = {
        id: 'task-1',
        requiredProgress: 1,
        status: 'ACTIVE',
        resetPolicy: 'DAILY',
        rewardDefinition: { type: 'EXP', amount: 100 },
        progressRules: { eventCodes: ['gift.sent'], operator: 'ANY' },
      };
      mockPrismaService.taskDefinition.findMany.mockResolvedValue([taskDef]);
      mockPrismaService.taskProgress.findUnique.mockResolvedValue(null);

      const summary = await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'gift.sent',
      });

      expect(summary.evaluated).toBe(1);
      expect(summary.progressed).toBe(1);
      expect(summary.completed).toBe(1);
    });

    it('should dynamically accumulate durationMinutes for room.duration_updated', async () => {
      const durationTask = {
        id: 'task-stay-20',
        requiredProgress: 20,
        status: 'ACTIVE',
        resetPolicy: 'DAILY',
        progressRules: { eventCodes: ['room.duration_updated'], incrementField: 'durationMinutes' },
      };
      mockPrismaService.taskDefinition.findMany.mockResolvedValue([durationTask]);
      mockPrismaService.taskProgress.findUnique.mockResolvedValue(null);

      const spyIncrement = jest.spyOn(progressService, 'incrementProgress');

      await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'room.duration_updated',
        metadata: { durationMinutes: 15 },
      });

      expect(spyIncrement).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-stay-20',
          incrementBy: 15,
        }),
      );
    });

    it('should dynamically accumulate coin recharge amount for wallet.credited', async () => {
      const rechargeTask = {
        id: 'task-recharge-2000',
        requiredProgress: 2000,
        status: 'ACTIVE',
        resetPolicy: 'DAILY',
        progressRules: { eventCodes: ['wallet.credited'], incrementField: 'amount' },
      };
      mockPrismaService.taskDefinition.findMany.mockResolvedValue([rechargeTask]);
      mockPrismaService.taskProgress.findUnique.mockResolvedValue(null);

      const spyIncrement = jest.spyOn(progressService, 'incrementProgress');

      await evaluationService.evaluateEvent({
        userId: 'user-1',
        eventCode: 'wallet.credited',
        metadata: { amount: 500, currency: 'GAME' },
      });

      expect(spyIncrement).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-recharge-2000',
          incrementBy: 500,
        }),
      );
    });
  });

  // ─── 5. Reward Service ────────────────────────────────────────────────────

  describe('5. Reward Service', () => {
    it('should dispatch reward and emit domain event without touching wallet', async () => {
      mockPrismaService.taskDefinition.findUnique.mockResolvedValue({
        id: 'task-1',
        rewardDefinition: { type: 'COINS', amount: 100 },
      });

      const reward = await rewardService.dispatchReward('user-1', 'task-1');

      expect(reward.claimed).toBe(true);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'reward.dispatched' }),
      );
    });
  });

  // ─── 6. Validation & Audit Services ──────────────────────────────────────

  describe('6. Validation & Audit Services', () => {
    it('should throw NotFoundException for missing task', async () => {
      mockPrismaService.taskDefinition.findUnique.mockResolvedValue(null);
      await expect(validationService.validateTaskExists('missing-task')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should log audit entries', async () => {
      await auditService.logAudit('TASK_CREATED', 'task-1', 'admin-1', { code: 'TEST' });
      expect(mockPrismaService.taskAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'TASK_CREATED' }),
        }),
      );
    });

    it('should return platform summary stats', async () => {
      const summary = await statisticsService.getPlatformSummary();
      expect(summary.activeTasks).toBe(10);
    });
  });
});
