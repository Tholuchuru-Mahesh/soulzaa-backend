import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventEventService } from './event-event.service';

@Injectable()
export class EventRewardService {
  private readonly logger = new Logger(EventRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: EventAuditService,
    private readonly eventService: EventEventService,
  ) {}

  /**
   * Dispatches rewards for an event participant or winner.
   * Records the reward definition in `event_rewards` and publishes `event.reward.dispatched`.
   * Does NOT touch Wallet or EXP directly (decoupled orchestration).
   */
  async dispatchReward(
    eventId: string,
    userId: string,
    customReward?: Record<string, any>,
    actorId?: string,
  ) {
    const event = await this.prisma.eventDefinition.findUnique({ where: { id: eventId } });
    if (!event) throw new Error(`Event ${eventId} not found`);

    const rewardDef = customReward ?? (event.rewardDefinition as Record<string, any>) ?? {};

    const record = await this.prisma.eventReward.create({
      data: {
        eventId,
        userId,
        rewardDefinition: rewardDef,
        dispatched: true,
        dispatchedAt: new Date(),
      },
    });

    await this.auditService.logAudit('EVENT_REWARD_DISPATCHED', eventId, actorId, {
      userId,
      rewardId: record.id,
      rewardDefinition: rewardDef,
    });

    await this.eventService.publishRewardDispatched(eventId, userId, rewardDef);

    this.logger.log(`Reward dispatched for event ${eventId} to user ${userId}`);

    return record;
  }

  /**
   * Dispatches rewards to all completed participants of an event.
   */
  async dispatchAllParticipantRewards(eventId: string, actorId?: string) {
    const participants = await this.prisma.eventParticipant.findMany({
      where: { eventId, status: 'COMPLETED' },
    });

    const results = [];
    for (const p of participants) {
      try {
        const reward = await this.dispatchReward(eventId, p.userId, undefined, actorId);
        results.push(reward);
      } catch (err) {
        this.logger.error(
          `Failed to dispatch reward to user ${p.userId} in event ${eventId}: ${(err as Error).message}`,
        );
      }
    }

    return results;
  }
}
