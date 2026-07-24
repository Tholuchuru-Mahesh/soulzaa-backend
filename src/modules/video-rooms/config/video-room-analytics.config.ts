import { registerAs } from '@nestjs/config';

export interface VideoRoomAnalyticsConfig {
  cacheTtlSeconds: number;
  aggregatedCacheTtlSeconds: number;
  trendingCacheTtlSeconds: number;
  aggregationBatchSize: number;
  snapshotRetentionDays: number;
  cleanupIntervalSeconds: number;
}

export const loadVideoRoomAnalyticsConfig = (config: {
  get: (key: string, options?: { infer: true }) => any;
}): VideoRoomAnalyticsConfig => {
  const over = config.get('videoRoomAnalytics', { infer: true }) as
    Partial<VideoRoomAnalyticsConfig> | undefined;

  return {
    cacheTtlSeconds: Number(over?.cacheTtlSeconds) || 3600,
    aggregatedCacheTtlSeconds: Number(over?.aggregatedCacheTtlSeconds) || 300,
    trendingCacheTtlSeconds: Number(over?.trendingCacheTtlSeconds) || 60,
    aggregationBatchSize: Number(over?.aggregationBatchSize) || 100,
    snapshotRetentionDays: Number(over?.snapshotRetentionDays) || 30,
    cleanupIntervalSeconds: Number(over?.cleanupIntervalSeconds) || 86400,
  };
};

export const videoRoomAnalyticsConfig = registerAs(
  'videoRoomAnalytics',
  (): VideoRoomAnalyticsConfig => ({
    cacheTtlSeconds: Number(process.env.VIDEO_ROOM_ANALYTICS_CACHE_TTL) || 3600,
    aggregatedCacheTtlSeconds: Number(process.env.VIDEO_ROOM_ANALYTICS_AGGREGATED_CACHE_TTL) || 300,
    trendingCacheTtlSeconds: Number(process.env.VIDEO_ROOM_ANALYTICS_TRENDING_CACHE_TTL) || 60,
    aggregationBatchSize: Number(process.env.VIDEO_ROOM_ANALYTICS_BATCH_SIZE) || 100,
    snapshotRetentionDays: Number(process.env.VIDEO_ROOM_ANALYTICS_RETENTION_DAYS) || 30,
    cleanupIntervalSeconds: Number(process.env.VIDEO_ROOM_ANALYTICS_CLEANUP_INTERVAL) || 86400,
  }),
);
