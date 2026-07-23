import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MissionProgressService } from './mission-progress.service';
import { TaskConfigurationService } from './task-configuration.service';
import { TaskProgressService } from './task-progress.service';
import { TaskRewardService } from './task-reward.service';

export interface EvaluateTaskEventInput {
  userId: string;
  eventCode: string;
  metadata?: Record<string, any>;
  actorId?: string;
}

export interface TaskEvaluationSummary {
  evaluated: number;
  progressed: number;
  completed: number;
  taskIds: string[];
}

@Injectable()
export class TaskEvaluationService {
  private readonly logger = new Logger(TaskEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly progressService: TaskProgressService,
    private readonly missionProgressService: MissionProgressService,
    private readonly rewardService: TaskRewardService,
    private readonly configService: TaskConfigurationService,
  ) {}

  /**
   * Evaluates a domain event against all ACTIVE tasks listening for that event.
   * No polling, no hardcoded rules.
   */
  async evaluateEvent(input: EvaluateTaskEventInput): Promise<TaskEvaluationSummary> {
    const { userId, eventCode, metadata = {}, actorId } = input;

    const definitions = await this.prisma.taskDefinition.findMany({
      where: { status: 'ACTIVE' },
    });

    const matching = definitions.filter((def) => {
      const rules = def.progressRules as Record<string, any> | null;
      if (!rules) return false;
      const listeningTo: string[] = rules['eventCodes'] ?? [];
      if (!listeningTo.includes(eventCode)) return false;
      return this.evaluateRule(rules, metadata);
    });

    let progressed = 0;
    let completed = 0;
    const completedTaskIds: string[] = [];
    const params = await this.configService.getParameters();

    for (const def of matching) {
      try {
        const incrementBy = this.extractIncrement(def.progressRules as Record<string, any>, metadata);

        const result = await this.progressService.incrementProgress({
          userId,
          taskId: def.id,
          requiredProgress: def.requiredProgress,
          incrementBy,
          resetPolicy: def.resetPolicy,
          eventCode,
          metadata,
        });

        progressed++;

        if (result.justCompleted) {
          completed++;
          completedTaskIds.push(def.id);

          // Evaluate mission progress if task belongs to a mission
          if (def.missionId) {
            await this.missionProgressService.evaluateMissionProgress(userId, def.missionId);
          }

          // Auto-claim reward if enabled
          if (params.autoClaim && def.rewardDefinition) {
            await this.rewardService.dispatchReward(userId, def.id, undefined, undefined, actorId);
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to evaluate task ${def.id} for event ${eventCode}: ${(err as Error).message}`,
        );
      }
    }

    return {
      evaluated: matching.length,
      progressed,
      completed,
      taskIds: completedTaskIds,
    };
  }

  private evaluateRule(rules: Record<string, any>, metadata: Record<string, any>): boolean {
    const operator: string = rules['operator'] ?? 'ANY';

    switch (operator) {
      case 'ANY':
        return true;
      case 'EQ': {
        const field = rules['field'] as string;
        return metadata[field] === rules['value'];
      }
      case 'GTE': {
        const field = rules['field'] as string;
        return Number(metadata[field] ?? 0) >= Number(rules['value']);
      }
      case 'LTE': {
        const field = rules['field'] as string;
        return Number(metadata[field] ?? 0) <= Number(rules['value']);
      }
      case 'IN': {
        const field = rules['field'] as string;
        const values: any[] = rules['values'] ?? [];
        return values.includes(metadata[field]);
      }
      default:
        return true;
    }
  }

  private extractIncrement(rules: Record<string, any> | null, metadata: Record<string, any>): number {
    if (!rules) return 1;
    const incrementField = rules['incrementField'] as string | undefined;
    if (incrementField && metadata[incrementField]) {
      return Math.max(1, Math.floor(Number(metadata[incrementField])));
    }
    return 1;
  }
}
