import type { IPushProvider, PushMessage } from '../../interfaces/push-provider.interface';
import { PushTokenInvalidError } from '../../interfaces/push-provider.interface';
import type { DeviceRepository } from '../../repositories/device.repository';
import { PushDispatcher } from './push.dispatcher';
import type { PushProviderRegistry } from './push-provider.registry';

const message: PushMessage = {
  title: 't',
  body: 'b',
  category: 'CALL',
  channelId: 'soulzaa_calls',
};

function fakeProvider(behaviour: (token: string) => Promise<void>): IPushProvider {
  return { name: 'fcm', send: jest.fn(behaviour) };
}

describe('PushDispatcher', () => {
  it('sends through the registry-resolved provider by default', async () => {
    const registryProvider = fakeProvider(() => Promise.resolve());
    const registry = { resolve: () => registryProvider } as unknown as PushProviderRegistry;
    const devices = { clearPushTokens: jest.fn() } as unknown as DeviceRepository;
    const dispatcher = new PushDispatcher(registry, devices);

    const result = await dispatcher.sendToTokens(['t1', 't2'], message);

    expect(result).toEqual({ delivered: 2, failed: 0, retired: 0 });
    expect(registryProvider.send).toHaveBeenCalledTimes(2);
  });

  it('bypasses the registry when an explicit provider is given', async () => {
    const voipProvider = fakeProvider(() => Promise.resolve());
    const registry = {
      resolve: jest.fn(() => {
        throw new Error('must not be called when a provider override is given');
      }),
    } as unknown as PushProviderRegistry;
    const devices = {} as DeviceRepository;
    const dispatcher = new PushDispatcher(registry, devices);

    const result = await dispatcher.sendToTokens(['voip-token'], message, voipProvider);

    expect(result.delivered).toBe(1);
    expect(voipProvider.send).toHaveBeenCalledWith('voip-token', message);
  });

  it('retires a dead ordinary token via clearPushTokens', async () => {
    const provider = fakeProvider(() =>
      Promise.reject(new PushTokenInvalidError('dead-1', 'unregistered')),
    );
    const registry = { resolve: () => provider } as unknown as PushProviderRegistry;
    const clearPushTokens = jest.fn().mockResolvedValue(1);
    const devices = { clearPushTokens } as unknown as DeviceRepository;
    const dispatcher = new PushDispatcher(registry, devices);

    const result = await dispatcher.sendToTokens(['dead-1'], message);

    expect(result).toEqual({ delivered: 0, failed: 0, retired: 1 });
    expect(clearPushTokens).toHaveBeenCalledWith(['dead-1']);
  });

  it('retires a dead VoIP token via clearVoipPushTokens, never clearPushTokens', async () => {
    const provider = fakeProvider(() =>
      Promise.reject(new PushTokenInvalidError('dead-voip', 'BadDeviceToken')),
    );
    const registry = {} as PushProviderRegistry;
    const clearPushTokens = jest.fn();
    const clearVoipPushTokens = jest.fn().mockResolvedValue(1);
    const devices = { clearPushTokens, clearVoipPushTokens } as unknown as DeviceRepository;
    const dispatcher = new PushDispatcher(registry, devices);

    const result = await dispatcher.sendToTokens(['dead-voip'], message, provider, 'voip');

    expect(result).toEqual({ delivered: 0, failed: 0, retired: 1 });
    expect(clearVoipPushTokens).toHaveBeenCalledWith(['dead-voip']);
    expect(clearPushTokens).not.toHaveBeenCalled();
  });

  it('counts a non-token failure as failed, not retired, and keeps going', async () => {
    const provider = fakeProvider((token) =>
      token === 'bad' ? Promise.reject(new Error('network blip')) : Promise.resolve(),
    );
    const registry = { resolve: () => provider } as unknown as PushProviderRegistry;
    const devices = {} as DeviceRepository;
    const dispatcher = new PushDispatcher(registry, devices);

    const result = await dispatcher.sendToTokens(['bad', 'good'], message);

    expect(result).toEqual({ delivered: 1, failed: 1, retired: 0 });
  });
});
