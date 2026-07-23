import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditLogQueryDto } from '../dto/audit-log-query.dto';

export interface CreateAuditLogParams {
  actorId: string;
  actorRole?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  status?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Infrastructure framework method to record a privileged audit log entry.
   */
  async logAction(params: CreateAuditLogParams) {
    try {
      return await this.prisma.auditLog.create({
        data: {
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: params.action,
          resource: params.resource,
          resourceId: params.resourceId,
          details: params.details ?? undefined,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          status: params.status ?? 'SUCCESS',
        },
      });
    } catch (err) {
      // Audit logging framework should be resilient and never crash caller business logic
      this.logger.error(
        `Failed to record audit log: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return null;
    }
  }

  /**
   * Query audit log records with pagination and filters.
   */
  async getAuditLogs(query: AuditLogQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.resource) where.resource = query.resource;
    if (query.resourceId) where.resourceId = query.resourceId;

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
