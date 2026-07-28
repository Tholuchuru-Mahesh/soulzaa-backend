import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  PROGRESSION_EVENT_NAMES,
  resolveProgressionSubject,
} from 'src/common/events/progression-events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ReferralService } from '../services/referral.service';

/**
 * Drives referral qualification from real activity.
 *
 * A referral sits at REGISTERED until the referee actually does something — the
 * whole point of qualification rules is to stop a referrer being paid for signups
 * that never engage. Nothing was re-checking that, so relationships never
 * advanced on their own.
 *
 * Rules come from the campaign (`ReferralCampaign.qualificationRules`), so what
 * counts as qualifying is configured per campaign rather than coded here.
 */
@Injectable()
export class ReferralProgressionListener implements OnModuleInit {
  private readonly logger = new Logger(ReferralProgressionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly referrals: ReferralService,
  ) {}

  onModuleInit(): void {
    for (const eventName of PROGRESSION_EVENT_NAMES) {
      this.bus.subscribe(eventName, (event) => {
        void this.handle(eventName, event.payload);
      });
    }
  }

  private async handle(eventCode: string, payload: unknown): Promise<void> {
    const refereeId = resolveProgressionSubject(payload);
    if (!refereeId) return;

    try {
      // refereeId is unique — a user can only be referred once.
      const relationship = await this.prisma.referralRelationship.findUnique({
        where: { refereeId },
        include: { campaign: true },
      });

      // Only pending referrals are interesting; `qualify` is idempotent but this
      // keeps the common case (no referral, or already settled) to one read.
      if (!relationship || relationship.status !== 'REGISTERED') return;

      const rules = (relationship.campaign?.qualificationRules ?? undefined) as
        Record<string, unknown> | undefined;

      await this.referrals.qualify({ relationshipId: relationship.id, rules });
    } catch (err) {
      this.logger.error(
        `Referral qualification failed for '${eventCode}': ${(err as Error).message}`,
      );
    }
  }
}
