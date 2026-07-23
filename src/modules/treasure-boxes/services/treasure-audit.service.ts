import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type TreasureAuditAction =
  | 'TREASURE_CREATED'
  | 'TREASURE_PROGRESS_UPDATED'
  | 'TREASURE_BOX_COMPLETED'
  | 'TREASURE_REWARD_GENERATED'
  | 'TREASURE_REWARD_DISTRIBUTED'
  | 'TREASURE_RESET';

@Injectable()
export class TreasureAuditService {
  private readonly logger = new Logger(TreasureAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an operational audit record for a treasure box action.
   */
  async logAudit(
    action: TreasureAuditAction,
    roomId?: string,
    boxId?: string,
    details?: Record<string, any>,
    actorId?: string,
  ) {
    try {
      return await this.prisma.treasureAudit.create({
        data: {
          action,
          roomId,
          boxId,
          details: details ? JSON.parse(JSON.stringify(details)) : undefined,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to log treasure audit [${action}]: ${(err as Error).message}`);
    }
  }

  /**
   * Queries paginated audit logs.
   */
  async getAuditLogs(roomId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = roomId ? { roomId } : {};

    const [total, items] = await Promise.all([
      this.prisma.treasureAudit.count({ where }),
      this.prisma.treasureAudit.findMany({
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
