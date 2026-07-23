import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface CoinSellerCommissionConfig {
  commissionPercentage: number;
  masterSellerPercentage: number;
  regionalSellerPercentage: number;
  minimumCommission: number;
}

@Injectable()
export class CoinSellerConfigurationService {
  private readonly logger = new Logger(CoinSellerConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves active seller commission config from Platform Configuration.
   * Defaults to 5.0% if unconfigured.
   */
  async getCommissionConfig(): Promise<CoinSellerCommissionConfig> {
    try {
      const commissionPct =
        (await this.platformConfig.get<number>('seller.commission_percentage')) ?? 5.0;
      const masterPct =
        (await this.platformConfig.get<number>('future.master_seller_percentage')) ?? 0.0;
      const regionalPct =
        (await this.platformConfig.get<number>('future.regional_seller_percentage')) ?? 0.0;
      const minComm = (await this.platformConfig.get<number>('seller.minimum_commission')) ?? 1;

      return {
        commissionPercentage: commissionPct,
        masterSellerPercentage: masterPct,
        regionalSellerPercentage: regionalPct,
        minimumCommission: minComm,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch dynamic seller config, using 5% fallback: ${(err as Error).message}`,
      );
      return {
        commissionPercentage: 5.0,
        masterSellerPercentage: 0.0,
        regionalSellerPercentage: 0.0,
        minimumCommission: 1,
      };
    }
  }

  /**
   * Upsert coin seller configuration parameter (Admin path).
   */
  async updateConfigParameter(key: string, value: any) {
    return this.prisma.coinSellerConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
