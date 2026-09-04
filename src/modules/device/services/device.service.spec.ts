import { ConfigService } from '@nestjs/config';
import { DevicePlatform } from '@prisma/client';
import { Queue } from 'bullmq';
import { IEventBus } from 'src/common/events';
import { DeviceRepository } from '../repositories/device.repository';
import { DeviceService } from './device.service';

const CFG = { suspiciousLoginAlerts: true };
const INFO = {
  deviceIdentifier: 'dev-a',
  platform: DevicePlatform.IOS,
  deviceName: "Adi's iPhone",
};

function device(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    userId: 'u1',
    deviceIdentifier: 'dev-a',
    platform: DevicePlatform.IOS,
    deviceName: null,
    deviceType: null,
    osVersion: null,
    appVersion: null,
    pushToken: null,
    ipAddress: null,
    country: null,
    trusted: false,
    trustedAt: null,
    verified: false,
    verifiedAt: null,
    lastActiveAt: new Date(),
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as never;
}

describe('DeviceService', () => {
  let repo: jest.Mocked<
    Pick<
      DeviceRepository,
      | 'getByIdentifier'
      | 'getById'
      | 'upsert'
      | 'listActive'
      | 'setTrust'
      | 'setVerified'
      | 'updatePushToken'
      | 'rename'
      | 'softRemove'
      | 'grantTrust'
      | 'revokeTrust'
      | 'recordEvent'
    >
  >;
  let bus: jest.Mocked<IEventBus>;
  let pushQueue: jest.Mocked<Pick<Queue, 'add'>>;
  let service: DeviceService;

  beforeEach(() => {
    repo = {
      getByIdentifier: jest.fn().mockResolvedValue(null),
      getById: jest.fn().mockResolvedValue(device()),
      upsert: jest.fn().mockResolvedValue(device()),
      listActive: jest.fn().mockResolvedValue([]),
      setTrust: jest.fn().mockResolvedValue(device()),
      setVerified: jest.fn().mockResolvedValue(device()),
      updatePushToken: jest.fn().mockResolvedValue(device()),
      rename: jest.fn().mockResolvedValue(device()),
      softRemove: jest.fn().mockResolvedValue(device()),
      grantTrust: jest.fn().mockResolvedValue(undefined),
      revokeTrust: jest.fn().mockResolvedValue({ count: 1 }),
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    pushQueue = { add: jest.fn().mockResolvedValue({}) };
    const config = { get: () => CFG } as unknown as ConfigService;
    service = new DeviceService(
      repo as unknown as DeviceRepository,
      bus,
      pushQueue as unknown as Queue,
      config,
    );
  });

  describe('registerDevice', () => {
    it('registers a first device without a suspicious alert', async () => {
      repo.listActive.mockResolvedValue([device()]); // only the just-upserted device
      const result = await service.registerDevice('u1', INFO, { ip: '1.2.3.4' });
      expect(result).toMatchObject({ deviceId: 'd1', isNew: true, suspicious: false });
      expect(pushQueue.add).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'device.registered' }),
      );
    });

    it('flags a new device as suspicious when the user already has others, and records it without a push alert', async () => {
      repo.getByIdentifier.mockResolvedValue(null); // first-seen
      repo.upsert.mockResolvedValue(device({ id: 'd2', deviceIdentifier: 'dev-b' }));
      repo.listActive.mockResolvedValue([
        device({ id: 'd1' }),
        device({ id: 'd2', deviceIdentifier: 'dev-b' }),
      ]);
      const result = await service.registerDevice(
        'u1',
        { ...INFO, deviceIdentifier: 'dev-b' },
        { ip: '9.9.9.9' },
      );
      expect(result.suspicious).toBe(true);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'device.suspicious_login' }),
      );
      // Push notification for new login disabled per requirement — see
      // DeviceService.maybeFlagSuspicious's own comment.
      expect(pushQueue.add).not.toHaveBeenCalled();
    });

    it('flags a country change on a known device as suspicious', async () => {
      repo.getByIdentifier.mockResolvedValue(device({ country: 'IN' }));
      repo.upsert.mockResolvedValue(device({ country: 'US' }));
      repo.listActive.mockResolvedValue([device({ id: 'd1' }), device({ id: 'other' })]);
      const result = await service.registerDevice(
        'u1',
        { ...INFO, country: 'US' },
        { ip: '1.1.1.1' },
      );
      expect(result.suspicious).toBe(true);
    });
  });

  it('trustDevice sets the flag + ledger + history', async () => {
    await service.trustDevice('u1', 'd1', '1.2.3.4');
    expect(repo.setTrust).toHaveBeenCalledWith('d1', true);
    expect(repo.grantTrust).toHaveBeenCalledWith('u1', 'd1', '1.2.3.4');
    expect(repo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'TRUSTED' }));
  });

  it('verifyDevice sets verified + emits device.verified', async () => {
    await service.verifyDevice('u1', 'd1');
    expect(repo.setVerified).toHaveBeenCalledWith('d1');
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'device.verified' }));
  });

  it('removeDevice soft-removes, revokes trust and emits device.removed', async () => {
    await service.removeDevice('u1', 'd1');
    expect(repo.softRemove).toHaveBeenCalledWith('d1');
    expect(repo.revokeTrust).toHaveBeenCalledWith('d1');
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'device.removed' }));
  });

  it('rejects operations on a device the caller does not own', async () => {
    repo.getById.mockResolvedValue(device({ userId: 'someone-else' }));
    await expect(service.renameDevice('u1', 'd1', 'x')).rejects.toMatchObject({
      errorCode: 'DEVICE_FORBIDDEN',
    });
  });

  it('throws DEVICE_NOT_FOUND for a missing device', async () => {
    repo.getById.mockResolvedValue(null);
    await expect(service.verifyDevice('u1', 'missing')).rejects.toMatchObject({
      errorCode: 'DEVICE_NOT_FOUND',
    });
  });
});
