import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TreasuryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active global Treasury Reserve tracking row
   */
  async getTreasuryReserve() {
    let reserve = await this.prisma.treasuryReserve.findFirst();
    if (!reserve) {
      reserve = await this.prisma.treasuryReserve.create({
        data: {
          maxSupply: BigInt('1000000000000'),
          circulatingSupply: BigInt('0'),
          reservedSupply: BigInt('0'),
          treasuryBalance: BigInt('0'),
          isFrozen: false,
        },
      });
    }

    const summary = await this.getTreasurySummary();

    return {
      id: reserve.id,
      maxSupply: summary.maxSupply,
      circulatingSupply: summary.circulatingSupply,
      reservedSupply: summary.reservedSupply,
      treasuryBalance: summary.treasuryBalance,
      isFrozen: summary.isFrozen,
      updatedAt: reserve.updatedAt,
    };
  }

  /**
   * Returns global treasury balance summary metrics computed dynamically from live database wallets
   */
  async getTreasurySummary() {
    const reserve = await this.prisma.treasuryReserve.findFirst();

    // Dynamically calculate actual circulating, reserved, and treasury balances from database wallets
    const [userWalletAgg, treasuryWalletAgg] = await Promise.all([
      this.prisma.wallet.aggregate({
        _sum: {
          availableBalance: true,
          lockedBalance: true,
          reservedBalance: true,
          pendingBalance: true,
        },
        where: {
          type: 'USER_WALLET',
        },
      }),
      this.prisma.wallet.aggregate({
        _sum: {
          availableBalance: true,
          lockedBalance: true,
        },
        where: {
          type: { in: ['TREASURY_WALLET', 'SYSTEM_WALLET'] },
        },
      }),
    ]);

    const circulatingSupply = userWalletAgg._sum.availableBalance ?? 0n;
    const reservedSupply =
      (userWalletAgg._sum.lockedBalance ?? 0n) +
      (userWalletAgg._sum.reservedBalance ?? 0n) +
      (userWalletAgg._sum.pendingBalance ?? 0n);
    const treasuryBalance =
      (treasuryWalletAgg._sum.availableBalance ?? 0n) +
      (treasuryWalletAgg._sum.lockedBalance ?? 0n);

    const maxSupply = reserve?.maxSupply ?? BigInt('1000000000000');
    const isFrozen = reserve?.isFrozen ?? false;

    return {
      treasuryBalance: treasuryBalance.toString(),
      reservedSupply: reservedSupply.toString(),
      circulatingSupply: circulatingSupply.toString(),
      maxSupply: maxSupply.toString(),
      isFrozen,
      lastUpdated: reserve?.updatedAt ?? new Date(),
    };
  }
}
