import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ModeratorWarningLevel, ModeratorWarningStatus, NotificationType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';

export interface IssueWarningInput {
  moderatorId: string;
  issuedBy: string;
  level: ModeratorWarningLevel;
  reason: string;
  description?: string;
}

@Injectable()
export class ModeratorWarningService {
  private readonly logger = new Logger(ModeratorWarningService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    @Optional() private readonly performanceStats?: ModeratorPerformanceService,
  ) {}

  /**
   * Issues an internal warning to a Moderator.
   *
   * Level 1 → sends training reminder notification.
   * Level 2 → sends manager review notification.
   * Level 3 → suspends Moderator's permissions + sends admin notification.
   */
  async issueWarning(input: IssueWarningInput) {
    const isLevel2 = input.level === ModeratorWarningLevel.LEVEL_2;
    const warning = await this.prisma.moderatorWarningRecord.create({
      data: {
        moderatorId: input.moderatorId,
        issuedBy: input.issuedBy,
        level: input.level,
        reason: input.reason,
        description: isLevel2
          ? `[PENDING_COUNTRY_MANAGER_REVIEW] ${input.description ?? ''}`.trim()
          : input.description,
      },
    });

    this.logger.warn(
      `Warning ${input.level} issued to moderator ${input.moderatorId} by ${input.issuedBy}`,
    );

    // Notify the moderator regardless of level. Goes through
    // NOTIFICATION_SERVICE.create() (fires NotificationCreatedEvent for
    // realtime Push/In-App delivery), not a raw prisma write.
    await this.notifications.create({
      userId: input.moderatorId,
      type: NotificationType.MODERATOR_WARNING_ISSUED,
      actorId: input.issuedBy,
      data: {
        warningId: warning.id,
        level: input.level,
        reason: input.reason,
        requiresCountryManagerReview: isLevel2,
      },
    });

    // Task 24 — record WARN action in performance stats
    if (this.performanceStats) {
      void this.performanceStats.recordAction(input.issuedBy, 'WARN');
    }

    // Level 3: suspend Moderator role by marking UserRole suspended
    if (input.level === ModeratorWarningLevel.LEVEL_3) {
      this.logger.warn(
        `Moderator ${input.moderatorId} has received Level 3 warning — access suspended pending Admin review.`,
      );
      const modRole = await this.prisma.role.findFirst({ where: { name: 'MODERATOR' } });
      if (modRole) {
        await this.prisma.userRole.updateMany({
          where: { userId: input.moderatorId, roleId: modRole.id },
          data: { suspendedAt: new Date(), suspendedBy: input.issuedBy },
        });
      }
    }

    return warning;
  }

  async reviewWarning(warningId: string, reviewerId: string, approved: boolean, note?: string) {
    const warning = await this.prisma.moderatorWarningRecord.findUnique({
      where: { id: warningId },
    });
    if (!warning) throw new NotFoundException('Warning not found');

    if (approved) {
      const updatedDescription = (warning.description ?? '')
        .replace('[PENDING_COUNTRY_MANAGER_REVIEW]', '')
        .trim();
      return this.prisma.moderatorWarningRecord.update({
        where: { id: warningId },
        data: {
          description: `[COUNTRY_MANAGER_APPROVED by ${reviewerId}] ${updatedDescription}`.trim(),
        },
      });
    } else {
      return this.prisma.moderatorWarningRecord.update({
        where: { id: warningId },
        data: {
          status: ModeratorWarningStatus.RESOLVED,
          resolvedAt: new Date(),
          resolvedBy: reviewerId,
          resolution: note ?? 'Rejected by Country Manager',
        },
      });
    }
  }

  async resolveWarning(warningId: string, resolvedBy: string, resolution?: string) {
    const warning = await this.prisma.moderatorWarningRecord.findUnique({
      where: { id: warningId },
    });
    if (!warning) throw new NotFoundException('Warning not found');

    const updated = await this.prisma.moderatorWarningRecord.update({
      where: { id: warningId },
      data: {
        status: ModeratorWarningStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy,
        resolution,
      },
    });

    // If resolving a Level 3 warning, restore the moderator role if no other active Level 3 exists
    if (warning.level === ModeratorWarningLevel.LEVEL_3) {
      const remainingL3 = await this.prisma.moderatorWarningRecord.count({
        where: {
          moderatorId: warning.moderatorId,
          level: ModeratorWarningLevel.LEVEL_3,
          status: ModeratorWarningStatus.ACTIVE,
        },
      });
      if (remainingL3 === 0) {
        const modRole = await this.prisma.role.findFirst({ where: { name: 'MODERATOR' } });
        if (modRole) {
          await this.prisma.userRole.updateMany({
            where: { userId: warning.moderatorId, roleId: modRole.id },
            data: { suspendedAt: null, suspendedBy: null },
          });
        }
      }
    }

    return updated;
  }

  async getWarnings(
    moderatorId: string,
    filters?: { status?: ModeratorWarningStatus; level?: ModeratorWarningLevel },
  ) {
    return this.prisma.moderatorWarningRecord.findMany({
      where: {
        moderatorId,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.level ? { level: filters.level } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getWarning(id: string) {
    const w = await this.prisma.moderatorWarningRecord.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Warning not found');
    return w;
  }

  /**
   * Returns true if the moderator has an unresolved Level 3 warning.
   * Used by the moderation guard to block access when suspended.
   */
  async isSuspended(moderatorId: string): Promise<boolean> {
    const count = await this.prisma.moderatorWarningRecord.count({
      where: {
        moderatorId,
        level: ModeratorWarningLevel.LEVEL_3,
        status: ModeratorWarningStatus.ACTIVE,
      },
    });
    return count > 0;
  }

  async listAll(filters?: { status?: ModeratorWarningStatus; level?: ModeratorWarningLevel }) {
    return this.prisma.moderatorWarningRecord.findMany({
      where: {
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.level ? { level: filters.level } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
