import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Wallet, WalletCurrency, WalletStatus } from '@prisma/client';
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
   * Validates sufficient balance for a debit.
   *
   * `availableBalance` is an aggregate maintained in lockstep with the three
   * sub-balances (gold/free/earnings). Validating the aggregate would let one
   * currency's coins satisfy another currency's debit — and drive that
   * sub-balance negative (PRD: FREE coins cannot buy gifts/VIP/treasure).
   *
   * When `currency` is supplied, the matching sub-balance is checked. When it
   * is omitted, the aggregate `availableBalance` is checked — this preserves
   * the behaviour of aggregate operations (reservation, transfer) that move
   * `availableBalance` directly rather than a specific sub-balance.
   */
  validateSufficientBalance(wallet: Wallet, requiredAmount: bigint, currency?: WalletCurrency) {
    const balance =
      currency === WalletCurrency.GOLD
        ? wallet.goldBalance
        : currency === WalletCurrency.GAME
          ? wallet.gameBalance
          : currency === WalletCurrency.DIAMOND
            ? wallet.diamondBalance
            : wallet.availableBalance;
    if (balance < requiredAmount) {
      const label = currency ? `${currency} ` : 'available ';
      throw new BadRequestException(
        `Insufficient ${label}balance. Required: ${requiredAmount.toString()}, Available: ${balance.toString()}`,
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
