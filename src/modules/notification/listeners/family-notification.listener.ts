import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  FAMILY_EVENTS,
  type FamilyDeletedEvent,
  type FamilyMemberJoinedEvent,
  type FamilyMemberLeftEvent,
} from 'src/modules/families/events/families.events';
import {
  FAMILIES_SERVICE,
  type IFamiliesService,
} from 'src/modules/families/interfaces/families.service.interface';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

interface FamilyNotice {
  type: NotificationType;
  title: string;
  body: string;
}

/**
 * Family membership notifications.
 *
 * **Fan-out is capped on purpose.** Membership churn goes to the family's
 * officers (FOUNDER / CO_FOUNDER / ELDER) rather than to everyone, because
 * those are the people who act on it. A 500-member family would otherwise turn
 * a single join into 500 notification rows and 500 pushes, several times a day
 * — which is both a write amplification problem and, for the other 497 members,
 * pure noise.
 *
 * `DELETED` is the one full fan-out. It is rare, irreversible, and genuinely
 * concerns every member.
 *
 * Family *invitations* are not handled here: the social invitation listener
 * already maps `InvitationType.FAMILY` to `FAMILY_INVITE`.
 */
@Injectable()
export class FamilyNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
    @Inject(FAMILIES_SERVICE) private readonly families: IFamiliesService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<FamilyMemberJoinedEvent>(FAMILY_EVENTS.MEMBER_JOINED, (e) =>
      this.onMemberJoined(e),
    );
    this.bus.subscribe<FamilyMemberLeftEvent>(FAMILY_EVENTS.MEMBER_LEFT, (e) =>
      this.onMemberLeft(e),
    );
    this.bus.subscribe<FamilyDeletedEvent>(FAMILY_EVENTS.DELETED, (e) => this.onDeleted(e));
  }

  private async onMemberJoined(e: FamilyMemberJoinedEvent): Promise<void> {
    const { familyId, userId } = e.payload;
    const officers = await this.families.getOfficerIds(familyId);

    await this.fanOut(familyId, officers, 'joined', userId, {
      type: NotificationType.FAMILY_MEMBER_JOINED,
      title: 'New family member',
      body: 'Someone new joined your family',
    });
  }

  private async onMemberLeft(e: FamilyMemberLeftEvent): Promise<void> {
    const { familyId, userId, kicked } = e.payload;

    if (kicked) {
      // Being removed is the one membership change the subject has to hear
      // about — they cannot see it any other way once they are out.
      await this.fanOut(familyId, [userId], 'removed', null, {
        type: NotificationType.FAMILY_REMOVED,
        title: 'Removed from family',
        body: 'You were removed from your family',
      });
      return;
    }

    const officers = await this.families.getOfficerIds(familyId);
    await this.fanOut(familyId, officers, 'left', userId, {
      type: NotificationType.FAMILY_MEMBER_LEFT,
      title: 'Member left',
      body: 'A member left your family',
    });
  }

  private async onDeleted(e: FamilyDeletedEvent): Promise<void> {
    const { familyId } = e.payload;
    const members = await this.families.getMemberIds(familyId);

    await this.fanOut(familyId, members, 'deleted', null, {
      type: NotificationType.FAMILY_REMOVED,
      title: 'Family disbanded',
      body: 'Your family has been disbanded',
    });
  }

  /**
   * @param exclude the user the event is *about*, who must never be told about
   * their own action — a joiner does not need "someone joined your family".
   */
  private async fanOut(
    familyId: string,
    recipients: string[],
    event: string,
    exclude: string | null,
    notice: FamilyNotice,
  ): Promise<void> {
    const targets = recipients.filter((id) => id !== exclude);
    if (targets.length === 0) return;

    await Promise.all(
      targets.map((userId) =>
        this.guard.once(`family:${familyId}:${userId}:${event}`, GUARD_TTL.WALLET_TXN, async () => {
          await this.notifications.create({
            userId,
            type: notice.type,
            entityType: 'family',
            entityId: familyId,
            data: { event },
          });

          await this.notifications.notify(userId, {
            category: PUSH_CATEGORIES.FAMILY,
            title: notice.title,
            body: notice.body,
            threadId: `family_${familyId}`,
            badge: 'unread',
            data: { type: 'family', familyId, event },
          });
        }),
      ),
    );
  }
}
