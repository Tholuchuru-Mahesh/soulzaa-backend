import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type AgencyAuditAction =
  | 'AGENCY_SETTLEMENT_CREATED'
  | 'AGENCY_COMMISSION_CALCULATED'
  | 'AGENCY_COMMISSION_CREDITED'
  | 'AGENCY_SETTLEMENT_COMPLETED'
  | 'AGENCY_CONFIGURATION_UPDATED';

@Injectable()
export class AgencyAuditService {
  private readonly logger = new Logger(AgencyAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit record for agency settlement actions.
   */
  async logAudit(
    action: AgencyAuditAction,
    agencyId?: string,
    hostId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.agencyAudit.create({
        data: {
          action,
          agencyId,
          hostId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log agency audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated agency audit logs.
   */
  async getAuditLogs(agencyId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = agencyId ? { agencyId } : {};

    const [total, items] = await Promise.all([
      this.prisma.agencyAudit.count({ where }),
      this.prisma.agencyAudit.findMany({
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
