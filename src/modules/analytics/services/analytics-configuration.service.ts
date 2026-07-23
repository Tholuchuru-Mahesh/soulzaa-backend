import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ANALYTICS_CONFIG_KEYS } from '../constants/analytics-engine.constants';

@Injectable()
export class AnalyticsConfigurationService {
  private readonly logger = new Logger(AnalyticsConfigurationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const record = await this.prisma.analyticsConfiguration.findUnique({
      where: { key },
    });
    if (!record) return defaultValue as T;
    return record.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.analyticsConfiguration.upsert({
      where: { key },
      create: { key, value: value as any },
      update: { value: value as any },
    });
    this.logger.log(`Config updated: ${key}`);
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.analyticsConfiguration.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async getSnapshotInterval(): Promise<number> {
    return this.get<number>(ANALYTICS_CONFIG_KEYS.SNAPSHOT_INTERVAL, 60); // minutes
  }

  async getRetentionDays(): Promise<number> {
    return this.get<number>(ANALYTICS_CONFIG_KEYS.RETENTION_DAYS, 90);
  }

  async getExportLimit(): Promise<number> {
    return this.get<number>(ANALYTICS_CONFIG_KEYS.EXPORT_LIMIT, 5000);
  }

  async getDefaultTimezone(): Promise<string> {
    return this.get<string>(ANALYTICS_CONFIG_KEYS.DEFAULT_TIMEZONE, 'UTC');
  }

  async getCacheTtl(): Promise<number> {
    return this.get<number>(ANALYTICS_CONFIG_KEYS.CACHE_TTL, 300); // seconds
  }
}
