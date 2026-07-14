import { Injectable, Logger } from '@nestjs/common';
import { PushTokenInvalidError, type PushMessage } from '../../interfaces/push-provider.interface';
import { DeviceRepository } from '../../repositories/device.repository';
import { PushProviderRegistry } from './push-provider.registry';

/** What a fan-out did, for the queue's job result and the logs. */
export interface PushFanoutResult {
  delivered: number;
  failed: number;
  /** Tokens retired because the provider said they are permanently dead. */
  retired: number;
}

/**
 * Fan-out facade over the selected push provider. Sends a message to many device
 * tokens, isolating per-token failures so one bad token doesn't abort the batch.
 * Called by the push queue processor.
 *
 * A token the provider rejects as *permanently* invalid is cleared from the
 * registry rather than retried. Without that, an uninstalled app leaves its token
 * behind forever and every subsequent push to that user pays for a send that
 * cannot possibly land — a cost that only ever grows, because nothing else in the
 * system will ever remove it.
 */
@Injectable()
export class PushDispatcher {
  private readonly logger = new Logger(PushDispatcher.name);

  constructor(
    private readonly registry: PushProviderRegistry,
    private readonly devices: DeviceRepository,
  ) {}

  async sendToTokens(tokens: string[], message: PushMessage): Promise<PushFanoutResult> {
    const provider = this.registry.resolve();
    const dead: string[] = [];
    let delivered = 0;
    let failed = 0;

    await Promise.all(
      tokens.map(async (token) => {
        try {
          await provider.send(token, message);
          delivered++;
        } catch (err) {
          if (err instanceof PushTokenInvalidError) {
            dead.push(token);
            return;
          }
          failed++;
          // Never log the token itself — it is a credential for reaching a device.
          this.logger.warn(`push to ${redact(token)} failed: ${(err as Error).message}`);
        }
      }),
    );

    const retired = dead.length ? await this.retire(dead) : 0;
    return { delivered, failed, retired };
  }

  /** Clear dead tokens from the registry. Never fails the push that found them. */
  private async retire(tokens: string[]): Promise<number> {
    try {
      const cleared = await this.devices.clearPushTokens(tokens);
      this.logger.log(`retired ${cleared} dead push token(s): ${tokens.map(redact).join(', ')}`);
      return cleared;
    } catch (err) {
      this.logger.warn(`failed to retire dead push tokens: ${(err as Error).message}`);
      return 0;
    }
  }
}

/** A token is a capability to reach someone's phone; logs get a fingerprint, not the key. */
function redact(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
