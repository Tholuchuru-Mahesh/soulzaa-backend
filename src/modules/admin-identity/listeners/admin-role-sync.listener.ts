import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  ROLE_EVENTS,
  type RoleAssignedEvent,
  type RoleRevokedEvent,
} from 'src/modules/authorization/events/role.events';
import {
  ADMIN_IDENTITY_SERVICE,
  type IAdminIdentityService,
} from '../interfaces/admin-identity.interface';

/**
 * Keeps `User.isHiddenAccount` true to the account's roles.
 *
 * Deliberately unconditional — it resyncs on *any* role change rather than only
 * on ADMIN/SUPER_ADMIN ones. Recomputing costs a single cached role lookup, and
 * it removes a class of bug where a role rename, or a role added to HIDDEN_ROLES
 * later, leaves stale flags on accounts that changed under the old rule.
 */
@Injectable()
export class AdminRoleSyncListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(ADMIN_IDENTITY_SERVICE) private readonly identity: IAdminIdentityService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(ROLE_EVENTS.ASSIGNED, (e) =>
      this.identity.syncHiddenState(e.payload.userId),
    );
    this.bus.subscribe<RoleRevokedEvent>(ROLE_EVENTS.REVOKED, (e) =>
      this.identity.syncHiddenState(e.payload.userId),
    );
  }
}
