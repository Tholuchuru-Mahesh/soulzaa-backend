import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthBenefitService } from './wealth-benefit.service';

function benefit(level: number, id: string) {
  return { id, level, benefitType: 'BADGE', config: {}, isActive: true };
}

describe('WealthBenefitService', () => {
  let repo: Record<string, jest.Mock>;
  let cosmetics: Record<string, jest.Mock>;
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
    };
    cosmetics = {
      grantToUser: jest.fn(),
      equip: jest.fn(),
      unequip: jest.fn(),
      isEquipped: jest.fn().mockResolvedValue(false),
    };
    service = new WealthBenefitService(
      repo as unknown as WealthRepository,
      cosmetics as unknown as ICosmeticsService,
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
});
