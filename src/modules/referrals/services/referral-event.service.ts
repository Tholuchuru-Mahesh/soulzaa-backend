import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface ReferralEventPayload {
  relationshipId?: string;
  referrerId?: string;
  refereeId?: string;
  campaignId?: string;
  referralType?: string;
  rewardDefinition?: unknown;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ReferralEventService {
  private readonly logger = new Logger(ReferralEventService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  emitReferralCreated(payload: ReferralEventPayload): void {
    this.eventEmitter.emit('referral.created', payload);
    this.logger.log(`Event: referral.created — referrer: ${payload.referrerId}`);
  }

  emitReferralRegistered(payload: ReferralEventPayload): void {
    this.eventEmitter.emit('referral.registered', payload);
    this.logger.log(`Event: referral.registered — referee: ${payload.refereeId}`);
  }

  emitReferralQualified(payload: ReferralEventPayload): void {
    this.eventEmitter.emit('referral.qualified', payload);
    this.logger.log(`Event: referral.qualified — relationship: ${payload.relationshipId}`);
  }

  emitRewardDispatched(payload: ReferralEventPayload): void {
    this.eventEmitter.emit('referral.reward.dispatched', payload);
    this.logger.log(`Event: referral.reward.dispatched — referrer: ${payload.referrerId}`);
  }

  emitReferralExpired(payload: ReferralEventPayload): void {
    this.eventEmitter.emit('referral.expired', payload);
    this.logger.log(`Event: referral.expired — relationship: ${payload.relationshipId}`);
  }

  emitReferralCancelled(payload: ReferralEventPayload): void {
    this.eventEmitter.emit('referral.cancelled', payload);
    this.logger.log(`Event: referral.cancelled — relationship: ${payload.relationshipId}`);
  }
}
