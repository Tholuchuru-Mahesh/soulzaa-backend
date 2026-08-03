import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinPackageService } from './coin-package.service';
import { PurchaseAuditService } from './purchase-audit.service';

/**
 * Regional pricing must be decided server-side. It used to come from a query
 * parameter, so any client could see any region's prices by changing it.
 */
describe('CoinPackageService regional pricing', () => {
  let service: CoinPackageService;

  const prisma = {
    user: { findUnique: jest.fn() },
    coinPackage: { findMany: jest.fn().mockResolvedValue([]) },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.coinPackage.findMany.mockResolvedValue([]);
    service = new CoinPackageService(
      prisma as unknown as PrismaService,
      {} as unknown as PurchaseAuditService,
    );
  });

  const whereOf = () => prisma.coinPackage.findMany.mock.calls[0][0].where;

  it('uses the caller’s normalised country, not the one they asked for', async () => {
    prisma.user.findUnique.mockResolvedValue({ locationCountry: { code: 'IN' } });

    await service.listPackages({ country: 'US' }, 'u-1');

    // The request said US; the user is in IN. IN must win.
    expect(JSON.stringify(whereOf())).toContain('IN');
    expect(JSON.stringify(whereOf())).not.toContain('US');
  });

  it('falls back to the default storefront country when the caller has no location', async () => {
    prisma.user.findUnique.mockResolvedValue({ locationCountry: null });

    await service.listPackages({ country: 'US' }, 'u-1');

    // Nobody sets `countryId` at signup, so almost every real user lands here.
    // Restricting them to GLOBAL made the whole INR panel unreachable: those
    // rows are country 'IN', so the storefront showed only the USD leftovers.
    // The fallback is a server constant, never the caller's `country` — the
    // request asked for US and must still not get it.
    expect(whereOf().AND).toContainEqual({
      OR: [{ country: 'GLOBAL' }, { country: 'IN' }],
    });
    expect(JSON.stringify(whereOf())).not.toContain('US');
  });

  it('keeps the platform constraint when a country also applies', async () => {
    prisma.user.findUnique.mockResolvedValue({ locationCountry: { code: 'IN' } });

    await service.listPackages({ platform: 'IOS' }, 'u-1');

    // Both filters previously assigned `where.OR`, so the second overwrote the
    // first and the platform constraint silently vanished.
    const serialised = JSON.stringify(whereOf());
    expect(serialised).toContain('IOS');
    expect(serialised).toContain('IN');
    expect(whereOf().AND).toHaveLength(2);
  });

  it('honours an explicit country only when no user is supplied', async () => {
    await service.listPackages({ country: 'US' });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(JSON.stringify(whereOf())).toContain('US');
  });
});
