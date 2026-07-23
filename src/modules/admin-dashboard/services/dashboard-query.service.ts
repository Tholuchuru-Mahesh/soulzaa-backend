import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class DashboardQueryService {
  private readonly logger = new Logger(DashboardQueryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Performs read-only cross-module queries to get quick system-wide stats counters.
   */
  async getOverviewStats(): Promise<Record<string, number>> {
    this.logger.log('Performing cross-module analytics counts read...');
    const [
      users,
      countries,
      wallets,
      referrals,
      notifications,
      reports,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.country.count(),
      this.prisma.wallet.count(),
      this.prisma.referralCode.count(),
      this.prisma.enterpriseNotification.count(),
      this.prisma.analyticsReport.count(),
    ]);

    return {
      totalUsers: users,
      totalCountries: countries,
      totalWallets: wallets,
      totalReferralCodes: referrals,
      totalNotifications: notifications,
      totalReportsCompiled: reports,
    };
  }

  async searchGlobal(query: string): Promise<unknown[]> {
    this.logger.log(`Performing global console search query: "${query}"`);
    // Search user accounts, campaigns, or notifications matching query
    const [users, campaigns] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          OR: [
            { username: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: 10,
      }),
      this.prisma.referralCampaign.findMany({
        where: {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { code: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: 10,
      }),
    ]);

    return [
      ...users.map((u) => ({ type: 'USER', id: u.id, title: u.username, subtitle: u.email })),
      ...campaigns.map((c) => ({ type: 'CAMPAIGN', id: c.id, title: c.name, subtitle: c.code })),
    ];
  }
}
