import { DomainEvent } from 'src/common/events';

export const VIDEO_ROOM_ANALYTICS_EVENTS = {
  ANALYTICS_UPDATED: 'video_room.analytics_updated',
  ANALYTICS_AGGREGATED: 'video_room.analytics_aggregated',
  SNAPSHOT_CREATED: 'video_room.analytics_snapshot_created',
} as const;

export const VIDEO_ROOM_ANALYTICS_SOCKET_EVENTS = {
  ANALYTICS_UPDATED: 'analyticsUpdated',
  ROOM_ANALYTICS_UPDATED: 'roomAnalyticsUpdated',
} as const;

export class AnalyticsUpdatedEvent extends DomainEvent<{
  roomId?: string;
  data: unknown;
}> {
  readonly name = VIDEO_ROOM_ANALYTICS_EVENTS.ANALYTICS_UPDATED;
}

export class AnalyticsAggregatedEvent extends DomainEvent<{
  period: string;
  dateKey: string;
  processedMetrics: number;
}> {
  readonly name = VIDEO_ROOM_ANALYTICS_EVENTS.ANALYTICS_AGGREGATED;
}

export class AnalyticsSnapshotCreatedEvent extends DomainEvent<{
  domain: string;
  metricKey: string;
  metricValue: number;
}> {
  readonly name = VIDEO_ROOM_ANALYTICS_EVENTS.SNAPSHOT_CREATED;
}
