import { Injectable, Logger } from '@nestjs/common';
import {
  CoinSellerCommissionConfig,
  CoinSellerConfigurationService,
} from './coin-seller-configuration.service';

export interface CalculatedCoinSellerCommission {
  purchaseAmountCoins: bigint;
  commissionPercentage: number;
  sellerCommissionCoins: bigint;
}

@Injectable()
export class CoinSellerCommissionService {
  private readonly logger = new Logger(CoinSellerCommissionService.name);

  constructor(private readonly configService: CoinSellerConfigurationService) {}

  /**
   * Calculates exact coin seller commission amount based on purchase amount coins.
   */
  async calculateCommission(
    purchaseAmountCoins: bigint,
    configOverride?: CoinSellerCommissionConfig,
  ): Promise<CalculatedCoinSellerCommission> {
    const config = configOverride ?? (await this.configService.getCommissionConfig());

    if (purchaseAmountCoins <= BigInt(0)) {
      return {
        purchaseAmountCoins: BigInt(0),
        commissionPercentage: config.commissionPercentage,
        sellerCommissionCoins: BigInt(0),
      };
    }

    const commMultiplier = BigInt(Math.floor(config.commissionPercentage));
    const sellerCommissionCoins = (purchaseAmountCoins * commMultiplier) / BigInt(100);

    return {
      purchaseAmountCoins,
      commissionPercentage: config.commissionPercentage,
      sellerCommissionCoins,
    };
  }
}
