import { Inject, Injectable, Logger } from '@nestjs/common';
import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import type { IAdminIdentityService } from '../interfaces/admin-identity.interface';

/**
 * Roles whose holders must never surface to ordinary users.
 *
 * MODERATOR and the other workforce roles are deliberately absent: they operate
 * in public and are meant to be seen. Only Admin and Super Admin are hidden.
 */
export const HIDDEN_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

const HIDDEN_ROLE_SET: ReadonlySet<string> = new Set<string>(HIDDEN_ROLES);

/**
 * Owns `User.isHiddenAccount` — the denormalised projection of "this account
 * holds a hidden role". Every read path filters on that column rather than
 * resolving roles per request, so invisibility costs no extra query.
 *
 * This service is the column's only writer, and it writes through IUsersService
 * because the users table belongs to the users module.
 */
@Injectable()
export class AdminIdentityService implements IAdminIdentityService {
  private readonly logger = new Logger(AdminIdentityService.name);

  constructor(
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(ROLE_SOURCE) private readonly roles: IRoleSource,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  async syncHiddenState(userId: string): Promise<void> {
    const names = await this.roles.getRoleNames(userId);
    const shouldHide = names.some((name) => HIDDEN_ROLE_SET.has(name));
    await this.users.setHiddenAccount(userId, shouldHide);
    // The profile snapshot is cached and carries the flag; without this a
    // freshly-promoted Admin stays visible until the TTL lapses.
    await this.profiles.invalidateProfile(userId);
  }

  async isHidden(userId: string): Promise<boolean> {
    const user = await this.users.findById(userId);
    return user?.isHiddenAccount ?? false;
  }

  async backfill(): Promise<{ scanned: number; hidden: number }> {
    const holders = await this.roles.getUserIdsWithAnyRole([...HIDDEN_ROLES]);
    for (const userId of holders) {
      await this.users.setHiddenAccount(userId, true);
      await this.profiles.invalidateProfile(userId);
    }
    this.logger.log(`Backfilled ${holders.length} hidden account(s)`);
    return { scanned: holders.length, hidden: holders.length };
  }
}
