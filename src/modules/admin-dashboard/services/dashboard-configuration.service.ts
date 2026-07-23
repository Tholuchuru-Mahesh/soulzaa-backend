import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { DASHBOARD_CONFIG_KEYS } from '../constants/dashboard.constants';

@Injectable()
export class DashboardConfigurationService {
  private readonly logger = new Logger(DashboardConfigurationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const record = await this.prisma.dashboardConfiguration.findUnique({
      where: { key },
    });
    if (!record) return defaultValue as T;
    return record.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.dashboardConfiguration.upsert({
      where: { key },
      create: { key, value: value as any },
      update: { value: value as any },
    });
    this.logger.log(`Config updated: ${key}`);
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.dashboardConfiguration.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async getRefreshInterval(): Promise<number> {
    return this.get<number>(DASHBOARD_CONFIG_KEYS.REFRESH_INTERVAL, 30); // seconds
  }

  async getDefaultLayout(): Promise<string> {
    return this.get<string>(DASHBOARD_CONFIG_KEYS.DEFAULT_LAYOUT, 'GRID_3X3');
  }

  async getWidgetLimit(): Promise<number> {
    return this.get<number>(DASHBOARD_CONFIG_KEYS.WIDGET_LIMIT, 20);
  }

  async getExportLimit(): Promise<number> {
    return this.get<number>(DASHBOARD_CONFIG_KEYS.EXPORT_LIMIT, 1000);
  }

  async getCacheTtl(): Promise<number> {
    return this.get<number>(DASHBOARD_CONFIG_KEYS.CACHE_TTL, 60); // seconds
  }
}
