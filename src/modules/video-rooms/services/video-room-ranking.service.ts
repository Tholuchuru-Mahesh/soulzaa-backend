import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainEvent, EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  LeaderboardStore,
  type LeaderboardIncrement,
  RankingPeriodResolver,
  type RankingPeriodName,
} from 'src/modules/rankings/interfaces';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_HOT_PERIODS,
  VIDEO_ROOM_RANKING_NAMESPACE,
  errorMessage,
  parseScope,
  scopeCity,
  scopeCountry,
  scopeGlobal,
  scopeRoom,
} from '../constants/video-room-ranking.constants';
import {
  GifterRankingUpdatedEvent,
  HostRankingUpdatedEvent,
  PKRankingUpdatedEvent,
  RankingUpdatedEvent,
  type RankingMovementPayload,
  RoomRankingUpdatedEvent,
  TreasureRankingUpdatedEvent,
} from '../events/video-room-ranking.events';
import { type UserGeo, VideoRoomRankingScopeResolver } from './video-room-ranking-scope.resolver';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

export interface GiftRankingInput {
  transactionId: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  totalCoinValue: number;
  quantity: number;
  /** Only a seated receiver is a "host" for ranking purposes. */
  receiverIsSeated: boolean;
  occurredAt: Date;
}

export interface PkRankingInput {
  battleId: string;
  roomId: string;
  occurredAt: Date;
  outcomes: { userId: string; won: boolean; lost: boolean; score: number }[];
}

export interface TreasureRankingInput {
  rewardId: string;
  roomId: string;
  userId: string;
  amount: number;
  occurredAt: Date;
}

export interface RoomActivityInput {
  /** Natural id for dedupe — a session id or a monitor tick id. */
  activityId: string;
  roomId: string;
  occurredAt: Date;
  peakViewers?: number;
  avgWatchSeconds?: number;
  pkCount?: number;
  treasureCount?: number;
}

/**
 * One entity's movement on one dimension, before scope fan-out.
 *
 * `attributionUserId` is whose geography decides this delta's country/city
 * ladders — deliberately per-DELTA, not per-event: a gift's `gifters` delta
 * and its `hosts` delta belong to two different people. Absent when no single
 * user is attributable (room-dimension rows), which fans out to global + room
 * only. See the class doc for the full per-dimension rule.
 */
interface DimensionDelta {
  dimension: VideoRoomRankingDimension;
  member: string;
  delta: number;
  attributionUserId?: string;
}

/**
 * The VR-13 write path: turn a domain event into ZSET increments.
 *
 * Four invariants hold for every method here.
 *
 * 1. **Dedupe claimed only for real work.** Every source event has a natural
 *    id; the first thing any record* method does after computing its deltas is
 *    claim that id — but ONLY once there is at least one non-zero delta to
 *    apply. An event that produces no work (e.g. a PK result with an empty
 *    outcomes list) never burns its dedupe marker, so a later redelivery
 *    carrying real outcomes is not silently dropped. A redelivered event that
 *    DOES have work must not move a ladder twice, and ZINCRBY has no
 *    idempotency of its own — hence the claim.
 *
 * 2. **One batched write.** A single gift touches 5 periods × up to 4 scopes ×
 *    up to 4 dimensions. Issued individually that is ~80 round trips on the hot
 *    path of every gift on the platform; issued as one pipeline it is one.
 *    Version bumps are pipelined the same way via `bumpVersionMany`.
 *
 * 3. **Never throw.** Every method swallows and logs. The caller is a listener
 *    reacting to money that has ALREADY moved — a gift is delivered, a PK is
 *    settled, a treasure is paid. Throwing here cannot undo any of that; it can
 *    only poison the bus for the other subscribers. Anything lost is restored
 *    by the recompute pass. Every message interpolated into a log line inside
 *    a catch block goes through `errorMessage`, never a bare
 *    `(err as Error).message` — a subscriber that rejects with `undefined` (a
 *    bare `throw undefined` or an empty `Promise.reject()`) would otherwise
 *    throw a NEW TypeError from inside the catch itself, escaping this class
 *    and poisoning the whole event delivery for every other subscriber on the
 *    bus — exactly the outcome invariant 3 exists to prevent.
 *
 * 4. **Geography is resolved PER DIMENSION, matching the recompute.** One
 *    event can carry deltas for several different people (a gift's sender AND
 *    receiver), and each delta's country/city ladders must reflect ITS OWN
 *    user, not the event's primary actor:
 *      - `gifters`             → the SENDER's geography
 *      - `receivers` / `hosts` → the RECEIVER's geography
 *      - `rooms`               → global + room ONLY, never country/city — a
 *                                room has no geography of its own, and the
 *                                recompute pass (which loads room rows via
 *                                `aggregateGiftCoinsByRoom`, a query with no
 *                                `userId` column) can never partition them by
 *                                one either, so the incremental path must not
 *                                either or the two would permanently disagree.
 *      - `pk` / `treasure`     → the scored user's own geography where a
 *                                single user is attributable; otherwise global
 *                                + room only.
 *    Getting this wrong makes "top hosts in India" mean "hosts funded by
 *    Indian gifters" instead of "hosts who live in India" — silently and
 *    permanently, since the recompute pass would keep disagreeing with it.
 */
@Injectable()
export class VideoRoomRankingService {
  private readonly logger = new Logger(VideoRoomRankingService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    private readonly scoring: VideoRoomRankingScoreEngine,
    private readonly scopes: VideoRoomRankingScopeResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  async recordGift(input: GiftRankingInput): Promise<void> {
    await this.record('gift', input.transactionId, input.roomId, input.occurredAt, () =>
      this.giftDeltas(input, 1),
    );
  }

  /**
   * A refund reverses a gift. It carries its OWN dedupe marker rather than
   * reusing the gift's: the gift marker is already claimed, so sharing it would
   * make every refund a silent no-op.
   */
  async recordGiftRefund(input: GiftRankingInput): Promise<void> {
    await this.record('gift-refund', input.transactionId, input.roomId, input.occurredAt, () =>
      this.giftDeltas(input, -1),
    );
  }

  private giftDeltas(input: GiftRankingInput, sign: 1 | -1): DimensionDelta[] {
    const coins = input.totalCoinValue;
    const deltas: DimensionDelta[] = [
      {
        dimension: VideoRoomRankingDimension.GIFTERS,
        member: input.senderId,
        attributionUserId: input.senderId,
        delta:
          sign * this.scoring.deltaFor(VideoRoomRankingDimension.GIFTERS, { coinsSpent: coins }),
      },
      {
        dimension: VideoRoomRankingDimension.RECEIVERS,
        member: input.receiverId,
        attributionUserId: input.receiverId,
        delta:
          sign *
          this.scoring.deltaFor(VideoRoomRankingDimension.RECEIVERS, { coinsReceived: coins }),
      },
      {
        dimension: VideoRoomRankingDimension.ROOMS,
        member: input.roomId,
        // No attributionUserId: a room has no geography of its own — see the
        // class doc's invariant 4.
        delta: sign * this.scoring.deltaFor(VideoRoomRankingDimension.ROOMS, { giftCoins: coins }),
      },
    ];

    // A receiver who is not on a seat is a spectator being tipped, not a host.
    if (input.receiverIsSeated) {
      deltas.push({
        dimension: VideoRoomRankingDimension.HOSTS,
        member: input.receiverId,
        attributionUserId: input.receiverId,
        delta:
          sign *
          this.scoring.deltaFor(VideoRoomRankingDimension.HOSTS, {
            coins,
            gifts: input.quantity,
          }),
      });
    }
    return deltas;
  }

  async recordPkResult(input: PkRankingInput): Promise<void> {
    await this.record('pk', input.battleId, input.roomId, input.occurredAt, () =>
      input.outcomes.map((o) => ({
        dimension: VideoRoomRankingDimension.PK,
        member: o.userId,
        // Each outcome scores its OWN user — this is already per-delta, not a
        // single event-wide attribution.
        attributionUserId: o.userId,
        delta: this.scoring.deltaFor(VideoRoomRankingDimension.PK, {
          wins: o.won ? 1 : 0,
          losses: o.lost ? 1 : 0,
          score: o.score,
        }),
      })),
    );
  }

  async recordTreasureWin(input: TreasureRankingInput): Promise<void> {
    await this.record('treasure', input.rewardId, input.roomId, input.occurredAt, () => [
      {
        dimension: VideoRoomRankingDimension.TREASURE,
        member: input.userId,
        attributionUserId: input.userId,
        delta: this.scoring.deltaFor(VideoRoomRankingDimension.TREASURE, {
          treasureCoins: input.amount,
        }),
      },
    ]);
  }

  async recordRoomActivity(input: RoomActivityInput): Promise<void> {
    await this.record('room-activity', input.activityId, input.roomId, input.occurredAt, () => [
      {
        dimension: VideoRoomRankingDimension.ROOMS,
        member: input.roomId,
        // No attributionUserId — a room tick has no user at all.
        delta: this.scoring.deltaFor(VideoRoomRankingDimension.ROOMS, {
          peakViewers: input.peakViewers,
          avgWatchSeconds: input.avgWatchSeconds,
          pkCount: input.pkCount,
          treasureCount: input.treasureCount,
        }),
      },
    ]);
  }

  /**
   * The shared pipeline: gate → build deltas → (no-op short-circuit) →
   * dedupe → resolve per-dimension scopes → expand to keys → one batched
   * write → bump versions (one pipeline) → publish (concurrently).
   *
   * Deltas are built and filtered to non-zero BEFORE the dedupe marker is
   * claimed, and an empty result returns without ever calling `markSeen` —
   * see the class doc's invariant 1. `naturalId`/`source` identify the event
   * for logging and for the dedupe marker; `roomId` always contributes the
   * room scope, since every VR-13 source event happens in a room.
   */
  private async record(
    source: string,
    naturalId: string,
    roomId: string,
    occurredAt: Date,
    buildDeltas: () => DimensionDelta[],
  ): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const deltas = buildDeltas().filter((d) => d.delta !== 0);
      if (deltas.length === 0) return;

      const fresh = await this.store.markSeen(
        this.ns,
        source,
        naturalId,
        this.config.dedupeTtlSeconds,
      );
      if (!fresh) {
        this.logger.debug(`${source}:${naturalId} already applied — skipping`);
        return;
      }

      // Resolve every attributed user's geography in ONE batched call rather
      // than once per delta — a gift has at most two distinct users (sender,
      // receiver), a PK result has as many as the battle had participants,
      // but this is always a single `geoForMany` round trip regardless.
      const attributedUserIds = [
        ...new Set(
          deltas.map((d) => d.attributionUserId).filter((id): id is string => Boolean(id)),
        ),
      ];
      const geo =
        attributedUserIds.length > 0
          ? await this.scopes.geoForMany(attributedUserIds)
          : new Map<string, UserGeo>();

      const increments: LeaderboardIncrement[] = [];
      // Keyed on a delimiter-free encoding (JSON, not `${scope}|${dimension}`)
      // so a city id containing `|` — city is user-editable free text — can
      // never collapse two distinct version keys onto one.
      const touched = new Map<string, { scope: string; dimension: string }>();

      for (const { dimension, member, delta, attributionUserId } of deltas) {
        const scopes = this.scopesForDelta(attributionUserId, roomId, geo);
        for (const scope of scopes) {
          const isRoomScoped = parseScope(scope)?.kind === 'room';
          touched.set(JSON.stringify([scope, dimension]), { scope, dimension });
          for (const period of VIDEO_ROOM_RANKING_HOT_PERIODS) {
            increments.push({
              key: this.store.key(
                this.ns,
                scope,
                dimension,
                period,
                this.periods.dateKeyFor(period, occurredAt),
              ),
              member,
              delta,
              // Room ladders expire so an ended room stops consuming memory.
              // Global/country/city ladders are snapshotted and TTL'd by the
              // aggregation job instead, never by a write.
              ...(isRoomScoped ? { ttlSeconds: this.config.roomLadderTtlSeconds } : {}),
            });
          }
        }
      }

      await this.store.incrementMany(increments);

      // Invalidate every cached page of every ladder this write moved — one
      // pipeline rather than one INCR per touched scope+dimension pair.
      await this.store.bumpVersionMany(this.ns, [...touched.values()]);

      await this.publishMovements(deltas, roomId, occurredAt, source, naturalId);
    } catch (err) {
      // Deliberately swallowed — see the class doc's invariant 3. Uses
      // `errorMessage`, not a bare `(err as Error).message`, because this
      // catch's entire purpose is to never itself throw.
      this.logger.error(`ranking write failed for ${source}:${naturalId}: ${errorMessage(err)}`);
    }
  }

  /**
   * Resolve one delta's scope list: always global and the event's room, plus
   * the attributed user's country/city when one is attributable. See the
   * class doc's invariant 4 for which user backs which dimension.
   */
  private scopesForDelta(
    attributionUserId: string | undefined,
    roomId: string,
    geo: Map<string, UserGeo>,
  ): string[] {
    const scopes = [scopeGlobal()];
    if (attributionUserId) {
      const g = geo.get(attributionUserId);
      if (g?.country) scopes.push(scopeCountry(g.country));
      if (g?.city) scopes.push(scopeCity(g.city));
    }
    scopes.push(scopeRoom(roomId));
    return scopes;
  }

  /**
   * Announce movement per dimension, one event per distinct dimension in the
   * batch. Published CONCURRENTLY with `Promise.allSettled` rather than
   * sequential `await`s: a socket-bridge subscriber that rejects on the first
   * publish must not prevent the other three dimensions' events from ever
   * firing, and must not be mistaken for a write failure — the ZSET write
   * already committed by the time this runs, so a publish failure is logged
   * distinctly from `record`'s "ranking write failed". The socket listener
   * itself coalesces these into at most one broadcast per room per window, so
   * publishing one event per dimension here is safe even during a gift storm.
   */
  private async publishMovements(
    deltas: DimensionDelta[],
    roomId: string,
    occurredAt: Date,
    source: string,
    naturalId: string,
  ): Promise<void> {
    const daily: RankingPeriodName = 'daily';
    const dateKey = this.periods.dateKeyFor(daily, occurredAt);
    const seen = new Set<VideoRoomRankingDimension>();
    const events: DomainEvent<RankingMovementPayload>[] = [];

    for (const { dimension } of deltas) {
      if (seen.has(dimension)) continue;
      seen.add(dimension);

      const payload: RankingMovementPayload = {
        scope: scopeRoom(roomId),
        dimension,
        period: daily,
        dateKey,
        roomId,
        entries: [],
      };

      events.push(this.movementEventFor(dimension, payload));
    }

    const results = await Promise.allSettled(events.map((e) => this.bus.publish(e)));
    for (const result of results) {
      if (result.status === 'rejected') {
        // Distinct from "ranking write failed": the ZSET write already
        // committed. This is a subscriber problem, not a data-loss one.
        this.logger.error(
          `ranking publish failed for ${source}:${naturalId}: ${errorMessage(result.reason)}`,
        );
      }
    }
  }

  /** Dimension → the domain event announcing its movement. */
  private movementEventFor(
    dimension: VideoRoomRankingDimension,
    payload: RankingMovementPayload,
  ): DomainEvent<RankingMovementPayload> {
    switch (dimension) {
      case VideoRoomRankingDimension.HOSTS:
        return new HostRankingUpdatedEvent(payload);
      case VideoRoomRankingDimension.GIFTERS:
        return new GifterRankingUpdatedEvent(payload);
      case VideoRoomRankingDimension.ROOMS:
        return new RoomRankingUpdatedEvent(payload);
      case VideoRoomRankingDimension.PK:
        return new PKRankingUpdatedEvent(payload);
      case VideoRoomRankingDimension.TREASURE:
        return new TreasureRankingUpdatedEvent(payload);
      default:
        return new RankingUpdatedEvent(payload);
    }
  }
}
