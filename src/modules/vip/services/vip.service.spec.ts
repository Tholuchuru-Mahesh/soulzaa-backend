import { VipLevel } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { VipRepository } from '../repositories/vip.repository';
import { VipService } from './vip.service';

function tier(level: VipLevel, minRecharge: number, benefits: unknown[] = []) {
  return {
    level,
    minRecharge: BigInt(minRecharge),
    benefits,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('VipService', () => {
  let repo: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let cosmetics: { grantToUser: jest.Mock };
  let service: VipService;

  const CONFIGS = [
    tier(VipLevel.BRONZE, 10_000, [{ kind: 'COSMETIC', cosmeticId: 'bronze' }]),
    tier(VipLevel.SILVER, 50_000, [{ kind: 'COSMETIC', cosmeticId: 'silver' }]),
    tier(VipLevel.GOLD, 200_000, [{ kind: 'COSMETIC', cosmeticId: 'gold' }]),
  ];

  beforeEach(async () => {
    repo = {
      listConfigs: jest.fn().mockResolvedValue(CONFIGS),
      getStatus: jest.fn().mockResolvedValue({ level: VipLevel.NONE, lifetimeRecharge: 0n }),
      findRechargeLog: jest.fn().mockResolvedValue(null),
      applyRecharge: jest
        .fn()
        .mockResolvedValue({ level: VipLevel.BRONZE, lifetimeRecharge: 10_000n }),
      logUpgrade: jest.fn().mockResolvedValue(undefined),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    cosmetics = {
      grantToUser: jest.fn().mockResolvedValue({ backpackItemId: 'i1', duplicate: false }),
    };
    service = new VipService(
      repo as unknown as VipRepository,
      locks as unknown as LockService,
      bus,
      cosmetics as unknown as ICosmeticsService,
    );
    await service.reload();
  });

  describe('recordRecharge', () => {
    it('accrues recharge without upgrading below the first threshold', async () => {
      repo.getStatus.mockResolvedValue({ level: VipLevel.NONE, lifetimeRecharge: 0n });
      const res = await service.recordRecharge({
        userId: 'u1',
        amount: 5_000,
        idempotencyKey: 'k1',
      });
      expect(res).toMatchObject({ level: VipLevel.NONE, upgraded: false });
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('upgrades the tier, grants benefits, logs and publishes when a threshold is crossed', async () => {
      repo.getStatus.mockResolvedValue({ level: VipLevel.NONE, lifetimeRecharge: 8_000n });
      const res = await service.recordRecharge({
        userId: 'u1',
        amount: 5_000,
        idempotencyKey: 'k2',
      });
      // 8000 + 5000 = 13000 → BRONZE
      expect(res).toMatchObject({ level: VipLevel.BRONZE, upgraded: true });
      expect(cosmetics.grantToUser).toHaveBeenCalledWith(
        expect.objectContaining({ cosmeticId: 'bronze', grantKey: 'vip:u1:BRONZE:bronze' }),
      );
      expect(repo.logUpgrade).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'vip.upgraded' }));
    });

    it('grants benefits for every tier crossed in one recharge', async () => {
      repo.getStatus.mockResolvedValue({ level: VipLevel.NONE, lifetimeRecharge: 0n });
      await service.recordRecharge({ userId: 'u1', amount: 60_000, idempotencyKey: 'k3' });
      // 0 → 60000 crosses BRONZE and SILVER
      expect(cosmetics.grantToUser).toHaveBeenCalledWith(
        expect.objectContaining({ cosmeticId: 'bronze' }),
      );
      expect(cosmetics.grantToUser).toHaveBeenCalledWith(
        expect.objectContaining({ cosmeticId: 'silver' }),
      );
    });

    it('is idempotent — a replayed recharge does not re-apply', async () => {
      repo.findRechargeLog.mockResolvedValue({ id: 'log-1' });
      const res = await service.recordRecharge({
        userId: 'u1',
        amount: 5_000,
        idempotencyKey: 'k1',
      });
      expect(res.upgraded).toBe(false);
      expect(repo.applyRecharge).not.toHaveBeenCalled();
    });
  });

  describe('getLevelOrdinal', () => {
    it('returns the ordinal of the current tier', async () => {
      repo.getStatus.mockResolvedValue({ level: VipLevel.GOLD, lifetimeRecharge: 200_000n });
      expect(await service.getLevelOrdinal('u1')).toBe(3);
    });

    it('returns 0 for a user with no VIP', async () => {
      repo.getStatus.mockResolvedValue(null);
      expect(await service.getLevelOrdinal('u1')).toBe(0);
    });
  });
});
