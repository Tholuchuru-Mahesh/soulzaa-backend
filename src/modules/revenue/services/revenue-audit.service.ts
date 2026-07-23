import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type RevenueAuditAction =
  | 'HOST_EARNING_CREATED'
  | 'HOST_EARNING_CREDITED'
  | 'REVENUE_DISTRIBUTED'
  | 'REVENUE_CALCULATED'
  | 'REVENUE_CONFIGURATION_UPDATED';

@Injectable()
export class RevenueAuditService {
  private readonly logger = new Logger(RevenueAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit record for revenue events.
   */
  async logAudit(
    action: RevenueAuditAction,
    hostId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.revenueAudit.create({
        data: {
          action,
          hostId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log revenue audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated audit logs.
   */
  async getAuditLogs(hostId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = hostId ? { hostId } : {};

    const [total, items] = await Promise.all([
      this.prisma.revenueAudit.count({ where }),
      this.prisma.revenueAudit.findMany({
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
