import { Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DeviceChangeRequestStatus, DeviceEventType, DevicePlatform } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface RequestDeviceChangeInput {
  moderatorId: string;
  oldDeviceId?: string;
  newDeviceInfo: Record<string, unknown>;
  reason?: string;
}

@Injectable()
export class ModeratorDeviceBindingService {
  private readonly logger = new Logger(ModeratorDeviceBindingService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      this.logger.warn(`Moderator ${userId} login blocked: active device already bound (${otherActiveDevices[0].id})`);
      throw new ConflictException(
        'Moderators are restricted to one active device. Submit a Device Change Request to switch devices.',
      );
    }
  }

  /** Moderator submits a request to change bound device */
  async requestDeviceChange(input: RequestDeviceChangeInput) {
    // Check if there is already a PENDING request
    const pending = await this.prisma.device_change_requests.findFirst({
      where: { moderatorId: input.moderatorId, status: DeviceChangeRequestStatus.PENDING },
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
        metadata: JSON.parse(JSON.stringify({ requestId: request.id, newDeviceInfo: input.newDeviceInfo })),
      },
    });

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

  /** Stage 2: Admin approves device change and auto-registers new device */
  async approveDeviceChange(requestId: string, reviewerId: string, reviewNote?: string) {
    const request = await this.prisma.device_change_requests.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Device change request not found');
    if (
      request.status !== DeviceChangeRequestStatus.PENDING &&
      request.status !== DeviceChangeRequestStatus.MANAGER_REVIEWED
    ) {
      throw new ConflictException('Request is no longer pending or manager reviewed.');
    }

    // 1. Soft delete the old device(s)
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

    // 2. Auto-register the new device from newDeviceInfo
    const info = (request.newDeviceInfo ?? {}) as Record<string, any>;
    const deviceIdentifier = (info.deviceIdentifier ?? info.identifier ?? randomUUID()) as string;
    const rawPlatform = (info.platform ?? 'ANDROID').toString().toUpperCase();
    const platform = (['ANDROID', 'IOS', 'WEB'].includes(rawPlatform) ? rawPlatform : 'ANDROID') as DevicePlatform;

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
        ipAddress: (info.ip ?? null) as string | null,
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

  /** Manager/Admin rejects device change */
  async rejectDeviceChange(requestId: string, reviewerId: string, reviewNote?: string) {
    const request = await this.prisma.device_change_requests.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Device change request not found');
    if (
      request.status !== DeviceChangeRequestStatus.PENDING &&
      request.status !== DeviceChangeRequestStatus.MANAGER_REVIEWED
    ) {
      throw new ConflictException('Request is no longer pending review.');
    }

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

  async getPendingRequests() {
    return this.prisma.device_change_requests.findMany({
      where: { status: DeviceChangeRequestStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getModeratorRequests(moderatorId: string) {
    return this.prisma.device_change_requests.findMany({
      where: { moderatorId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
