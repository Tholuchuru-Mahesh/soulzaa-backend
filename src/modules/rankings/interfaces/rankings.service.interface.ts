import type { Paginated } from 'src/common/interfaces/api-response.interface';
import {
  RankedFamily,
  RankedGifter,
  RankedReceiver,
  RankedStreamer,
  RankingPeriod,
} from '../dto/rankings.dto';

/**
 * Public contract for the rankings module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals stay private.
 */
export const RANKINGS_SERVICE = Symbol('RANKINGS_SERVICE');

export interface IRankingsService {
  /** Get top gifters (coins sent) for a given period. */
  getGifters(period: RankingPeriod, limit: number, page: number): Promise<Paginated<RankedGifter>>;

  /** Get top receivers (coins received) for a given period. */
  getReceivers(
    period: RankingPeriod,
    limit: number,
    page: number,
  ): Promise<Paginated<RankedReceiver>>;

  /** Get top families (coins sent by members) for a given period. */
  getFamilies(period: RankingPeriod, limit: number, page: number): Promise<Paginated<RankedFamily>>;

  /** Get top streamers (coins received in room/live contexts) for a given period. */
  getStreamers(
    period: RankingPeriod,
    limit: number,
    page: number,
  ): Promise<Paginated<RankedStreamer>>;
}
