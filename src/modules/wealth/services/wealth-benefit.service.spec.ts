import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { IEventBus } from 'src/common/events';
import type { RewardFulfillmentEngine } from 'src/modules/tasks/services/reward-engine/reward-fulfillment.engine';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthBenefitService } from './wealth-benefit.service';

function benefit(level: number, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    level,
    benefitType: 'BADGE',
    config: {},
    cosmeticId: null,
    coinAmount: null,
    durationDays: null,
    isActive: true,
    ...extra,
  };
}

describe('WealthBenefitService', () => {
  let repo: Record<string, jest.Mock>;
  let cosmetics: Record<string, jest.Mock>;
  let rewardEngine: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let service: WealthBenefitService;

  beforeEach(() => {
    repo = {
      listBenefits: jest
        .fn()
        .mockResolvedValue([
          benefit(0, 'normal-badge'),
          benefit(1, 'prestige-badge'),
          benefit(2, 'rise-badge'),
          benefit(3, 'nova-badge'),
          benefit(4, 'elite-badge'),
        ]),
      listBenefitClaimsForUser: jest.fn().mockResolvedValue([]),
      getBenefit: jest.fn(),
      findBenefitClaim: jest.fn().mockResolvedValue(null),
      createBenefitClaim: jest.fn().mockResolvedValue({ id: 'claim-1' }),
    };
    cosmetics = {
      grantToUser: jest.fn(),
      equip: jest.fn(),
      unequip: jest.fn(),
      isEquipped: jest.fn().mockResolvedValue(false),
    };
    rewardEngine = { fulfillRewards: jest.fn().mockResolvedValue({}) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new WealthBenefitService(
      repo as unknown as WealthRepository,
      cosmetics as unknown as ICosmeticsService,
      rewardEngine as unknown as RewardFulfillmentEngine,
      bus,
    );
  });

  it('a Nova (level 3) user holds every benefit from Normal User through Nova, cumulatively', async () => {
    const benefits = await service.getBenefitsUpToLevel(3);

    expect(benefits.map((b) => b.id)).toEqual([
      'normal-badge',
      'prestige-badge',
      'rise-badge',
      'nova-badge',
    ]);
  });

  it('does not include benefits from levels above the user', async () => {
    const benefits = await service.getBenefitsUpToLevel(3);

    expect(benefits.map((b) => b.id)).not.toContain('elite-badge');
  });

  it('a level 0 (Normal User) still holds level-0 benefits', async () => {
    const benefits = await service.getBenefitsUpToLevel(0);

    expect(benefits.map((b) => b.id)).toEqual(['normal-badge']);
  });

  it('only returns active benefits (the repository already filters, this just proves pass-through)', async () => {
    repo.listBenefits.mockResolvedValue([benefit(1, 'active-one')]);

    const benefits = await service.getBenefitsUpToLevel(5);

    expect(benefits).toHaveLength(1);
  });

  describe('claimBenefit', () => {
    it('rejects a legacy passive benefit (no cosmeticId/coinAmount) as not claimable', async () => {
      repo.getBenefit.mockResolvedValue(benefit(1, 'vip-hall', { benefitType: 'VIP_HALL' }));

      await expect(service.claimBenefit('u1', 'vip-hall', 5)).rejects.toThrow();
      expect(rewardEngine.fulfillRewards).not.toHaveBeenCalled();
    });

    it('rejects when the user level is below the benefit level', async () => {
      repo.getBenefit.mockResolvedValue(
        benefit(5, 'frame-5', { benefitType: 'PROFILE_FRAME', cosmeticId: 'cos-1' }),
      );

      await expect(service.claimBenefit('u1', 'frame-5', 2)).rejects.toThrow();
      expect(rewardEngine.fulfillRewards).not.toHaveBeenCalled();
    });

    it('claims a grantable benefit through the shared RewardFulfillmentEngine', async () => {
      repo.getBenefit.mockResolvedValue(
        benefit(1, 'frame-1', { benefitType: 'PROFILE_FRAME', cosmeticId: 'cos-1' }),
      );

      const res = await service.claimBenefit('u1', 'frame-1', 3);

      expect(res).toEqual({ claimed: true });
      expect(repo.createBenefitClaim).toHaveBeenCalledWith('u1', 'frame-1');
      expect(rewardEngine.fulfillRewards).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          rewardDefinition: [expect.objectContaining({ type: 'FRAME', cosmeticId: 'cos-1' })],
        }),
      );
      expect(bus.publish).toHaveBeenCalled();
    });

    it('is idempotent — a second claim is a no-op replay', async () => {
      repo.getBenefit.mockResolvedValue(
        benefit(1, 'frame-1', { benefitType: 'PROFILE_FRAME', cosmeticId: 'cos-1' }),
      );
      repo.findBenefitClaim.mockResolvedValue({ id: 'existing-claim' });

      const res = await service.claimBenefit('u1', 'frame-1', 3);

      expect(res).toEqual({ claimed: true });
      expect(repo.createBenefitClaim).not.toHaveBeenCalled();
      expect(rewardEngine.fulfillRewards).not.toHaveBeenCalled();
    });
  });

  describe('equipBenefit', () => {
    it('refuses to equip a grantable benefit that has not been claimed yet', async () => {
      repo.getBenefit.mockResolvedValue(
        benefit(1, 'frame-1', { benefitType: 'PROFILE_FRAME', cosmeticId: 'cos-1' }),
      );
      repo.findBenefitClaim.mockResolvedValue(null);

      await expect(service.equipBenefit('u1', 'frame-1', 5)).rejects.toThrow();
      expect(cosmetics.equip).not.toHaveBeenCalled();
    });

    it('equips once the benefit has been claimed', async () => {
      repo.getBenefit.mockResolvedValue(
        benefit(1, 'frame-1', { benefitType: 'PROFILE_FRAME', cosmeticId: 'cos-1' }),
      );
      repo.findBenefitClaim.mockResolvedValue({ id: 'claim-1' });

      await service.equipBenefit('u1', 'frame-1', 5);

      expect(cosmetics.equip).toHaveBeenCalledWith('u1', 'cos-1');
    });
  });
});
