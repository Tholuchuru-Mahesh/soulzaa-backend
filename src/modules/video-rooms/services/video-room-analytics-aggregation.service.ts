import { Injectable, Logger } from '@nestjs/common';
import { AggregationException } from '../exceptions/video-room-analytics.exception';
import { VideoRoomAnalyticsMetrics } from '../metrics/video-room-analytics.metrics';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomAnalyticsAuditService } from './video-room-analytics-audit.service';
import { VideoRoomAnalyticsCacheService } from './video-room-analytics-cache.service';

export interface AggregationResult {
  period: string;
  dateKey: string;
  processedMetrics: number;
  durationMs: number;
}

@Injectable()
export class VideoRoomAnalyticsAggregationService {
  private readonly logger = new Logger(VideoRoomAnalyticsAggregationService.name);

  constructor(
    private readonly repository: VideoRoomAnalyticsProjectionRepository,
    private readonly cacheService: VideoRoomAnalyticsCacheService,
    private readonly auditService: VideoRoomAnalyticsAuditService,
    private readonly metrics: VideoRoomAnalyticsMetrics,
  ) {}

  private getDateKey(date: Date = new Date()): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  async aggregateHourly(dateKey?: string): Promise<AggregationResult> {
    const startMs = Date.now();
    const targetDateKey = dateKey || `${this.getDateKey()}${new Date().getUTCHours()}`;

    try {
      const live = await this.cacheService.getLiveActiveMetrics();

      await this.repository.upsertAnalyticsStatistics({
        period: 'HOURLY',
        dateKey: targetDateKey,
        metricType: 'ACTIVE_ROOMS',
        count: live.activeRooms,
      });

      await this.repository.upsertAnalyticsStatistics({
        period: 'HOURLY',
        dateKey: targetDateKey,
        metricType: 'ACTIVE_HOSTS',
        count: live.activeHosts,
      });

      await this.repository.upsertAnalyticsStatistics({
        period: 'HOURLY',
        dateKey: targetDateKey,
        metricType: 'ACTIVE_VIEWERS',
        count: live.activeViewers,
      });

      const durationMs = Date.now() - startMs;
      this.metrics.observeAggregationDuration('HOURLY', durationMs / 1000);

      await this.auditService.logAudit({
        action: 'ANALYTICS_HOURLY_AGGREGATION',
        details: { dateKey: targetDateKey, metrics: live },
        executionTimeMs: durationMs,
      });

      return {
        period: 'HOURLY',
        dateKey: targetDateKey,
        processedMetrics: 3,
        durationMs,
      };
    } catch (err: any) {
      this.metrics.incFailure('HOURLY_AGGREGATION');
      this.logger.error(`Hourly aggregation failed: ${err.message}`, err.stack);
      throw new AggregationException(`Hourly aggregation failed: ${err.message}`);
    }
  }

  async aggregateDaily(dateKey?: string): Promise<AggregationResult> {
    const startMs = Date.now();
    const targetDateKey = dateKey || this.getDateKey();

    try {
      const live = await this.cacheService.getLiveActiveMetrics();

      await this.repository.upsertAnalyticsStatistics({
        period: 'DAILY',
        dateKey: targetDateKey,
        metricType: 'PEAK_ROOMS',
        count: live.activeRooms,
      });

      await this.repository.upsertAnalyticsStatistics({
        period: 'DAILY',
        dateKey: targetDateKey,
        metricType: 'PEAK_VIEWERS',
        count: live.activeViewers,
      });

      await this.createHistoricalSnapshot('video_room', 'daily_active_rooms', live.activeRooms);
      await this.createHistoricalSnapshot('video_room', 'daily_active_viewers', live.activeViewers);

      const durationMs = Date.now() - startMs;
      this.metrics.observeAggregationDuration('DAILY', durationMs / 1000);

      await this.auditService.logAudit({
        action: 'ANALYTICS_DAILY_AGGREGATION',
        details: { dateKey: targetDateKey, metrics: live },
        executionTimeMs: durationMs,
      });

      return {
        period: 'DAILY',
        dateKey: targetDateKey,
        processedMetrics: 2,
        durationMs,
      };
    } catch (err: any) {
      this.metrics.incFailure('DAILY_AGGREGATION');
      this.logger.error(`Daily aggregation failed: ${err.message}`, err.stack);
      throw new AggregationException(`Daily aggregation failed: ${err.message}`);
    }
  }

  async aggregateWeekly(dateKey?: string): Promise<AggregationResult> {
    const startMs = Date.now();
    const targetDateKey = dateKey || `${this.getDateKey()}W`;

    try {
      const live = await this.cacheService.getLiveActiveMetrics();

      await this.repository.upsertAnalyticsStatistics({
        period: 'WEEKLY',
        dateKey: targetDateKey,
        metricType: 'WEEKLY_ACTIVE_ROOMS',
        count: live.activeRooms,
      });

      const durationMs = Date.now() - startMs;
      this.metrics.observeAggregationDuration('WEEKLY', durationMs / 1000);

      await this.auditService.logAudit({
        action: 'ANALYTICS_WEEKLY_AGGREGATION',
        details: { dateKey: targetDateKey },
        executionTimeMs: durationMs,
      });

      return {
        period: 'WEEKLY',
        dateKey: targetDateKey,
        processedMetrics: 1,
        durationMs,
      };
    } catch (err: any) {
      this.metrics.incFailure('WEEKLY_AGGREGATION');
      this.logger.error(`Weekly aggregation failed: ${err.message}`);
      throw new AggregationException(`Weekly aggregation failed: ${err.message}`);
    }
  }

  async aggregateMonthly(dateKey?: string): Promise<AggregationResult> {
    const startMs = Date.now();
    const date = new Date();
    const targetDateKey =
      dateKey || `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

    try {
      const live = await this.cacheService.getLiveActiveMetrics();

      await this.repository.upsertAnalyticsStatistics({
        period: 'MONTHLY',
        dateKey: targetDateKey,
        metricType: 'MONTHLY_ACTIVE_ROOMS',
        count: live.activeRooms,
      });

      const durationMs = Date.now() - startMs;
      this.metrics.observeAggregationDuration('MONTHLY', durationMs / 1000);

      await this.auditService.logAudit({
        action: 'ANALYTICS_MONTHLY_AGGREGATION',
        details: { dateKey: targetDateKey },
        executionTimeMs: durationMs,
      });

      return {
        period: 'MONTHLY',
        dateKey: targetDateKey,
        processedMetrics: 1,
        durationMs,
      };
    } catch (err: any) {
      this.metrics.incFailure('MONTHLY_AGGREGATION');
      this.logger.error(`Monthly aggregation failed: ${err.message}`);
      throw new AggregationException(`Monthly aggregation failed: ${err.message}`);
    }
  }

  async createHistoricalSnapshot(domain: string, metricKey: string, metricValue: number) {
    const snapshot = await this.repository.createSnapshot({
      domain,
      metricKey,
      metricValue,
    });

    await this.auditService.logAudit({
      action: 'ANALYTICS_SNAPSHOT_CREATED',
      details: { domain, metricKey, metricValue, snapshotId: snapshot.id },
    });

    return snapshot;
  }

  async refreshCache(): Promise<void> {
    const live = await this.cacheService.getLiveActiveMetrics();
    await this.cacheService.setCachedAnalytics('global', 'LIVE', live, 60);

    await this.auditService.logAudit({
      action: 'ANALYTICS_CACHE_REFRESHED',
      details: { live },
    });
  }
}
