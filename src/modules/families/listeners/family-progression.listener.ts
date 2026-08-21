import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, type GiftSentPayload } from 'src/modules/gifts/events/gift.events';
import { FamiliesService } from '../services/families.service';
import { FamilyStatisticsService } from '../services/family-statistics.service';

/**
 * Listens to platform domain events (such as gift sending) and feeds activity,
 * EXP, and coin contributions directly into the Family Progression & Stats Engine.
 */
@Injectable()
export class FamilyProgressionListener implements OnModuleInit {
  private readonly logger = new Logger(FamilyProgressionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly familiesService: FamiliesService,
    private readonly statisticsService: FamilyStatisticsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(GIFT_EVENTS.SENT, async (event) => {
      await this.handleGiftSent(event.payload as GiftSentPayload);
    });
  }

  private async handleGiftSent(payload: GiftSentPayload): Promise<void> {
    if (!payload?.senderId || !payload?.totalCoinValue) return;

    try {
      const familyId = await this.familiesService.getMemberFamilyId(payload.senderId);
      if (!familyId) return;

      const expDelta = payload.totalCoinValue;

      // 1. Increment total family EXP and check for level-ups
      await this.familiesService.addFamilyExp(familyId, expDelta);

      // 2. Increment individual member's contribution points
      await this.familiesService.incrementMemberContribution(payload.senderId, expDelta);

      // 3. Record aggregated statistics
      await this.statisticsService.updateStatistics(familyId, BigInt(expDelta), BigInt(expDelta));
    } catch (err: any) {
      this.logger.error(
        `Failed to process family progression for gift ${payload.transactionId}: ${err?.message || err}`,
      );
    }
  }
}
