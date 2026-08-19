// src/modules/platform-moderation/services/platform-moderation-audit.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlatformModerationActionType, PlatformRoomType, PlatformWarningScope } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface RecordAuditInput {
  moderatorId: string;
  action: PlatformModerationActionType;
  roomType: PlatformRoomType;
  roomId: string;
  targetUserId?: string;
  reason?: string;
  /** Only meaningful for a WARNING_SENT row — PRIVATE or ROOM-wide broadcast. */
  scope?: PlatformWarningScope;
}

export interface ListAuditFilter {
  moderatorId?: string;
  targetUserId?: string;
  action?: PlatformModerationActionType;
}

/**
 * Accountability trail for covert moderator actions. `record()` is called
 * from hot paths (room join, warn, ban) via `void this.platformAudit?.record(...)`
 * — it must never throw, or a logging hiccup would break the moderator action
 * it's meant to only observe.
 */
@Injectable()
export class PlatformModerationAuditService {
  private readonly logger = new Logger(PlatformModerationAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.prisma.platformModerationAuditLog.create({
        data: {
          moderatorId: input.moderatorId,
          action: input.action,
          roomType: input.roomType,
          roomId: input.roomId,
          targetUserId: input.targetUserId ?? null,
          reason: input.reason ?? null,
          scope: input.scope ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`Failed to write moderation audit log: ${(e as Error).message}`);
    }
  }

  async list(
    filter: ListAuditFilter,
    skip: number,
    limit: number,
  ): Promise<[Array<Record<string, unknown>>, number]> {
    const where = {
      ...(filter.moderatorId ? { moderatorId: filter.moderatorId } : {}),
      ...(filter.targetUserId ? { targetUserId: filter.targetUserId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
    };
    return Promise.all([
      this.prisma.platformModerationAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.platformModerationAuditLog.count({ where }),
    ]);
  }
}
