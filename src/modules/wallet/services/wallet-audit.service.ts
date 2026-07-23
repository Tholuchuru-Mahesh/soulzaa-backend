import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class WalletAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logs a wallet operational audit event
   */
  async logAudit(walletId: string, action: string, details?: any, actorId?: string) {
    return this.prisma.walletAudit.create({
      data: {
        walletId,
        action,
        details: details ? JSON.parse(JSON.stringify(details)) : undefined,
        actorId,
      },
    });
  }

  /**
   * Retrieves audit logs for a target wallet
   */
  async getWalletAuditHistory(walletId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [total, logs] = await Promise.all([
      this.prisma.walletAudit.count({ where: { walletId } }),
      this.prisma.walletAudit.findMany({
        where: { walletId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: logs,
    };
  }
}
