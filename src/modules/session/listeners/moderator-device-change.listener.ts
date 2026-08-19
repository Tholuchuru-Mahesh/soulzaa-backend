import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  DEVICE_EVENTS,
  type ModeratorDeviceChangeApprovedEvent,
  type ModeratorDeviceChangeRejectedEvent,
} from 'src/modules/device/events/device.events';
import { SESSION_SERVICE, type ISessionService } from '../interfaces/session.interface';

/**
 * Enforces the Moderator one-device rule end to end: when Admin approves a
 * device-change request or rejects/revokes an approved device, force-logout
 * every session on that account immediately instead of leaving its still-valid
 * access token to expire on its own.
 */
@Injectable()
export class ModeratorDeviceChangeListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(SESSION_SERVICE) private readonly sessions: ISessionService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ModeratorDeviceChangeApprovedEvent>(
      DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_APPROVED,
      (event) =>
        this.sessions.adminForceLogout(event.payload.moderatorId, event.payload.approvedBy),
    );

    this.bus.subscribe<ModeratorDeviceChangeRejectedEvent>(
      DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_REJECTED,
      (event) =>
        this.sessions.adminForceLogout(event.payload.moderatorId, event.payload.rejectedBy),
    );
  }
}
