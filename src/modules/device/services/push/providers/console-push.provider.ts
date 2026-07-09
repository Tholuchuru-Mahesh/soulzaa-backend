import { Injectable, Logger } from '@nestjs/common';
import type {
  IPushProvider,
  PushMessage,
  PushProviderName,
} from '../../../interfaces/push-provider.interface';

/**
 * Default push transport: logs the message. Swap PUSH_PROVIDER to fcm/apns for
 * production. Never used to deliver real notifications.
 */
@Injectable()
export class ConsolePushProvider implements IPushProvider {
  readonly name: PushProviderName = 'console';
  private readonly logger = new Logger(ConsolePushProvider.name);

  async send(token: string, message: PushMessage): Promise<void> {
    this.logger.warn(`[DEV PUSH] → ${token.slice(0, 12)}…: ${message.title} — ${message.body}`);
  }
}
