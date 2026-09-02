import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthAdminService } from './wealth-admin.service';
import { WealthLevelService } from './wealth-level.service';

describe('WealthAdminService', () => {
  let repo: Record<string, jest.Mock>;
  let levels: Record<string, jest.Mock>;
  let cosmetics: Record<string, jest.Mock>;
  let service: WealthAdminService;

  beforeEach(() => {
    repo = {
      listAllLevels: jest.fn().mockResolvedValue([]),
      getLevel: jest.fn().mockResolvedValue(null),
      upsertLevel: jest.fn().mockImplementation((level, data) => ({ id: 'lvl-1', level, ...data })),
      nextLevelOrdinal: jest.fn().mockResolvedValue(0),
      listAllCategories: jest.fn().mockResolvedValue([]),
      getCategory: jest.fn(),
      createCategory: jest.fn().mockImplementation((data) => ({ id: 'cat-1', ...data })),
      updateCategory: jest.fn().mockImplementation((id, data) => ({ id, ...data })),
      getBenefit: jest.fn(),
      createBenefit: jest.fn().mockImplementation((data) => ({ id: 'benefit-1', ...data })),
      updateBenefit: jest.fn().mockImplementation((id, data) => ({ id, ...data })),
      writeAudit: jest.fn().mockResolvedValue(undefined),
    };
    levels = { reload: jest.fn().mockResolvedValue(undefined) };
    cosmetics = {
      getCosmetic: jest.fn(),
      setMedia: jest.fn().mockResolvedValue(undefined),
    };
    service = new WealthAdminService(
      repo as unknown as WealthRepository,
      levels as unknown as WealthLevelService,
      cosmetics as unknown as ICosmeticsService,
    );
  });

  describe('upsertLevel', () => {
    it('persists backgroundUrl alongside the existing fields and busts the level cache', async () => {
      await service.upsertLevel('actor-1', 1, {
        name: 'Prestige',
        expThreshold: 10_000,
        iconUrl: 'icon.png',
        backgroundUrl: 'bg.png',
      });

      expect(repo.upsertLevel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ backgroundUrl: 'bg.png', iconUrl: 'icon.png' }),
      );
      expect(levels.reload).toHaveBeenCalled();
      expect(repo.writeAudit).toHaveBeenCalled();
    });
  });

  describe('benefit categories', () => {
    it('creates a category and audits it', async () => {
      const created = await service.createCategory('actor-1', { level: 1, name: 'Frames', iconUrl: 'frame-icon.png' });

      expect(created).toEqual(expect.objectContaining({ level: 1, name: 'Frames' }));
      expect(repo.writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'WEALTH_BENEFIT_CATEGORY_CREATED' }),
      );
    });

    it('rejects updating a category that does not exist', async () => {
      repo.getCategory.mockResolvedValue(null);

      await expect(service.updateCategory('actor-1', 'missing', { name: 'X' })).rejects.toThrow();
      expect(repo.updateCategory).not.toHaveBeenCalled();
    });
  });

  describe('benefit <-> category ownership', () => {
    it('rejects creating a benefit whose categoryId belongs to a different level', async () => {
      repo.getCategory.mockResolvedValue({ id: 'cat-1', level: 2, name: 'Frames' });

      await expect(
        service.createBenefit('actor-1', {
          level: 1,
          categoryId: 'cat-1',
          benefitType: 'OTHER',
          config: {},
        }),
      ).rejects.toThrow(/level 2, not level 1/);
      expect(repo.createBenefit).not.toHaveBeenCalled();
    });

    it('rejects creating a benefit whose categoryId does not exist', async () => {
      repo.getCategory.mockResolvedValue(null);

      await expect(
        service.createBenefit('actor-1', {
          level: 1,
          categoryId: 'missing-cat',
          benefitType: 'OTHER',
          config: {},
        }),
      ).rejects.toThrow();
      expect(repo.createBenefit).not.toHaveBeenCalled();
    });

    it('allows creating a benefit whose categoryId belongs to the same level', async () => {
      repo.getCategory.mockResolvedValue({ id: 'cat-1', level: 1, name: 'Frames' });

      const created = await service.createBenefit('actor-1', {
        level: 1,
        categoryId: 'cat-1',
        benefitType: 'OTHER',
        config: {},
      });

      expect(created).toEqual(expect.objectContaining({ categoryId: 'cat-1' }));
      expect(repo.createBenefit).toHaveBeenCalled();
    });

    it('rejects re-categorizing an existing benefit into another level\'s category', async () => {
      repo.getBenefit.mockResolvedValue({ id: 'b1', level: 1, benefitType: 'OTHER', cosmeticId: null, coinAmount: null });
      repo.getCategory.mockResolvedValue({ id: 'cat-2', level: 2, name: 'Effects' });

      await expect(
        service.updateBenefit('actor-1', 'b1', { categoryId: 'cat-2' }),
      ).rejects.toThrow(/level 2, not level 1/);
      expect(repo.updateBenefit).not.toHaveBeenCalled();
    });

    it('allows clearing categoryId back to null (uncategorizing)', async () => {
      repo.getBenefit.mockResolvedValue({ id: 'b1', level: 1, benefitType: 'OTHER', cosmeticId: null, coinAmount: null });

      await service.updateBenefit('actor-1', 'b1', { categoryId: null });

      expect(repo.updateBenefit).toHaveBeenCalledWith('b1', expect.objectContaining({ categoryId: null }));
    });

    it('rejects updating a benefit that does not exist', async () => {
      repo.getBenefit.mockResolvedValue(null);

      await expect(service.updateBenefit('actor-1', 'missing', { isActive: false })).rejects.toThrow();
      expect(repo.updateBenefit).not.toHaveBeenCalled();
    });
  });
});
