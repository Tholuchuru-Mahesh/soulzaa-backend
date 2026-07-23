import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface WithdrawalConfig {
  minimumAmountCoins: number;
  maximumAmountCoins: number;
  dailyLimitCoins: number;
  monthlyLimitCoins: number;
  processingFeeCoins: number;
  taxPercentage: number;
}

@Injectable()
export class WithdrawalConfigurationService {
  private readonly logger = new Logger(WithdrawalConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves active withdrawal configuration from Platform Configuration.
   */
  async getWithdrawalConfig(): Promise<WithdrawalConfig> {
    try {
      const minAmt = (await this.platformConfig.get<number>('withdrawal.minimum')) ?? 1000;
      const maxAmt = (await this.platformConfig.get<number>('withdrawal.maximum')) ?? 100000;
      const dailyLim = (await this.platformConfig.get<number>('withdrawal.daily_limit')) ?? 200000;
      const monthlyLim =
        (await this.platformConfig.get<number>('withdrawal.monthly_limit')) ?? 1000000;
      const fee = (await this.platformConfig.get<number>('withdrawal.processing_fee')) ?? 0;
      const tax = (await this.platformConfig.get<number>('withdrawal.tax_percentage')) ?? 0.0;

      return {
        minimumAmountCoins: minAmt,
        maximumAmountCoins: maxAmt,
        dailyLimitCoins: dailyLim,
        monthlyLimitCoins: monthlyLim,
        processingFeeCoins: fee,
        taxPercentage: tax,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch dynamic withdrawal config, using fallbacks: ${(err as Error).message}`,
      );
      return {
        minimumAmountCoins: 1000,
        maximumAmountCoins: 100000,
        dailyLimitCoins: 200000,
        monthlyLimitCoins: 1000000,
        processingFeeCoins: 0,
        taxPercentage: 0.0,
      };
    }
  }

  /**
   * Upsert withdrawal configuration parameter (Admin path).
   */
  async updateConfigParameter(key: string, value: any) {
    return this.prisma.withdrawalConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
