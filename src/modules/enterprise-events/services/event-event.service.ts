import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class EventEventService {
  private readonly logger = new Logger(EventEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}

  private async publish(name: string, payload: Record<string, any>) {
    try {
      await this.eventBus.publish({ name, payload, timestamp: new Date() } as any);
    } catch (err) {
      this.logger.error(`Failed to publish event ${name}: ${(err as Error).message}`);
    }
  }

  async publishEventCreated(eventId: string, code: string, category: string) {
    await this.publish('event.created', { eventId, code, category });
  }

  async publishEventUpdated(eventId: string, changes: Record<string, any>) {
    await this.publish('event.updated', { eventId, changes });
  }

  async publishRegistrationOpened(eventId: string, regEndTime?: Date) {
    await this.publish('event.registration.opened', { eventId, regEndTime });
  }

  async publishRegistrationClosed(eventId: string, totalRegistrations: number) {
    await this.publish('event.registration.closed', { eventId, totalRegistrations });
  }

  async publishEventStarted(eventId: string, startTime: Date) {
    await this.publish('event.started', { eventId, startTime });
  }

  async publishEventCompleted(eventId: string, completedAt: Date, totalParticipants: number) {
    await this.publish('event.completed', { eventId, completedAt, totalParticipants });
  }

  async publishEventCancelled(eventId: string, reason?: string) {
    await this.publish('event.cancelled', { eventId, reason });
  }

  async publishRewardDispatched(
    eventId: string,
    userId: string,
    rewardDefinition: Record<string, any>,
  ) {
    await this.publish('event.reward.dispatched', { eventId, userId, rewardDefinition });
  }
}
