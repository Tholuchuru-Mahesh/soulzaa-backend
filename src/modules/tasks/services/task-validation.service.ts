import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  RESET_POLICIES,
  TASK_CATEGORIES,
  TASK_DIFFICULTIES,
  TASK_STATUSES,
} from '../constants/task.constants';

@Injectable()
export class TaskValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
  }

  async validateTaskExists(taskId: string, requireActive = false) {
    const def = await this.prisma.taskDefinition.findUnique({ where: { id: taskId } });
    if (!def) throw new NotFoundException(`Task definition ${taskId} not found`);
    if (requireActive && def.status !== 'ACTIVE')
      throw new BadRequestException(`Task ${taskId} is not active (Status: ${def.status})`);
    return def;
  }

  async validateTaskByCode(code: string, requireActive = false) {
    const def = await this.prisma.taskDefinition.findUnique({ where: { code } });
    if (!def) throw new NotFoundException(`Task with code '${code}' not found`);
    if (requireActive && def.status !== 'ACTIVE')
      throw new BadRequestException(`Task '${code}' is not active (Status: ${def.status})`);
    return def;
  }

  async validateMissionExists(missionId: string, requireActive = false) {
    const def = await this.prisma.missionDefinition.findUnique({ where: { id: missionId } });
    if (!def) throw new NotFoundException(`Mission definition ${missionId} not found`);
    if (requireActive && def.status !== 'ACTIVE')
      throw new BadRequestException(`Mission ${missionId} is not active (Status: ${def.status})`);
    return def;
  }

  validateCategory(category: string): void {
    if (!(TASK_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException(
        `Invalid task category '${category}'. Valid: ${TASK_CATEGORIES.join(', ')}`,
      );
    }
  }

  validateStatus(status: string): void {
    if (!(TASK_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Invalid task status '${status}'. Valid: ${TASK_STATUSES.join(', ')}`,
      );
    }
  }

  validateResetPolicy(policy: string): void {
    if (!(RESET_POLICIES as readonly string[]).includes(policy)) {
      throw new BadRequestException(
        `Invalid reset policy '${policy}'. Valid: ${RESET_POLICIES.join(', ')}`,
      );
    }
  }

  validateDifficulty(difficulty: string): void {
    if (!(TASK_DIFFICULTIES as readonly string[]).includes(difficulty)) {
      throw new BadRequestException(
        `Invalid difficulty '${difficulty}'. Valid: ${TASK_DIFFICULTIES.join(', ')}`,
      );
    }
  }

  validateProgressAmount(amount: number): void {
    if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
      throw new BadRequestException('Progress increment amount must be a positive finite integer');
    }
  }
}
