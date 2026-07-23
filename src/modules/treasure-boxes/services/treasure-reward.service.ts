import { Injectable, Logger } from '@nestjs/common';
import { TreasureConfigurationService } from './treasure-configuration.service';

export interface CalculatedRewardPool {
  boxLevel: number;
  threshold: bigint;
  rewardPoolPercentage: number;
  totalRewardPool: bigint;
}

@Injectable()
export class TreasureRewardService {
  private readonly logger = new Logger(TreasureRewardService.name);

  constructor(private readonly configService: TreasureConfigurationService) {}

  /**
   * Calculates the total coin reward pool for a given box threshold dynamically
   * using the platform configuration percentage (never hardcoded).
   */
  async calculateRewardPool(boxLevel: number, threshold: bigint): Promise<CalculatedRewardPool> {
    const percentage = await this.configService.getRewardPoolPercentage();
    // totalRewardPool = threshold * percentage / 100
    const totalRewardPool = (threshold * BigInt(percentage)) / BigInt(100);

    this.logger.log(
      `Calculated reward pool for Level ${boxLevel} (threshold ${threshold.toString()}): ${totalRewardPool.toString()} coins (${percentage}%)`,
    );

    return {
      boxLevel,
      threshold,
      rewardPoolPercentage: percentage,
      totalRewardPool,
    };
  }
}
