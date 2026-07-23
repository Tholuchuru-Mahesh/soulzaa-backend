import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type WithdrawalAuditAction =
  | 'WITHDRAWAL_REQUESTED'
  | 'WITHDRAWAL_APPROVED'
  | 'WITHDRAWAL_REJECTED'
  | 'WITHDRAWAL_CANCELLED'
  | 'WITHDRAWAL_PROCESSING'
  | 'WITHDRAWAL_COMPLETED'
  | 'WITHDRAWAL_FAILED'
  | 'WITHDRAWAL_CONFIGURATION_UPDATED';

@Injectable()
export class WithdrawalAuditService {
  private readonly logger = new Logger(WithdrawalAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit log entry for withdrawal lifecycle events.
   */
  async logAudit(
    action: WithdrawalAuditAction,
    userId?: string,
    requestId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.withdrawalAudit.create({
        data: {
          action,
          userId,
          requestId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log withdrawal audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated audit logs.
   */
  async getAuditLogs(userId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = userId ? { userId } : {};

    const [total, items] = await Promise.all([
      this.prisma.withdrawalAudit.count({ where }),
      this.prisma.withdrawalAudit.findMany({
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
