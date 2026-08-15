import { resolveUserCountryCode } from './resolve-user-country';

/**
 * Both sides of the cross-border check resolve through this, so the two things
 * that matter are: an account located only by the normalised hierarchy still
 * resolves, and two spellings of the same country collapse to one code.
 */
describe('resolveUserCountryCode', () => {
  function build(user: Record<string, unknown> | null, country: Record<string, unknown> | null) {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      country: {
        findUnique: jest.fn().mockResolvedValue(country),
        findFirst: jest.fn().mockResolvedValue(country),
      },
    };
    return prisma;
  }

  it('resolves from countryId, which is all the application flow writes', async () => {
    // The exact case that broke: an agency approved through the new form has a
    // countryId and no free-text country, and could not open its inventory.
    const prisma = build({ country: null, countryId: 'c-in' }, { code: 'IN' });

    await expect(resolveUserCountryCode(prisma, 'u-1')).resolves.toBe('IN');
    expect(prisma.country.findUnique).toHaveBeenCalledWith({
      where: { id: 'c-in' },
      select: { code: true },
    });
  });

  it('collapses a free-text country name to its code', async () => {
    // Otherwise a seller holding "IN" and a buyer holding "India" read as two
    // different countries and a legitimate sale is refused.
    const prisma = build({ country: 'India', countryId: null }, { code: 'IN' });

    await expect(resolveUserCountryCode(prisma, 'u-1')).resolves.toBe('IN');
  });

  it('prefers countryId over the free text when both are present', async () => {
    const prisma = build({ country: 'Atlantis', countryId: 'c-in' }, { code: 'IN' });

    await expect(resolveUserCountryCode(prisma, 'u-1')).resolves.toBe('IN');
  });

  it('falls back to the raw text for a country not in the table yet', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ country: 'np', countryId: null }) },
      country: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    // Upper-cased so it still compares consistently against a stored code.
    await expect(resolveUserCountryCode(prisma, 'u-1')).resolves.toBe('NP');
  });

  it('returns null when the account has no location at all', async () => {
    const prisma = build({ country: null, countryId: null }, null);

    await expect(resolveUserCountryCode(prisma, 'u-1')).resolves.toBeNull();
  });

  it('returns null for a user that does not exist', async () => {
    const prisma = build(null, null);

    await expect(resolveUserCountryCode(prisma, 'ghost')).resolves.toBeNull();
  });
});
