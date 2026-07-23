import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AchievementAuditService } from './achievement-audit.service';
import { AchievementEventService } from './achievement-event.service';

export interface IncrementProgressInput {
  userId: string;
  achievementId: string;
  requiredProgress: number;
  incrementBy?: number;
  eventCode?: string;
  metadata?: Record<string, any>;
}

export interface IncrementProgressResult {
  progressBefore: number;
  progressAfter: number;
  percentComplete: number;
  isCompleted: boolean;
  justCompleted: boolean;
}

@Injectable()
export class AchievementProgressService {
  private readonly logger = new Logger(AchievementProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AchievementAuditService,
    private readonly eventService: AchievementEventService,
  ) {}

  async incrementProgress(input: IncrementProgressInput): Promise<IncrementProgressResult> {
    const { userId, achievementId, requiredProgress, incrementBy = 1, eventCode, metadata } = input;

    const existing = await this.prisma.achievementProgress.findUnique({
      where: { userId_achievementId: { userId, achievementId } },
    });

    // Skip if already completed (unless repeatable handling is done upstream)
    if (existing?.isCompleted) {
      return {
        progressBefore: existing.currentProgress,
        progressAfter: existing.currentProgress,
        percentComplete: 100,
        isCompleted: true,
        justCompleted: false,
      };
    }

    const progressBefore = existing?.currentProgress ?? 0;
    const newProgress = Math.min(progressBefore + incrementBy, requiredProgress);
    const percentComplete = Math.round((newProgress / requiredProgress) * 100 * 100) / 100;
    const justCompleted = !existing?.isCompleted && newProgress >= requiredProgress;

    await this.prisma.achievementProgress.upsert({
      where: { userId_achievementId: { userId, achievementId } },
      update: {
        currentProgress: newProgress,
        percentComplete,
        isCompleted: justCompleted,
        completedAt: justCompleted ? new Date() : undefined,
        lastEventCode: eventCode,
        lastEventAt: new Date(),
      },
      create: {
        userId,
        achievementId,
        currentProgress: newProgress,
        requiredProgress,
        percentComplete,
        isCompleted: justCompleted,
        completedAt: justCompleted ? new Date() : undefined,
        lastEventCode: eventCode,
        lastEventAt: new Date(),
      },
    });

    // Record history entry
    await this.prisma.achievementHistory.create({
      data: {
        userId,
        achievementId,
        eventCode: eventCode ?? 'PROGRESS_UPDATE',
        progressBefore,
        progressAfter: newProgress,
        unlocked: justCompleted,
        metadata: metadata ?? {},
      },
    });

    await this.auditService.logAudit('ACHIEVEMENT_PROGRESS_UPDATED', userId, undefined, {
      achievementId,
      progressBefore,
      progressAfter: newProgress,
      percentComplete,
      justCompleted,
    });

    await this.eventService.publishAchievementProgress(
      userId,
      achievementId,
      newProgress,
      requiredProgress,
      percentComplete,
    );

    return {
      progressBefore,
      progressAfter: newProgress,
      percentComplete,
      isCompleted: justCompleted,
      justCompleted,
    };
  }

  async resetProgress(userId: string, achievementId: string): Promise<void> {
    await this.prisma.achievementProgress.updateMany({
      where: { userId, achievementId },
      data: { currentProgress: 0, percentComplete: 0, isCompleted: false, completedAt: null },
    });
  }

  async getUserProgress(userId: string, achievementId?: string) {
    const where: any = { userId };
    if (achievementId) where.achievementId = achievementId;
    return this.prisma.achievementProgress.findMany({
      where,
      include: { achievement: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getProgressSummary(userId: string) {
    const [all, completed] = await Promise.all([
      this.prisma.achievementProgress.count({ where: { userId } }),
      this.prisma.achievementProgress.count({ where: { userId, isCompleted: true } }),
    ]);
    return {
      total: all,
      completed,
      pending: all - completed,
      completionRate: all > 0 ? Math.round((completed / all) * 100 * 100) / 100 : 0,
    };
  }
}
