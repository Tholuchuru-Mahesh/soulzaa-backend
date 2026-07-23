import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class ReferralQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserReferralSummary(userId: string): Promise<unknown> {
    const [codesCreated, totalReferred, qualified, rewarded, myReferral] =
      await Promise.all([
        this.prisma.referralCode.count({ where: { referrerId: userId } }),
        this.prisma.referralRelationship.count({ where: { referrerId: userId } }),
        this.prisma.referralRelationship.count({
          where: { referrerId: userId, status: { in: ['QUALIFIED', 'REWARDED'] } },
        }),
        this.prisma.referralRelationship.count({
          where: { referrerId: userId, status: 'REWARDED' },
        }),
        this.prisma.referralRelationship.findUnique({ where: { refereeId: userId } }),
      ]);
    return { codesCreated, totalReferred, qualified, rewarded, myReferral };
  }

  async getUserActiveCodes(userId: string): Promise<unknown[]> {
    return this.prisma.referralCode.findMany({
      where: { referrerId: userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getReferralHistory(userId: string, skip = 0, take = 50): Promise<unknown[]> {
    return this.prisma.referralHistory.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async getCampaignLeaderboard(
    campaignId: string,
    limit = 20,
  ): Promise<unknown[]> {
    return this.prisma.referralRelationship.groupBy({
      by: ['referrerId'],
      where: {
        campaignId,
        status: { in: ['QUALIFIED', 'REWARDED'] },
      },
      _count: { referrerId: true },
      orderBy: { _count: { referrerId: 'desc' } },
      take: limit,
    } as any);
  }

  async getRelationshipDetails(relationshipId: string): Promise<unknown> {
    return this.prisma.referralRelationship.findUnique({
      where: { id: relationshipId },
      include: {
        qualifications: true,
        rewards: true,
      },
    });
  }

  async findExpiredRelationships(): Promise<unknown[]> {
    return this.prisma.referralRelationship.findMany({
      where: {
        status: { in: ['REGISTERED', 'CREATED'] },
        expiresAt: { lt: new Date() },
      },
    });
  }
}
