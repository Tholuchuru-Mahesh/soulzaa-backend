import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class WithdrawalEventService implements OnModuleInit {
  private readonly logger = new Logger(WithdrawalEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus) {}

  onModuleInit() {
    this.logger.log('WithdrawalEventService initialized.');
  }

  /**
   * Publishes withdrawal lifecycle events onto IEventBus.
   */
  async publishWithdrawalEvent(eventName: string, payload: any) {
    try {
      await this.bus.publish({
        name: eventName,
        payload,
      } as any);
    } catch (err) {
      this.logger.error(
        `Failed to publish withdrawal event '${eventName}': ${(err as Error).message}`,
      );
    }
  }
}
