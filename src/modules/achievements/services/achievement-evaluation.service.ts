import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AchievementService } from './achievement.service';
import { AchievementProgressService } from './achievement-progress.service';

export interface EvaluateEventInput {
  userId: string;
  eventCode: string;
  metadata?: Record<string, any>;
  actorId?: string;
}

export interface EvaluationResult {
  evaluated: number;
  progressed: number;
  unlocked: number;
  achievementIds: string[];
}

/**
 * AchievementEvaluationService — event-driven rule engine.
 *
 * When a domain event fires (GiftSent, LevelUp, VipPurchased, …),
 * this service:
 *   1. Finds all ACTIVE achievements that respond to that event code.
 *   2. Evaluates the unlock rule (if any) against the event metadata.
 *   3. Increments progress for each matching achievement.
 *   4. Triggers unlock when progress threshold is reached.
 *
 * No polling. No hardcoded rules. Rules are stored as JSON in
 * AchievementDefinition.unlockRule.
 *
 * Supported rule operators:
 *   { "operator": "GTE", "field": "amount", "value": 100 }
 *   { "operator": "EQ", "field": "tier", "value": "GOLD" }
 *   { "operator": "ANY" }   ← always matches
 */
@Injectable()
export class AchievementEvaluationService {
  private readonly logger = new Logger(AchievementEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly progressService: AchievementProgressService,
    private readonly achievementService: AchievementService,
  ) {}

  async evaluateEvent(input: EvaluateEventInput): Promise<EvaluationResult> {
    const { userId, eventCode, metadata = {}, actorId } = input;

    // Find achievements that listen to this event code
    const definitions = await this.prisma.achievementDefinition.findMany({
      where: { status: 'ACTIVE' },
    });

    const matching = definitions.filter((def) => {
      const rule = def.unlockRule as Record<string, any> | null;
      if (!rule) return false;
      const listeningTo: string[] = rule['eventCodes'] ?? [];
      if (!listeningTo.includes(eventCode)) return false;
      return this.evaluateRule(rule, metadata);
    });

    let progressed = 0;
    let unlocked = 0;
    const unlockedIds: string[] = [];

    for (const def of matching) {
      try {
        const result = await this.progressService.incrementProgress({
          userId,
          achievementId: def.id,
          requiredProgress: def.requiredProgress,
          incrementBy: this.extractIncrement(def.unlockRule as Record<string, any>, metadata),
          eventCode,
          metadata,
        });

        progressed++;

        if (result.justCompleted) {
          try {
            await this.achievementService.unlockAchievement(userId, def.id, actorId, true);
            unlocked++;
            unlockedIds.push(def.id);
          } catch (unlockErr) {
            // Already unlocked (non-repeatable) — swallow
            this.logger.debug(
              `Achievement ${def.id} already unlocked for user ${userId}: ${(unlockErr as Error).message}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to evaluate achievement ${def.id} for event ${eventCode}: ${(err as Error).message}`,
        );
      }
    }

    return {
      evaluated: matching.length,
      progressed,
      unlocked,
      achievementIds: unlockedIds,
    };
  }

  /**
   * Evaluates a JSON rule against event metadata.
   * Returns true if the rule passes (achievement should be incremented).
   */
  private evaluateRule(rule: Record<string, any>, metadata: Record<string, any>): boolean {
    const operator: string = rule['operator'] ?? 'ANY';

    switch (operator) {
      case 'ANY':
        return true;
      case 'EQ': {
        const field = rule['field'] as string;
        const expected = rule['value'];
        return metadata[field] === expected;
      }
      case 'GTE': {
        const field = rule['field'] as string;
        const threshold = Number(rule['value']);
        return Number(metadata[field] ?? 0) >= threshold;
      }
      case 'LTE': {
        const field = rule['field'] as string;
        const threshold = Number(rule['value']);
        return Number(metadata[field] ?? 0) <= threshold;
      }
      case 'IN': {
        const field = rule['field'] as string;
        const values: any[] = rule['values'] ?? [];
        return values.includes(metadata[field]);
      }
      default:
        return true;
    }
  }

  /** Extract increment amount from rule or default to 1 */
  private extractIncrement(
    rule: Record<string, any> | null,
    metadata: Record<string, any>,
  ): number {
    if (!rule) return 1;
    const incrementField = rule['incrementField'] as string | undefined;
    if (incrementField && metadata[incrementField]) {
      return Math.max(1, Math.floor(Number(metadata[incrementField])));
    }
    return 1;
  }
}
