import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface RevenueSplitConfig {
  hostPercentage: number;
  platformPercentage: number;
  agencyPercentage: number;
  referralPercentage: number;
  coinSellerPercentage: number;
  minimumPayout: number;
}

@Injectable()
export class RevenueConfigurationService {
  private readonly logger = new Logger(RevenueConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves the active revenue split configuration from Platform Configuration Service.
   * Defaults to 50% Host, 50% Platform if unconfigured.
   */
  async getRevenueSplitConfig(): Promise<RevenueSplitConfig> {
    try {
      const hostPct = (await this.platformConfig.get<number>('host.revenue_percentage')) ?? 50.0;
      const platformPct =
        (await this.platformConfig.get<number>('platform.revenue_percentage')) ?? 50.0;
      const agencyPct = (await this.platformConfig.get<number>('future.agency_percentage')) ?? 0.0;
      const referralPct =
        (await this.platformConfig.get<number>('future.referral_percentage')) ?? 0.0;
      const sellerPct =
        (await this.platformConfig.get<number>('future.coin_seller_percentage')) ?? 0.0;
      const minPayout = (await this.platformConfig.get<number>('minimum_payout')) ?? 1;

      return {
        hostPercentage: hostPct,
        platformPercentage: platformPct,
        agencyPercentage: agencyPct,
        referralPercentage: referralPct,
        coinSellerPercentage: sellerPct,
        minimumPayout: minPayout,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch dynamic revenue config, using 50/50 fallback: ${(err as Error).message}`,
      );
      return {
        hostPercentage: 50.0,
        platformPercentage: 50.0,
        agencyPercentage: 0.0,
        referralPercentage: 0.0,
        coinSellerPercentage: 0.0,
        minimumPayout: 1,
      };
    }
  }

  /**
   * Upsert revenue configuration parameter (Admin path).
   */
  async updateConfigParameter(key: string, value: any) {
    return this.prisma.revenueConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
