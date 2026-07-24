import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { VipAuditService } from './vip-audit.service';
import { VipBenefitService } from './vip-benefit.service';
import { VipConfigurationService } from './vip-configuration.service';
import { VipEventService } from './vip-event.service';
import { VipHistoryService } from './vip-history.service';
import { VipMembershipService } from './vip-membership.service';
import { VipQueryService } from './vip-query.service';
import { VipRewardService } from './vip-reward.service';
import { VipStatisticsService } from './vip-statistics.service';
import { VipSubscriptionService } from './vip-subscription.service';
import { VipTierService } from './vip-tier.service';
import { VipValidationService } from './vip-validation.service';

describe('Phase 12: Enterprise VIP Membership Engine', () => {
  let configService: VipConfigurationService;
  let validationService: VipValidationService;
  let tierService: VipTierService;
  let benefitService: VipBenefitService;
  let rewardService: VipRewardService;
  let subscriptionService: VipSubscriptionService;
  let membershipService: VipMembershipService;
  let historyService: VipHistoryService;
  let auditService: VipAuditService;
  let statisticsService: VipStatisticsService;
  let queryService: VipQueryService;
  let eventService: VipEventService;

  const mockPrismaService: any = {
    vipTier: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
    },
    vipMembership: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    vipSubscription: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    vipReward: {
      create: jest.fn(),
    },
    vipHistory: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    vipAudit: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    vipStatistics: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    vipConfiguration: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(mockPrismaService);
      }
      return Promise.all(arg);
    }),
  };

  const mockWalletService = {
    debit: jest.fn().mockResolvedValue({ success: true, transactionId: 'txn-100' }),
    credit: jest.fn().mockResolvedValue({ success: true, transactionId: 'txn-101' }),
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'vip.max_level') return Promise.resolve(10);
      if (key === 'vip.default_duration') return Promise.resolve(30);
      return Promise.resolve(null);
    }),
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
        VipConfigurationService,
        VipValidationService,
        VipTierService,
        VipBenefitService,
        VipRewardService,
        VipSubscriptionService,
        VipMembershipService,
        VipHistoryService,
        VipAuditService,
        VipStatisticsService,
        VipQueryService,
        VipEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: WALLET_SERVICE, useValue: mockWalletService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    configService = module.get<VipConfigurationService>(VipConfigurationService);
    validationService = module.get<VipValidationService>(VipValidationService);
    tierService = module.get<VipTierService>(VipTierService);
    benefitService = module.get<VipBenefitService>(VipBenefitService);
    rewardService = module.get<VipRewardService>(VipRewardService);
    subscriptionService = module.get<VipSubscriptionService>(VipSubscriptionService);
    membershipService = module.get<VipMembershipService>(VipMembershipService);
    historyService = module.get<VipHistoryService>(VipHistoryService);
    auditService = module.get<VipAuditService>(VipAuditService);
    statisticsService = module.get<VipStatisticsService>(VipStatisticsService);
    queryService = module.get<VipQueryService>(VipQueryService);
    eventService = module.get<VipEventService>(VipEventService);

    jest.clearAllMocks();
  });

  describe('1. VIP Purchase & Wallet Double-Entry Debit', () => {
    it('should purchase VIP 1 and debit wallet GOLD balance', async () => {
      mockPrismaService.vipTier.findUnique.mockResolvedValue({
        id: 'tier-vip-1',
        level: 1,
        name: 'VIP 1',
        price: BigInt(500),
        durationDays: 30,
        status: 'ACTIVE',
      });
      mockPrismaService.vipMembership.findUnique.mockResolvedValue(null);
      mockPrismaService.vipSubscription.create.mockResolvedValue({ id: 'sub-1' });
      mockPrismaService.vipMembership.upsert.mockResolvedValue({
        id: 'mem-1',
        userId: 'user-buyer',
        tierId: 'tier-vip-1',
        level: 1,
        status: 'ACTIVE',
        expGained: BigInt(0),
        totalSpent: BigInt(0),
      });

      const res = await subscriptionService.purchaseVip({
        userId: 'user-buyer',
        level: 1,
      });

      expect(res.level).toBe(1);
      expect(mockWalletService.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-buyer',
          currency: 'GOLD',
          amount: 500,
          reason: 'VIP_PURCHASE',
        }),
        expect.anything(), // debit now participates in the membership $transaction
      );
    });
  });

  describe('1b. VIP Purchase — atomicity & deterministic idempotency', () => {
    const tier = {
      id: 'tier-vip-1',
      level: 1,
      name: 'VIP 1',
      price: BigInt(500),
      durationDays: 30,
      status: 'ACTIVE',
    };

    it('debits inside the membership transaction using a deterministic (no-timestamp) idempotency key', async () => {
      mockPrismaService.vipTier.findUnique.mockResolvedValue(tier);
      mockPrismaService.vipMembership.findUnique.mockResolvedValue(null);
      mockPrismaService.vipSubscription.create.mockResolvedValue({ id: 'sub-1' });
      mockPrismaService.vipMembership.upsert.mockResolvedValue({
        id: 'mem-1',
        userId: 'user-buyer',
        tierId: 'tier-vip-1',
        level: 1,
        status: 'ACTIVE',
        expGained: BigInt(0),
        totalSpent: BigInt(0),
      });

      await subscriptionService.purchaseVip({ userId: 'user-buyer', level: 1 });

      // debit participates in the SAME $transaction → the tx client is its 2nd arg
      expect(mockWalletService.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-buyer',
          currency: 'GOLD',
          amount: 500,
          idempotencyKey: 'vip:purchase:user-buyer:1:new',
        }),
        expect.anything(),
      );
      const key = mockWalletService.debit.mock.calls[0][0].idempotencyKey as string;
      expect(key).not.toMatch(/:\d{13}$/); // no epoch-ms timestamp
    });

    it('rejects and keeps the debit inside the tx when the membership write fails (atomic rollback)', async () => {
      mockPrismaService.vipTier.findUnique.mockResolvedValue(tier);
      mockPrismaService.vipMembership.findUnique.mockResolvedValue(null);
      mockPrismaService.vipSubscription.create.mockResolvedValue({ id: 'sub-1' });
      mockPrismaService.vipMembership.upsert.mockRejectedValue(new Error('db write failed'));

      await expect(
        subscriptionService.purchaseVip({ userId: 'user-buyer', level: 1 }),
      ).rejects.toThrow('db write failed');

      expect(mockWalletService.debit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-buyer' }),
        expect.anything(), // the tx client — a real DB rolls the debit back with the failed write
      );
    });

    it("acquires the payer's wallet lock (wallet:lock:*) so the tx-scoped debit is concurrency-safe", async () => {
      mockPrismaService.vipTier.findUnique.mockResolvedValue(tier);
      mockPrismaService.vipMembership.findUnique.mockResolvedValue(null);
      mockPrismaService.vipSubscription.create.mockResolvedValue({ id: 'sub-1' });
      mockPrismaService.vipMembership.upsert.mockResolvedValue({
        id: 'mem-1',
        userId: 'user-buyer',
        tierId: 'tier-vip-1',
        level: 1,
        status: 'ACTIVE',
        expGained: BigInt(0),
        totalSpent: BigInt(0),
      });

      await subscriptionService.purchaseVip({ userId: 'user-buyer', level: 1 });

      // WalletService.debit skips its own lock when handed a tx, so the VIP method
      // MUST hold walletLockKey(payer) itself — else concurrent same-payer wallet
      // ops lost-update into a double-spend.
      expect(mockLockService.withLock).toHaveBeenCalledWith(
        'wallet:lock:user-buyer',
        expect.any(Function),
      );
    });
  });

  describe('2. Upgrade Logic & Entitlements', () => {
    it('should upgrade VIP 1 to VIP 3 and recalculate entitlements', async () => {
      const activeMem = {
        id: 'mem-1',
        userId: 'user-buyer',
        tierId: 'tier-vip-1',
        level: 1,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 1000000),
      };
      mockPrismaService.vipMembership.findUnique.mockResolvedValue(activeMem);
      mockPrismaService.vipTier.findUnique.mockResolvedValue({
        id: 'tier-vip-3',
        level: 3,
        name: 'VIP 3',
        price: BigInt(1500),
        durationDays: 30,
        status: 'ACTIVE',
      });
      mockPrismaService.vipMembership.update.mockResolvedValue({
        ...activeMem,
        level: 3,
        tierId: 'tier-vip-3',
        expGained: BigInt(0),
        totalSpent: BigInt(0),
      });

      const res = await subscriptionService.upgradeVip('user-buyer', 3);
      expect(res.level).toBe(3);
      expect(mockWalletService.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-buyer',
          amount: 1500,
        }),
        expect.anything(), // debit now participates in the membership $transaction
      );
    });

    it('should reject upgrade if target level is lower or equal to current level', async () => {
      mockPrismaService.vipMembership.findUnique.mockResolvedValue({
        id: 'mem-1',
        userId: 'user-buyer',
        level: 3,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 1000000),
      });

      await expect(subscriptionService.upgradeVip('user-buyer', 2)).rejects.toThrow(
        'must be higher than current tier',
      );
    });
  });

  describe('3. Reward Claiming & Window Reset Guards', () => {
    it('should claim daily reward and update lastClaimedDailyAt', async () => {
      const activeMem = {
        id: 'mem-1',
        userId: 'user-buyer',
        tierId: 'tier-vip-1',
        level: 1,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 1000000),
        lastClaimedDailyAt: null,
      };
      mockPrismaService.vipMembership.findUnique.mockResolvedValue(activeMem);
      mockPrismaService.vipTier.findUnique.mockResolvedValue({
        id: 'tier-vip-1',
        level: 1,
        dailyRewards: [{ type: 'COIN', amount: 10 }],
      });

      const result = await rewardService.claimReward('user-buyer', 'DAILY');
      expect(result.claimed).toBe(true);
      expect(mockPrismaService.vipReward.create).toHaveBeenCalled();
    });
  });
});
