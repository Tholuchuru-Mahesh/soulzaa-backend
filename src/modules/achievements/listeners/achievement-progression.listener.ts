import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  PROGRESSION_EVENT_NAMES,
  resolveProgressionSubject,
} from 'src/common/events/progression-events';
import { AchievementEvaluationService } from '../services/achievement-evaluation.service';

/**
 * Feeds domain events into the achievement rule engine.
 *
 * `AchievementEvaluationService` was written to be event-driven but nothing ever
 * called it, so achievements only ever moved when an admin poked the API. This
 * subscribes it to the progression signals and passes the bus event name straight
 * through as the `eventCode`, so which achievements react to what stays in
 * `unlockRule.eventCodes` rather than in code.
 */
@Injectable()
export class AchievementProgressionListener implements OnModuleInit {
  private readonly logger = new Logger(AchievementProgressionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly evaluation: AchievementEvaluationService,
  ) {}

  onModuleInit(): void {
    for (const eventName of PROGRESSION_EVENT_NAMES) {
      this.bus.subscribe(eventName, (event) => {
        void this.handle(eventName, event.payload);
      });
    }
  }

  private async handle(eventCode: string, payload: unknown): Promise<void> {
    const userId = resolveProgressionSubject(payload);
    // Room-scoped events carry no subject — nothing to progress.
    if (!userId) return;

    try {
      await this.evaluation.evaluateEvent({
        userId,
        eventCode,
        metadata: (payload ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      // Progression is a side effect: never fail the originating action.
      this.logger.error(
        `Achievement evaluation failed for '${eventCode}': ${(err as Error).message}`,
      );
    }
  }
}
