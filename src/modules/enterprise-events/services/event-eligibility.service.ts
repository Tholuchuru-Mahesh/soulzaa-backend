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
   * Country restriction, matched on normalised `countryId`.
   *
   * The allow-list is authored as ISO codes, so codes are resolved to ids once
   * and compared by id. Free-text `user.country` is deliberately not read: it is
   * self-reported and unnormalised ("India" vs "IN"), which silently rejected
   * legitimate users — and is why an unnormalised user now fails closed rather
   * than being admitted on the strength of a profile string.
   */
  async checkCountryEligibility(
    userId: string,
    rules: { allowedCountries?: unknown },
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (!rules.allowedCountries || !Array.isArray(rules.allowedCountries)) {
      return { eligible: true };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryId: true },
    });

    if (!user?.countryId) {
      return {
        eligible: false,
        reason: 'Your location has not been set, so country eligibility cannot be confirmed',
      };
    }

    const allowed = await this.prisma.country.findMany({
      where: { code: { in: rules.allowedCountries as string[] } },
      select: { id: true, code: true },
    });

    if (allowed.some((country) => country.id === user.countryId)) {
      return { eligible: true };
    }

    return { eligible: false, reason: 'Your country is not eligible for this event' };
  }

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

    // 2. Wealth Level check
    if (rules.minVipLevel !== undefined) {
      const userWealthLevel = userStats?.wealthLevel ?? 0;
      if (userWealthLevel < Number(rules.minVipLevel)) {
        reasons.push(
          `Minimum Wealth Level required is ${rules.minVipLevel} (Current: ${userWealthLevel})`,
        );
      }
    }

    // 3. Country / Region restriction — normalised ids, never profile text.
    const countryCheck = await this.checkCountryEligibility(userId, rules);
    if (!countryCheck.eligible && countryCheck.reason) {
      reasons.push(countryCheck.reason);
    }

    // 4. Custom JSON conditions (e.g. minGiftsSent)
    if (rules.minGiftsSent !== undefined) {
      const totalGiftsSent = Number(userStats?.giftsSent ?? 0);
      if (totalGiftsSent < Number(rules.minGiftsSent)) {
        reasons.push(
          `Minimum gifts sent required is ${rules.minGiftsSent} (Current: ${totalGiftsSent})`,
        );
      }
    }

    return {
      eligible: reasons.length === 0,
      reasons,
    };
  }
}
