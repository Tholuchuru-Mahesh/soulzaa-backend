import { Inject, Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DeviceChangeRequestStatus, DeviceEventType, DevicePlatform } from '@prisma/client';
import { randomUUID } from 'crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  ModeratorDeviceChangeApprovedEvent,
  ModeratorDeviceChangeRejectedEvent,
  ModeratorDeviceChangeRequestedEvent,
} from '../events/device.events';
import { StaffIpAllowlistService } from './staff-ip-allowlist.service';

export interface RequestDeviceChangeInput {
  moderatorId: string;
  oldDeviceId?: string;
  newDeviceInfo: Record<string, unknown>;
  reason?: string;
}

export interface ModeratorDeviceInfoInput {
  deviceName?: string;
  platform?: string;
  osVersion?: string;
  appVersion?: string;
}

@Injectable()
export class ModeratorDeviceBindingService {
  private readonly logger = new Logger(ModeratorDeviceBindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly staffIpAllowlist: StaffIpAllowlistService,
  ) {}

  /**
   * Enforces that a Moderator account has at most ONE active registered device.
   * Throws ConflictException if another active device exists for this user.
   */
  async assertSingleDevice(userId: string, currentDeviceId: string): Promise<void> {
    // Check if the user is a MODERATOR
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });

    const isModerator = userRoles.some((ur) => ur.role.name === 'MODERATOR');
    if (!isModerator) return; // Non-moderator accounts can have multiple devices

    // Count active non-deleted devices for this user excluding current device
    const otherActiveDevices = await this.prisma.userDevice.findMany({
      where: {
        userId,
        deletedAt: null,
        id: { not: currentDeviceId },
      },
    });

    if (otherActiveDevices.length > 0) {
      this.logger.warn(
        `Moderator ${userId} login blocked: active device already bound (${otherActiveDevices[0].id})`,
      );
      throw new ConflictException(
        'Moderators are restricted to one active device. Submit a Device Change Request to switch devices.',
      );
    }
  }

  /**
   * Moderator single-device enforcement keyed by the client-reported device
   * identifier, for callers (staffLogin).
   *
   * Rules:
   * 1. If this device is already active, verified, and trusted (deletedAt == null), allow login and update device info.
   * 2. If this is a newly provisioned moderator with zero prior devices and zero requests, auto-bind on first login.
   * 3. Otherwise (unbound device, replaced device, or explicitly rejected/revoked device), block login and require admin approval.
   */
  async assertSingleDeviceByIdentifier(
    userId: string,
    deviceIdentifier: string,
    deviceInfo?: ModeratorDeviceInfoInput,
  ): Promise<void> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    const isModerator = userRoles.some((ur) => ur.role.name === 'MODERATOR');
    if (!isModerator) return;

    // 1. Check if this exact device is currently active, trusted, and verified
    const thisActiveDevice = await this.prisma.userDevice.findFirst({
      where: {
        userId,
        deviceIdentifier,
        deletedAt: null,
        trusted: true,
      },
    });

    if (thisActiveDevice) {
      await this.prisma.userDevice.update({
        where: { id: thisActiveDevice.id },
        data: {
          lastActiveAt: new Date(),
          ...(deviceInfo?.deviceName ? { deviceName: deviceInfo.deviceName } : {}),
          ...(deviceInfo?.platform ? { platform: deviceInfo.platform as any } : {}),
          ...(deviceInfo?.osVersion ? { osVersion: deviceInfo.osVersion } : {}),
          ...(deviceInfo?.appVersion ? { appVersion: deviceInfo.appVersion } : {}),
        },
      });
      return;
    }

    // 2. Check if this moderator has any prior devices or change requests
    const [anyEverDevice, anyDeviceRequest] = await Promise.all([
      this.prisma.userDevice.findFirst({ where: { userId } }),
      this.prisma.device_change_requests.findFirst({ where: { moderatorId: userId } }),
    ]);

    // Initial first-time login auto-binding for fresh accounts
    if (!anyEverDevice && !anyDeviceRequest) {
      await this.prisma.userDevice.create({
        data: {
          id: randomUUID(),
          userId,
          deviceIdentifier,
          platform: (deviceInfo?.platform as any) || 'ANDROID',
          deviceName: deviceInfo?.deviceName || null,
          osVersion: deviceInfo?.osVersion || null,
          appVersion: deviceInfo?.appVersion || null,
          verified: true,
          verifiedAt: new Date(),
          trusted: true,
          trustedAt: new Date(),
          lastActiveAt: new Date(),
        },
      });
      return;
    }

    // 3. Otherwise, login is blocked
    this.logger.warn(
      `Moderator ${userId} login blocked: device ${deviceIdentifier} is not approved or was revoked/rejected`,
    );
    throw new ConflictException(
      'Moderator device is not approved. Admin approval is required to access the moderator portal.',
    );
  }

  /** Moderator submits a request to change bound device */
  async requestDeviceChange(input: RequestDeviceChangeInput) {
    // Check if there is already a PENDING or MANAGER_REVIEWED request
    const pending = await this.prisma.device_change_requests.findFirst({
      where: {
        moderatorId: input.moderatorId,
        status: {
          in: [DeviceChangeRequestStatus.PENDING, DeviceChangeRequestStatus.MANAGER_REVIEWED],
        },
      },
    });

    if (pending) {
      throw new ConflictException('A device change request is already pending review.');
    }

    const request = await this.prisma.device_change_requests.create({
      data: {
        id: randomUUID(),
        moderatorId: input.moderatorId,
        oldDeviceId: input.oldDeviceId ?? null,
        newDeviceInfo: input.newDeviceInfo as any,
        reason: input.reason ?? null,
        status: DeviceChangeRequestStatus.PENDING,
        updatedAt: new Date(),
      },
    });

    // Record audit in device history
    await this.prisma.deviceHistory.create({
      data: {
        userId: input.moderatorId,
        deviceId: input.oldDeviceId ?? null,
        event: DeviceEventType.CHANGE_REQUESTED,
        metadata: JSON.parse(
          JSON.stringify({ requestId: request.id, newDeviceInfo: input.newDeviceInfo }),
        ),
      },
    });

    await this.bus.publish(
      new ModeratorDeviceChangeRequestedEvent({
        requestId: request.id,
        moderatorId: input.moderatorId,
        reason: input.reason ?? null,
      }),
    );

    return request;
  }

  /** Stage 1: Manager reviews device change request */
  async managerReviewDeviceChange(requestId: string, reviewerId: string, reviewNote?: string) {
    const request = await this.prisma.device_change_requests.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Device change request not found');
    if (request.status !== DeviceChangeRequestStatus.PENDING) {
      throw new ConflictException('Request is no longer in PENDING state.');
    }

    const updated = await this.prisma.device_change_requests.update({
      where: { id: requestId },
      data: {
        status: DeviceChangeRequestStatus.MANAGER_REVIEWED,
        managerReviewedBy: reviewerId,
        managerReviewedAt: new Date(),
        managerReviewNote: reviewNote ?? null,
      },
    });

    await this.prisma.deviceHistory.create({
      data: {
        userId: request.moderatorId,
        event: DeviceEventType.CHANGE_REQUESTED,
        metadata: { stage: 'MANAGER_REVIEWED', requestId, reviewerId, reviewNote },
      },
    });

    return updated;
  }

  /** Stage 2: Admin approves device change and auto-registers new device (also supports switching from REJECTED to APPROVED) */
  async approveDeviceChange(requestId: string, reviewerId: string, reviewNote?: string) {
    const request = await this.prisma.device_change_requests.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Device change request not found');
    if (request.status === DeviceChangeRequestStatus.APPROVED) {
      throw new ConflictException('Request is already approved.');
    }

    // 1. Immediately log out old device(s). Published (not written directly) so
    // the session module's real revoke path runs: DB row + Redis live-session
    // cache + token epoch bump, which is what actually rejects an already-issued
    // access token. A direct `userSession.updateMany` here would only flip a
    // column nothing re-checks until the old device's refresh token is used.
    await this.bus.publish(
      new ModeratorDeviceChangeApprovedEvent({
        requestId: request.id,
        moderatorId: request.moderatorId,
        approvedBy: reviewerId,
      }),
    );

    // 2. Soft delete the old device(s)
    if (request.oldDeviceId) {
      await this.prisma.userDevice.update({
        where: { id: request.oldDeviceId },
        data: { deletedAt: new Date() },
      });
    } else {
      await this.prisma.userDevice.updateMany({
        where: { userId: request.moderatorId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    // 3. Auto-register the new device from newDeviceInfo
    const info = (request.newDeviceInfo ?? {}) as Record<string, any>;
    const deviceIdentifier = (info.deviceIdentifier ?? info.identifier ?? randomUUID()) as string;
    const rawPlatform = (info.platform ?? 'ANDROID').toString().toUpperCase();
    const platform = (
      ['ANDROID', 'IOS', 'WEB'].includes(rawPlatform) ? rawPlatform : 'ANDROID'
    ) as DevicePlatform;

    await this.prisma.userDevice.upsert({
      where: {
        userId_deviceIdentifier: {
          userId: request.moderatorId,
          deviceIdentifier,
        },
      },
      create: {
        id: randomUUID(),
        userId: request.moderatorId,
        deviceIdentifier,
        platform,
        deviceName: (info.deviceName ?? info.model ?? null) as string | null,
        osVersion: (info.osVersion ?? null) as string | null,
        appVersion: (info.appVersion ?? null) as string | null,
        ipAddress: null,
        verified: true,
        verifiedAt: new Date(),
        trusted: true,
        trustedAt: new Date(),
      },
      update: {
        deletedAt: null,
        verified: true,
        verifiedAt: new Date(),
        trusted: true,
        trustedAt: new Date(),
        lastActiveAt: new Date(),
      },
    });

    const updated = await this.prisma.device_change_requests.update({
      where: { id: requestId },
      data: {
        status: DeviceChangeRequestStatus.APPROVED,
        managerReviewedBy: request.managerReviewedBy ?? reviewerId,
        managerReviewedAt: request.managerReviewedAt ?? new Date(),
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote,
      },
    });

    await this.prisma.deviceHistory.create({
      data: {
        userId: request.moderatorId,
        event: DeviceEventType.CHANGE_APPROVED,
        metadata: { requestId, reviewerId, reviewNote, autoRegisteredDevice: deviceIdentifier },
      },
    });

    return updated;
  }

  /** Manager/Admin rejects device change (also supports switching from APPROVED to REJECTED with immediate logout) */
  async rejectDeviceChange(requestId: string, reviewerId: string, reviewNote?: string) {
    const request = await this.prisma.device_change_requests.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Device change request not found');
    if (request.status === DeviceChangeRequestStatus.REJECTED) {
      throw new ConflictException('Request is already rejected.');
    }

    // 1. If device was registered, revoke the device row
    const info = (request.newDeviceInfo ?? {}) as Record<string, any>;
    const deviceIdentifier = (info.deviceIdentifier ?? info.identifier) as string | undefined;
    if (deviceIdentifier) {
      await this.prisma.userDevice.updateMany({
        where: {
          userId: request.moderatorId,
          deviceIdentifier,
        },
        data: {
          deletedAt: new Date(),
          trusted: false,
          verified: false,
        },
      });
    }

    // 2. Force-logout moderator immediately on rejection so any active portal sessions on that device are terminated
    await this.bus.publish(
      new ModeratorDeviceChangeRejectedEvent({
        requestId: request.id,
        moderatorId: request.moderatorId,
        rejectedBy: reviewerId,
      }),
    );

    const updated = await this.prisma.device_change_requests.update({
      where: { id: requestId },
      data: {
        status: DeviceChangeRequestStatus.REJECTED,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote,
      },
    });

    await this.prisma.deviceHistory.create({
      data: {
        userId: request.moderatorId,
        event: DeviceEventType.CHANGE_REJECTED,
        metadata: { requestId, reviewerId, reviewNote },
      },
    });

    return updated;
  }

  /**
   * Requests still awaiting review stage — PENDING or MANAGER_REVIEWED.
   * Enriched with moderator user information (name, email, username).
   */
  async getPendingRequests() {
    const requests = await this.prisma.device_change_requests.findMany({
      where: {
        status: {
          in: [DeviceChangeRequestStatus.PENDING, DeviceChangeRequestStatus.MANAGER_REVIEWED],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const moderatorIds = Array.from(new Set(requests.map((r) => r.moderatorId)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: moderatorIds } },
      select: {
        id: true,
        fullName: true,
        email: true,
        username: true,
        mobile: true,
      },
    });
    const userMap = new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          name: u.fullName ?? u.username,
          email: u.email,
          username: u.username,
          phone: u.mobile,
        },
      ]),
    );

    return requests.map((r) => ({
      ...r,
      moderator: userMap.get(r.moderatorId) ?? null,
    }));
  }

  /**
   * List all device change requests including resolved history (APPROVED, REJECTED).
   */
  async getAllRequests() {
    const requests = await this.prisma.device_change_requests.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const moderatorIds = Array.from(new Set(requests.map((r) => r.moderatorId)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: moderatorIds } },
      select: {
        id: true,
        fullName: true,
        email: true,
        username: true,
        mobile: true,
      },
    });
    const userMap = new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          name: u.fullName ?? u.username,
          email: u.email,
          username: u.username,
          phone: u.mobile,
        },
      ]),
    );

    return requests.map((r) => ({
      ...r,
      moderator: userMap.get(r.moderatorId) ?? null,
    }));
  }

  async getModeratorRequests(moderatorId: string) {
    return this.prisma.device_change_requests.findMany({
      where: { moderatorId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
