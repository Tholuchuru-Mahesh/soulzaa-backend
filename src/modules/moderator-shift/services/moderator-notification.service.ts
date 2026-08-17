import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';

/**
 * Task 27 — Wire up dead notification types.
 * Task 33 — Moderator-specific notification types (OFFICIAL_MESSAGE, MANAGER_INSTRUCTION, SYSTEM_ANNOUNCEMENT).
 *
 * This scheduler fires MODERATOR_TASK_DUE_SOON hourly for tasks due in the next hour.
 * Provides methods for triggering:
 *   - MODERATOR_EMERGENCY_REQUEST (Officials/Managers call emergencyRequest)
 *   - MODERATOR_POLICY_UPDATE (Admin broadcast)
 *   - MODERATOR_OFFICIAL_MESSAGE (Official -> assigned moderators)
 *   - MODERATOR_MANAGER_INSTRUCTION (Manager -> assigned moderators)
 *   - MODERATOR_SYSTEM_ANNOUNCEMENT (Admin -> all moderators)
 *
 * Every notification here goes through NOTIFICATION_SERVICE.create() rather
 * than a raw `prisma.notification.create()` — that's what fires
 * NotificationCreatedEvent for realtime Push/In-App delivery. Writing the
 * row directly only produces a pollable DB record, no realtime delivery.
 */
@Injectable()
export class ModeratorNotificationService {
  private readonly logger = new Logger(ModeratorNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
  ) {}

  // ---- Task 27: MODERATOR_TASK_DUE_SOON cron ----

  /**
   * Runs every hour; sends MODERATOR_TASK_DUE_SOON to moderators whose tasks
   * are due within the next 60 minutes and still PENDING/IN_PROGRESS.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendTaskDueSoonReminders(): Promise<void> {
    try {
      const now = new Date();
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

      const dueAssignments = await this.prisma.moderator_task_assignments.findMany({
        where: {
          dueAt: { gte: now, lte: oneHourFromNow },
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      });

      // Fetch task names in one batched query — no direct relation on moderator_task_assignments
      const taskIds = Array.from(new Set(dueAssignments.map((a) => a.taskId)));
      const taskDefs = await this.prisma.taskDefinition.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, name: true },
      });
      const taskNameById = new Map(taskDefs.map((t) => [t.id, t.name]));

      await Promise.all(
        dueAssignments.map(async (assignment) => {
          await this.notifications.create({
            userId: assignment.moderatorId,
            type: NotificationType.MODERATOR_TASK_DUE_SOON,
            data: {
              assignmentId: assignment.id,
              taskName: taskNameById.get(assignment.taskId) ?? 'Task',
              dueAt: assignment.dueAt?.toISOString() ?? null,
            },
          });
          this.logger.debug(`TASK_DUE_SOON reminder sent to ${assignment.moderatorId}`);
        }),
      );
    } catch (err) {
      this.logger.error(`Task due-soon reminder error: ${(err as Error).message}`);
    }
  }

  // ---- Task 27: MODERATOR_HIGH_PRIORITY_REPORT ----

  /**
   * Notify a moderator when a high-priority report is assigned or created.
   * Called from the report service when severity is critical.
   */
  async notifyHighPriorityReport(
    moderatorId: string,
    reportId: string,
    reason: string,
  ): Promise<void> {
    await this.notifications.create({
      userId: moderatorId,
      type: NotificationType.MODERATOR_HIGH_PRIORITY_REPORT,
      data: { reportId, reason },
    });
  }

  // ---- Task 27: MODERATOR_REPORT_ASSIGNED ----

  /** Notify a moderator when a report is assigned to them. */
  async notifyReportAssigned(
    moderatorId: string,
    reportId: string,
    assignedBy: string,
  ): Promise<void> {
    await this.notifications.create({
      userId: moderatorId,
      type: NotificationType.MODERATOR_REPORT_ASSIGNED,
      actorId: assignedBy,
      data: { reportId, assignedBy },
    });
  }

  // ---- Shared broadcast helpers ----

  /** All userIds currently holding the MODERATOR role — the "everyone" audience for admin broadcasts. */
  private async allModeratorIds(): Promise<string[]> {
    const moderators = await this.prisma.userRole.findMany({
      where: { role: { name: 'MODERATOR' } },
      select: { userId: true },
    });
    return moderators.map(({ userId }) => userId);
  }

  private async broadcastToModerators(
    userIds: string[],
    type: NotificationType,
    actorId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.notifications.create({ userId, type, actorId, data })),
    );
  }

  // ---- Task 27: MODERATOR_EMERGENCY_REQUEST ----

  /** Officials/Managers send an emergency request to a moderator or all mods in region. */
  async sendEmergencyRequest(
    recipientModeratorIds: string[],
    senderId: string,
    message: string,
    regionId?: string,
  ): Promise<void> {
    await this.broadcastToModerators(
      recipientModeratorIds,
      NotificationType.MODERATOR_EMERGENCY_REQUEST,
      senderId,
      { senderId, message, regionId: regionId ?? null },
    );
    this.logger.log(
      `EMERGENCY_REQUEST sent to ${recipientModeratorIds.length} moderator(s) by ${senderId}`,
    );
  }

  // ---- Task 27: MODERATOR_POLICY_UPDATE ----

  /** Admin broadcasts a policy update to all active moderators. */
  async broadcastPolicyUpdate(adminId: string, title: string, body: string): Promise<void> {
    const moderatorIds = await this.allModeratorIds();
    await this.broadcastToModerators(
      moderatorIds,
      NotificationType.MODERATOR_POLICY_UPDATE,
      adminId,
      {
        adminId,
        title,
        body,
      },
    );
    this.logger.log(`POLICY_UPDATE broadcast to ${moderatorIds.length} moderator(s) by ${adminId}`);
  }

  // ---- Task 33: MODERATOR_OFFICIAL_MESSAGE ----

  /** Officials send an instruction/message to specific moderators. */
  async sendOfficialMessage(
    recipientModeratorIds: string[],
    officialId: string,
    title: string,
    message: string,
  ): Promise<void> {
    await this.broadcastToModerators(
      recipientModeratorIds,
      NotificationType.MODERATOR_OFFICIAL_MESSAGE,
      officialId,
      { officialId, title, message },
    );
    this.logger.log(
      `OFFICIAL_MESSAGE sent to ${recipientModeratorIds.length} moderator(s) by official ${officialId}`,
    );
  }

  // ---- Task 33: MODERATOR_MANAGER_INSTRUCTION ----

  /** Managers send an instruction to their assigned moderators. */
  async sendManagerInstruction(
    recipientModeratorIds: string[],
    managerId: string,
    title: string,
    instruction: string,
    priority?: 'NORMAL' | 'URGENT',
  ): Promise<void> {
    await this.broadcastToModerators(
      recipientModeratorIds,
      NotificationType.MODERATOR_MANAGER_INSTRUCTION,
      managerId,
      { managerId, title, instruction, priority: priority ?? 'NORMAL' },
    );
    this.logger.log(
      `MANAGER_INSTRUCTION sent to ${recipientModeratorIds.length} moderator(s) by manager ${managerId}`,
    );
  }

  // ---- Task 33: MODERATOR_SYSTEM_ANNOUNCEMENT ----

  /** Admin broadcasts a system-wide announcement to all active moderators. */
  async broadcastSystemAnnouncement(adminId: string, title: string, body: string): Promise<void> {
    const moderatorIds = await this.allModeratorIds();
    await this.broadcastToModerators(
      moderatorIds,
      NotificationType.MODERATOR_SYSTEM_ANNOUNCEMENT,
      adminId,
      {
        adminId,
        title,
        body,
      },
    );
    this.logger.log(
      `SYSTEM_ANNOUNCEMENT broadcast to ${moderatorIds.length} moderator(s) by ${adminId}`,
    );
  }
}
