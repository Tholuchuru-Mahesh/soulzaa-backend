export * from './rankings.service.interface';

/**
 * `RankingPeriodResolver`, `LeaderboardStore` and `LeaderboardCache` are the
 * generic ranking core other domain modules (starting with video-rooms) build
 * on top of. They are re-exported here — as concrete classes, not behind a
 * DI token/interface pair the way `RANKINGS_SERVICE` is — because that
 * abstraction would have no purpose: these are domain-free infrastructure
 * utilities (date math, a ZSET layer, a hydrated-page cache) with no second
 * implementation to abstract over, so inventing an interface per class would
 * be indirection with no consumer. `interfaces/` is simply the location
 * `no-cross-module-imports` recognises as a module's public surface, so
 * re-exporting from here is what lets another module import them legally.
 */
export {
  RankingPeriodResolver,
  type RankingPeriodName,
  type RankingTimezone,
} from '../services/ranking-period.resolver';
export {
  LeaderboardStore,
  type RankedEntry,
  type LeaderboardIncrement,
} from '../services/leaderboard-store.service';
export { LeaderboardCache, type CachedPage } from '../services/leaderboard-cache.service';
export {
  type LeaderboardKeyParts,
  buildLeaderboardKey,
  leaderboardTag,
} from '../constants/ranking-keys';
