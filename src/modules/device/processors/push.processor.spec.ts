import { DevicePlatform } from '@prisma/client';
import type { DeviceDeliveryTarget } from '../repositories/device.repository';
import type { ApnsVoipPushProvider } from '../services/push/providers/apns-voip-push.provider';
import type { PushFanoutResult } from '../services/push/push.dispatcher';
import { PushProcessor } from './push.processor';

const support = {
  metrics: { observeDuration: jest.fn(), incCompleted: jest.fn(), incFailed: jest.fn() },
};

const zero: PushFanoutResult = { delivered: 0, failed: 0, retired: 0 };

function target(over: Partial<DeviceDeliveryTarget>): DeviceDeliveryTarget {
  return {
    deviceId: 'd1',
    platform: DevicePlatform.ANDROID,
    pushToken: 'push-1',
    voipPushToken: null,
    ...over,
  };
}

function build(rows: DeviceDeliveryTarget[], apnsConfigured = true) {
  const devices = { deliveryTargetsForUser: jest.fn().mockResolvedValue(rows) };
  const sendToTokens = jest.fn().mockResolvedValue(zero);
  const dispatcher = { sendToTokens };
  const apnsVoip = { isConfigured: () => apnsConfigured } as unknown as ApnsVoipPushProvider;
  const processor = new PushProcessor(
    support as never,
    devices as never,
    dispatcher as never,
    apnsVoip,
  );
  return { processor, devices, sendToTokens };
}

describe('PushProcessor', () => {
  it('sends a non-call push to every device over the alert path, ignoring voip tokens', async () => {
    const rows = [
      target({ deviceId: 'android', platform: DevicePlatform.ANDROID, pushToken: 'a-tok' }),
      target({
        deviceId: 'ios',
        platform: DevicePlatform.IOS,
        pushToken: 'i-tok',
        voipPushToken: 'voip-tok',
      }),
    ];
    const { processor, sendToTokens } = build(rows);

    const result = await processor.handle({
      data: { userId: 'u1', category: 'MESSAGE', title: 't', body: 'b', channelId: 'c' },
    } as never);

    expect(sendToTokens).toHaveBeenCalledTimes(1);
    expect(sendToTokens).toHaveBeenCalledWith(
      expect.arrayContaining(['a-tok', 'i-tok']),
      expect.anything(),
    );
    expect(result).toMatchObject({ targets: 2 });
  });

  it('routes an iOS device with a VoIP token through the voip provider when preferVoipOnIos is set', async () => {
    const rows = [
      target({
        deviceId: 'ios',
        platform: DevicePlatform.IOS,
        pushToken: 'i-tok',
        voipPushToken: 'voip-tok',
      }),
      target({ deviceId: 'android', platform: DevicePlatform.ANDROID, pushToken: 'a-tok' }),
    ];
    const { processor, sendToTokens } = build(rows);

    await processor.handle({
      data: {
        userId: 'u1',
        category: 'CALL',
        title: 't',
        body: 'b',
        channelId: 'soulzaa_calls',
        preferVoipOnIos: true,
      },
    } as never);

    expect(sendToTokens).toHaveBeenCalledTimes(2);
    // The Android device's ordinary token still goes through the default (alert) path.
    expect(sendToTokens).toHaveBeenCalledWith(['a-tok'], expect.anything());
    // The iOS device's VoIP token goes through the explicit voip provider + 'voip' kind —
    // its ordinary `pushToken` must NOT also receive a second, duplicate push.
    expect(sendToTokens).toHaveBeenCalledWith(
      ['voip-tok'],
      expect.anything(),
      expect.anything(),
      'voip',
    );
  });

  it('falls back to the alert token for an iOS device with no VoIP token registered yet', async () => {
    const rows = [
      target({ deviceId: 'ios', platform: DevicePlatform.IOS, pushToken: 'i-tok', voipPushToken: null }),
    ];
    const { processor, sendToTokens } = build(rows);

    await processor.handle({
      data: {
        userId: 'u1',
        category: 'CALL',
        title: 't',
        body: 'b',
        channelId: 'soulzaa_calls',
        preferVoipOnIos: true,
      },
    } as never);

    expect(sendToTokens).toHaveBeenCalledTimes(1);
    expect(sendToTokens).toHaveBeenCalledWith(['i-tok'], expect.anything());
  });

  it('never uses the voip path when APNs is not configured, even with a voip token and the flag set', async () => {
    const rows = [
      target({
        deviceId: 'ios',
        platform: DevicePlatform.IOS,
        pushToken: 'i-tok',
        voipPushToken: 'voip-tok',
      }),
    ];
    const { processor, sendToTokens } = build(rows, /* apnsConfigured */ false);

    await processor.handle({
      data: {
        userId: 'u1',
        category: 'CALL',
        title: 't',
        body: 'b',
        channelId: 'soulzaa_calls',
        preferVoipOnIos: true,
      },
    } as never);

    expect(sendToTokens).toHaveBeenCalledTimes(1);
    expect(sendToTokens).toHaveBeenCalledWith(['i-tok'], expect.anything());
  });

  it('returns zero counts without dispatching when the user has no devices', async () => {
    const { processor, sendToTokens } = build([]);

    const result = await processor.handle({
      data: { userId: 'u1', category: 'MESSAGE', title: 't', body: 'b', channelId: 'c' },
    } as never);

    expect(result).toEqual({ targets: 0, delivered: 0, failed: 0, retired: 0 });
    expect(sendToTokens).not.toHaveBeenCalled();
  });

  it('sums delivered/failed/retired across the alert and voip fan-outs', async () => {
    const rows = [
      target({
        deviceId: 'ios',
        platform: DevicePlatform.IOS,
        pushToken: 'i-tok',
        voipPushToken: 'voip-tok',
      }),
      target({ deviceId: 'android', platform: DevicePlatform.ANDROID, pushToken: 'a-tok' }),
    ];
    const devices = { deliveryTargetsForUser: jest.fn().mockResolvedValue(rows) };
    const sendToTokens = jest
      .fn()
      .mockResolvedValueOnce({ delivered: 1, failed: 0, retired: 0 } satisfies PushFanoutResult)
      .mockResolvedValueOnce({ delivered: 0, failed: 1, retired: 1 } satisfies PushFanoutResult);
    const dispatcher = { sendToTokens };
    const apnsVoip = { isConfigured: () => true } as unknown as ApnsVoipPushProvider;
    const processor = new PushProcessor(
      support as never,
      devices as never,
      dispatcher as never,
      apnsVoip,
    );

    const result = await processor.handle({
      data: {
        userId: 'u1',
        category: 'CALL',
        title: 't',
        body: 'b',
        channelId: 'soulzaa_calls',
        preferVoipOnIos: true,
      },
    } as never);

    expect(result).toEqual({ targets: 2, delivered: 1, failed: 1, retired: 1 });
  });
});
