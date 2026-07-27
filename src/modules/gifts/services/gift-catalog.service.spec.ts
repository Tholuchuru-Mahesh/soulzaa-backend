import { Test, TestingModule } from '@nestjs/testing';
import { GiftCategory } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GiftAuditService } from './gift-audit.service';
import { GiftCatalogService } from './gift-catalog.service';

/**
 * Replaces the former `gift-engine.spec.ts`, which also exercised
 * `GiftValidationService` and `GiftTransactionService` — a parallel gift engine
 * that no controller, gateway or service ever called. Both were deleted along
 * with their tests; the live send pipeline is covered by `gift.service.spec.ts`.
 * What remains here is the catalog, which `GiftService` genuinely depends on.
 */
describe('GiftCatalogService', () => {
  let catalogService: GiftCatalogService;

  const mockPrismaService: any = {
    giftCategoryEntity: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
    },
    gift: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
    },
    giftAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftCatalogService,
        GiftAuditService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    catalogService = module.get<GiftCatalogService>(GiftCatalogService);
    jest.clearAllMocks();
  });

  it('should list catalog gifts', async () => {
    mockPrismaService.gift.findMany.mockResolvedValue([
      {
        id: 'gift-1',
        code: 'ROSE',
        name: 'Rose',
        coinValue: 10,
        category: GiftCategory.CLASSIC,
        enabled: true,
      },
    ]);

    const gifts = await catalogService.listGifts({});
    expect(gifts.length).toBe(1);
    expect(gifts[0].code).toBe('ROSE');
  });
});
