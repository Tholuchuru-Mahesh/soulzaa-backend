import { Inject, Injectable, Logger } from '@nestjs/common';
import { Notification, NotificationPreference, Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  DEVICE_SERVICE,
  type IDeviceService,
} from 'src/modules/device/interfaces/device.interface';
import {
  NotificationCreatedEvent,
  NotificationPreferencesChangedEvent,
  NotificationReadAllEvent,
  NotificationReadEvent,
} from '../events/notification.events';
import type {
  CreateNotificationInput,
  INotificationService,
  NotificationPreferenceView,
  NotificationView,
  PushIntent,
  UpdateNotificationPreferenceInput,
} from '../interfaces/notification.interface';
import { NotificationPreferenceRepository } from '../repositories/notification-preference.repository';
import { NotificationRepository } from '../repositories/notification.repository';
import { PushPolicy } from './push.policy';

/**
 * Every switch on, nothing snoozed: what a user who has never opened Settings
 * gets — and, deliberately, what a *failed* preference read falls back to. If the
 * database cannot tell us the user turned their calls off, ringing them anyway is
 * the recoverable mistake. Silently swallowing their calls is not.
 */
const DEFAULT_PREFERENCES: NotificationPreferenceView = {
  pushEnabled: true,
  messageEvents: true,
  callEvents: true,
  friendEvents: true,
  followEvents: true,
  inviteEvents: true,
  giftEvents: true,
  systemEvents: true,
  roomEvents: true,
  seatEvents: true,
  treasureEvents: true,
  pkEvents: true,
  announcementEvents: true,
  walletEvents: true,
  gameEvents: true,
  vipEvents: true,
  wealthEvents: true,
  familyEvents: true,
  sound: true,
  vibration: true,
  showPreview: true,
  mutedUntil: null,
};

/**
 * The notification centre: the durable in-app store, the user's delivery
 * preferences, and the one door through which other modules reach a phone.
 *
 * Realtime delivery of the *underlying* events (a message, a call) rides each
 * producer's own socket namespace. What rides this module's namespace is the
 * notification row itself — which is what turns the bell badge from a poll into a
 * push.
 */
@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repo: NotificationRepository,
    private readonly prefs: NotificationPreferenceRepository,
    private readonly policy: PushPolicy,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(DEVICE_SERVICE) private readonly devices: IDeviceService,
  ) {}

  // ---- Store ----

  async create(input: CreateNotificationInput): Promise<NotificationView> {
    const row = await this.repo.create({
      userId: input.userId,
      type: input.type,
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      data: (input.data as Prisma.InputJsonValue | undefined) ?? undefined,
    });
    const notification = this.toView(row);

    // Persist-then-publish: by the time a client hears about a notification, the
    // row it will try to mark read already exists.
    await this.bus.publish(
      new NotificationCreatedEvent({
        userId: input.userId,
        notification,
        unreadCount: await this.unreadCount(input.userId),
      }),
    );
    return notification;
  }

  async list(userId: string, page: number, limit: number): Promise<Paginated<NotificationView>> {
    const { rows, total } = await this.repo.page(userId, (page - 1) * limit, limit);
    return buildPaginated(
      rows.map((r) => this.toView(r)),
      total,
      page,
      limit,
    );
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.repo.markRead(userId, id);
    await this.bus.publish(
      new NotificationReadEvent({
        userId,
        notificationId: id,
        unreadCount: await this.unreadCount(userId),
      }),
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.repo.markAllRead(userId);
    await this.bus.publish(new NotificationReadAllEvent({ userId, unreadCount: 0 }));
  }

  unreadCount(userId: string): Promise<number> {
    return this.repo.unreadCount(userId);
  }

  // ---- Preferences ----

  async preferences(userId: string): Promise<NotificationPreferenceView> {
    try {
      const row = await this.prefs.find(userId);
      return row ? this.toPreferenceView(row) : DEFAULT_PREFERENCES;
    } catch (err) {
      // Fail open — see DEFAULT_PREFERENCES.
      this.logger.warn(
        `preference read failed for ${userId}; falling back to defaults: ${(err as Error).message}`,
      );
      return DEFAULT_PREFERENCES;
    }
  }

  async updatePreferences(
    userId: string,
    input: UpdateNotificationPreferenceInput,
  ): Promise<NotificationPreferenceView> {
    // Prisma reads `undefined` as "leave this column alone" and `null` as "write
    // null", which is exactly the PATCH semantics we want: an omitted key is
    // untouched, and an explicit `mutedUntil: null` cancels the snooze.
    const row = await this.prefs.upsert(userId, input);
    const preferences = this.toPreferenceView(row);

    await this.bus.publish(new NotificationPreferencesChangedEvent({ userId, preferences }));
    return preferences;
  }

  // ---- Push ----

  async notify(userId: string, intent: PushIntent): Promise<boolean> {
    const prefs = await this.preferences(userId);
    if (!this.policy.allows(intent.category, prefs)) return false;

    const unread = this.policy.needsUnreadCount(intent) ? await this.unreadCount(userId) : 0;
    const message = this.policy.resolve(intent, prefs, unread);
    if (!message) return false;

    await this.devices.pushToUser(userId, message);
    return true;
  }

  // ---- Mapping ----

  private toView(n: Notification): NotificationView {
    return {
      id: n.id,
      type: n.type,
      actorId: n.actorId,
      entityType: n.entityType,
      entityId: n.entityId,
      data: n.data,
      read: n.readAt !== null,
      createdAt: n.createdAt,
    };
  }

  private toPreferenceView(p: NotificationPreference): NotificationPreferenceView {
    return {
      pushEnabled: p.pushEnabled,
      messageEvents: p.messageEvents,
      callEvents: p.callEvents,
      friendEvents: p.friendEvents,
      followEvents: p.followEvents,
      inviteEvents: p.inviteEvents,
      giftEvents: p.giftEvents,
      systemEvents: p.systemEvents,
      roomEvents: p.roomEvents,
      seatEvents: p.seatEvents,
      treasureEvents: p.treasureEvents,
      pkEvents: p.pkEvents,
      announcementEvents: p.announcementEvents,
      walletEvents: p.walletEvents,
      gameEvents: p.gameEvents,
      vipEvents: p.vipEvents,
      wealthEvents: p.wealthEvents,
      familyEvents: p.familyEvents,
      sound: p.sound,
      vibration: p.vibration,
      showPreview: p.showPreview,
      mutedUntil: p.mutedUntil,
    };
  }
}
