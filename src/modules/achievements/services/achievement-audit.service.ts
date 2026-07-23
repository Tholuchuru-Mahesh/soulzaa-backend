import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AchievementAuditAction } from '../constants/achievement.constants';

@Injectable()
export class AchievementAuditService {
  private readonly logger = new Logger(AchievementAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAudit(
    action: AchievementAuditAction,
    userId?: string,
    actorId?: string,
    details?: Record<string, any>,
  ) {
    try {
      return await this.prisma.achievementAudit.create({
        data: { userId, actorId, action, details: details ?? {} },
      });
    } catch (err) {
      this.logger.error(
        `Failed to log audit event ${action} for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  async getAuditLogs(userId?: string, action?: string, limit = 50, offset = 0) {
    const where: any = {};
    if (userId) where.userId = userId;
    if (action) where.action = action;

    const [items, total] = await Promise.all([
      this.prisma.achievementAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.achievementAudit.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
