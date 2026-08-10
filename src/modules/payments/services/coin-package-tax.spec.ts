import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinPackageService } from './coin-package.service';
import { PurchaseAuditService } from './purchase-audit.service';

/**
 * Tax is an economy value, so it belongs in Super Admin configuration rather
 * than in a shipped binary (PRD §12, §36: "Never place economy business values
 * inside ... UI"). The rate used to be a `const _gstRate = 0.18` in the Flutter
 * buy screen, which meant a rate change — or a second taxed country — required
 * an app release, and older installs would keep charging the old figure on
 * screen.
 */
describe('CoinPackageService tax configuration', () => {
  let service: CoinPackageService;

  const prisma = {
    user: { findUnique: jest.fn() },
    coinPackage: { findMany: jest.fn() },
  };

  const config = { get: jest.fn() };

  const pkgRow = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    code: 'IN_GOLD_100',
    name: '250 Coins',
    coins: BigInt(250),
    bonusCoins: BigInt(0),
    priceAmount: 100,
    currency: 'INR',
    country: 'IN',
    sortOrder: 0,
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ locationCountry: { code: 'IN' } });
    service = new CoinPackageService(
      prisma as unknown as PrismaService,
      {} as unknown as PurchaseAuditService,
      config as never,
    );
  });

  it('returns the configured tax rate on every package', async () => {
    prisma.coinPackage.findMany.mockResolvedValue([pkgRow()]);
    config.get.mockImplementation(async (key: string) =>
      key === 'payments.tax_rate_percent.IN' ? 18 : undefined,
    );

    const [pkg] = await service.listPackages({}, 'u-1');

    expect(pkg.taxRatePercent).toBe(18);
  });

  it('prefers a country-specific rate over the platform-wide default', async () => {
    prisma.coinPackage.findMany.mockResolvedValue([pkgRow({ country: 'AE' })]);
    config.get.mockImplementation(async (key: string) => {
      if (key === 'payments.tax_rate_percent.AE') return 5;
      if (key === 'payments.tax_rate_percent') return 18;
      return undefined;
    });

    const [pkg] = await service.listPackages({}, 'u-1');

    expect(pkg.taxRatePercent).toBe(5);
  });

  it('falls back to the platform-wide rate when the country has none', async () => {
    prisma.coinPackage.findMany.mockResolvedValue([pkgRow({ country: 'GLOBAL' })]);
    config.get.mockImplementation(async (key: string) =>
      key === 'payments.tax_rate_percent' ? 12 : undefined,
    );

    const [pkg] = await service.listPackages({}, 'u-1');

    expect(pkg.taxRatePercent).toBe(12);
  });

  it('reports zero — not a guessed 18% — when no tax is configured', async () => {
    prisma.coinPackage.findMany.mockResolvedValue([pkgRow()]);
    config.get.mockResolvedValue(undefined);

    const [pkg] = await service.listPackages({}, 'u-1');

    // Inventing a tax the platform never configured would overstate the total
    // the user is about to be charged.
    expect(pkg.taxRatePercent).toBe(0);
  });

  it('ignores a non-numeric configured value rather than propagating NaN', async () => {
    prisma.coinPackage.findMany.mockResolvedValue([pkgRow()]);
    config.get.mockResolvedValue('eighteen');

    const [pkg] = await service.listPackages({}, 'u-1');

    expect(pkg.taxRatePercent).toBe(0);
  });
});
