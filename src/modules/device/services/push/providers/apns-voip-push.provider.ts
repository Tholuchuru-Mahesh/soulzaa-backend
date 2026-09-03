import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import apn from '@parse/node-apn';
import {
  PushTokenInvalidError,
  type IPushProvider,
  type PushMessage,
  type PushProviderName,
} from '../../../interfaces/push-provider.interface';

/** APNs statuses that mean "this token is dead", never "this send failed". */
const DEAD_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
]);

/**
 * Raw APNs transport for PushKit VoIP pushes — the *only* push type Apple
 * delivers to a force-quit app, and the one carrying the CallKit-reporting
 * obligation (see `PushMessage.preferVoipOnIos`'s doc comment).
 *
 * Deliberately **not** selectable via `PUSH_PROVIDER`/`PushProviderRegistry`:
 * a VoIP push is not an alternative *default* transport, it is the one
 * transport a specific handful of call-lifecycle pushes must always use for
 * an iOS device that has registered a VoIP token, regardless of which
 * provider handles everything else. `PushProcessor` selects this provider
 * directly, per-device, when `message.preferVoipOnIos` is set.
 *
 * Self-gates on the same `pushProviders.apns` config the scaffolded alert
 * provider uses — a single token-based `.p8` Auth Key covers both push
 * types, Apple does not require a separate VoIP certificate for token auth.
 *
 * The payload carries no `aps.alert` — a VoIP push is pure data (`callId`,
 * `type`, ...); the client's `PKPushRegistryDelegate` reports the call to
 * CallKit itself, exactly as the Android background isolate already does
 * with the same data shape (see `CallsPushListener`, `CallKitGateway`).
 */
@Injectable()
export class ApnsVoipPushProvider implements IPushProvider, OnModuleDestroy {
  readonly name: PushProviderName = 'apns-voip';
  private readonly logger = new Logger(ApnsVoipPushProvider.name);
  private readonly bundleId?: string;
  private provider?: apn.Provider;

  constructor(config: ConfigService) {
    const { keyId, teamId, bundleId, privateKey } = config.get<{
      apns: { keyId?: string; teamId?: string; bundleId?: string; privateKey?: string };
    }>('pushProviders', { infer: true })!.apns;
    this.bundleId = bundleId;

    if (!keyId || !teamId || !bundleId || !privateKey) {
      this.logger.warn(
        'APNs credentials absent — VoIP calling push is inert (background/killed ' +
          'iOS incoming calls will not ring; foreground calls are unaffected)',
      );
      return;
    }

    this.provider = new apn.Provider({
      token: {
        key: privateKey.replace(/\\n/g, '\n'),
        keyId,
        teamId,
      },
      production: process.env.NODE_ENV === 'production',
    });
    this.logger.log('APNs VoIP push provider ready');
  }

  isConfigured(): boolean {
    return this.provider !== undefined;
  }

  async send(token: string, message: PushMessage): Promise<void> {
    if (!this.provider || !this.bundleId) {
      throw new Error(
        'APNs VoIP push provider is not configured (APNS_KEY_ID/TEAM_ID/BUNDLE_ID/PRIVATE_KEY)',
      );
    }

    const note = new apn.Notification();
    // The `.voip` suffix is Apple's required topic for a PushKit push — the
    // same Auth Key, a different topic, is what routes it through the VoIP
    // gateway instead of the ordinary one.
    note.topic = `${this.bundleId}.voip`;
    note.pushType = 'voip';
    note.priority = message.priority === 'high' ? 10 : 5;
    if (message.ttlSeconds !== undefined) {
      note.expiry = Math.floor(Date.now() / 1000) + message.ttlSeconds;
    }
    if (message.collapseKey) note.collapseId = message.collapseKey;
    // Pure data — no `alert`/`sound`/`badge`. The client builds its own
    // CallKit UI from these fields; APNs never draws anything for a VoIP push.
    note.payload = {
      ...message.data,
      title: message.title,
      body: message.body,
      category: message.category,
    };

    const result = await this.provider.send(note, token);
    const failure = result.failed[0];
    if (failure) {
      const reason = failure.response?.reason ?? failure.error?.message ?? 'unknown';
      if (DEAD_TOKEN_REASONS.has(reason)) throw new PushTokenInvalidError(token, reason);
      throw new Error(`APNs VoIP push failed: ${reason}`);
    }
  }

  onModuleDestroy(): void {
    this.provider?.shutdown();
  }
}
