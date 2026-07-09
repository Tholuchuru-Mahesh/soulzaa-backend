import { RocketStatus } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { RocketRepository } from '../repositories/rocket.repository';
import { RewardDistributor } from './reward-distributor.service';
import { RocketService } from './rocket.service';

const ROOM = 'room-1';
const GIFT = 'gift-1';

function rocketConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rc-1',
    triggerGiftId: GIFT,
    durationSeconds: 60,
    priority: 0,
    rewardPool: [{ rank: 1, kind: 'COINS', coins: 1000 }],
    enabled: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function rocketEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rk-1',
    roomId: ROOM,
    contextType: 'AUDIO_ROOM',
    triggerGiftId: GIFT,
    triggeredBy: 'u1',
    status: RocketStatus.ACTIVE,
    totalContribution: 0n,
    startedAt: new Date(),
    endsAt: new Date(Date.now() + 60000),
    completedAt: null,
    ...overrides,
  };
}

describe('RocketService', () => {
  let repo: Record<string, jest.Mock>;
  let distributor: { distribute: jest.Mock };
  let locks: { withLock: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let service: RocketService;

  beforeEach(() => {
    repo = {
      getConfigByGift: jest.fn().mockResolvedValue(rocketConfig()),
      getActiveByRoom: jest.fn().mockResolvedValue(null),
      getEvent: jest.fn().mockResolvedValue(rocketEvent()),
      createEvent: jest.fn().mockResolvedValue(rocketEvent()),
      addContribution: jest.fn().mockResolvedValue(undefined),
      addProgress: jest.fn().mockResolvedValue(rocketEvent({ totalContribution: 500n })),
      complete: jest.fn().mockResolvedValue(undefined),
      findExpired: jest.fn().mockResolvedValue([]),
      topContributors: jest
        .fn()
        .mockResolvedValue([{ userId: 'u1', amount: 500n, firstAt: new Date() }]),
      createReward: jest.fn().mockResolvedValue(undefined),
      listEvents: jest.fn().mockResolvedValue([[], 0]),
    };
    distributor = {
      distribute: jest.fn().mockResolvedValue([
        {
          userId: 'u1',
          rank: 1,
          kind: 'COINS',
          coins: 1000n,
          itemType: null,
          itemName: null,
          walletTxnId: 'w1',
          backpackItemId: null,
        },
      ]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new RocketService(
      repo as unknown as RocketRepository,
      distributor as unknown as RewardDistributor,
      locks as unknown as LockService,
      queue as unknown as QueueService,
      bus,
    );
  });

  describe('maybeTrigger', () => {
    it('ignores a gift that is not a trigger gift', async () => {
      repo.getConfigByGift.mockResolvedValue(null);
      await service.maybeTrigger({
        roomId: ROOM,
        giftId: 'x',
        senderId: 'u1',
        giftValue: 100,
        giftTxnId: 't1',
      });
      expect(repo.createEvent).not.toHaveBeenCalled();
    });

    it('starts a rocket and contributes when none is active', async () => {
      await service.maybeTrigger({
        roomId: ROOM,
        giftId: GIFT,
        senderId: 'u1',
        giftValue: 500,
        giftTxnId: 't1',
      });
      expect(repo.createEvent).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.rocket_started' }),
      );
      expect(repo.addContribution).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.rocket_progress' }),
      );
    });

    it('feeds an already-active rocket without starting a new one', async () => {
      repo.getActiveByRoom.mockResolvedValue(rocketEvent());
      await service.maybeTrigger({
        roomId: ROOM,
        giftId: GIFT,
        senderId: 'u2',
        giftValue: 300,
        giftTxnId: 't2',
      });
      expect(repo.createEvent).not.toHaveBeenCalled();
      expect(repo.addContribution).toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('distributes the pool to top contributors and broadcasts completion', async () => {
      await service.complete('rk-1');
      expect(distributor.distribute).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyPrefix: 'rocket:rk-1' }),
      );
      expect(repo.createReward).toHaveBeenCalled();
      expect(repo.complete).toHaveBeenCalledWith('rk-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.rocket_completed' }),
      );
    });

    it('is a no-op for an already-completed rocket', async () => {
      repo.getEvent.mockResolvedValue(rocketEvent({ status: RocketStatus.COMPLETED }));
      await service.complete('rk-1');
      expect(repo.complete).not.toHaveBeenCalled();
    });
  });
});
