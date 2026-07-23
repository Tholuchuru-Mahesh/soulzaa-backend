import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { REFERRAL_CONFIG_KEYS } from '../constants/referral.constants';

@Injectable()
export class ReferralConfigurationService {
  private readonly logger = new Logger(ReferralConfigurationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const record = await this.prisma.referralConfiguration.findUnique({
      where: { key },
    });
    if (!record) return defaultValue as T;
    return record.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.referralConfiguration.upsert({
      where: { key },
      create: { key, value: value as any },
      update: { value: value as any },
    });
    this.logger.log(`Config updated: ${key}`);
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.referralConfiguration.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async getDefaultExpiryDays(): Promise<number> {
    return this.get<number>(REFERRAL_CONFIG_KEYS.DEFAULT_EXPIRY_DAYS, 30);
  }

  async getMaxUses(): Promise<number> {
    return this.get<number>(REFERRAL_CONFIG_KEYS.MAX_USES, 100);
  }

  async isSelfReferralAllowed(): Promise<boolean> {
    return this.get<boolean>(REFERRAL_CONFIG_KEYS.SELF_REFERRAL_ALLOWED, false);
  }

  async getQualificationTimeoutDays(): Promise<number> {
    return this.get<number>(REFERRAL_CONFIG_KEYS.QUALIFICATION_TIMEOUT, 7);
  }
}
