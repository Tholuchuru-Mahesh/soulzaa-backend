import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RankingAuditAction } from '../constants/ranking.constants';

@Injectable()
export class RankingAuditService {
  private readonly logger = new Logger(RankingAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAudit(
    action: RankingAuditAction,
    entityId?: string,
    actorId?: string,
    details?: Record<string, any>,
  ) {
    try {
      return await this.prisma.rankingAudit.create({
        data: { entityId, actorId, action, details: details ?? {} },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write ranking audit ${action}: ${(err as Error).message}`,
      );
    }
  }

  async getLogs(entityId?: string, action?: string, limit = 50, offset = 0) {
    const where: any = {};
    if (entityId) where.entityId = entityId;
    if (action) where.action = action;

    const [items, total] = await Promise.all([
      this.prisma.rankingAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.rankingAudit.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
