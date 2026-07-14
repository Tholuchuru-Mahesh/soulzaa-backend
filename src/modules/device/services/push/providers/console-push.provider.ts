import { Injectable, Logger } from '@nestjs/common';
import type {
  IPushProvider,
  PushMessage,
  PushProviderName,
} from '../../../interfaces/push-provider.interface';

/**
 * Default push transport: logs the message. Swap PUSH_PROVIDER to fcm/apns for
 * production. Never used to deliver real notifications.
 *
 * It logs the resolved channel and category as well as the text, because those are
 * the two things that go wrong silently in dev — a push on a channel the client
 * never registered is dropped by Android without a word.
 */
@Injectable()
export class ConsolePushProvider implements IPushProvider {
  readonly name: PushProviderName = 'console';
  private readonly logger = new Logger(ConsolePushProvider.name);

  async send(token: string, message: PushMessage): Promise<void> {
    const badge = message.badge !== undefined ? ` badge=${message.badge}` : '';
    const thread = message.threadId ? ` thread=${message.threadId}` : '';
    this.logger.warn(
      `[DEV PUSH] → ${token.slice(0, 8)}… [${message.category}/${message.channelId}]${badge}${thread}: ${message.title} — ${message.body}`,
    );
  }
}
