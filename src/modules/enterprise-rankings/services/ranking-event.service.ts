import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class RankingEventService {
  private readonly logger = new Logger(RankingEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}

  private async publish(name: string, payload: Record<string, any>) {
    try {
      await this.eventBus.publish({ name, payload, timestamp: new Date() } as any);
    } catch (err) {
      this.logger.error(`Failed to publish event ${name}: ${(err as Error).message}`);
    }
  }

  async publishRankingUpdated(
    rankingId: string,
    entityId: string,
    entityType: string,
    newRank: number,
    previousRank: number | null,
    scoreDelta: number,
  ) {
    await this.publish('ranking.updated', {
      rankingId,
      entityId,
      entityType,
      newRank,
      previousRank,
      scoreDelta,
    });

    if (previousRank !== null) {
      if (newRank < previousRank) {
        await this.publish('ranking.promoted', { rankingId, entityId, newRank, previousRank });
      } else if (newRank > previousRank) {
        await this.publish('ranking.demoted', { rankingId, entityId, newRank, previousRank });
      }
    }
  }

  async publishLeaderboardRefreshed(rankingId: string, category: string, period: string) {
    await this.publish('leaderboard.refreshed', { rankingId, category, period });
  }

  async publishSnapshotCreated(rankingId: string, period: string, dateKey: string, count: number) {
    await this.publish('ranking.snapshot.created', { rankingId, period, dateKey, count });
  }
}
