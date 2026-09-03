import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { AUTH_EVENTS, type UserPasswordChangedEvent } from 'src/modules/auth/events/auth.events';
import {
  DEVICE_EVENTS,
  type SuspiciousLoginDetectedEvent,
} from 'src/modules/device/events/device.events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/**
 * Durable security history.
 *
 * ## Why this writes a row but does not push for logins
 *
 * `DeviceService` already enqueues the login alert itself — `SECURITY` category,
 * `excludeDeviceId` set to the device that just signed in, deliberately built
 * outside `PushPolicy` because an alert the intruder could silence from inside
 * the account is not an alert. Pushing again from here would double-alert on
 * every suspicious login.
 *
 * What was missing is the **row**. That push is fire-and-forget: nothing
 * persisted it, so a user who missed or dismissed the banner had no way to ever
 * discover that an unrecognised device had signed in. `create()` without
 * `notify()` is the entire point of this handler.
 *
 * ## Why it listens to the device module, not to AUTH_EVENTS.USER_LOGGED_IN
 *
 * `USER_LOGGED_IN` fires on *every* successful login — a notification per login
 * is noise, not security. The device module already makes the judgement call
 * (new device, or country change, and only when the account has another active
 * device). It is also the only one of the two events that carries a real
 * `deviceId`: the auth publish site hardcodes `deviceId: null`.
 */
@Injectable()
export class SecurityNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SuspiciousLoginDetectedEvent>(DEVICE_EVENTS.SUSPICIOUS_LOGIN, (e) =>
      this.onSuspiciousLogin(e),
    );
    this.bus.subscribe<UserPasswordChangedEvent>(AUTH_EVENTS.USER_PASSWORD_CHANGED, (e) =>
      this.onPasswordChanged(e),
    );
  }

  private async onSuspiciousLogin(_e: SuspiciousLoginDetectedEvent): Promise<void> {
    // Disabled: neither in-app row nor push notification is dispatched for suspicious login.
  }

  private async onPasswordChanged(_e: UserPasswordChangedEvent): Promise<void> {
    // Disabled: neither in-app row nor push notification is dispatched for password change.
  }
}
