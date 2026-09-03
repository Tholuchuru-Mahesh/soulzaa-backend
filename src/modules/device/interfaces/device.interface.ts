import type { DevicePlatform } from '@prisma/client';
import type { PushMessage } from './push-provider.interface';

/**
 * Public contract for the device module — the ONLY surface other modules
 * (session, auth) may depend on. Internals (service, repository, push
 * providers) stay private. The session module registers/references devices
 * through this token; it never touches user_devices directly.
 */
export const DEVICE_SERVICE = Symbol('DEVICE_SERVICE');

/** Device fingerprint supplied by the client on login/registration. */
export interface DeviceInfo {
  deviceIdentifier: string;
  platform: DevicePlatform;
  pushToken?: string;
  deviceName?: string;
  deviceType?: string;
  osVersion?: string;
  appVersion?: string;
  country?: string;
}

/** Per-request context threaded into device operations (audit + geo). */
export interface DeviceContext {
  ip?: string;
  userAgent?: string;
}

/** Result of registering a device on login (drives session binding + alerts). */
export interface RegisterDeviceResult {
  deviceId: string;
  platform: DevicePlatform;
  trusted: boolean;
  isNew: boolean;
  suspicious: boolean;
}

/** Read model of a device for the "my devices" listing. */
export interface DeviceView {
  id: string;
  deviceName: string | null;
  deviceType: string | null;
  platform: DevicePlatform;
  osVersion: string | null;
  appVersion: string | null;
  ipAddress: string | null;
  country: string | null;
  trusted: boolean;
  verified: boolean;
  hasPushToken: boolean;
  lastActiveAt: Date;
  createdAt: Date;
}

export interface IDeviceService {
  /** Upsert a device on login; detect first-seen/country-change → suspicious. */
  registerDevice(
    userId: string,
    info: DeviceInfo,
    ctx: DeviceContext,
  ): Promise<RegisterDeviceResult>;
  /** Resolve a device id from its client identifier (used by session hijack check). */
  getDeviceByIdentifier(userId: string, deviceIdentifier: string): Promise<{ id: string } | null>;
  /** Trust flag for a device (used by session listing). */
  isTrusted(deviceId: string): Promise<boolean>;
  listDevices(
    userId: string,
    currentDeviceId?: string,
  ): Promise<(DeviceView & { current: boolean })[]>;
  trustDevice(userId: string, deviceId: string, ip?: string): Promise<void>;
  untrustDevice(userId: string, deviceId: string): Promise<void>;
  verifyDevice(userId: string, deviceId: string): Promise<void>;
  removeDevice(userId: string, deviceId: string): Promise<void>;
  updatePushToken(
    userId: string,
    deviceId: string,
    pushToken: string | null,
    tokenType?: 'fcm' | 'voip',
  ): Promise<void>;
  renameDevice(userId: string, deviceId: string, name: string): Promise<void>;

  /**
   * Push a message to every registered device of a user.
   *
   * The seam other domains use to reach a phone: they describe *what* to say and
   * this module decides *how* — token resolution, provider selection and retry all
   * stay behind the queue. Enqueues and returns; delivery is asynchronous, so a
   * push that cannot be sent never fails the call that requested it.
   */
  pushToUser(userId: string, message: PushMessage): Promise<void>;
}
