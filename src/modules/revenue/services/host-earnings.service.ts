import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class HostEarningsService {
  private readonly logger = new Logger(HostEarningsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves or initializes a HostEarnings record.
   */
  async getOrCreateHostEarnings(hostId: string) {
    let earnings = await this.prisma.hostEarnings.findUnique({
      where: { hostId },
    });

    if (!earnings) {
      earnings = await this.prisma.hostEarnings.create({
        data: {
          hostId,
          totalEarnedCoins: BigInt(0),
          totalGiftCount: 0,
        },
      });
    }

    return earnings;
  }

  /**
   * Increments cumulative earnings and gift count for a host.
   */
  async incrementHostEarnings(hostId: string, earnedAmount: bigint) {
    return this.prisma.hostEarnings.upsert({
      where: { hostId },
      update: {
        totalEarnedCoins: { increment: earnedAmount },
        totalGiftCount: { increment: 1 },
      },
      create: {
        hostId,
        totalEarnedCoins: earnedAmount,
        totalGiftCount: 1,
      },
    });
  }

  /**
   * Gets host earnings summary formatted for API response.
   */
  async getHostSummary(hostId: string) {
    const record = await this.getOrCreateHostEarnings(hostId);
    return {
      hostId: record.hostId,
      totalEarnedCoins: record.totalEarnedCoins.toString(),
      totalGiftCount: record.totalGiftCount,
      updatedAt: record.updatedAt,
    };
  }
}
