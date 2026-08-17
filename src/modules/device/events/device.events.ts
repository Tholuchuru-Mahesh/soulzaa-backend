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
  MODERATOR_DEVICE_CHANGE_REQUESTED: 'device.moderator_change_requested',
  MODERATOR_DEVICE_CHANGE_APPROVED: 'device.moderator_change_approved',
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

/**
 * A Moderator's device-change request was filed (either self-submitted, or
 * auto-filed by staffLogin when a bound Moderator is rejected from an
 * unrecognized device). Admin/Super Admin need to act on it.
 */
export class ModeratorDeviceChangeRequestedEvent extends DomainEvent<{
  requestId: string;
  moderatorId: string;
  reason: string | null;
}> {
  readonly name = DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_REQUESTED;
}

/**
 * Admin approved a Moderator's device-change request. The one-device-per-
 * Moderator rule means the previously bound device must be force-logged-out
 * immediately, not just marked revoked in a column nothing re-checks.
 */
export class ModeratorDeviceChangeApprovedEvent extends DomainEvent<{
  requestId: string;
  moderatorId: string;
  approvedBy: string;
}> {
  readonly name = DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_APPROVED;
}
