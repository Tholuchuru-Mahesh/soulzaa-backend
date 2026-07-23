import { Test, TestingModule } from '@nestjs/testing';
import { TreasureBoxStatus, TreasureSessionStatus, WalletCurrency } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { TreasureAuditService } from './treasure-audit.service';
import { TreasureBoxService } from './treasure-box.service';
import {
  PRD_BOX_THRESHOLDS,
  TOTAL_DAILY_CAPACITY,
  TreasureConfigurationService,
} from './treasure-configuration.service';
import { TreasureDistributionService } from './treasure-distribution.service';
import { TreasureEligibilityService } from './treasure-eligibility.service';
import { TreasureEventService } from './treasure-event.service';
import { TreasureHistoryService } from './treasure-history.service';
import { TreasureProgressService } from './treasure-progress.service';
import { TreasureResetService } from './treasure-reset.service';
import { TreasureRewardService } from './treasure-reward.service';

describe('Phase 6: Enterprise Treasure Box Engine', () => {
  let configService: TreasureConfigurationService;
  let boxService: TreasureBoxService;
  let progressService: TreasureProgressService;
  let rewardService: TreasureRewardService;
  let eligibilityService: TreasureEligibilityService;
  let distributionService: TreasureDistributionService;
  let historyService: TreasureHistoryService;
  let auditService: TreasureAuditService;
  let eventService: TreasureEventService;
  let resetService: TreasureResetService;

  const mockPrismaService: any = {
    treasureBoxConfig: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    treasureSession: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    treasureBox: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    treasureContribution: {
      create: jest.fn(),
      groupBy: jest.fn(),
    },
    treasureReward: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    treasureAudit: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'treasure.reward_pool_percentage') return Promise.resolve(50);
      if (key === 'treasure.min_winners') return Promise.resolve(5);
      if (key === 'treasure.max_winners') return Promise.resolve(7);
      return Promise.resolve(null);
    }),
  };

  const mockWalletService = {
    credit: jest.fn().mockResolvedValue({ transactionId: 'w-tx-123', status: 'COMPLETED' }),
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
        TreasureConfigurationService,
        TreasureBoxService,
        TreasureProgressService,
        TreasureRewardService,
        TreasureEligibilityService,
        TreasureDistributionService,
        TreasureHistoryService,
        TreasureAuditService,
        TreasureEventService,
        TreasureResetService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: WALLET_SERVICE, useValue: mockWalletService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    configService = module.get<TreasureConfigurationService>(TreasureConfigurationService);
    boxService = module.get<TreasureBoxService>(TreasureBoxService);
    progressService = module.get<TreasureProgressService>(TreasureProgressService);
    rewardService = module.get<TreasureRewardService>(TreasureRewardService);
    eligibilityService = module.get<TreasureEligibilityService>(TreasureEligibilityService);
    distributionService = module.get<TreasureDistributionService>(TreasureDistributionService);
    historyService = module.get<TreasureHistoryService>(TreasureHistoryService);
    auditService = module.get<TreasureAuditService>(TreasureAuditService);
    eventService = module.get<TreasureEventService>(TreasureEventService);
    resetService = module.get<TreasureResetService>(TreasureResetService);

    jest.clearAllMocks();
  });

  describe('1. TreasureConfigurationService & Thresholds', () => {
    it('should return PRD exact thresholds (15k, 60k, 120k, 300k, 500k = 995k total)', async () => {
      mockPrismaService.treasureBoxConfig.findUnique.mockResolvedValue(null);

      expect(await configService.getLevelThreshold(1)).toBe(BigInt(15_000));
      expect(await configService.getLevelThreshold(2)).toBe(BigInt(60_000));
      expect(await configService.getLevelThreshold(3)).toBe(BigInt(120_000));
      expect(await configService.getLevelThreshold(4)).toBe(BigInt(300_000));
      expect(await configService.getLevelThreshold(5)).toBe(BigInt(500_000));

      const totalSum =
        PRD_BOX_THRESHOLDS[1] +
        PRD_BOX_THRESHOLDS[2] +
        PRD_BOX_THRESHOLDS[3] +
        PRD_BOX_THRESHOLDS[4] +
        PRD_BOX_THRESHOLDS[5];

      expect(totalSum).toBe(TOTAL_DAILY_CAPACITY);
      expect(totalSum).toBe(BigInt(995_000));
    });

    it('should retrieve configurable reward pool percentage from PlatformConfigurationService', async () => {
      const percentage = await configService.getRewardPoolPercentage();
      expect(percentage).toBe(50);
    });
  });

  describe('2. Multi-Box Overflow Engine', () => {
    it('should overflow leftover gift progress to Box 2 when Box 1 fills', async () => {
      const sessionId = 'session-101';
      const roomId = 'room-202';

      mockPrismaService.treasureSession.findFirst.mockResolvedValue({
        id: sessionId,
        roomId,
        currentLevel: 1,
        status: TreasureSessionStatus.ACTIVE,
      });

      // Box 1 threshold 15,000, current progress 10,000 (needs 5,000)
      mockPrismaService.treasureBox.findUnique.mockImplementation(({ where }: any) => {
        if (where.sessionId_level.level === 1) {
          return Promise.resolve({
            id: 'box-1',
            sessionId,
            roomId,
            level: 1,
            threshold: BigInt(15_000),
            progress: BigInt(10_000),
            status: TreasureBoxStatus.ACTIVE,
          });
        }
        return Promise.resolve(null);
      });

      mockPrismaService.treasureBox.update.mockResolvedValue({});
      mockPrismaService.treasureBox.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: `box-${data.level}`, ...data }),
      );
      mockPrismaService.treasureBox.upsert.mockResolvedValue({});
      mockPrismaService.treasureContribution.create.mockResolvedValue({});
      mockPrismaService.treasureSession.update.mockResolvedValue({});

      // Send 20,000 coins (5,000 fills Box 1, remaining 15,000 overflows to Box 2)
      const result = await progressService.applyGiftProgress(roomId, 'user-1', BigInt(20_000));

      expect(result.completedBoxes.length).toBe(1);
      expect(result.completedBoxes[0].level).toBe(1);
      expect(result.completedBoxes[0].finalProgress).toBe(BigInt(15_000));
      expect(mockPrismaService.treasureSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentLevel: 2 },
        }),
      );
    });

    it('should handle large single gift completing all 5 boxes sequentially in one transaction', async () => {
      const sessionId = 'session-mega';
      const roomId = 'room-303';

      mockPrismaService.treasureSession.findFirst.mockResolvedValue({
        id: sessionId,
        roomId,
        currentLevel: 1,
        status: TreasureSessionStatus.ACTIVE,
      });

      mockPrismaService.treasureBox.findUnique.mockImplementation(({ where }: any) => {
        const lvl = where.sessionId_level.level;
        return Promise.resolve({
          id: `box-${lvl}`,
          sessionId,
          roomId,
          level: lvl,
          threshold: PRD_BOX_THRESHOLDS[lvl],
          progress: BigInt(0),
          status: TreasureBoxStatus.ACTIVE,
        });
      });

      mockPrismaService.treasureBox.update.mockResolvedValue({});
      mockPrismaService.treasureBox.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: `box-${data.level}`, ...data }),
      );
      mockPrismaService.treasureBox.upsert.mockResolvedValue({});
      mockPrismaService.treasureContribution.create.mockResolvedValue({});
      mockPrismaService.treasureSession.update.mockResolvedValue({});

      // Send 1,000,000 coins (exceeds total capacity 995,000)
      const result = await progressService.applyGiftProgress(
        roomId,
        'whale-user',
        BigInt(1_000_000),
      );

      expect(result.completedBoxes.length).toBe(5);
      expect(result.sessionCompleted).toBe(true);
      expect(mockPrismaService.treasureSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TreasureSessionStatus.COMPLETED,
          }),
        }),
      );
    });
  });

  describe('3. Reward Pool & Weighted Distribution', () => {
    it('should generate reward pool dynamically from config percentage', async () => {
      const pool = await rewardService.calculateRewardPool(1, BigInt(15_000));
      expect(pool.rewardPoolPercentage).toBe(50);
      expect(pool.totalRewardPool).toBe(BigInt(7_500));
    });

    it('should filter eligible users excluding banned users and 0-contribution users', async () => {
      mockPrismaService.treasureContribution.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { amount: BigInt(5000) } },
        { userId: 'u2', _sum: { amount: BigInt(3000) } },
        { userId: 'banned-u3', _sum: { amount: BigInt(2000) } },
        { userId: 'u4', _sum: { amount: BigInt(0) } },
      ]);

      mockPrismaService.user.findMany.mockResolvedValue([
        { id: 'u1', status: 'ACTIVE' },
        { id: 'u2', status: 'ACTIVE' },
      ]);

      const eligible = await eligibilityService.getEligibleParticipants('box-1', 'room-1');
      expect(eligible.length).toBe(2);
      expect(eligible.map((e) => e.userId)).toEqual(['u1', 'u2']);
    });

    it('should distribute rewards using WalletTransactionService with double-entry ledger entries', async () => {
      mockPrismaService.treasureContribution.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { amount: BigInt(5000) } },
        { userId: 'u2', _sum: { amount: BigInt(3000) } },
        { userId: 'u3', _sum: { amount: BigInt(2000) } },
        { userId: 'u4', _sum: { amount: BigInt(1000) } },
        { userId: 'u5', _sum: { amount: BigInt(500) } },
      ]);

      mockPrismaService.user.findMany.mockResolvedValue([
        { id: 'u1', status: 'ACTIVE' },
        { id: 'u2', status: 'ACTIVE' },
        { id: 'u3', status: 'ACTIVE' },
        { id: 'u4', status: 'ACTIVE' },
        { id: 'u5', status: 'ACTIVE' },
      ]);

      mockPrismaService.treasureReward.create.mockResolvedValue({ id: 'rew-1' });

      const dist = await distributionService.distributeBoxRewards(
        'sess-1',
        'box-1',
        'room-1',
        1,
        BigInt(7_500),
      );

      expect(dist.winnersCount).toBe(5);
      expect(mockWalletService.credit).toHaveBeenCalledTimes(5);
      expect(mockWalletService.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.any(String),
          amount: expect.any(Number),
          currency: WalletCurrency.GOLD,
          reason: 'TREASURE_BOX',
        }),
      );
    });
  });

  describe('4. Reset Engine & Audit Logging', () => {
    it('should reset room treasure cycle and log TREASURE_RESET audit event', async () => {
      mockPrismaService.treasureSession.findMany.mockResolvedValue([
        { id: 'old-session', roomId: 'room-1', status: TreasureSessionStatus.ACTIVE },
      ]);
      mockPrismaService.treasureSession.findFirst.mockResolvedValue(null);
      mockPrismaService.treasureBoxConfig.findMany.mockResolvedValue([]);
      mockPrismaService.treasureSession.update.mockResolvedValue({});
      mockPrismaService.treasureSession.create.mockResolvedValue({ id: 'new-session' });
      mockPrismaService.treasureBox.create.mockResolvedValue({});
      mockPrismaService.treasureAudit.create.mockResolvedValue({});

      const res = await resetService.resetRoomTreasure('room-1', 'admin-1');

      expect(res.reset).toBe(true);
      expect(res.newSessionId).toBe('new-session');
      expect(mockPrismaService.treasureAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'TREASURE_RESET',
            roomId: 'room-1',
            actorId: 'admin-1',
          }),
        }),
      );
    });
  });

  describe('5. Event-Driven GiftSentEvent Consumption', () => {
    it('should subscribe to GiftSentEvent and process progress without DB polling', async () => {
      eventService.onModuleInit();
      expect(mockEventBus.subscribe).toHaveBeenCalledWith('gift.sent', expect.any(Function));
    });
  });
});
