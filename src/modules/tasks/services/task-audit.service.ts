import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskAuditAction } from '../constants/task.constants';

@Injectable()
export class TaskAuditService {
  private readonly logger = new Logger(TaskAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAudit(
    action: TaskAuditAction,
    taskId?: string,
    actorId?: string,
    details?: Record<string, any>,
  ) {
    try {
      return await this.prisma.taskAudit.create({
        data: { taskId, actorId, action, details: details ?? {} },
      });
    } catch (err) {
      this.logger.error(`Failed to write task audit ${action}: ${(err as Error).message}`);
    }
  }

  async getLogs(taskId?: string, action?: string, limit = 50, offset = 0) {
    const where: any = {};
    if (taskId) where.taskId = taskId;
    if (action) where.action = action;

    const [items, total] = await Promise.all([
      this.prisma.taskAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.taskAudit.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
