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

/**
 * Generic Event-Driven Task & Engagement Rule Engine.
 *
 * Universal rule evaluation:
 * - Domain events trigger the engine with `eventCode` and `metadata`.
 * - Matches active tasks configured by Super Admin via `progressRules.eventCodes` or `eventCode`.
 * - Evaluates generic filter conditions (EQ, GTE, LTE, IN, NEQ, CONTAINS, ANY).
 * - Extracts dynamic accumulation values (e.g. minutes, coins) or increments by 1 per event.
 * - Auto-completes, updates period progress, and dispatches rewards without per-task hardcoded logic.
 */
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
   * Evaluates a domain event against all ACTIVE task definitions.
   */
  async evaluateEvent(input: EvaluateTaskEventInput): Promise<TaskEvaluationSummary> {
    const { userId, eventCode, metadata = {}, actorId } = input;
    if (!userId || !eventCode) {
      return { evaluated: 0, progressed: 0, completed: 0, taskIds: [] };
    }

    const normalizedEventCode = eventCode.toLowerCase().trim();

    const definitions = await this.prisma.taskDefinition.findMany({
      where: {
        OR: [
          { status: 'ACTIVE' },
          { category: 'EVENT_MISSION', status: { in: ['ACTIVE', 'SCHEDULED', 'DRAFT'] } },
        ],
      },
    });

    const matching = definitions.filter((def) => {
      return this.isListeningToEvent(def, normalizedEventCode, metadata);
    });

    let progressed = 0;
    let completed = 0;
    const completedTaskIds: string[] = [];
    const params = await this.configService.getParameters();

    for (const def of matching) {
      try {
        const incrementBy = this.extractIncrement(
          def.progressRules as Record<string, any> | null,
          normalizedEventCode,
          metadata,
        );

        const result = await this.progressService.incrementProgress({
          userId,
          taskId: def.id,
          requiredProgress: def.requiredProgress,
          incrementBy,
          resetPolicy: def.resetPolicy,
          eventCode: normalizedEventCode,
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

          // Auto-claim reward if enabled in configuration
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

  /**
   * Generic event matcher based on configured event codes and rule constraints.
   */
  private isListeningToEvent(
    def: {
      id: string;
      code: string;
      name: string;
      category: string;
      objective: string;
      progressRules: any;
    },
    eventCode: string,
    metadata: Record<string, any>,
  ): boolean {
    const rules = def.progressRules as Record<string, any> | null;

    // 1. Explicitly configured eventCodes in progressRules
    if (rules) {
      const configuredEvents: string[] = [];
      if (Array.isArray(rules['eventCodes'])) {
        configuredEvents.push(
          ...rules['eventCodes'].map((e: any) => String(e).toLowerCase().trim()),
        );
      }
      if (rules['eventCode']) {
        configuredEvents.push(String(rules['eventCode']).toLowerCase().trim());
      }

      if (configuredEvents.length > 0) {
        const matchesEvent = configuredEvents.includes(eventCode);
        if (!matchesEvent) return false;
        return this.evaluateRule(rules, metadata);
      }
    }

    // 2. Exact code match (e.g. task code matches the eventCode)
    const normalizedDefCode = (def.code || '').toLowerCase().trim();
    if (normalizedDefCode === eventCode) {
      return this.evaluateRule(rules || {}, metadata);
    }

    // 3. Fallback: Check if progressRules has a rule without eventCodes constraint
    if (rules && rules['operator'] && rules['operator'] !== 'ANY') {
      return this.evaluateRule(rules, metadata);
    }

    return false;
  }

  /**
   * Generic condition rule evaluation.
   */
  private evaluateRule(rules: Record<string, any>, metadata: Record<string, any>): boolean {
    const operator: string = rules['operator'] ?? 'ANY';
    if (operator === 'ANY') return true;

    const field = rules['field'] as string | undefined;
    if (!field) return true;

    const actual = metadata[field];
    const target = rules['value'];

    switch (operator) {
      case 'EQ':
        return actual === target;
      case 'NEQ':
        return actual !== target;
      case 'GTE':
        return Number(actual ?? 0) >= Number(target);
      case 'LTE':
        return Number(actual ?? 0) <= Number(target);
      case 'IN': {
        const values: any[] = Array.isArray(rules['values']) ? rules['values'] : [target];
        return values.includes(actual);
      }
      case 'CONTAINS':
        return String(actual ?? '').includes(String(target ?? ''));
      default:
        return true;
    }
  }

  /**
   * Dynamically extracts the increment amount from the event metadata.
   */
  private extractIncrement(
    rules: Record<string, any> | null,
    eventCode: string,
    metadata: Record<string, any>,
  ): number {
    // 1. Configured incrementField (e.g. 'durationMinutes', 'amount', 'totalCoinValue')
    const incrementField = rules?.['incrementField'] as string | undefined;
    if (incrementField && metadata[incrementField] !== undefined) {
      const val = Number(metadata[incrementField]);
      if (!isNaN(val) && val > 0) {
        return Math.floor(val);
      }
    }

    // 2. Natural accumulation for recharge & wallet credit events
    if (
      (eventCode === 'wallet.credited' ||
        eventCode === 'coin_purchase.completed' ||
        eventCode === 'recharge.success') &&
      (metadata['amount'] !== undefined ||
        metadata['coins'] !== undefined ||
        metadata['coinAmount'] !== undefined)
    ) {
      const coins = Number(
        metadata['amount'] ?? metadata['coins'] ?? metadata['coinAmount'],
      );
      if (!isNaN(coins) && coins > 0) {
        return Math.floor(coins);
      }
    }

    // 3. Natural accumulation for duration events
    if (
      eventCode === 'room.duration_updated' &&
      (metadata['durationMinutes'] !== undefined ||
        metadata['duration'] !== undefined ||
        metadata['minutes'] !== undefined)
    ) {
      const mins = Number(
        metadata['durationMinutes'] ?? metadata['duration'] ?? metadata['minutes'],
      );
      if (!isNaN(mins) && mins > 0) {
        return Math.floor(mins);
      }
    }

    // Default count-based progress: 1 per event occurrence
    return 1;
  }
}
