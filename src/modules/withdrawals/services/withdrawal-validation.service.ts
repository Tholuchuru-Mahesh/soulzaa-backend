import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { WithdrawalConfigurationService } from './withdrawal-configuration.service';

@Injectable()
export class WithdrawalValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coinEconomyService: CoinEconomyService,
    private readonly configService: WithdrawalConfigurationService,
    private readonly policyService: FinancialPolicyService,
  ) {}

  /**
   * Validates pre-conditions before creating a withdrawal request.
   */
  async validateWithdrawalRequest(userId: string, amountCoins: bigint) {
    // 1. Check Treasury Economy Freeze
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException('Withdrawals suspended due to Treasury Economy Freeze');
    }

    // 2. Validate User Account Status
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user || user.status === 'BANNED' || user.status === 'SUSPENDED') {
      throw new ForbiddenException('User account is not active for withdrawals');
    }

    // 3. Dynamic Config & Policy Thresholds
    const config = await this.configService.getWithdrawalConfig();
    try {
      const minPolicy = await this.policyService.getPolicy('min_withdrawal_amount');
      const maxPolicy = await this.policyService.getPolicy('max_withdrawal_amount');
      const minCoins = BigInt(minPolicy.value);
      const maxCoins = BigInt(maxPolicy.value);

      if (amountCoins < minCoins) {
        throw new BadRequestException(
          `Withdrawal amount ${amountCoins} is below minimum policy limit of ${minCoins} coins`,
        );
      }
      if (amountCoins > maxCoins) {
        throw new BadRequestException(
          `Withdrawal amount ${amountCoins} exceeds maximum policy cap of ${maxCoins} coins`,
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const minCoins = BigInt(config.minimumAmountCoins);
      const maxCoins = BigInt(config.maximumAmountCoins);

      if (amountCoins < minCoins) {
        throw new BadRequestException(
          `Withdrawal amount ${amountCoins} is below minimum ${minCoins} coins`,
        );
      }
      if (amountCoins > maxCoins) {
        throw new BadRequestException(
          `Withdrawal amount ${amountCoins} exceeds maximum ${maxCoins} coins`,
        );
      }
    }

    // 4. Validate Eligible Earnings Balance (diamondBalance on Wallet)
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });
    const currentBalance = wallet ? wallet.diamondBalance : BigInt(0);

    if (currentBalance < amountCoins) {
      throw new BadRequestException(
        `Insufficient eligible diamond balance (${currentBalance} < ${amountCoins})`,
      );
    }

    // 5. Daily Cumulative Limit Check
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const dailyAgg = await this.prisma.withdrawalRequest.aggregate({
      where: {
        userId,
        createdAt: { gte: startOfDay },
        status: { in: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED'] },
      },
      _sum: { amountCoins: true },
    });
    const dailyTotal = (dailyAgg?._sum?.amountCoins ?? BigInt(0)) + amountCoins;
    if (dailyTotal > BigInt(config.dailyLimitCoins)) {
      throw new BadRequestException(
        `Withdrawal request exceeds daily limit of ${config.dailyLimitCoins} coins`,
      );
    }

    // 6. Active Concurrent Pending Request Check
    const pendingCount = await this.prisma.withdrawalRequest.count({
      where: {
        userId,
        status: { in: ['PENDING', 'UNDER_REVIEW', 'PROCESSING'] },
      },
    });
    if (pendingCount > 0) {
      throw new BadRequestException('You already have an active pending withdrawal request');
    }

    return { config, walletBalance: currentBalance };
  }
}
