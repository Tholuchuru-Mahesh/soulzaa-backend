import { Test, TestingModule } from '@nestjs/testing';
import { WalletCurrency } from '@prisma/client';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { WithdrawalApprovalService } from './withdrawal-approval.service';
import { WithdrawalAuditService } from './withdrawal-audit.service';
import { WithdrawalConfigurationService } from './withdrawal-configuration.service';
import { WithdrawalEventService } from './withdrawal-event.service';
import { WithdrawalExecutionService } from './withdrawal-execution.service';
import { WithdrawalHistoryService } from './withdrawal-history.service';
import { WithdrawalQueryService } from './withdrawal-query.service';
import { WithdrawalStatisticsService } from './withdrawal-statistics.service';
import { WithdrawalValidationService } from './withdrawal-validation.service';
import { WithdrawalService } from './withdrawal.service';

describe('Phase 10: Enterprise Withdrawal Engine', () => {
  let _configService: WithdrawalConfigurationService;
  let validationService: WithdrawalValidationService;
  let withdrawalService: WithdrawalService;
  let approvalService: WithdrawalApprovalService;
  let executionService: WithdrawalExecutionService;
  let _historyService: WithdrawalHistoryService;
  let _auditService: WithdrawalAuditService;
  let _statisticsService: WithdrawalStatisticsService;
  let _queryService: WithdrawalQueryService;
  let _eventService: WithdrawalEventService;

  const mockPrismaService: any = {
    withdrawalRequest: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    withdrawalReview: {
      create: jest.fn(),
    },
    withdrawalFailure: {
      create: jest.fn(),
    },
    withdrawalHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    withdrawalAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    withdrawalStatistics: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    withdrawalConfiguration: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'withdrawal.minimum') return Promise.resolve(1000);
      if (key === 'withdrawal.maximum') return Promise.resolve(100000);
      if (key === 'withdrawal.daily_limit') return Promise.resolve(200000);
      if (key === 'withdrawal.processing_fee') return Promise.resolve(0);
      return Promise.resolve(null);
    }),
  };

  const mockCoinEconomyService = {
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
  };

  const mockWalletService = {
    debit: jest.fn().mockResolvedValue({ transactionId: 'w-hold-tx-100', status: 'COMPLETED' }),
    credit: jest.fn().mockResolvedValue({ transactionId: 'w-rel-tx-100', status: 'COMPLETED' }),
  };

  const mockEventBus = {
    subscribe: jest.fn(),
    publish: jest.fn(),
  };

  const mockLockService = {
    withLock: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalConfigurationService,
        WithdrawalValidationService,
        WithdrawalService,
        WithdrawalApprovalService,
        WithdrawalExecutionService,
        WithdrawalHistoryService,
        WithdrawalAuditService,
        WithdrawalStatisticsService,
        WithdrawalQueryService,
        WithdrawalEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: CoinEconomyService, useValue: mockCoinEconomyService },
        { provide: WALLET_SERVICE, useValue: mockWalletService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    _configService = module.get<WithdrawalConfigurationService>(WithdrawalConfigurationService);
    validationService = module.get<WithdrawalValidationService>(WithdrawalValidationService);
    withdrawalService = module.get<WithdrawalService>(WithdrawalService);
    approvalService = module.get<WithdrawalApprovalService>(WithdrawalApprovalService);
    executionService = module.get<WithdrawalExecutionService>(WithdrawalExecutionService);
    _historyService = module.get<WithdrawalHistoryService>(WithdrawalHistoryService);
    _auditService = module.get<WithdrawalAuditService>(WithdrawalAuditService);
    _statisticsService = module.get<WithdrawalStatisticsService>(WithdrawalStatisticsService);
    _queryService = module.get<WithdrawalQueryService>(WithdrawalQueryService);
    _eventService = module.get<WithdrawalEventService>(WithdrawalEventService);

    jest.clearAllMocks();
  });

  describe('1. Threshold & Limit Validation Guards', () => {
    it('should reject request below minimum threshold (e.g. 500 < 1000)', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', status: 'ACTIVE' });

      await expect(validationService.validateWithdrawalRequest('u-1', BigInt(500))).rejects.toThrow(
        'below minimum',
      );
    });

    it('should reject request exceeding maximum threshold (e.g. 150000 > 100000)', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', status: 'ACTIVE' });

      await expect(
        validationService.validateWithdrawalRequest('u-1', BigInt(150000)),
      ).rejects.toThrow('exceeds maximum');
    });

    it('should reject request if user has insufficient eligible earnings balance', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', status: 'ACTIVE' });
      mockPrismaService.wallet.findUnique.mockResolvedValue({
        userId: 'u-1',
        earningsBalance: BigInt(2000),
      });

      await expect(
        validationService.validateWithdrawalRequest('u-1', BigInt(5000)),
      ).rejects.toThrow('Insufficient eligible earnings balance');
    });
  });

  describe('2. Withdrawal Request & Funds Reservation', () => {
    it('should create withdrawal request and debit funds via IWalletService', async () => {
      mockCoinEconomyService.isEconomyFrozen.mockResolvedValue(false);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', status: 'ACTIVE' });
      mockPrismaService.wallet.findUnique.mockResolvedValue({
        userId: 'u-1',
        earningsBalance: BigInt(10000),
      });
      mockPrismaService.withdrawalRequest.aggregate.mockResolvedValue({
        _sum: { amountCoins: BigInt(0) },
      });
      mockPrismaService.withdrawalRequest.count.mockResolvedValue(0);
      mockPrismaService.withdrawalRequest.create.mockResolvedValue({
        id: 'wd-req-100',
        userId: 'u-1',
        amountCoins: BigInt(5000),
        netPayoutAmountCoins: BigInt(5000),
        status: 'PENDING',
        holdTxnId: 'w-hold-tx-100',
      });
      mockPrismaService.withdrawalHistory.create.mockResolvedValue({});
      mockPrismaService.withdrawalStatistics.upsert.mockResolvedValue({});
      mockPrismaService.withdrawalAudit.create.mockResolvedValue({});

      const result = await withdrawalService.requestWithdrawal({
        userId: 'u-1',
        amountCoins: BigInt(5000),
      });

      expect(result.requestId).toBe('wd-req-100');
      expect(result.status).toBe('PENDING');

      expect(mockWalletService.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-1',
          currency: WalletCurrency.EARNINGS,
          amount: 5000,
          reason: 'WITHDRAWAL',
        }),
      );
    });
  });

  describe('3. Approval Workflow & Refund on Rejection', () => {
    it('should refund funds via IWalletService.credit when withdrawal request is REJECTED', async () => {
      mockPrismaService.withdrawalRequest.findUnique.mockResolvedValue({
        id: 'wd-req-100',
        userId: 'u-1',
        amountCoins: BigInt(5000),
        status: 'PENDING',
        holdTxnId: 'w-hold-tx-100',
      });
      mockPrismaService.withdrawalRequest.update.mockResolvedValue({});
      mockPrismaService.withdrawalReview.create.mockResolvedValue({});
      mockPrismaService.withdrawalHistory.create.mockResolvedValue({});
      mockPrismaService.withdrawalStatistics.upsert.mockResolvedValue({});
      mockPrismaService.withdrawalAudit.create.mockResolvedValue({});

      const result = await approvalService.reviewWithdrawal({
        requestId: 'wd-req-100',
        reviewerId: 'admin-1',
        action: 'REJECT',
        reason: 'Invalid bank account details',
      });

      expect(result.toStatus).toBe('REJECTED');
      expect(mockWalletService.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-1',
          currency: WalletCurrency.EARNINGS,
          amount: 5000,
          reason: 'WITHDRAWAL',
        }),
      );
    });
  });

  describe('4. Payout Execution & Ledger Finalization', () => {
    it('should complete withdrawal upon payout execution', async () => {
      mockPrismaService.withdrawalRequest.findUnique.mockResolvedValue({
        id: 'wd-req-100',
        userId: 'u-1',
        amountCoins: BigInt(5000),
        netPayoutAmountCoins: BigInt(5000),
        status: 'APPROVED',
        holdTxnId: 'w-hold-tx-100',
      });
      mockPrismaService.withdrawalRequest.update.mockResolvedValue({});
      mockPrismaService.withdrawalHistory.create.mockResolvedValue({});
      mockPrismaService.withdrawalStatistics.upsert.mockResolvedValue({});
      mockPrismaService.withdrawalAudit.create.mockResolvedValue({});

      const result = await executionService.executePayout({
        requestId: 'wd-req-100',
      });

      expect(result.status).toBe('COMPLETED');
    });
  });
});
