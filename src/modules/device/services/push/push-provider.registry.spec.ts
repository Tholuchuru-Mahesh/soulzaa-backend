import { ConfigService } from '@nestjs/config';
import type { IPushProvider, PushProviderName } from '../../interfaces/push-provider.interface';
import { ApnsPushProvider } from './providers/apns-push.provider';
import { ConsolePushProvider } from './providers/console-push.provider';
import { FcmPushProvider } from './providers/fcm-push.provider';
import { PushProviderRegistry } from './push-provider.registry';

const fake = (name: PushProviderName): IPushProvider => ({ name, send: jest.fn() });

function registryFor(selected: PushProviderName): PushProviderRegistry {
  const config = { get: () => ({ provider: selected }) } as unknown as ConfigService;
  return new PushProviderRegistry(
    config,
    fake('console') as ConsolePushProvider,
    fake('fcm') as FcmPushProvider,
    fake('apns') as ApnsPushProvider,
  );
}

describe('PushProviderRegistry', () => {
  it.each<PushProviderName>(['console', 'fcm', 'apns'])(
    'resolves the configured provider "%s"',
    (name) => {
      expect(registryFor(name).resolve().name).toBe(name);
    },
  );
});
