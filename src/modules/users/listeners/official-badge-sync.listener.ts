import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  ROLE_EVENTS,
  type RoleAssignedEvent,
  type RoleRevokedEvent,
} from 'src/modules/authorization/events/role.events';
import { OfficialBadgeService } from '../services/official-badge.service';

/**
 * Drives the Official badge off role changes.
 *
 * Role management writes the RBAC store and knows nothing about the profile
 * aggregate; this is the sanctioned inbound channel that keeps
 * `user_verification` in step without inverting the dependency.
 */
@Injectable()
export class OfficialBadgeSyncListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly badges: OfficialBadgeService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(ROLE_EVENTS.ASSIGNED, (e) =>
      this.badges.syncOfficialBadge(e.payload.userId),
    );
    this.bus.subscribe<RoleRevokedEvent>(ROLE_EVENTS.REVOKED, (e) =>
      this.badges.syncOfficialBadge(e.payload.userId),
    );
  }
}
