import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  PROGRESSION_EVENT_NAMES,
  resolveProgressionSubject,
} from 'src/common/events/progression-events';
import { TaskEvaluationService } from '../services/task-evaluation.service';

/**
 * Feeds domain events into the tasks & missions rule engine.
 *
 * Mirrors the achievement listener: the bus event name is forwarded as the
 * `eventCode`, so a task's trigger is `TaskDefinition.eventCode` in the database
 * and adding a mission needs no deploy.
 */
@Injectable()
export class TaskProgressionListener implements OnModuleInit {
  private readonly logger = new Logger(TaskProgressionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly evaluation: TaskEvaluationService,
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
    if (!userId) return;

    try {
      await this.evaluation.evaluateEvent({
        userId,
        eventCode,
        metadata: (payload ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      this.logger.error(`Task evaluation failed for '${eventCode}': ${(err as Error).message}`);
    }
  }
}
