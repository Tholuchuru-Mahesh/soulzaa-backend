import { EventType, EventVisibility } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { IExpService } from 'src/modules/exp/interfaces/exp.service.interface';
import type { IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import { EventsRepository } from '../repositories/events.repository';
import { EventRewardGranter } from './event-reward.granter';
import { EventsService } from './events.service';

function evt(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'e1',
    name: 'Welcome',
    type: EventType.FESTIVAL,
    description: null,
    startAt: new Date(now - 1000),
    endAt: new Date(now + 3_600_000),
    visibility: EventVisibility.PUBLIC,
    enabled: true,
    rewards: [{ kind: 'COINS', coins: 100, currency: 'FREE' }],
    multiplier: 1,
    eligibility: null,
    bannerUrl: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('EventsService', () => {
  let repo: Record<string, jest.Mock>;
  let granter: { grant: jest.Mock };
  let locks: { withLock: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let exp: Record<string, jest.Mock>;
  let vip: Record<string, jest.Mock>;
  let service: EventsService;

  beforeEach(async () => {
    repo = {
      listActive: jest.fn().mockResolvedValue([]),
      listActivePublic: jest.fn().mockResolvedValue([]),
      getEvent: jest.fn().mockResolvedValue(evt()),
      findClaim: jest.fn().mockResolvedValue(null),
      createClaim: jest.fn().mockResolvedValue({ id: 'claim-1' }),
      listUserClaims: jest.fn().mockResolvedValue([[], 0]),
    };
    granter = {
      grant: jest
        .fn()
        .mockResolvedValue([
          { kind: 'COINS', coins: 100, currency: 'FREE', cosmeticId: null, exp: null },
        ]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    exp = { getUserExp: jest.fn().mockResolvedValue({ level: 10 }) };
    vip = { getLevelOrdinal: jest.fn().mockResolvedValue(3) };
    service = new EventsService(
      repo as unknown as EventsRepository,
      granter as unknown as EventRewardGranter,
      locks as unknown as LockService,
      queue as unknown as QueueService,
      bus,
      exp as unknown as IExpService,
      vip as unknown as IVipService,
    );
    await service.reload();
  });

  describe('getActiveMultiplier', () => {
    it('returns the highest active multiplier of the type', async () => {
      repo.listActive.mockResolvedValue([
        evt({ type: EventType.DOUBLE_EXP, multiplier: 2 }),
        evt({ type: EventType.DOUBLE_EXP, multiplier: 3 }),
      ]);
      await service.reload();
      expect(await service.getActiveMultiplier(EventType.DOUBLE_EXP)).toBe(3);
    });

    it('returns 1 for a non-multiplier type', async () => {
      expect(await service.getActiveMultiplier(EventType.FESTIVAL)).toBe(1);
    });

    it('ignores an out-of-window event', async () => {
      repo.listActive.mockResolvedValue([
        evt({ type: EventType.DOUBLE_EXP, multiplier: 2, endAt: new Date(Date.now() - 1000) }),
      ]);
      await service.reload();
      expect(await service.getActiveMultiplier(EventType.DOUBLE_EXP)).toBe(1);
    });
  });

  describe('claim', () => {
    it('grants rewards, records the claim, and publishes', async () => {
      const res = await service.claim('u1', 'e1');
      expect(granter.grant).toHaveBeenCalledWith('u1', expect.any(Array), 'event:e1:u1');
      expect(repo.createClaim).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'event.reward_claimed' }),
      );
      expect(res.claimId).toBe('claim-1');
    });

    it('rejects claiming a multiplier event', async () => {
      repo.getEvent.mockResolvedValue(evt({ type: EventType.DOUBLE_EXP }));
      await expect(service.claim('u1', 'e1')).rejects.toMatchObject({
        errorCode: 'EVENT_NOT_CLAIMABLE',
      });
    });

    it('rejects an inactive event', async () => {
      repo.getEvent.mockResolvedValue(evt({ enabled: false }));
      await expect(service.claim('u1', 'e1')).rejects.toMatchObject({
        errorCode: 'EVENT_NOT_ACTIVE',
      });
    });

    it('rejects a duplicate claim', async () => {
      repo.findClaim.mockResolvedValue({ id: 'existing' });
      await expect(service.claim('u1', 'e1')).rejects.toMatchObject({
        errorCode: 'EVENT_ALREADY_CLAIMED',
      });
      expect(granter.grant).not.toHaveBeenCalled();
    });

    it('enforces eligibility (min user level)', async () => {
      repo.getEvent.mockResolvedValue(evt({ eligibility: { minUserLevel: 20 } }));
      exp.getUserExp.mockResolvedValue({ level: 5 });
      await expect(service.claim('u1', 'e1')).rejects.toMatchObject({
        errorCode: 'EVENT_NOT_ELIGIBLE',
      });
    });

    it('allows an eligible user', async () => {
      repo.getEvent.mockResolvedValue(evt({ eligibility: { minVipLevel: 2 } }));
      vip.getLevelOrdinal.mockResolvedValue(3);
      await expect(service.claim('u1', 'e1')).resolves.toBeDefined();
    });
  });
});
