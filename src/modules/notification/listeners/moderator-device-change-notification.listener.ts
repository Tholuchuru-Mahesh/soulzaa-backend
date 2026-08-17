import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import {
  DEVICE_EVENTS,
  type ModeratorDeviceChangeRequestedEvent,
} from 'src/modules/device/events/device.events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { NotificationService } from '../services/notification.service';

/**
 * A Moderator's device-change request (self-filed, or auto-filed by a blocked
 * login) sits idle until an Admin acts on it. Without this, "goes to the
 * admin as a request" only meant a DB row nobody was told about — Admin had
 * to remember to poll the pending-requests list.
 */
@Injectable()
export class ModeratorDeviceChangeNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(ROLE_SOURCE) private readonly roles: IRoleSource,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ModeratorDeviceChangeRequestedEvent>(
      DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_REQUESTED,
      (e) => this.onRequested(e),
    );
  }

  private async onRequested(e: ModeratorDeviceChangeRequestedEvent): Promise<void> {
    const { requestId, moderatorId, reason } = e.payload;
    // Only Admin/Super Admin can give final approval (spec: "Approved only by
    // Admin"), so only they need to be told a request is waiting.
    const adminIds = await this.roles.getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN']);

    await Promise.all(
      adminIds.map(async (adminId) => {
        await this.notifications.create({
          userId: adminId,
          type: NotificationType.MODERATOR_DEVICE_CHANGE_REQUESTED,
          entityType: 'device_change_request',
          entityId: requestId,
          data: { moderatorId, reason },
        });
        await this.notifications.notify(adminId, {
          category: PUSH_CATEGORIES.SECURITY,
          title: 'Moderator device change pending approval',
          body: 'A moderator was blocked from an unrecognized device and needs your approval to switch devices.',
          data: { type: 'moderator_device_change_requested', requestId },
        });
      }),
    );
  }
}
