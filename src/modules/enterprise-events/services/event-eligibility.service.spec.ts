import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventEligibilityService } from './event-eligibility.service';

describe('EventEligibilityService country restriction', () => {
  let service: EventEligibilityService;

  const prisma = {
    user: { findUnique: jest.fn() },
    country: { findMany: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EventEligibilityService(prisma as unknown as PrismaService);
  });

  it('admits a user whose normalised country is allowed, whatever their profile text says', async () => {
    // Profile says "India"; the allow-list says "IN". Matching on countryId makes
    // the two agree — string matching silently rejected this user.
    prisma.user.findUnique.mockResolvedValue({ countryId: 'c-in' });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-in', code: 'IN' }]);

    const result = await service.checkCountryEligibility('u-1', { allowedCountries: ['IN'] });

    expect(result.eligible).toBe(true);
  });

  it('rejects a user whose normalised country is not on the list', async () => {
    prisma.user.findUnique.mockResolvedValue({ countryId: 'c-in' });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-ae', code: 'AE' }]);

    const result = await service.checkCountryEligibility('u-1', { allowedCountries: ['AE'] });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('not eligible');
  });

  it('rejects a user with no normalised country rather than guessing from profile text', async () => {
    prisma.user.findUnique.mockResolvedValue({ countryId: null });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-in', code: 'IN' }]);

    const result = await service.checkCountryEligibility('u-1', { allowedCountries: ['IN'] });

    // Fail closed: an unnormalised user is not silently admitted to a
    // geo-restricted event on the strength of a free-text field.
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('location has not been set');
  });

  it('admits everyone when the event sets no country restriction', async () => {
    const result = await service.checkCountryEligibility('u-1', {});

    expect(result.eligible).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('never reads the free-text country field', async () => {
    prisma.user.findUnique.mockResolvedValue({ countryId: 'c-in' });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-in', code: 'IN' }]);

    await service.checkCountryEligibility('u-1', { allowedCountries: ['IN'] });

    const select = prisma.user.findUnique.mock.calls[0][0].select;
    expect(select).toEqual({ countryId: true });
  });
});
