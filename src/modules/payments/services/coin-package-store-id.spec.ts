import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinPackageService } from './coin-package.service';
import { PurchaseAuditService } from './purchase-audit.service';

/**
 * The catalogue is the only place the client learns which Play SKU maps to which
 * bundle. A package that reaches the app without its product ID cannot be bought,
 * so this is asserted rather than assumed.
 */
describe('CoinPackageService store product IDs', () => {
  let service: CoinPackageService;

  const mockPrisma: any = {
    coinPackage: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    purchaseAudit: { create: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ locationCountry: { code: 'IN' } }) },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinPackageService,
        PurchaseAuditService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(CoinPackageService);
    jest.clearAllMocks();
  });

  it('exposes googleProductId on listed packages', async () => {
    mockPrisma.coinPackage.findMany.mockResolvedValue([
      {
        id: 'pkg-1',
        code: 'IN_GOLD_100',
        name: '250 Coins',
        coins: 250n,
        bonusCoins: 0n,
        priceAmount: 100,
        currency: 'INR',
        country: 'IN',
        platform: 'ALL',
        googleProductId: 'in_gold_100',
        appleProductId: null,
        isActive: true,
        sortOrder: 0,
      },
    ]);

    const result = await service.listPackages({}, 'user-1');

    expect(result[0].googleProductId).toBe('in_gold_100');
    // BigInt fields must stay strings on the wire.
    expect(result[0].coins).toBe('250');
  });

  /**
   * A validator on a field that never reaches the database is worse than no
   * field at all: an admin sets a product ID, gets no error, and the mismatch
   * only surfaces later when a real purchase fails verification. Asserting on
   * the payload actually handed to Prisma — not on the return value — is the
   * only way to catch a field getting silently enumerated out.
   */
  it('persists googleProductId when creating a package', async () => {
    mockPrisma.coinPackage.findUnique.mockResolvedValue(null);
    mockPrisma.coinPackage.create.mockResolvedValue({
      id: 'pkg-2',
      code: 'IN_GOLD_200',
      name: '500 Coins',
      coins: 500n,
      bonusCoins: 0n,
      priceAmount: 200,
      currency: 'INR',
      country: 'IN',
      platform: 'ALL',
      googleProductId: 'in_gold_100',
      appleProductId: null,
      isActive: true,
      sortOrder: 0,
    });

    await service.createPackage({
      code: 'IN_GOLD_200',
      name: '500 Coins',
      coins: 500,
      priceAmount: 200,
      googleProductId: 'in_gold_100',
    } as any);

    expect(mockPrisma.coinPackage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ googleProductId: 'in_gold_100' }),
      }),
    );
  });

  it('leaves googleProductId untouched when updating a package without one', async () => {
    mockPrisma.coinPackage.findFirst.mockResolvedValue({
      id: 'pkg-3',
      code: 'IN_GOLD_500',
      name: '1250 Coins',
      coins: 1250n,
      bonusCoins: 0n,
      priceAmount: 500,
      currency: 'INR',
      country: 'IN',
      platform: 'ALL',
      googleProductId: 'in_gold_500',
      appleProductId: null,
      isActive: true,
      sortOrder: 0,
    });
    mockPrisma.coinPackage.update.mockResolvedValue({
      id: 'pkg-3',
      code: 'IN_GOLD_500',
      name: '1250 Coins Renamed',
      coins: 1250n,
      bonusCoins: 0n,
      priceAmount: 500,
      currency: 'INR',
      country: 'IN',
      platform: 'ALL',
      googleProductId: 'in_gold_500',
      appleProductId: null,
      isActive: true,
      sortOrder: 0,
    });

    // An unrelated rename must not wipe an existing product ID: no
    // googleProductId in the DTO means the field is absent, not null.
    await service.updatePackage('pkg-3', { name: '1250 Coins Renamed' });

    expect(mockPrisma.coinPackage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ googleProductId: undefined }),
      }),
    );
  });
});
