import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Wallet, WalletStatus } from '@prisma/client';
import { FeatureFlagService } from 'src/modules/platform-configuration/services/feature-flag.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';

@Injectable()
export class WalletValidationService {
  constructor(
    private readonly coinEconomyService: CoinEconomyService,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  /**
   * Validates economy freeze & wallet feature flags
   */
  async validateEconomyStatus() {
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException(
        'Wallet operations are currently suspended due to Emergency Economy Freeze',
      );
    }

    const walletEnabled = await this.featureFlagService.isEnabled('feature.wallet.enabled');
    if (!walletEnabled) {
      throw new ForbiddenException(
        'Wallet feature is currently disabled by platform configuration',
      );
    }
  }

  /**
   * Validates wallet status is ACTIVE
   */
  validateWalletActive(wallet: Wallet) {
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new ForbiddenException(
        `Wallet '${wallet.id}' is currently ${wallet.status} and cannot process operations`,
      );
    }
  }

  /**
   * Validates sufficient available balance
   */
  validateSufficientBalance(wallet: Wallet, requiredAmount: bigint) {
    if (wallet.availableBalance < requiredAmount) {
      throw new BadRequestException(
        `Insufficient available balance. Required: ${requiredAmount.toString()}, Available: ${wallet.availableBalance.toString()}`,
      );
    }
  }

  /**
   * Validates positive amount bounds
   */
  validatePositiveAmount(amount: bigint | number) {
    const amtBig = BigInt(amount);
    if (amtBig <= 0n) {
      throw new BadRequestException('Transaction amount must be strictly greater than 0');
    }
  }
}
