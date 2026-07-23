import { Injectable, Logger } from '@nestjs/common';

export interface ChannelDispatchContext {
  notificationId: string;
  recipientId?: string;
  title?: string;
  body?: string;
  variables?: Record<string, string>;
}

@Injectable()
export class NotificationChannelService {
  private readonly logger = new Logger(NotificationChannelService.name);

  // In memory registry of registered channels
  private readonly channels = new Set<string>(['IN_APP', 'PUSH', 'WEBSOCKET', 'EMAIL', 'SMS']);

  registerChannel(channel: string): void {
    this.channels.add(channel.toUpperCase());
    this.logger.log(`Channel registered: ${channel}`);
  }

  isChannelRegistered(channel: string): boolean {
    return this.channels.has(channel.toUpperCase());
  }

  /**
   * Simulates/dispatches execution across a registered provider.
   */
  async dispatchToChannel(
    channel: string,
    ctx: ChannelDispatchContext,
  ): Promise<{ success: boolean; errorMessage?: string }> {
    if (!this.isChannelRegistered(channel)) {
      return { success: false, errorMessage: `Channel ${channel} is not registered.` };
    }

    try {
      this.logger.log(
        `Dispatched via [${channel}] to recipient: ${ctx.recipientId ?? 'Broadcast'} - title: ${ctx.title}`,
      );
      // Simulate real communication channel delays/operations
      return { success: true };
    } catch (err) {
      return { success: false, errorMessage: (err as Error).message };
    }
  }
}
