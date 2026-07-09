import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IPushProvider,
  PushMessage,
  PushProviderName,
} from '../../../interfaces/push-provider.interface';

/**
 * Apple Push Notification service transport — SCAFFOLD. Credentials come from
 * the `pushProviders.apns` config namespace (token-based auth: key id, team id,
 * bundle id, .p8 private key). To activate:
 *   1) `pnpm add @parse/node-apn`
 *   2) build a Provider with the token auth config
 *   3) replace send() with apn.Notification + provider.send(note, token).
 * Logs until then.
 */
@Injectable()
export class ApnsPushProvider implements IPushProvider {
  readonly name: PushProviderName = 'apns';
  private readonly logger = new Logger(ApnsPushProvider.name);
  private readonly bundleId?: string;

  constructor(config: ConfigService) {
    this.bundleId = config.get('pushProviders', { infer: true })!.apns.bundleId;
  }

  async send(token: string, message: PushMessage): Promise<void> {
    if (!this.bundleId) {
      this.logger.error('APNS not configured (APNS_KEY_ID/TEAM_ID/BUNDLE_ID/PRIVATE_KEY)');
      throw new Error('APNS push provider is not configured');
    }
    // TODO: integrate @parse/node-apn — see class doc.
    this.logger.warn(`[apns stub] would push to ${token.slice(0, 12)}…: ${message.title}`);
  }
}
