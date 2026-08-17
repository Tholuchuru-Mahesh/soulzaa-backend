import { ConflictException, NotFoundException } from '@nestjs/common';
import { DeviceChangeRequestStatus } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DEVICE_EVENTS } from '../events/device.events';
import { ModeratorDeviceBindingService } from './moderator-device-binding.service';
import type { StaffIpAllowlistService } from './staff-ip-allowlist.service';

function request(over: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    moderatorId: 'mod-1',
    oldDeviceId: 'device-old',
    newDeviceInfo: { deviceIdentifier: 'device-new', platform: 'ANDROID' },
    status: DeviceChangeRequestStatus.PENDING,
    ...over,
  };
}

describe('ModeratorDeviceBindingService — two-tier device change approval', () => {
  let prisma: {
    device_change_requests: {
      findUnique: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    deviceHistory: { create: jest.Mock };
    userDevice: {
      update: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
      findMany: jest.Mock;
    };
    staffAllowedIp: { create: jest.Mock };
    userRole: { findMany: jest.Mock };
  };
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let staffIpAllowlist: { addIp: jest.Mock };
  let service: ModeratorDeviceBindingService;

  beforeEach(() => {
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    prisma = {
      device_change_requests: {
        findUnique: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ ...request(), ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ ...request(), ...data })),
      },
      deviceHistory: { create: jest.fn().mockResolvedValue({}) },
      userDevice: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      staffAllowedIp: {
        create: jest.fn().mockResolvedValue({}),
      },
      userRole: {
        findMany: jest.fn().mockResolvedValue([{ role: { name: 'MODERATOR' } }]),
      },
    };
    staffIpAllowlist = { addIp: jest.fn().mockResolvedValue({}) };
    service = new ModeratorDeviceBindingService(
      prisma as unknown as PrismaService,
      bus as unknown as IEventBus,
      staffIpAllowlist as unknown as StaffIpAllowlistService,
    );
  });

  describe('approveDeviceChange', () => {
    it('approves a request directly from PENDING status', async () => {
      prisma.device_change_requests.findUnique.mockResolvedValue(
        request({
          status: DeviceChangeRequestStatus.PENDING,
          newDeviceInfo: { deviceIdentifier: 'device-new', ip: '192.168.1.50' },
        }),
      );

      const result = await service.approveDeviceChange('req-1', 'admin-1');

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_APPROVED,
          payload: { requestId: 'req-1', moderatorId: 'mod-1', approvedBy: 'admin-1' },
        }),
      );
      expect(prisma.userDevice.upsert).toHaveBeenCalled();
      expect(staffIpAllowlist.addIp).toHaveBeenCalledWith(
        'mod-1',
        '192.168.1.50/32',
        'Auto-registered from approved device change',
        'admin-1',
      );
      expect(prisma.device_change_requests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1' },
          data: expect.objectContaining({
            status: DeviceChangeRequestStatus.APPROVED,
            reviewedBy: 'admin-1',
          }),
        }),
      );
      expect(result.status).toBe(DeviceChangeRequestStatus.APPROVED);
    });

    it('approves a request once it has been Manager-reviewed', async () => {
      prisma.device_change_requests.findUnique.mockResolvedValue(
        request({
          status: DeviceChangeRequestStatus.MANAGER_REVIEWED,
          managerReviewedBy: 'manager-1',
          managerReviewedAt: new Date('2026-08-14T00:00:00Z'),
        }),
      );

      const result = await service.approveDeviceChange('req-1', 'admin-1');

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_APPROVED }),
      );
      expect(prisma.userDevice.upsert).toHaveBeenCalled();
      expect(prisma.device_change_requests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1' },
          data: expect.objectContaining({
            status: DeviceChangeRequestStatus.APPROVED,
            reviewedBy: 'admin-1',
          }),
        }),
      );
      expect(result.status).toBe(DeviceChangeRequestStatus.APPROVED);
    });

    it('refuses to re-approve an already-decided request', async () => {
      prisma.device_change_requests.findUnique.mockResolvedValue(
        request({ status: DeviceChangeRequestStatus.APPROVED }),
      );

      await expect(service.approveDeviceChange('req-1', 'admin-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws when the request does not exist', async () => {
      prisma.device_change_requests.findUnique.mockResolvedValue(null);

      await expect(service.approveDeviceChange('missing', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('managerReviewDeviceChange', () => {
    it('stamps the Manager-review stage distinctly from final approval', async () => {
      prisma.device_change_requests.findUnique.mockResolvedValue(
        request({ status: DeviceChangeRequestStatus.PENDING }),
      );

      await service.managerReviewDeviceChange('req-1', 'manager-1', 'looks fine');

      expect(prisma.device_change_requests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1' },
          data: expect.objectContaining({
            status: DeviceChangeRequestStatus.MANAGER_REVIEWED,
            managerReviewedBy: 'manager-1',
          }),
        }),
      );
    });

    it('refuses to review a request that is not PENDING', async () => {
      prisma.device_change_requests.findUnique.mockResolvedValue(
        request({ status: DeviceChangeRequestStatus.MANAGER_REVIEWED }),
      );

      await expect(service.managerReviewDeviceChange('req-1', 'manager-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('assertSingleDeviceByIdentifier', () => {
    it('no-ops for non-moderator accounts without querying devices', async () => {
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: 'CONSUMER' } }]);

      await expect(
        service.assertSingleDeviceByIdentifier('user-1', 'device-abc'),
      ).resolves.toBeUndefined();

      expect(prisma.userDevice.findMany).not.toHaveBeenCalled();
      expect(prisma.userDevice.upsert).not.toHaveBeenCalled();
    });

    it('succeeds and upserts a new row when the moderator has no existing devices', async () => {
      prisma.userDevice.findMany.mockResolvedValue([]);

      await expect(
        service.assertSingleDeviceByIdentifier('mod-1', 'device-abc'),
      ).resolves.toBeUndefined();

      expect(prisma.userDevice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_deviceIdentifier: { userId: 'mod-1', deviceIdentifier: 'device-abc' } },
        }),
      );
    });

    it('succeeds without conflict on a repeat login from the same device identifier', async () => {
      // The filter excludes rows matching the current identifier, so a repeat
      // login never sees its own row as "another" device.
      prisma.userDevice.findMany.mockResolvedValue([]);

      await expect(
        service.assertSingleDeviceByIdentifier('mod-1', 'device-abc'),
      ).resolves.toBeUndefined();

      expect(prisma.userDevice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'mod-1',
            deletedAt: null,
            deviceIdentifier: { not: 'device-abc' },
          }),
        }),
      );
      expect(prisma.userDevice.upsert).toHaveBeenCalled();
    });

    it('throws ConflictException when a different device identifier is already bound', async () => {
      prisma.userDevice.findMany.mockResolvedValue([
        { id: 'device-row-1', userId: 'mod-1', deviceIdentifier: 'device-old' },
      ]);

      await expect(service.assertSingleDeviceByIdentifier('mod-1', 'device-new')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.userDevice.upsert).not.toHaveBeenCalled();
    });
  });

  describe('requestDeviceChange — dedupe', () => {
    it('rejects a new request when one is already PENDING', async () => {
      prisma.device_change_requests.findFirst.mockResolvedValue(
        request({ status: DeviceChangeRequestStatus.PENDING }),
      );

      await expect(
        service.requestDeviceChange({ moderatorId: 'mod-1', newDeviceInfo: {} }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.device_change_requests.create).not.toHaveBeenCalled();
    });

    it('rejects a new request when one is already MANAGER_REVIEWED but not yet Admin-approved', async () => {
      prisma.device_change_requests.findFirst.mockResolvedValue(
        request({ status: DeviceChangeRequestStatus.MANAGER_REVIEWED }),
      );

      await expect(
        service.requestDeviceChange({ moderatorId: 'mod-1', newDeviceInfo: {} }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.device_change_requests.create).not.toHaveBeenCalled();
    });

    it('allows a new request when no PENDING/MANAGER_REVIEWED request exists', async () => {
      prisma.device_change_requests.findFirst.mockResolvedValue(null);

      await expect(
        service.requestDeviceChange({ moderatorId: 'mod-1', newDeviceInfo: {} }),
      ).resolves.toBeDefined();
      expect(prisma.device_change_requests.create).toHaveBeenCalled();
    });

    it('publishes ModeratorDeviceChangeRequestedEvent so Admin gets notified', async () => {
      prisma.device_change_requests.findFirst.mockResolvedValue(null);

      const created = await service.requestDeviceChange({
        moderatorId: 'mod-1',
        newDeviceInfo: {},
        reason: 'Automatic: rejected login from unbound device',
      });

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_REQUESTED,
          payload: expect.objectContaining({
            requestId: created.id,
            moderatorId: 'mod-1',
            reason: 'Automatic: rejected login from unbound device',
          }),
        }),
      );
    });

    it('does not publish when the request is rejected as a duplicate', async () => {
      prisma.device_change_requests.findFirst.mockResolvedValue(
        request({ status: DeviceChangeRequestStatus.PENDING }),
      );

      await expect(
        service.requestDeviceChange({ moderatorId: 'mod-1', newDeviceInfo: {} }),
      ).rejects.toThrow(ConflictException);
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('getPendingRequests', () => {
    it('queries for both PENDING and MANAGER_REVIEWED requests so the admin screen keeps showing rows through both approval stages', async () => {
      const pendingRequest = request({ id: 'req-1', status: DeviceChangeRequestStatus.PENDING });
      const managerReviewedRequest = request({
        id: 'req-2',
        status: DeviceChangeRequestStatus.MANAGER_REVIEWED,
      });
      prisma.device_change_requests.findMany.mockResolvedValue([
        pendingRequest,
        managerReviewedRequest,
      ]);

      const result = await service.getPendingRequests();

      expect(prisma.device_change_requests.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: {
              in: [DeviceChangeRequestStatus.PENDING, DeviceChangeRequestStatus.MANAGER_REVIEWED],
            },
          },
        }),
      );
      expect(result).toEqual([pendingRequest, managerReviewedRequest]);
    });

    it('excludes resolved APPROVED/REJECTED requests from the query filter', async () => {
      await service.getPendingRequests();

      const calledWhere = prisma.device_change_requests.findMany.mock.calls[0][0].where;
      expect(calledWhere.status.in).not.toContain(DeviceChangeRequestStatus.APPROVED);
      expect(calledWhere.status.in).not.toContain(DeviceChangeRequestStatus.REJECTED);
    });
  });
});
