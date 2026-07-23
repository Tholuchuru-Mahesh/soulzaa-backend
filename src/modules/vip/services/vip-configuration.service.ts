import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface VipConfig {
  maxLevel: number;
  defaultDurationDays: number;
  autoRenew: boolean;
  rewardResetTime: string;
  maxDiscountLimit: number;
}

@Injectable()
export class VipConfigurationService {
  private readonly logger = new Logger(VipConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves dynamic VIP configuration parameters from Platform Configuration Engine.
   */
  async getVipConfig(): Promise<VipConfig> {
    try {
      const maxLvl = (await this.platformConfig.get<number>('vip.max_level')) ?? 10;
      const duration = (await this.platformConfig.get<number>('vip.default_duration')) ?? 30;
      const autoRenew = (await this.platformConfig.get<boolean>('vip.auto_renew')) ?? false;
      const resetTime = (await this.platformConfig.get<string>('vip.reward_reset')) ?? '00:00:00';
      const limit = (await this.platformConfig.get<number>('vip.discount_limits')) ?? 20.0;

      return {
        maxLevel: maxLvl,
        defaultDurationDays: duration,
        autoRenew,
        rewardResetTime: resetTime,
        maxDiscountLimit: limit,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch dynamic VIP config, using fallbacks: ${(err as Error).message}`,
      );
      return {
        maxLevel: 10,
        defaultDurationDays: 30,
        autoRenew: false,
        rewardResetTime: '00:00:00',
        maxDiscountLimit: 20.0,
      };
    }
  }

  /**
   * Upsert VIP configuration parameter (Admin path).
   */
  async updateConfigParameter(key: string, value: any) {
    return this.prisma.vipConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
