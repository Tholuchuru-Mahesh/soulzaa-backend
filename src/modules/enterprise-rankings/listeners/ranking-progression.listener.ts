import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  PROGRESSION_EVENT_NAMES,
  resolveProgressionSubject,
} from 'src/common/events/progression-events';
import { RankingCalculationService } from '../services/ranking-calculation.service';

/**
 * How much a single event contributes before `scoreFormula`'s multiplier/cap are
 * applied by the calculation service.
 *
 * `scoreField` names the payload field carrying the magnitude (gift coin value,
 * wager amount); `defaultDelta` covers countable events that have no magnitude
 * (a room join is worth a flat amount). Falls back to 1 so a ranking configured
 * with only `eventCodes` still counts occurrences.
 */
export function resolveScoreDelta(
  formula: Record<string, unknown> | null,
  payload: unknown,
): number {
  const scoreField = formula?.['scoreField'];
  if (typeof scoreField === 'string' && payload && typeof payload === 'object') {
    const raw = (payload as Record<string, unknown>)[scoreField];
    const value = typeof raw === 'bigint' ? Number(raw) : Number(raw);
    if (Number.isFinite(value)) return value;
  }

  const fallback = Number(formula?.['defaultDelta']);
  return Number.isFinite(fallback) ? fallback : 1;
}

/**
 * Feeds domain events into the enterprise ranking engine.
 *
 * Which rankings respond to which events lives in
 * `RankingDefinition.scoreFormula.eventCodes`, so leaderboards are added and
 * retuned from the database rather than in code — the spec's "no hardcoded
 * scoring formulas".
 */
@Injectable()
export class RankingProgressionListener implements OnModuleInit {
  private readonly logger = new Logger(RankingProgressionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly calculation: RankingCalculationService,
  ) {}

  onModuleInit(): void {
    for (const eventName of PROGRESSION_EVENT_NAMES) {
      this.bus.subscribe(eventName, (event) => {
        void this.handle(eventName, event.payload);
      });
    }
  }

  private async handle(eventCode: string, payload: unknown): Promise<void> {
    const entityId = resolveProgressionSubject(payload);
    if (!entityId) return;

    try {
      const definitions = await this.prisma.rankingDefinition.findMany({
        where: { status: 'ACTIVE' },
      });

      const listening = definitions.filter((def) => {
        const formula = def.scoreFormula as Record<string, unknown> | null;
        const codes = formula?.['eventCodes'];
        return Array.isArray(codes) && codes.includes(eventCode);
      });

      for (const def of listening) {
        const formula = def.scoreFormula as Record<string, unknown> | null;
        await this.calculation.applyScore({
          entityId,
          entityType: def.entityType,
          rankingId: def.id,
          eventCode,
          scoreDelta: resolveScoreDelta(formula, payload),
          metadata: (payload ?? {}) as Record<string, unknown>,
        });
      }
    } catch (err) {
      this.logger.error(`Ranking scoring failed for '${eventCode}': ${(err as Error).message}`);
    }
  }
}
