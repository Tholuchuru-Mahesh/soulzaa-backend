import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GiftCategory, GiftContextType, GiftTxnStatus, GiftType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { WalletService } from 'src/modules/wallet/services/wallet.service';
import { GiftAuditService } from './gift-audit.service';
import { GiftAvailabilityService } from './gift-availability.service';
import { GiftCatalogSeederService } from './gift-catalog-seeder.service';
import { GiftCatalogService } from './gift-catalog.service';
import { GiftHistoryService } from './gift-history.service';
import { GiftInventoryService } from './gift-inventory.service';
import { GiftQueryService } from './gift-query.service';
import { GiftTransactionService } from './gift-transaction.service';
import { GiftValidationService } from './gift-validation.service';

describe('Phase 5: Enterprise Gift Engine', () => {
  let catalogService: GiftCatalogService;
  let validationService: GiftValidationService;
  let transactionService: GiftTransactionService;
  let _historyService: GiftHistoryService;

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
    giftInventory: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    giftAvailability: {
      findUnique: jest.fn(),
    },
    giftTransaction: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    giftAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockWalletTxService = {
    transferCoins: jest.fn(),
  };

  const mockWalletService = {
    getOrCreateWallet: jest.fn(),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockFinancialPolicyService = {
    validatePolicyLimit: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    // Set up default mock implementations BEFORE compiling the module
    // so that onModuleInit lifecycle hooks get valid mock responses
    mockWalletService.getOrCreateWallet.mockImplementation((userId: string) =>
      Promise.resolve({ id: `w-${userId}`, status: 'ACTIVE', availableBalance: BigInt(10000) }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftAuditService,
        GiftCatalogService,
        GiftAvailabilityService,
        GiftValidationService,
        GiftInventoryService,
        GiftTransactionService,
        GiftHistoryService,
        GiftQueryService,
        GiftCatalogSeederService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WalletTransactionService, useValue: mockWalletTxService },
        { provide: WalletService, useValue: mockWalletService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: FinancialPolicyService, useValue: mockFinancialPolicyService },
      ],
    }).compile();

    catalogService = module.get<GiftCatalogService>(GiftCatalogService);
    validationService = module.get<GiftValidationService>(GiftValidationService);
    transactionService = module.get<GiftTransactionService>(GiftTransactionService);
    _historyService = module.get<GiftHistoryService>(GiftHistoryService);

    // Clear call history AFTER compile (preserves implementations)
    jest.clearAllMocks();
    // Re-set implementations after clearAllMocks (clearAllMocks only clears call history, not implementations)
    // However re-setting ensures consistent state
    mockWalletService.getOrCreateWallet.mockImplementation((userId: string) =>
      Promise.resolve({ id: `w-${userId}`, status: 'ACTIVE', availableBalance: BigInt(10000) }),
    );
  });

  describe('GiftCatalogService', () => {
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

  describe('GiftValidationService', () => {
    it('should throw error if user tries to send gift to themselves', async () => {
      await expect(
        validationService.validateGiftSend('user-1', 'user-1', 'gift-1', 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw error if Treasury Economy is frozen', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(true);

      await expect(
        validationService.validateGiftSend('sender-1', 'receiver-1', 'gift-1', 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw error if sender wallet balance is insufficient', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.gift.findFirst.mockResolvedValue({
        id: 'gift-1',
        name: 'Dragon',
        coinValue: 5000,
        enabled: true,
      });

      mockWalletService.getOrCreateWallet
        .mockResolvedValueOnce({ id: 'w-sender', status: 'ACTIVE', availableBalance: BigInt(100) })
        .mockResolvedValueOnce({ id: 'w-receiver', status: 'ACTIVE', availableBalance: BigInt(0) });

      await expect(
        validationService.validateGiftSend('sender-1', 'receiver-1', 'gift-1', 1),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GiftTransactionService', () => {
    it('should execute atomic gift transaction and delegate coin transfer to WalletTransactionService', async () => {
      mockPrismaService.giftTransaction.findUnique.mockResolvedValue(null);
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);

      const mockGift = {
        id: 'gift-1',
        code: 'ROSE',
        name: 'Rose',
        type: GiftType.STATIC,
        coinValue: 10,
        enabled: true,
        luckyMultipliers: [],
        luckyWinChanceBp: 0,
      };

      // Mock validationService to return a valid gift+totalCoinValue without
      // requiring a live wallet or DB connection in this unit test
      jest.spyOn(validationService, 'validateGiftSend').mockResolvedValue({
        gift: mockGift as any,
        totalCoinValue: BigInt(20),
        senderWallet: { id: 'w-sender', status: 'ACTIVE', availableBalance: BigInt(10000) } as any,
        receiverWallet: { id: 'w-receiver', status: 'ACTIVE', availableBalance: BigInt(0) } as any,
      });

      mockWalletTxService.transferCoins.mockResolvedValue({
        transactionId: 'wallet-tx-transfer-1',
      });

      mockPrismaService.giftTransaction.create.mockResolvedValue({
        id: 'gift-tx-1',
        senderId: 'sender-1',
        receiverId: 'receiver-1',
        giftId: 'gift-1',
        giftType: GiftType.STATIC,
        contextType: GiftContextType.AUDIO_ROOM,
        contextId: 'room-101',
        quantity: 2,
        unitCoinValue: 10,
        totalCoinValue: BigInt(20),
        creatorEarnings: BigInt(10),
        status: GiftTxnStatus.COMPLETED,
        idempotencyKey: 'idemp-gift-1',
      });

      const result = await transactionService.sendGift('sender-1', {
        giftId: 'gift-1',
        receiverId: 'receiver-1',
        contextType: GiftContextType.AUDIO_ROOM,
        contextId: 'room-101',
        quantity: 2,
        idempotencyKey: 'idemp-gift-1',
      });

      expect(result.id).toBe('gift-tx-1');
      expect(result.totalCoinValue).toBe('20');
      expect(mockWalletTxService.transferCoins).toHaveBeenCalledWith(
        expect.objectContaining({
          senderUserId: 'sender-1',
          recipientUserId: 'receiver-1',
          amount: 20,
        }),
        'sender-1',
      );
    });
  });
});
