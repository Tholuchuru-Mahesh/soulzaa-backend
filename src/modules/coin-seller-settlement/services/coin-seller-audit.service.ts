import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type CoinSellerAuditAction =
  | 'COIN_SELLER_SETTLEMENT_CREATED'
  | 'COIN_SELLER_COMMISSION_CALCULATED'
  | 'COIN_SELLER_COMMISSION_CREDITED'
  | 'COIN_SELLER_SETTLEMENT_COMPLETED'
  | 'COIN_SELLER_CONFIGURATION_UPDATED';

@Injectable()
export class CoinSellerAuditService {
  private readonly logger = new Logger(CoinSellerAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit record for coin seller settlement actions.
   */
  async logAudit(
    action: CoinSellerAuditAction,
    sellerId?: string,
    buyerId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.coinSellerAudit.create({
        data: {
          action,
          sellerId,
          buyerId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log coin seller audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated audit logs.
   */
  async getAuditLogs(sellerId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = sellerId ? { sellerId } : {};

    const [total, items] = await Promise.all([
      this.prisma.coinSellerAudit.count({ where }),
      this.prisma.coinSellerAudit.findMany({
        where,
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
      items,
    };
  }
}
