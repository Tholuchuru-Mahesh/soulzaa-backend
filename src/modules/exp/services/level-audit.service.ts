import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type LevelAuditAction =
  | 'LEVEL_CREATED'
  | 'LEVEL_UP'
  | 'EXP_ADDED'
  | 'EXP_REMOVED'
  | 'LEVEL_RECALCULATED'
  | 'LEVEL_CONFIGURATION_UPDATED';

@Injectable()
export class LevelAuditService {
  private readonly logger = new Logger(LevelAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAudit(
    action: LevelAuditAction,
    userId?: string,
    actorId?: string,
    details?: Record<string, any>,
  ) {
    try {
      return await this.prisma.levelAudit.create({
        data: {
          userId,
          actorId,
          action,
          details: details ?? {},
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to log audit event ${action} for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  async getAuditLogs(userId?: string, limit: number = 50, offset: number = 0) {
    const where = userId ? { userId } : {};
    const [items, total] = await Promise.all([
      this.prisma.levelAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.levelAudit.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
