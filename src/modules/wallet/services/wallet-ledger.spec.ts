import { Test, TestingModule } from '@nestjs/testing';
import {
  ReservationStatus,
  TransactionStatus,
  WalletEntryType,
  WalletStatus,
  WalletType,
} from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { FeatureFlagService } from 'src/modules/platform-configuration/services/feature-flag.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletRepository } from '../repositories/wallet.repository';
import { BalanceService } from './balance.service';
import { LedgerService } from './ledger.service';
import { ReservationService } from './reservation.service';
import { TransactionQueryService } from './transaction-query.service';
import { WalletAuditService } from './wallet-audit.service';
import { WalletTransactionService } from './wallet-transaction.service';
import { WalletValidationService } from './wallet-validation.service';
import { WalletService } from './wallet.service';

describe('Phase 3: Enterprise Wallet & Double-Entry Ledger Infrastructure', () => {
  let walletService: WalletService;
  let balanceService: BalanceService;
  let reservationService: ReservationService;
  let transactionService: WalletTransactionService;

  const mockPrismaService: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    wallet: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    ledgerEntry: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    walletTransaction: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    walletReservation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    walletAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((cb: (tx: any) => Promise<any>) => cb(mockPrismaService)),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockFeatureFlagService = {
    isEnabled: jest.fn().mockResolvedValue(true),
  };

  // WalletService's movement path (debit/credit) collaborators. The suites here
  // exercise wallet lifecycle, balances, reservations and transactions, none of
  // which reach these — they are provided so the container can resolve the graph.
  const mockWalletRepository = {
    ensureWallet: jest.fn().mockResolvedValue(undefined),
    getWallet: jest.fn().mockResolvedValue(null),
    applyMovement: jest.fn(),
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    listTransactions: jest.fn().mockResolvedValue([[], 0]),
  };

  const mockLockService = {
    withLock: jest.fn(<T>(_key: string, fn: () => Promise<T>) => fn()),
  };

  const mockEventBus = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  };

  const mockWalletMetrics = { recordMovement: jest.fn(), recordFailure: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletAuditService,
        WalletValidationService,
        WalletService,
        LedgerService,
        BalanceService,
        ReservationService,
        WalletTransactionService,
        TransactionQueryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: FeatureFlagService, useValue: mockFeatureFlagService },
        { provide: WalletRepository, useValue: mockWalletRepository },
        { provide: LockService, useValue: mockLockService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: WalletMetrics, useValue: mockWalletMetrics },
      ],
    }).compile();

    walletService = module.get<WalletService>(WalletService);
    balanceService = module.get<BalanceService>(BalanceService);
    reservationService = module.get<ReservationService>(ReservationService);
    transactionService = module.get<WalletTransactionService>(WalletTransactionService);

    jest.clearAllMocks();
  });

  describe('WalletService', () => {
    it('should create a new wallet account if not existing', async () => {
      mockPrismaService.wallet.findUnique.mockResolvedValue(null);
      mockPrismaService.wallet.create.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        type: WalletType.USER_WALLET,
        status: WalletStatus.ACTIVE,
        availableBalance: BigInt(0),
        goldBalance: BigInt(0),
        freeBalance: BigInt(0),
        earningsBalance: BigInt(0),
      });

      const wallet = await walletService.getOrCreateWallet('u-1');
      expect(wallet.id).toBe('w-1');
      expect(mockPrismaService.wallet.create).toHaveBeenCalled();
    });
  });

  describe('BalanceService', () => {
    it('should compute balance projections and reconcile with ledger entries', async () => {
      mockPrismaService.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        availableBalance: BigInt(500),
        reservedBalance: BigInt(100),
        pendingBalance: BigInt(0),
        lockedBalance: BigInt(0),
        goldBalance: BigInt(600),
        freeBalance: BigInt(0),
        earningsBalance: BigInt(0),
        version: 1,
        updatedAt: new Date(),
      });

      mockPrismaService.ledgerEntry.findMany.mockResolvedValue([
        { type: WalletEntryType.CREDIT, amount: BigInt(700) },
        { type: WalletEntryType.DEBIT, amount: BigInt(200) },
      ]);

      const projection = await balanceService.getBalanceProjection('w-1');
      // Spendable balance is derived per-currency (gold 600 + free 0), not from the
      // cached availableBalance column; total then adds reserved 100 + pending +
      // locked. reconcileBalanceWithLedger below is what checks the cached column.
      expect(projection.availableBalance).toBe('600');
      expect(projection.totalBalance).toBe('700');

      const reconciliation = await balanceService.reconcileBalanceWithLedger('w-1');
      expect(reconciliation.isReconciled).toBe(true);
      expect(reconciliation.derivedNetBalance).toBe('500');
    });
  });

  describe('ReservationService', () => {
    it('should place a coin reservation hold successfully', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockFeatureFlagService.isEnabled.mockResolvedValue(true);

      mockPrismaService.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        status: WalletStatus.ACTIVE,
        availableBalance: BigInt(1000),
        reservedBalance: BigInt(0),
      });

      mockPrismaService.wallet.update.mockResolvedValue({
        availableBalance: BigInt(800),
        reservedBalance: BigInt(200),
      });

      mockPrismaService.walletReservation.create.mockResolvedValue({
        id: 'res-1',
        walletId: 'w-1',
        amount: BigInt(200),
        purpose: 'GAME_STAKE',
        status: ReservationStatus.HELD,
      });

      const res = await reservationService.reserveCoins({
        userId: 'u-1',
        amount: 200,
        purpose: 'GAME_STAKE',
      });

      expect(res.id).toBe('res-1');
      expect(res.walletReservedBalance).toBe('200');
    });
  });

  describe('WalletTransactionService', () => {
    it('should credit a wallet account idempotently', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockFeatureFlagService.isEnabled.mockResolvedValue(true);

      mockPrismaService.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrismaService.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        status: WalletStatus.ACTIVE,
        availableBalance: BigInt(500),
      });

      mockPrismaService.walletTransaction.create.mockResolvedValue({
        id: 'tx-1',
        idempotencyKey: 'idemp-1',
        status: TransactionStatus.COMPLETED,
        createdAt: new Date(),
      });

      mockPrismaService.wallet.update.mockResolvedValue({
        availableBalance: BigInt(1500),
      });

      const result = await transactionService.creditWallet({
        userId: 'u-1',
        amount: 1000,
        idempotencyKey: 'idemp-1',
      });

      expect(result.transactionId).toBe('tx-1');
      expect((result as any).balanceAfter).toBe('1500');
    });
  });
});
