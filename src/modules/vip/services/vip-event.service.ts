import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class VipEventService implements OnModuleInit {
  private readonly logger = new Logger(VipEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus) {}

  onModuleInit() {
    this.logger.log('VipEventService initialized.');
  }

  /**
   * Publishes VIP lifecycle events onto IEventBus.
   */
  async publishVipEvent(eventName: string, payload: any) {
    try {
      await this.bus.publish({
        name: eventName,
        payload,
      } as any);
    } catch (err) {
      this.logger.error(`Failed to publish VIP event '${eventName}': ${(err as Error).message}`);
    }
  }
}
