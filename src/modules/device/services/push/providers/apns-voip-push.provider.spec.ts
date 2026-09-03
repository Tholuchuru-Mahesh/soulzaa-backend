import type { ConfigService } from '@nestjs/config';
import { PushTokenInvalidError, type PushMessage } from '../../../interfaces/push-provider.interface';

const sendMock = jest.fn();
const shutdownMock = jest.fn();

jest.mock('@parse/node-apn', () => ({
  __esModule: true,
  default: {
    Provider: jest.fn().mockImplementation(() => ({
      send: sendMock,
      shutdown: shutdownMock,
    })),
    Notification: jest.fn().mockImplementation(function (this: Record<string, unknown>) {
      // A plain, mutable object is enough — the provider only assigns fields
      // onto it and hands it to `provider.send`, never reads them back itself.
    }),
  },
}));

// Imported after the mock so the provider module picks up the mocked module.
import { ApnsVoipPushProvider } from './apns-voip-push.provider';

const fullCreds = {
  apns: {
    keyId: 'KEY123',
    teamId: 'TEAM123',
    bundleId: 'com.soulzaa.app',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  },
};

function configWith(apns: Partial<(typeof fullCreds)['apns']>): ConfigService {
  return { get: () => ({ apns: { ...fullCreds.apns, ...apns } }) } as unknown as ConfigService;
}

const message: PushMessage = {
  title: 'Jordan',
  body: 'Incoming voice call',
  category: 'CALL',
  channelId: 'soulzaa_calls',
  priority: 'high',
  ttlSeconds: 45,
  collapseKey: 'call_abc',
  data: { type: 'call_incoming', callId: 'call-1' },
};

describe('ApnsVoipPushProvider', () => {
  beforeEach(() => {
    sendMock.mockReset();
    shutdownMock.mockReset();
  });

  it('reports unconfigured and refuses to send when APNs credentials are absent', async () => {
    const provider = new ApnsVoipPushProvider(configWith({ privateKey: undefined }));

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.send('tok', message)).rejects.toThrow(/not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('is configured and sends a pure-data voip notification once credentials are present', async () => {
    sendMock.mockResolvedValue({ sent: [{ device: 'tok' }], failed: [] });
    const provider = new ApnsVoipPushProvider(configWith({}));

    expect(provider.isConfigured()).toBe(true);
    await provider.send('device-token', message);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [note, token] = sendMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(token).toBe('device-token');
    expect(note.topic).toBe('com.soulzaa.app.voip');
    expect(note.pushType).toBe('voip');
    expect(note.priority).toBe(10);
    expect(note.collapseId).toBe('call_abc');
    // Pure data — never an `aps.alert`/`sound`/`badge`; the client's own
    // PKPushRegistryDelegate reports the CallKit call, APNs never draws anything.
    expect(note.aps).toBeUndefined();
    expect(note.payload).toMatchObject({
      type: 'call_incoming',
      callId: 'call-1',
      title: 'Jordan',
      body: 'Incoming voice call',
    });
  });

  it('throws PushTokenInvalidError for a dead-token APNs reason', async () => {
    sendMock.mockResolvedValue({
      sent: [],
      failed: [{ device: 'tok', response: { reason: 'BadDeviceToken' } }],
    });
    const provider = new ApnsVoipPushProvider(configWith({}));

    await expect(provider.send('tok', message)).rejects.toBeInstanceOf(PushTokenInvalidError);
  });

  it('throws a plain error for a non-token APNs failure', async () => {
    sendMock.mockResolvedValue({
      sent: [],
      failed: [{ device: 'tok', response: { reason: 'PayloadTooLarge' } }],
    });
    const provider = new ApnsVoipPushProvider(configWith({}));

    await expect(provider.send('tok', message)).rejects.toThrow(/PayloadTooLarge/);
  });
});
