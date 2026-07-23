import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

@Injectable()
export class EventEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks if a user satisfies an event's eligibility rules and location restrictions.
   */
  async checkEligibility(userId: string, eventId: string): Promise<EligibilityResult> {
    const [event, userStats] = await Promise.all([
      this.prisma.eventDefinition.findUnique({ where: { id: eventId } }),
      this.prisma.userStatistics.findUnique({ where: { userId } }),
    ]);

    if (!event) {
      return { eligible: false, reasons: ['Event definition not found'] };
    }

    const reasons: string[] = [];
    const rules = (event.eligibilityRules as Record<string, any>) ?? {};

    // 1. Level check
    if (rules.minLevel !== undefined) {
      const userLevel = userStats?.level ?? 1;
      if (userLevel < Number(rules.minLevel)) {
        reasons.push(`Minimum level required is ${rules.minLevel} (Current: ${userLevel})`);
      }
    }

    // 2. VIP level check
    if (rules.minVipLevel !== undefined) {
      const userVipLevel = userStats?.vipLevel ?? 0;
      if (userVipLevel < Number(rules.minVipLevel)) {
        reasons.push(`Minimum VIP level required is ${rules.minVipLevel} (Current: ${userVipLevel})`);
      }
    }

    // 3. Country / Region restriction
    if (rules.allowedCountries && Array.isArray(rules.allowedCountries)) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      const userCountry = user?.country ?? '';
      if (!rules.allowedCountries.includes(userCountry)) {
        reasons.push(`Country '${userCountry}' is not eligible for this event`);
      }
    }

    // 4. Custom JSON conditions (e.g. minGiftsSent)
    if (rules.minGiftsSent !== undefined) {
      const totalGiftsSent = Number(userStats?.giftsSent ?? 0);
      if (totalGiftsSent < Number(rules.minGiftsSent)) {
        reasons.push(`Minimum gifts sent required is ${rules.minGiftsSent} (Current: ${totalGiftsSent})`);
      }
    }

    return {
      eligible: reasons.length === 0,
      reasons,
    };
  }
}
