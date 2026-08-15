import { Test, TestingModule } from '@nestjs/testing';
import { WalletCurrency, WalletStatus, WalletTxnReason, WalletType } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletAuditService } from './wallet-audit.service';
import { WalletService } from './wallet.service';
import { WalletValidationService } from './wallet-validation.service';

describe('WalletService', () => {
  let service: WalletService;

  const mockPrismaService = {
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockAuditService = {
    logAudit: jest.fn().mockResolvedValue({}),
  };

  // Wallet lifecycle (create/read/status) runs entirely on prisma + audit; the
  // remaining constructor dependencies belong to the movement path (debit/credit)
  // and are stubbed only so the container can resolve the service.
  const mockRepo = {
    ensureWallet: jest.fn().mockResolvedValue(undefined),
    getWallet: jest.fn().mockResolvedValue(null),
    applyMovement: jest.fn(),
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    listTransactions: jest.fn().mockResolvedValue([[], 0]),
  };
  const mockLocks = {
    withLock: jest.fn(<T>(_key: string, fn: () => Promise<T>) => fn()),
  };
  const mockBus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const mockMetrics = { recordMovement: jest.fn(), recordFailure: jest.fn() };
  const mockValidation = {
    validateEconomyStatus: jest.fn().mockResolvedValue(undefined),
    validateWalletActive: jest.fn(),
    validatePositiveAmount: jest.fn(),
    validateSufficientBalance: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WalletRepository, useValue: mockRepo },
        { provide: LockService, useValue: mockLocks },
        { provide: EVENT_BUS, useValue: mockBus },
        { provide: WalletMetrics, useValue: mockMetrics },
        { provide: WalletAuditService, useValue: mockAuditService },
        { provide: WalletValidationService, useValue: mockValidation },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    jest.clearAllMocks();
  });

  it('should create wallet if not existing', async () => {
    mockPrismaService.wallet.findUnique.mockResolvedValue(null);
    mockPrismaService.wallet.create.mockResolvedValue({
      id: 'w-100',
      userId: 'user-100',
      type: WalletType.USER_WALLET,
      status: WalletStatus.ACTIVE,
    });

    const wallet = await service.getOrCreateWallet('user-100');
    expect(wallet.id).toBe('w-100');
    expect(mockPrismaService.wallet.create).toHaveBeenCalled();
  });

  it('should return existing wallet if found', async () => {
    mockPrismaService.wallet.findUnique.mockResolvedValue({
      id: 'w-200',
      userId: 'user-200',
      type: WalletType.USER_WALLET,
      status: WalletStatus.ACTIVE,
    });

    const wallet = await service.getOrCreateWallet('user-200');
    expect(wallet.id).toBe('w-200');
    expect(mockPrismaService.wallet.create).not.toHaveBeenCalled();
  });

  it('should update wallet status', async () => {
    mockPrismaService.wallet.findUnique.mockResolvedValue({
      id: 'w-300',
      userId: 'user-300',
      status: WalletStatus.ACTIVE,
    });

    mockPrismaService.wallet.update.mockResolvedValue({
      id: 'w-300',
      userId: 'user-300',
      status: WalletStatus.LOCKED,
    });

    const updated = await service.updateWalletStatus('w-300', WalletStatus.LOCKED, 'actor-1');
    expect(updated.status).toBe(WalletStatus.LOCKED);
    expect(mockAuditService.logAudit).toHaveBeenCalled();
  });

  it('W4: an idempotent replay reports the wallet CURRENT balance, not the original amount', async () => {
    mockRepo.findByIdempotencyKey.mockResolvedValue({
      id: 'tx-1',
      currency: WalletCurrency.GOLD,
      amount: 100n,
    });
    mockRepo.getWallet.mockResolvedValue({
      id: 'w-1',
      goldBalance: 750n,
      diamondBalance: 0n,
      gameBalance: 0n,
      freeBalance: 0n,
      earningsBalance: 0n,
    });

    const res = await service.debit({
      userId: 'u1',
      currency: WalletCurrency.GOLD,
      amount: 100,
      reason: WalletTxnReason.CASINO_BET,
      idempotencyKey: 'k1',
    });

    expect(res.duplicate).toBe(true);
    expect(res.balanceAfter).toBe(750);
    expect(mockRepo.applyMovement).not.toHaveBeenCalled();
  });

  it('validates economy status on a DEBIT before any money moves (freeze gate)', async () => {
    mockRepo.findByIdempotencyKey.mockResolvedValue(null);
    mockRepo.applyMovement.mockResolvedValue({
      transactionId: 'tx-2',
      walletId: 'w-1',
      currency: WalletCurrency.GOLD,
      amount: 100n,
      reason: WalletTxnReason.CASINO_BET,
      balanceAfter: 800n,
    });
    const res = await service.debit({
      userId: 'u1',
      currency: WalletCurrency.GOLD,
      amount: 100,
      reason: WalletTxnReason.CASINO_BET,
      idempotencyKey: 'k1',
    });
    expect(mockValidation.validateEconomyStatus).toHaveBeenCalled();
    expect(mockRepo.applyMovement).toHaveBeenCalled();
    expect(res.duplicate).toBe(false);
  });

  it('does not validate economy status on a CREDIT (payouts still flow during a freeze)', async () => {
    mockRepo.findByIdempotencyKey.mockResolvedValue(null);
    mockRepo.applyMovement.mockResolvedValue({
      transactionId: 'tx-3',
      walletId: 'w-1',
      currency: WalletCurrency.GOLD,
      amount: 100n,
      reason: WalletTxnReason.CASINO_WIN,
      balanceAfter: 900n,
    });
    await service.credit({
      userId: 'u1',
      currency: WalletCurrency.GOLD,
      amount: 100,
      reason: WalletTxnReason.CASINO_WIN,
      idempotencyKey: 'k2',
    });
    expect(mockValidation.validateEconomyStatus).not.toHaveBeenCalled();
  });
});
