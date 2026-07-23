import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NOTIFICATION_CONFIG_KEYS } from '../constants/notification-center.constants';

@Injectable()
export class NotificationConfigurationService {
  private readonly logger = new Logger(NotificationConfigurationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const record = await this.prisma.notificationConfiguration.findUnique({
      where: { key },
    });
    if (!record) return defaultValue as T;
    return record.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.notificationConfiguration.upsert({
      where: { key },
      create: { key, value: value as any },
      update: { value: value as any },
    });
    this.logger.log(`Config updated: ${key}`);
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.notificationConfiguration.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async getRetryCount(): Promise<number> {
    return this.get<number>(NOTIFICATION_CONFIG_KEYS.RETRY_COUNT, 3);
  }

  async getDefaultChannel(): Promise<string> {
    return this.get<string>(NOTIFICATION_CONFIG_KEYS.DEFAULT_CHANNEL, 'IN_APP');
  }

  async getRetentionDays(): Promise<number> {
    return this.get<number>(NOTIFICATION_CONFIG_KEYS.RETENTION_DAYS, 30);
  }

  async getBatchSize(): Promise<number> {
    return this.get<number>(NOTIFICATION_CONFIG_KEYS.BATCH_SIZE, 100);
  }

  async getBroadcastLimit(): Promise<number> {
    return this.get<number>(NOTIFICATION_CONFIG_KEYS.BROADCAST_LIMIT, 5);
  }
}
