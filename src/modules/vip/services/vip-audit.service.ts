import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type VipAuditAction =
  | 'VIP_CREATED'
  | 'VIP_RENEWED'
  | 'VIP_UPGRADED'
  | 'VIP_DOWNGRADED'
  | 'VIP_EXPIRED'
  | 'VIP_SUSPENDED'
  | 'VIP_RESTORED'
  | 'VIP_CONFIGURATION_UPDATED';

@Injectable()
export class VipAuditService {
  private readonly logger = new Logger(VipAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit log record for VIP engine events.
   */
  async logAudit(
    action: VipAuditAction,
    userId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.vipAudit.create({
        data: {
          action,
          userId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log VIP audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated VIP audit logs.
   */
  async getAuditLogs(userId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = userId ? { userId } : {};

    const [total, items] = await Promise.all([
      this.prisma.vipAudit.count({ where }),
      this.prisma.vipAudit.findMany({
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
