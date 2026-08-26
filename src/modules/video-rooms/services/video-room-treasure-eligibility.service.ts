import { Inject, Injectable, Optional } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { WEALTH_SERVICE, type IWealthService } from 'src/modules/wealth/interfaces/wealth.service.interface';
import { treasureActivityKey } from '../constants/video-room-treasure.constants';
import {
  videoRoomHostsKey,
  videoRoomParticipantsKey,
  videoRoomViewersKey,
} from '../constants/video-room.constants';
import { TreasureWinnerAlgorithm } from '../constants/video-room-treasure.constants';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import type { TreasureLevelRules } from './video-room-treasure-pool.service';

export interface EligibilityResult {
  /** Users who passed every rule. May be fewer than `want`, or empty. */
  eligible: string[];
  /** How many distinct users were sampled before filtering — audit input. */
  candidateCount: number;
  /** Per-user activity counts, reused by ACTIVITY_BASED draws. */
  activity: Map<string, number>;
  /** Per-user VIP ordinal (NONE=0 … TITAN=7), reused by VIP_PRIORITY draws. */
  vipTiers: Map<string, number>;
}

/**
 * Resolves who may win a box (VR-11 spec §6.6).
 *
 * The shape is oversample-then-filter, never load-then-filter: `SRANDMEMBER key
 * N` asks Redis to pick N random members, so a room with 100k viewers never
 * materialises 100k ids in Node. Membership, ban status and join time are
 * filtered in one repository call over only the sampled candidates.
 *
 * Activity and VIP weights are fetched ONLY when an algorithm or rule actually
 * consumes them, so the common RANDOM draw pays for neither.
 *
 * A clock is injected so the minimum-stay rule is testable without fake timers.
 */
@Injectable()
export class VideoRoomTreasureEligibilityService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly repo: VideoRoomTreasureRepository,
    @Inject(WEALTH_SERVICE) private readonly wealth: IWealthService,
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(input: {
    roomId: string;
    sessionId: string;
    rules: TreasureLevelRules;
    want: number;
    oversampleFactor: number;
    oversampleMin: number;
  }): Promise<EligibilityResult> {
    const { roomId, sessionId, rules, want, oversampleFactor, oversampleMin } = input;
    const empty: EligibilityResult = {
      eligible: [],
      candidateCount: 0,
      activity: new Map(),
      vipTiers: new Map(),
    };

    const sampleSize = Math.max(want * oversampleFactor, oversampleMin);
    const [viewers, participants, hosts] = await Promise.all([
      this.redis.srandmember(videoRoomViewersKey(roomId), sampleSize),
      this.redis.srandmember(videoRoomParticipantsKey(roomId), sampleSize),
      this.redis.srandmember(videoRoomHostsKey(roomId), sampleSize),
    ]);

    // A seat holder is also a room member, so the sets overlap; dedupe before
    // paying for a Postgres round-trip.
    const candidates = [
      ...new Set([...(viewers ?? []), ...(participants ?? []), ...(hosts ?? [])]),
    ];
    if (candidates.length === 0) return empty;

    const joinedBefore = new Date(this.now() - rules.minStaySeconds * 1000);
    const [members, blocked] = await Promise.all([
      this.repo.findEligibleMembers(roomId, candidates, joinedBefore),
      this.repo.findBlockedUserIds(roomId, candidates),
    ]);

    // A blocked user may still hold a stale presence entry, so the block list is
    // applied explicitly rather than trusting membership alone.
    let eligible = members.filter((id) => !blocked.has(id));

    const activity = await this.activityFor(roomId, sessionId, eligible, rules);
    if (rules.minActivityEvents > 0) {
      eligible = eligible.filter((id) => (activity.get(id) ?? 0) >= rules.minActivityEvents);
    }

    const vipTiers = await this.vipTiersFor(eligible, rules);

    return { eligible, candidateCount: candidates.length, activity, vipTiers };
  }

  /**
   * Activity counts for the surviving candidates, read as ONE hash lookup.
   *
   * Must stay in lockstep with `VideoRoomTreasureProgressService.recordActivity`,
   * which writes `HINCRBY key userId 1` — key AND type both have to match or
   * every count silently reads as zero.
   */
  private async activityFor(
    roomId: string,
    sessionId: string,
    userIds: string[],
    rules: TreasureLevelRules,
  ): Promise<Map<string, number>> {
    const needed =
      rules.minActivityEvents > 0 ||
      rules.winnerAlgorithm === TreasureWinnerAlgorithm.ACTIVITY_BASED;
    if (!needed || userIds.length === 0) return new Map();

    const counts = await this.redis.hmget(treasureActivityKey(roomId, sessionId), ...userIds);
    const map = new Map<string, number>();
    userIds.forEach((id, i) => {
      const raw = counts?.[i];
      map.set(id, raw === null || raw === undefined ? 0 : Number(raw) || 0);
    });
    return map;
  }

  /**
   * VIP ordinals for the surviving candidates, resolved through the public VIP
   * service rather than by reaching into another module's table.
   *
   * Skipped entirely unless VIP_PRIORITY is the configured algorithm — the set
   * is already bounded by the oversample, so a handful of parallel lookups is
   * cheaper than a cross-module join, and the default draw pays nothing.
   */
  private async vipTiersFor(
    userIds: string[],
    rules: TreasureLevelRules,
  ): Promise<Map<string, number>> {
    if (rules.winnerAlgorithm !== TreasureWinnerAlgorithm.VIP_PRIORITY || userIds.length === 0) {
      return new Map();
    }
    const ordinals = await Promise.all(
      userIds.map((id) => this.wealth.getEffectiveLevel(id).catch(() => 0)),
    );
    return new Map(userIds.map((id, i) => [id, ordinals[i]]));
  }
}
