import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  DEVICE_EVENTS,
  type ModeratorDeviceChangeApprovedEvent,
} from 'src/modules/device/events/device.events';
import { SESSION_SERVICE, type ISessionService } from '../interfaces/session.interface';

/**
 * Enforces the Moderator one-device rule end to end: when Admin approves a
 * device-change request, force-logout every session on the previously bound
 * device instead of leaving its still-valid access token to expire on its
 * own (moderatorrole.txt Device Change Workflow: "Old device access removed").
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
  }
}
