import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type FamilyAuditAction =
  | 'FAMILY_CREATED'
  | 'FAMILY_UPDATED'
  | 'MEMBER_JOINED'
  | 'MEMBER_LEFT'
  | 'MEMBER_KICKED'
  | 'MEMBER_BANNED'
  | 'ROLE_CHANGED'
  | 'OWNER_TRANSFERRED';

@Injectable()
export class FamilyAuditService {
  private readonly logger = new Logger(FamilyAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit log record for family engine events.
   */
  async logAudit(
    action: FamilyAuditAction,
    familyId?: string,
    userId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.familyAudit.create({
        data: {
          action,
          familyId,
          userId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log family audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated family audit logs.
   */
  async getAuditLogs(familyId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = familyId ? { familyId } : {};

    const [total, items] = await Promise.all([
      this.prisma.familyAudit.count({ where }),
      this.prisma.familyAudit.findMany({
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
