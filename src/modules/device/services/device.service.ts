import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceEventType, UserDevice } from '@prisma/client';
import { Queue } from 'bullmq';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  DeviceRegisteredEvent,
  DeviceRemovedEvent,
  DeviceVerifiedEvent,
  SuspiciousLoginDetectedEvent,
} from '../events/device.events';
import type {
  DeviceContext,
  DeviceInfo,
  DeviceView,
  IDeviceService,
  RegisterDeviceResult,
} from '../interfaces/device.interface';
import type { PushMessage } from '../interfaces/push-provider.interface';
import { DEVICE_JOBS, DEVICE_QUEUES } from '../device.constants';
import { PUSH_CATEGORIES, PUSH_CHANNELS } from '../interfaces/push.constants';
import { DeviceRepository } from '../repositories/device.repository';
import type { UserPushJob } from '../processors/push.processor';

/**
 * Device Management domain service. Owns the device registry, trust ledger and
 * audit trail: registers devices on login (with alert-only suspicious-device
 * detection), manages trust/verification/naming/removal and push tokens, and
 * fans out login alerts through the push queue. Every mutation records a
 * device_history row and publishes the relevant event.
 */
@Injectable()
export class DeviceService implements IDeviceService {
  private readonly alertsEnabled: boolean;

  constructor(
    private readonly repo: DeviceRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @InjectQueue(DEVICE_QUEUES.PUSH) private readonly pushQueue: Queue,
    config: ConfigService,
  ) {
    this.alertsEnabled = Boolean(config.get('push', { infer: true })!.suspiciousLoginAlerts);
  }

  // ---- Registration + suspicious detection ----

  async registerDevice(
    userId: string,
    info: DeviceInfo,
    ctx: DeviceContext,
  ): Promise<RegisterDeviceResult> {
    const existing = await this.repo.getByIdentifier(userId, info.deviceIdentifier);
    const isNew = !existing || existing.deletedAt !== null;
    const countryChanged =
      !isNew && !!info.country && !!existing!.country && info.country !== existing!.country;

    const device = await this.repo.upsert({
      userId,
      deviceIdentifier: info.deviceIdentifier,
      platform: info.platform,
      pushToken: info.pushToken ?? null,
      deviceName: info.deviceName ?? null,
      deviceType: info.deviceType ?? null,
      osVersion: info.osVersion ?? null,
      appVersion: info.appVersion ?? null,
      ipAddress: ctx.ip ?? null,
      country: info.country ?? null,
    });

    await this.repo.recordEvent({
      userId,
      deviceId: device.id,
      event: DeviceEventType.REGISTERED,
      ip: ctx.ip ?? null,
      country: info.country ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    await this.bus.publish(
      new DeviceRegisteredEvent({ userId, deviceId: device.id, platform: device.platform, isNew }),
    );

    // Suspicious only when the user already has other devices — a brand-new
    // account's first device isn't an alert-worthy event.
    const suspicious = await this.maybeFlagSuspicious(
      userId,
      device,
      isNew,
      countryChanged,
      info,
      ctx,
    );

    return {
      deviceId: device.id,
      platform: device.platform,
      trusted: device.trusted,
      isNew,
      suspicious,
    };
  }

  private async maybeFlagSuspicious(
    userId: string,
    device: UserDevice,
    isNew: boolean,
    countryChanged: boolean,
    info: DeviceInfo,
    ctx: DeviceContext,
  ): Promise<boolean> {
    if (!isNew && !countryChanged) return false;

    const otherDevices = (await this.repo.listActive(userId)).filter((d) => d.id !== device.id);
    if (otherDevices.length === 0) return false; // first device on the account

    const reason = isNew ? 'new_device' : 'country_change';
    await this.repo.recordEvent({
      userId,
      deviceId: device.id,
      event: DeviceEventType.SUSPICIOUS_LOGIN,
      ip: ctx.ip ?? null,
      country: info.country ?? null,
      metadata: { reason },
    });
    await this.bus.publish(
      new SuspiciousLoginDetectedEvent({
        userId,
        deviceId: device.id,
        reason,
        ip: ctx.ip ?? null,
        country: info.country ?? null,
      }),
    );

    if (this.alertsEnabled) {
      // The one push that skips the preference gate. A break-in alert the intruder
      // could have silenced from inside the account is not an alert — so this is
      // built here, resolved, rather than going through PushPolicy like everything
      // else. SECURITY rides the default channel and always makes a sound.
      const job: UserPushJob = {
        userId,
        excludeDeviceId: device.id,
        category: PUSH_CATEGORIES.SECURITY,
        channelId: PUSH_CHANNELS.DEFAULT,
        title: 'New login detected',
        body: `A new sign-in from ${info.deviceName ?? info.platform}${info.country ? ` (${info.country})` : ''}. If this wasn't you, secure your account.`,
        data: { type: 'login_alert', deviceId: device.id },
      };
      await this.pushQueue.add(DEVICE_JOBS.LOGIN_ALERT, job);
    }
    return true;
  }

  // ---- Session-facing reads ----

  async getDeviceByIdentifier(
    userId: string,
    deviceIdentifier: string,
  ): Promise<{ id: string } | null> {
    const device = await this.repo.getByIdentifier(userId, deviceIdentifier);
    return device && !device.deletedAt ? { id: device.id } : null;
  }

  async isTrusted(deviceId: string): Promise<boolean> {
    const device = await this.repo.getById(deviceId);
    return device?.trusted ?? false;
  }

  async listDevices(
    userId: string,
    currentDeviceId?: string,
  ): Promise<(DeviceView & { current: boolean })[]> {
    const devices = await this.repo.listActive(userId);
    return devices.map((d) => ({ ...this.toView(d), current: d.id === currentDeviceId }));
  }

  // ---- Commands ----

  async trustDevice(userId: string, deviceId: string, ip?: string): Promise<void> {
    await this.assertOwned(userId, deviceId);
    await this.repo.setTrust(deviceId, true);
    await this.repo.grantTrust(userId, deviceId, ip ?? null);
    await this.repo.recordEvent({
      userId,
      deviceId,
      event: DeviceEventType.TRUSTED,
      ip: ip ?? null,
    });
  }

  async untrustDevice(userId: string, deviceId: string): Promise<void> {
    await this.assertOwned(userId, deviceId);
    await this.repo.setTrust(deviceId, false);
    await this.repo.revokeTrust(deviceId);
    await this.repo.recordEvent({ userId, deviceId, event: DeviceEventType.UNTRUSTED });
  }

  async verifyDevice(userId: string, deviceId: string): Promise<void> {
    await this.assertOwned(userId, deviceId);
    await this.repo.setVerified(deviceId);
    await this.repo.recordEvent({ userId, deviceId, event: DeviceEventType.VERIFIED });
    await this.bus.publish(new DeviceVerifiedEvent({ userId, deviceId }));
  }

  async removeDevice(userId: string, deviceId: string): Promise<void> {
    await this.assertOwned(userId, deviceId);
    await this.repo.revokeTrust(deviceId);
    await this.repo.softRemove(deviceId);
    await this.repo.recordEvent({ userId, deviceId, event: DeviceEventType.REMOVED });
    await this.bus.publish(new DeviceRemovedEvent({ userId, deviceId }));
  }

  async updatePushToken(
    userId: string,
    deviceId: string,
    pushToken: string | null,
    tokenType: 'fcm' | 'voip' = 'fcm',
  ): Promise<void> {
    await this.assertOwned(userId, deviceId);
    if (tokenType === 'voip') {
      await this.repo.updateVoipPushToken(deviceId, pushToken);
    } else {
      await this.repo.updatePushToken(deviceId, pushToken);
    }
    await this.repo.recordEvent({ userId, deviceId, event: DeviceEventType.PUSH_TOKEN_UPDATED });
  }

  /**
   * Push to every device a user owns. Enqueue-and-return by design: the caller
   * (a ringing call, say) must not wait on FCM, and must not fail because FCM did.
   */
  async pushToUser(userId: string, message: PushMessage): Promise<void> {
    const job: UserPushJob = { userId, ...message };
    await this.pushQueue.add(DEVICE_JOBS.USER_PUSH, job);
  }

  async renameDevice(userId: string, deviceId: string, name: string): Promise<void> {
    await this.assertOwned(userId, deviceId);
    await this.repo.rename(deviceId, name);
    await this.repo.recordEvent({
      userId,
      deviceId,
      event: DeviceEventType.RENAMED,
      metadata: { name },
    });
  }

  // ---- Helpers ----

  private async assertOwned(userId: string, deviceId: string): Promise<UserDevice> {
    const device = await this.repo.getById(deviceId);
    if (!device) {
      throw new BusinessException(
        ERROR_CODES.DEVICE_NOT_FOUND,
        'Device not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (device.userId !== userId) {
      throw new BusinessException(
        ERROR_CODES.DEVICE_FORBIDDEN,
        'You do not own this device',
        HttpStatus.FORBIDDEN,
      );
    }
    return device;
  }

  private toView(d: UserDevice): DeviceView {
    return {
      id: d.id,
      deviceName: d.deviceName,
      deviceType: d.deviceType,
      platform: d.platform,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      ipAddress: d.ipAddress,
      country: d.country,
      trusted: d.trusted,
      verified: d.verified,
      hasPushToken: !!d.pushToken,
      lastActiveAt: d.lastActiveAt,
      createdAt: d.createdAt,
    };
  }
}
