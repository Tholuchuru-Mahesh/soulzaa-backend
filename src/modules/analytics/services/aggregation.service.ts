import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class AggregationService {
  private readonly logger = new Logger(AggregationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregates key analytical metrics across various database domains.
   * Strictly read-only, NO modifications to source domains.
   */
  async aggregateDomainMetrics(domain: string): Promise<Record<string, number>> {
    this.logger.log(`Aggregating metrics for domain: ${domain}`);
    const results: Record<string, number> = {};

    switch (domain.toUpperCase()) {
      case 'GROWTH':
      case 'PLATFORM_OVERVIEW':
        results['total_users'] = await this.prisma.user.count();
        results['active_users'] = await this.prisma.user.count({ where: { status: 'ACTIVE' } });
        break;

      case 'WALLET':
      case 'FINANCIAL': {
        // Sum total balances in user wallets
        const walletSum = await this.prisma.wallet.aggregate({
          _sum: { availableBalance: true },
        });
        results['total_wallet_balance'] = Number(walletSum._sum.availableBalance ?? 0n);
        break;
      }

      case 'GIFT': {
        const giftCount = await this.prisma.roomActivity.aggregate({
          _sum: { totalGifts: true },
        });
        results['total_gifts_sent'] = giftCount._sum.totalGifts ?? 0;
        break;
      }

      case 'REFERRAL':
        results['total_referral_codes'] = await this.prisma.referralCode.count();
        results['total_referral_relationships'] = await this.prisma.referralRelationship.count();
        break;

      case 'NOTIFICATION':
        results['total_notifications_sent'] = await this.prisma.enterpriseNotification.count();
        break;

      default:
        results['placeholder_metric'] = 100;
        break;
    }

    return results;
  }
}
