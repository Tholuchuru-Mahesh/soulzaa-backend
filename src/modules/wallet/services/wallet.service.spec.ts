import { Test, TestingModule } from '@nestjs/testing';
import { WalletStatus, WalletType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WalletAuditService } from './wallet-audit.service';
import { WalletService } from './wallet.service';

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WalletAuditService, useValue: mockAuditService },
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
});
