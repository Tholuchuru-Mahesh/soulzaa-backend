import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IPushProvider, PushProviderName } from '../../interfaces/push-provider.interface';
import { ApnsPushProvider } from './providers/apns-push.provider';
import { ConsolePushProvider } from './providers/console-push.provider';
import { FcmPushProvider } from './providers/fcm-push.provider';

/**
 * Selects the active push transport from PUSH_PROVIDER. Every provider is
 * instantiated (cheap — config-only); the registry hands out the configured
 * one, defaulting to console. This is the seam that keeps push SDKs out of the
 * device service and makes provider selection unit-testable.
 */
@Injectable()
export class PushProviderRegistry {
  /**
   * Only the three providers `PUSH_PROVIDER` may select — deliberately
   * narrower than the full {@link PushProviderName} union. `apns-voip` is not
   * a general-purpose transport a deployment picks as its default; it is the
   * one specific delivery a call-lifecycle push demands for an iOS device
   * with a registered VoIP token, selected directly by `PushProcessor`
   * regardless of this setting — see `ApnsVoipPushProvider`.
   */
  private readonly providers: Record<Exclude<PushProviderName, 'apns-voip'>, IPushProvider>;
  private readonly selected: Exclude<PushProviderName, 'apns-voip'>;

  constructor(
    config: ConfigService,
    console: ConsolePushProvider,
    fcm: FcmPushProvider,
    apns: ApnsPushProvider,
  ) {
    this.providers = { console, fcm, apns };
    this.selected = config.get('push', { infer: true })!.provider;
  }

  resolve(): IPushProvider {
    return this.providers[this.selected] ?? this.providers.console;
  }
}
