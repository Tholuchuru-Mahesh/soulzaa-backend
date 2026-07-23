import { Injectable, NotFoundException } from '@nestjs/common';
import { WalletStatus, WalletType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WalletAuditService } from './wallet-audit.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: WalletAuditService,
  ) {}

  /**
   * Retrieves or creates a Wallet account for a target user
   */
  async getOrCreateWallet(userId: string, type: WalletType = WalletType.USER_WALLET) {
    let wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          userId,
          type,
          status: WalletStatus.ACTIVE,
          availableBalance: BigInt(0),
          goldBalance: BigInt(0),
          freeBalance: BigInt(0),
          earningsBalance: BigInt(0),
        },
      });

      await this.auditService.logAudit(wallet.id, 'WALLET_CREATED', { userId, type });
    }

    return wallet;
  }

  /**
   * Get wallet by ID
   */
  async getWalletById(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet '${walletId}' not found`);
    }

    return wallet;
  }

  /**
   * Get wallet by User ID
   */
  async getWalletByUserId(userId: string) {
    return this.getOrCreateWallet(userId);
  }

  /**
   * Updates wallet operational status (e.g. ACTIVE, LOCKED, FROZEN, SUSPENDED)
   */
  async updateWalletStatus(walletId: string, status: WalletStatus, actorId?: string) {
    const wallet = await this.getWalletById(walletId);

    const updated = await this.prisma.wallet.update({
      where: { id: walletId },
      data: { status },
    });

    const action = status === WalletStatus.LOCKED ? 'WALLET_LOCKED' : 'STATUS_UPDATED';
    await this.auditService.logAudit(
      wallet.id,
      action,
      { previousStatus: wallet.status, newStatus: status },
      actorId,
    );

    return updated;
  }
}
