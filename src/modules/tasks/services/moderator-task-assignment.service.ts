import { Inject, Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { randomUUID } from 'crypto';

export interface AssignModeratorTaskInput {
  taskId: string;
  moderatorId: string;
  assignedBy: string;
  dueAt?: Date;
  notes?: string;
}

@Injectable()
export class ModeratorTaskAssignmentService {
  private readonly logger = new Logger(ModeratorTaskAssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SERVICE) private readonly notificationService: INotificationService,
  ) {}

  async assignTask(input: AssignModeratorTaskInput) {
    const task = await this.prisma.taskDefinition.findUnique({
      where: { id: input.taskId },
    });
    if (!task) throw new NotFoundException('Task definition not found');

    const existing = await this.prisma.moderator_task_assignments.findUnique({
      where: {
        taskId_moderatorId: { taskId: input.taskId, moderatorId: input.moderatorId },
      },
    });

    if (existing) {
      throw new ConflictException('Task is already assigned to this moderator.');
    }

    const assignment = await this.prisma.moderator_task_assignments.create({
      data: {
        id: randomUUID(),
        taskId: input.taskId,
        moderatorId: input.moderatorId,
        assignedBy: input.assignedBy,
        dueAt: input.dueAt ?? null,
        notes: input.notes ?? null,
        status: 'PENDING',
        updatedAt: new Date(),
      },
    });

    // Task 26: Route through NotificationService so NotificationCreatedEvent fires for push/socket delivery
    await this.notificationService.create({
      userId: input.moderatorId,
      type: NotificationType.MODERATOR_TASK_ASSIGNED,
      actorId: input.assignedBy,
      data: {
        assignmentId: assignment.id,
        taskName: task.name,
        dueAt: input.dueAt?.toISOString() ?? null,
      },
    });

    return assignment;
  }

  async getModeratorAssignments(moderatorId: string, status?: string) {
    return this.prisma.moderator_task_assignments.findMany({
      where: {
        moderatorId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAssignedBy(assignedBy: string) {
    return this.prisma.moderator_task_assignments.findMany({
      where: { assignedBy },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateAssignmentStatus(
    assignmentId: string,
    moderatorId: string,
    status: 'IN_PROGRESS' | 'COMPLETED',
  ) {
    const assignment = await this.prisma.moderator_task_assignments.findUnique({
      where: { id: assignmentId },
    });

    if (!assignment) throw new NotFoundException('Task assignment not found');
    if (assignment.moderatorId !== moderatorId) {
      throw new ConflictException('You are not assigned to this task');
    }

    return this.prisma.moderator_task_assignments.update({
      where: { id: assignmentId },
      data: {
        status,
        ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });
  }
}
