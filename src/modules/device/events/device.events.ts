import type { DevicePlatform } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Device lifecycle events on the EVENT_BUS. Security/analytics subscribe to
 * `device.suspicious_login`; notification consumers can react to registration/
 * removal. Dot-namespaced names (fulfil the spec's device_registered /
 * device_removed / device_verified / suspicious_login_detected).
 */
export const DEVICE_EVENTS = {
  REGISTERED: 'device.registered',
  REMOVED: 'device.removed',
  VERIFIED: 'device.verified',
  SUSPICIOUS_LOGIN: 'device.suspicious_login',
} as const;

export class DeviceRegisteredEvent extends DomainEvent<{
  userId: string;
  deviceId: string;
  platform: DevicePlatform;
  isNew: boolean;
}> {
  readonly name = DEVICE_EVENTS.REGISTERED;
}

export class DeviceRemovedEvent extends DomainEvent<{ userId: string; deviceId: string }> {
  readonly name = DEVICE_EVENTS.REMOVED;
}

export class DeviceVerifiedEvent extends DomainEvent<{ userId: string; deviceId: string }> {
  readonly name = DEVICE_EVENTS.VERIFIED;
}

export class SuspiciousLoginDetectedEvent extends DomainEvent<{
  userId: string;
  deviceId: string;
  reason: 'new_device' | 'country_change';
  ip: string | null;
  country: string | null;
}> {
  readonly name = DEVICE_EVENTS.SUSPICIOUS_LOGIN;
}
