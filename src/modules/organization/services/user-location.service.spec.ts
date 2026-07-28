import { BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { UserLocationService } from './user-location.service';

describe('UserLocationService', () => {
  let service: UserLocationService;

  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    country: { findUnique: jest.fn(), findMany: jest.fn() },
    state: { findUnique: jest.fn() },
    region: { findUnique: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserLocationService(prisma as unknown as PrismaService);
  });

  describe('assignLocation', () => {
    it('stores a full country/state/region assignment', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.region.findUnique.mockResolvedValue({ id: 'r-1', stateId: 's-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });

      const result = await service.assignLocation('u-1', {
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });

      expect(result).toEqual({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });
    });

    it('rejects a state that does not belong to the given country', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-OTHER' });

      await expect(
        service.assignLocation('u-1', { countryId: 'c-1', stateId: 's-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a region that does not belong to the given state', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.region.findUnique.mockResolvedValue({ id: 'r-1', stateId: 's-OTHER' });

      await expect(
        service.assignLocation('u-1', { countryId: 'c-1', stateId: 's-1', regionId: 'r-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('derives the country from the state when only a state is given', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: null,
      });

      const result = await service.assignLocation('u-1', { stateId: 's-1' });

      // A state implies its country; storing it saves every country-scoped
      // query from having to join upward.
      expect(result.countryId).toBe('c-1');
    });

    it('derives state and country from a region alone', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.region.findUnique.mockResolvedValue({ id: 'r-1', stateId: 's-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });

      const result = await service.assignLocation('u-1', { regionId: 'r-1' });

      expect(result).toEqual({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });
    });

    it('clears the location when all three are explicitly null', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: null,
        stateId: null,
        regionId: null,
      });

      const result = await service.assignLocation('u-1', {
        countryId: null,
        stateId: null,
        regionId: null,
      });

      expect(result).toEqual({
        userId: 'u-1',
        countryId: null,
        stateId: null,
        regionId: null,
      });
    });

    it('rejects an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.assignLocation('ghost', { countryId: 'c-1' })).rejects.toThrow();
    });
  });

  describe('backfillFromProfileCountry', () => {
    it('matches a profile country by ISO code', async () => {
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1', country: 'IN' }]);
      prisma.user.update.mockResolvedValue({});

      const result = await service.backfillFromProfileCountry();

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { countryId: 'c-1' },
      });
      expect(result).toEqual({ scanned: 1, matched: 1, skipped: 0 });
    });

    it('matches a profile country by full name, case-insensitively', async () => {
      // `User.country` is free text — clients send "India" as often as "IN".
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1', country: 'india' }]);
      prisma.user.update.mockResolvedValue({});

      const result = await service.backfillFromProfileCountry();

      expect(result.matched).toBe(1);
    });

    it('skips a profile country it cannot match rather than guessing', async () => {
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1', country: 'Atlantis' }]);

      const result = await service.backfillFromProfileCountry();

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(result).toEqual({ scanned: 1, matched: 0, skipped: 1 });
    });

    it('never overwrites a location that has already been set', async () => {
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      // The query filters on countryId: null, so an assigned user is never read.
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.backfillFromProfileCountry();

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { countryId: null, country: { not: null } } }),
      );
      expect(result.matched).toBe(0);
    });
  });
});
