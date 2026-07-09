import { ExpSource } from '@prisma/client';
import { ModuleRef } from '@nestjs/core';
import { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { ExpRepository } from '../repositories/exp.repository';
import { ExpRewardGranter } from './exp-reward.granter';
import { ExpService } from './exp.service';

function levelConfig(level: number, minExp: number, rewards: unknown[] = []) {
  return {
    level,
    minExp: BigInt(minExp),
    title: `Level ${level}`,
    rewards,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('ExpService', () => {
  let repo: Record<string, jest.Mock>;
  let granter: { grant: jest.Mock };
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let moduleRef: { get: jest.Mock };
  let service: ExpService;

  const LEVELS = [
    levelConfig(1, 0),
    levelConfig(2, 100, [{ kind: 'COINS', coins: 200, currency: 'FREE' }]),
    levelConfig(3, 400, [{ kind: 'COSMETIC', cosmeticId: 'c1' }]),
  ];

  beforeEach(async () => {
    repo = {
      listLevelConfigs: jest.fn().mockResolvedValue(LEVELS),
      listRoomLevelConfigs: jest.fn().mockResolvedValue([levelConfig(1, 0), levelConfig(2, 500)]),
      findUserLog: jest.fn().mockResolvedValue(null),
      getUserExp: jest.fn().mockResolvedValue({ totalExp: 0n, level: 1 }),
      applyUserExp: jest.fn().mockResolvedValue({ totalExp: 50n, level: 1 }),
      findRoomLog: jest.fn().mockResolvedValue(null),
      getRoomExp: jest.fn().mockResolvedValue({ totalExp: 0n, level: 1 }),
      applyRoomExp: jest.fn().mockResolvedValue({ totalExp: 50n, level: 1 }),
      listUserLogs: jest.fn().mockResolvedValue([[], 0]),
    };
    granter = {
      grant: jest
        .fn()
        .mockResolvedValue([{ kind: 'COINS', coins: 200, currency: 'FREE', cosmeticId: null }]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    // ModuleRef resolves the events service (no active multiplier by default).
    moduleRef = {
      get: jest.fn().mockReturnValue({ getActiveMultiplier: jest.fn().mockResolvedValue(1) }),
    };
    service = new ExpService(
      repo as unknown as ExpRepository,
      granter as unknown as ExpRewardGranter,
      locks as unknown as LockService,
      bus,
      moduleRef as unknown as ModuleRef,
    );
    await service.reload();
  });

  describe('award', () => {
    it('accrues EXP without leveling up below the threshold', async () => {
      const res = await service.award({
        userId: 'u1',
        amount: 50,
        source: ExpSource.GIFT_SENT,
        idempotencyKey: 'k1',
      });
      expect(res).toMatchObject({ level: 1, leveledUp: false });
      expect(granter.grant).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('levels up, grants crossed-level rewards, and publishes when a threshold is crossed', async () => {
      repo.getUserExp.mockResolvedValue({ totalExp: 50n, level: 1 });
      const res = await service.award({
        userId: 'u1',
        amount: 60,
        source: ExpSource.GIFT_SENT,
        idempotencyKey: 'k2',
      });
      // 50 + 60 = 110 → level 2
      expect(res).toMatchObject({ level: 2, leveledUp: true });
      expect(granter.grant).toHaveBeenCalledWith('u1', expect.any(Array), 'level:u1:2');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'exp.user_leveled_up' }),
      );
    });

    it('grants rewards for every level crossed in one award', async () => {
      repo.getUserExp.mockResolvedValue({ totalExp: 0n, level: 1 });
      await service.award({
        userId: 'u1',
        amount: 500,
        source: ExpSource.ADMIN,
        idempotencyKey: 'k3',
      });
      // 0 → 500 crosses level 2 and level 3
      expect(granter.grant).toHaveBeenCalledWith('u1', expect.any(Array), 'level:u1:2');
      expect(granter.grant).toHaveBeenCalledWith('u1', expect.any(Array), 'level:u1:3');
    });

    it('is idempotent — a replayed award does not re-apply', async () => {
      repo.findUserLog.mockResolvedValue({ id: 'log-1' });
      const res = await service.award({
        userId: 'u1',
        amount: 60,
        source: ExpSource.GIFT_SENT,
        idempotencyKey: 'k2',
      });
      expect(res.leveledUp).toBe(false);
      expect(repo.applyUserExp).not.toHaveBeenCalled();
    });

    it('rejects a non-positive amount', async () => {
      await expect(
        service.award({ userId: 'u1', amount: 0, source: ExpSource.ADMIN, idempotencyKey: 'k' }),
      ).rejects.toMatchObject({ errorCode: 'INVALID_AMOUNT' });
    });

    it('applies an active DOUBLE_EXP multiplier to the award', async () => {
      moduleRef.get.mockReturnValue({ getActiveMultiplier: jest.fn().mockResolvedValue(2) });
      repo.getUserExp.mockResolvedValue({ totalExp: 0n, level: 1 });
      await service.award({
        userId: 'u1',
        amount: 50,
        source: ExpSource.GIFT_SENT,
        idempotencyKey: 'k9',
      });
      // 50 * 2 = 100 EXP applied
      expect(repo.applyUserExp).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
    });
  });

  describe('awardRoom', () => {
    it('levels up a room and publishes', async () => {
      repo.getRoomExp.mockResolvedValue({ totalExp: 480n, level: 1 });
      const res = await service.awardRoom({
        roomId: 'r1',
        amount: 50,
        source: ExpSource.GIFT_SENT,
        idempotencyKey: 'rk1',
      });
      expect(res).toMatchObject({ level: 2, leveledUp: true });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'exp.room_leveled_up' }),
      );
    });
  });
});
