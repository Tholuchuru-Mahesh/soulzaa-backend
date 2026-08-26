import { BackpackItemSource, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import { RewardFulfillmentEngine } from '../services/reward-engine/reward-fulfillment.engine';
import { TaskRewardExecutionListener } from './task-reward-execution.listener';

describe('TaskRewardExecutionListener & RewardFulfillmentEngine', () => {
  let listener: TaskRewardExecutionListener;
  let rewardEngine: RewardFulfillmentEngine;
  let mockEventBus: any;
  let mockWalletService: any;
  let mockExpService: any;
  let mockCosmeticsService: any;
  let mockPrismaService: any;
  let mockSocketManager: any;

  beforeEach(() => {
    mockEventBus = {
      subscribe: jest.fn(),
      publish: jest.fn(),
    };

    mockWalletService = {
      credit: jest.fn().mockResolvedValue({ id: 'txn-1' }),
      getBalance: jest.fn().mockResolvedValue({ gold: 0, diamond: 0, game: 100 }),
    };

    mockExpService = {
      award: jest.fn().mockResolvedValue({ id: 'exp-1', level: 5 }),
    };

    mockCosmeticsService = {
      grantToUser: jest.fn().mockResolvedValue({
        cosmeticId: 'frame-vip-gold',
        backpackItemId: 'item-1',
        duplicate: false,
      }),
    };

    mockPrismaService = {
      userStatistics: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    mockSocketManager = {
      emitToUserEverywhere: jest.fn(),
    };

    rewardEngine = new RewardFulfillmentEngine(
      mockEventBus,
      mockWalletService,
      mockExpService,
      mockCosmeticsService,
      mockPrismaService,
      undefined,
      mockSocketManager,
    );

    listener = new TaskRewardExecutionListener(mockEventBus, rewardEngine);
  });

  it('subscribes to reward.dispatched onModuleInit', () => {
    listener.onModuleInit();
    expect(mockEventBus.subscribe).toHaveBeenCalledWith('reward.dispatched', expect.any(Function));
  });

  it('credits free coins, EXP, and cosmetics when reward is dispatched', async () => {
    let handler: (event: any) => Promise<void> = () => Promise.resolve();
    mockEventBus.subscribe.mockImplementation((name: string, fn: any) => {
      if (name === 'reward.dispatched') handler = fn;
    });

    listener.onModuleInit();

    const payload = {
      userId: 'user-100',
      taskId: 'task-500',
      rewardDefinition: {
        freeCoins: 100,
        exp: 50,
        cosmeticId: 'frame-vip-gold',
      },
    };

    await handler({ payload });

    // 1. Verify Wallet Credit (Free / Game Coins)
    expect(mockWalletService.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-100',
        currency: WalletCurrency.GAME,
        amount: 100,
        reason: WalletTxnReason.EVENT_REWARD,
        referenceType: 'task',
        referenceId: 'task-500',
      }),
    );

    // 2. Verify EXP Award
    expect(mockExpService.award).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-100',
        amount: 50,
        source: ExpSource.TASK_COMPLETION,
        referenceType: 'task',
        referenceId: 'task-500',
      }),
    );

    // 3. Verify Cosmetic Item Grant
    expect(mockCosmeticsService.grantToUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-100',
        cosmeticId: 'frame-vip-gold',
        source: BackpackItemSource.EVENT,
      }),
    );
  });

  it('credits gold coins, room themes, and badges when dynamic rewards are dispatched', async () => {
    let handler: (event: any) => Promise<void> = () => Promise.resolve();
    mockEventBus.subscribe.mockImplementation((name: string, fn: any) => {
      if (name === 'reward.dispatched') handler = fn;
    });

    listener.onModuleInit();

    const payload = {
      userId: 'user-200',
      taskId: 'task-700',
      rewardDefinition: {
        goldCoins: 250,
        themeId: 'theme-cyberpunk',
        badgeId: 'badge-champion',
      },
    };

    await handler({ payload });

    // Verify Gold Coins Credit
    expect(mockWalletService.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-200',
        currency: WalletCurrency.GOLD,
        amount: 250,
      }),
    );

    // Verify Theme and Badge Grants
    expect(mockCosmeticsService.grantToUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-200',
        cosmeticId: 'theme-cyberpunk',
      }),
    );
    expect(mockCosmeticsService.grantToUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-200',
        cosmeticId: 'badge-champion',
      }),
    );
  });

  it('handles modern structured items array with TTL durations', async () => {
    let handler: (event: any) => Promise<void> = () => Promise.resolve();
    mockEventBus.subscribe.mockImplementation((name: string, fn: any) => {
      if (name === 'reward.dispatched') handler = fn;
    });

    listener.onModuleInit();

    const payload = {
      userId: 'user-300',
      taskId: 'task-900',
      rewardDefinition: {
        items: [
          { type: 'COINS', amount: 500 },
          { type: 'FRAME', cosmeticId: 'frame-neon', durationDays: 7 },
        ],
      },
    };

    await handler({ payload });

    expect(mockWalletService.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-300',
        currency: WalletCurrency.GAME,
        amount: 500,
      }),
    );

    expect(mockCosmeticsService.grantToUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-300',
        cosmeticId: 'frame-neon',
        durationDays: 7,
      }),
    );
  });

  it('gracefully handles missing reward components without errors', async () => {
    let handler: (event: any) => Promise<void> = () => Promise.resolve();
    mockEventBus.subscribe.mockImplementation((name: string, fn: any) => {
      if (name === 'reward.dispatched') handler = fn;
    });

    listener.onModuleInit();

    const payload = {
      userId: 'user-100',
      taskId: 'task-500',
      rewardDefinition: {},
    };

    await handler({ payload });

    expect(mockWalletService.credit).not.toHaveBeenCalled();
    expect(mockExpService.award).not.toHaveBeenCalled();
    expect(mockCosmeticsService.grantToUser).not.toHaveBeenCalled();
  });
});
