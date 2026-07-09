import { Injectable, Logger } from '@nestjs/common';
import type { PushMessage } from '../../interfaces/push-provider.interface';
import { PushProviderRegistry } from './push-provider.registry';

/**
 * Fan-out facade over the selected push provider. Sends a message to many device
 * tokens, isolating per-token failures so one bad token doesn't abort the batch.
 * Called by the push queue processor.
 */
@Injectable()
export class PushDispatcher {
  private readonly logger = new Logger(PushDispatcher.name);

  constructor(private readonly registry: PushProviderRegistry) {}

  async sendToTokens(tokens: string[], message: PushMessage): Promise<number> {
    const provider = this.registry.resolve();
    let delivered = 0;
    await Promise.all(
      tokens.map(async (token) => {
        try {
          await provider.send(token, message);
          delivered++;
        } catch (err) {
          this.logger.warn(`push to ${token.slice(0, 12)}… failed: ${(err as Error).message}`);
        }
      }),
    );
    return delivered;
  }
}
