import { Injectable } from '@nestjs/common';
import { DeviceEventType, DevicePlatform, Prisma, UserDevice } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** A device push token targeted by a login-alert fan-out. */
export interface DevicePushToken {
  deviceId: string;
  pushToken: string;
}

/** One device's delivery capability — see `deliveryTargetsForUser`. */
export interface DeviceDeliveryTarget {
  deviceId: string;
  platform: DevicePlatform;
  pushToken: string | null;
  voipPushToken: string | null;
}

/**
 * Prisma access for the device module: the device registry (user_devices), the
 * trust ledger (trusted_devices) and the audit trail (device_history). Owned by
 * the device module — no other module touches these tables directly.
 */
@Injectable()
export class DeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- user_devices (registry) ----

  getByIdentifier(userId: string, deviceIdentifier: string): Promise<UserDevice | null> {
    return this.prisma.userDevice.findUnique({
      where: { userId_deviceIdentifier: { userId, deviceIdentifier } },
    });
  }

  getById(id: string): Promise<UserDevice | null> {
    return this.prisma.userDevice.findFirst({ where: { id, deletedAt: null } });
  }

  /** Upsert a device on login (idempotent by userId + deviceIdentifier). */
  upsert(input: {
    userId: string;
    deviceIdentifier: string;
    platform: DevicePlatform;
    pushToken?: string | null;
    deviceName?: string | null;
    deviceType?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
    ipAddress?: string | null;
    country?: string | null;
  }): Promise<UserDevice> {
    const { userId, deviceIdentifier, platform } = input;
    const common = {
      platform,
      pushToken: input.pushToken ?? undefined,
      deviceName: input.deviceName ?? undefined,
      deviceType: input.deviceType ?? undefined,
      osVersion: input.osVersion ?? undefined,
      appVersion: input.appVersion ?? undefined,
      ipAddress: input.ipAddress ?? undefined,
      country: input.country ?? undefined,
    };
    return this.prisma.userDevice.upsert({
      where: { userId_deviceIdentifier: { userId, deviceIdentifier } },
      create: { userId, deviceIdentifier, ...common, lastActiveAt: new Date() },
      update: { ...common, lastActiveAt: new Date(), deletedAt: null },
    });
  }

  listActive(userId: string): Promise<UserDevice[]> {
    return this.prisma.userDevice.findMany({
      where: { userId, deletedAt: null },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  /** Push tokens for a user's active devices, optionally excluding one. */
  async pushTokensForUser(userId: string, excludeDeviceId?: string): Promise<DevicePushToken[]> {
    const rows = await this.prisma.userDevice.findMany({
      where: {
        userId,
        deletedAt: null,
        pushToken: { not: null },
        ...(excludeDeviceId ? { id: { not: excludeDeviceId } } : {}),
      },
      select: { id: true, pushToken: true },
    });
    return rows.map((r) => ({ deviceId: r.id, pushToken: r.pushToken! }));
  }

  /**
   * Every active device's delivery capability, for a producer that needs to
   * route per-device (a call: iOS devices with a VoIP token ring even when
   * backgrounded/killed; everything else — including iOS devices with no VoIP
   * token yet — falls back to the normal alert push). Rows with neither token
   * are still returned, not filtered out — a device the caller cannot reach at
   * all is information, not something to silently drop.
   */
  async deliveryTargetsForUser(
    userId: string,
    excludeDeviceId?: string,
  ): Promise<DeviceDeliveryTarget[]> {
    const rows = await this.prisma.userDevice.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(excludeDeviceId ? { id: { not: excludeDeviceId } } : {}),
      },
      select: { id: true, platform: true, pushToken: true, voipPushToken: true },
    });
    return rows.map((r) => ({
      deviceId: r.id,
      platform: r.platform,
      pushToken: r.pushToken,
      voipPushToken: r.voipPushToken,
    }));
  }

  updateVoipPushToken(id: string, voipPushToken: string | null): Promise<UserDevice> {
    return this.prisma.userDevice.update({ where: { id }, data: { voipPushToken } });
  }

  setTrust(id: string, trusted: boolean): Promise<UserDevice> {
    return this.prisma.userDevice.update({
      where: { id },
      data: { trusted, trustedAt: trusted ? new Date() : null },
    });
  }

  setVerified(id: string): Promise<UserDevice> {
    return this.prisma.userDevice.update({
      where: { id },
      data: { verified: true, verifiedAt: new Date() },
    });
  }

  updatePushToken(id: string, pushToken: string | null): Promise<UserDevice> {
    return this.prisma.userDevice.update({ where: { id }, data: { pushToken } });
  }

  /**
   * Retire push tokens the provider has told us are permanently dead (app
   * uninstalled, token rotated).
   *
   * Matched by *token*, not by device id, and deliberately not scoped to a user:
   * FCM issues a token per app-install, so the one that just came back dead is the
   * one to clear wherever it appears. The device row survives — the user still owns
   * that phone, it simply cannot be reached until the app registers a fresh token.
   */
  async clearPushTokens(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const { count } = await this.prisma.userDevice.updateMany({
      where: { pushToken: { in: tokens } },
      data: { pushToken: null },
    });
    return count;
  }

  /** Same as {@link clearPushTokens}, for the separate VoIP token column. */
  async clearVoipPushTokens(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const { count } = await this.prisma.userDevice.updateMany({
      where: { voipPushToken: { in: tokens } },
      data: { voipPushToken: null },
    });
    return count;
  }

  rename(id: string, deviceName: string): Promise<UserDevice> {
    return this.prisma.userDevice.update({ where: { id }, data: { deviceName } });
  }

  softRemove(id: string): Promise<UserDevice> {
    return this.prisma.userDevice.update({
      where: { id },
      data: { deletedAt: new Date(), pushToken: null, trusted: false, trustedAt: null },
    });
  }

  // ---- trusted_devices (ledger) ----

  grantTrust(userId: string, deviceId: string, trustedByIp?: string | null): Promise<void> {
    return this.prisma.trustedDevice
      .upsert({
        where: { deviceId },
        create: { userId, deviceId, trustedByIp: trustedByIp ?? null },
        update: { trustedByIp: trustedByIp ?? null, trustedAt: new Date(), revokedAt: null },
      })
      .then(() => undefined);
  }

  revokeTrust(deviceId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.trustedDevice.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ---- device_history (audit) ----

  recordEvent(input: {
    userId: string;
    deviceId?: string | null;
    event: DeviceEventType;
    ip?: string | null;
    country?: string | null;
    userAgent?: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    return this.prisma.deviceHistory
      .create({
        data: {
          userId: input.userId,
          deviceId: input.deviceId ?? null,
          event: input.event,
          ip: input.ip ?? null,
          country: input.country ?? null,
          userAgent: input.userAgent ?? null,
          metadata: input.metadata,
        },
      })
      .then(() => undefined);
  }
}
