import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface EligibleParticipant {
  userId: string;
  weight: bigint;
}

@Injectable()
export class TreasureEligibilityService {
  private readonly logger = new Logger(TreasureEligibilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Filters and returns eligible participants for a completed treasure box in a room.
   * Selection rules:
   * 1. Room participants / contributors only
   * 2. Exclude banned or blocked users
   * 3. Exclude users with zero participation (0 contribution)
   */
  async getEligibleParticipants(boxId: string, roomId: string): Promise<EligibleParticipant[]> {
    // 1. Fetch contributors for this box
    const contributions = await this.prisma.treasureContribution.groupBy({
      by: ['userId'],
      where: { boxId },
      _sum: { amount: true },
    });

    if (contributions.length === 0) {
      return [];
    }

    // Filter out 0 contribution users
    const validContributors = contributions.filter(
      (c) => c._sum.amount && c._sum.amount > BigInt(0),
    );

    if (validContributors.length === 0) {
      return [];
    }

    const userIds = validContributors.map((c) => c.userId);

    // 2. Fetch user status to exclude banned users
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        status: { notIn: ['BANNED', 'SUSPENDED'] },
      },
      select: { id: true, status: true },
    });

    const activeUserSet = new Set(users.map((u) => u.id));

    // 3. Map to eligible participants with weight
    const eligible: EligibleParticipant[] = [];

    for (const c of validContributors) {
      if (activeUserSet.has(c.userId)) {
        eligible.push({
          userId: c.userId,
          weight: c._sum.amount!,
        });
      }
    }

    return eligible;
  }
}
