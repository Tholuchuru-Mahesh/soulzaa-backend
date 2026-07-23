import { Injectable, Logger } from '@nestjs/common';
import { RevenueConfigurationService, RevenueSplitConfig } from './revenue-configuration.service';

export interface CalculatedRevenueSplit {
  totalCoinValue: bigint;
  hostPercentage: number;
  platformPercentage: number;
  hostEarningsCoins: bigint;
  platformEarningsCoins: bigint;
}

@Injectable()
export class RevenueCalculationService {
  private readonly logger = new Logger(RevenueCalculationService.name);

  constructor(private readonly configService: RevenueConfigurationService) {}

  /**
   * Calculates the exact coin splits for host and platform.
   */
  async calculateSplit(
    totalCoinValue: bigint,
    configOverride?: RevenueSplitConfig,
  ): Promise<CalculatedRevenueSplit> {
    const config = configOverride ?? (await this.configService.getRevenueSplitConfig());

    if (totalCoinValue <= BigInt(0)) {
      return {
        totalCoinValue: BigInt(0),
        hostPercentage: config.hostPercentage,
        platformPercentage: config.platformPercentage,
        hostEarningsCoins: BigInt(0),
        platformEarningsCoins: BigInt(0),
      };
    }

    // Host calculation: (totalCoinValue * Math.floor(hostPercentage)) / 100
    const hostMultiplier = BigInt(Math.floor(config.hostPercentage));
    const hostEarningsCoins = (totalCoinValue * hostMultiplier) / BigInt(100);
    const platformEarningsCoins = totalCoinValue - hostEarningsCoins;

    return {
      totalCoinValue,
      hostPercentage: config.hostPercentage,
      platformPercentage: config.platformPercentage,
      hostEarningsCoins,
      platformEarningsCoins,
    };
  }
}
