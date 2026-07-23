import { Injectable, Logger } from '@nestjs/common';
import { AgencyCommissionConfig, AgencyConfigurationService } from './agency-configuration.service';

export interface CalculatedAgencyCommission {
  hostEarningsCoins: bigint;
  commissionPercentage: number;
  agencyCommissionCoins: bigint;
}

@Injectable()
export class AgencyCommissionService {
  private readonly logger = new Logger(AgencyCommissionService.name);

  constructor(private readonly configService: AgencyConfigurationService) {}

  /**
   * Calculates the exact commission amount for an agency based on host earnings coins.
   */
  async calculateCommission(
    hostEarningsCoins: bigint,
    configOverride?: AgencyCommissionConfig,
  ): Promise<CalculatedAgencyCommission> {
    const config = configOverride ?? (await this.configService.getCommissionConfig());

    if (hostEarningsCoins <= BigInt(0)) {
      return {
        hostEarningsCoins: BigInt(0),
        commissionPercentage: config.commissionPercentage,
        agencyCommissionCoins: BigInt(0),
      };
    }

    const commMultiplier = BigInt(Math.floor(config.commissionPercentage));
    const agencyCommissionCoins = (hostEarningsCoins * commMultiplier) / BigInt(100);

    return {
      hostEarningsCoins,
      commissionPercentage: config.commissionPercentage,
      agencyCommissionCoins,
    };
  }
}
