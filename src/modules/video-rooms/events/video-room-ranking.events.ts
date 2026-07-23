import { DomainEvent } from 'src/common/events';

/**
 * VR-13 ranking events.
 *
 * Deliberately NOT re-declared here: `gift.sent`, `video_room.pk.*` and
 * `video_room.treasure.*` are published by their owning engines and CONSUMED by
 * this module. Re-publishing any of them would fire every existing listener a
 * second time — notifications, EXP, the platform rankings module and the socket
 * bridges all subscribe to them. These nine names are outputs only.
 */
export const VIDEO_ROOM_RANKING_EVENTS = {
  RANKING_UPDATED: 'video_room.ranking.updated',
  LEADERBOARD_UPDATED: 'video_room.leaderboard.updated',
  HOST_RANKING_UPDATED: 'video_room.ranking.host_updated',
  ROOM_RANKING_UPDATED: 'video_room.ranking.room_updated',
  GIFTER_RANKING_UPDATED: 'video_room.ranking.gifter_updated',
  PK_RANKING_UPDATED: 'video_room.ranking.pk_updated',
  TREASURE_RANKING_UPDATED: 'video_room.ranking.treasure_updated',
  AGGREGATED: 'video_room.ranking.aggregated',
  SNAPSHOT_CREATED: 'video_room.ranking.snapshot_created',
} as const;

/**
 * One ladder position as broadcast. `score` is a number, not BigInt: this
 * crosses the wire and BigInt has no JSON representation.
 */
export interface RankingEntryView {
  targetId: string;
  rank: number;
  score: number;
}

/** Every ranking event is addressable by its ladder coordinates. */
export interface RankingEventBase {
  scope: string;
  dimension: string;
  period: string;
  dateKey: string;
  /** Present when the ladder is room-scoped — the socket bridge routes on it. */
  roomId?: string;
  /** The originating HTTP request id, when a request caused this. */
  requestId?: string;
}

export type RankingMovementPayload = RankingEventBase & { entries: RankingEntryView[] };

export class RankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED;
}

export class LeaderboardUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED;
}

export class HostRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED;
}

export class RoomRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED;
}

export class GifterRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED;
}

export class PKRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED;
}

export class TreasureRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED;
}

/** A recompute finished. Consumed by the metrics and audit listeners. */
export class RankingAggregatedEvent extends DomainEvent<
  RankingEventBase & { entriesWritten: number; sourceRows: number; durationMs: number }
> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.AGGREGATED;
}

/** A ladder was persisted at period close. */
export class RankingSnapshotCreatedEvent extends DomainEvent<
  RankingEventBase & { entriesWritten: number; totalEntries: number; durationMs: number }
> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED;
}
