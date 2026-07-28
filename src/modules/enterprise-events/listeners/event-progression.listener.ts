import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  PROGRESSION_EVENT_NAMES,
  resolveProgressionSubject,
} from 'src/common/events/progression-events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventParticipationService } from '../services/event-participation.service';

/**
 * Scores live event participation from real activity.
 *
 * A competition or tournament is only meaningful if participants' scores move as
 * they play; nothing was feeding `updateParticipantScore`, so leaderboards inside
 * an event stayed at zero for its whole run.
 *
 * Which events score off which signals is configured on the event definition
 * (`participationRules.scoring`), so a new tournament format needs no deploy.
 */
@Injectable()
export class EventProgressionListener implements OnModuleInit {
  private readonly logger = new Logger(EventProgressionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly participation: EventParticipationService,
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
      // Only events the user is actively participating in can score.
      const participations = await this.prisma.eventParticipant.findMany({
        where: { userId, status: { in: ['PARTICIPATING', 'CHECKED_IN'] } },
        include: { event: true },
      });
      if (participations.length === 0) return;

      for (const participant of participations) {
        const event = participant.event;
        if (!event || event.status !== 'ACTIVE') continue;

        const scoring = (event.participationRules as Record<string, unknown> | null)?.[
          'scoring'
        ] as Record<string, unknown> | undefined;
        const codes = scoring?.['eventCodes'];
        if (!Array.isArray(codes) || !codes.includes(eventCode)) continue;

        await this.participation.updateParticipantScore(
          event.id,
          userId,
          this.scoreDelta(scoring, payload),
        );
      }
    } catch (err) {
      this.logger.error(
        `Event participation scoring failed for '${eventCode}': ${(err as Error).message}`,
      );
    }
  }

  /** Magnitude from the configured payload field, else a flat per-occurrence value. */
  private scoreDelta(scoring: Record<string, unknown> | undefined, payload: unknown): number {
    const field = scoring?.['scoreField'];
    if (typeof field === 'string' && payload && typeof payload === 'object') {
      const raw = (payload as Record<string, unknown>)[field];
      const value = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      if (Number.isFinite(value)) return value;
    }
    const fallback = Number(scoring?.['defaultDelta']);
    return Number.isFinite(fallback) ? fallback : 1;
  }
}
