import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AccountStatus } from '@prisma/client';
import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import {
  AUTH_SERVICE,
  type AuthContext,
  type IAuthService,
} from 'src/modules/auth/interfaces/auth.interface';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  ADMIN_IDENTITY_SERVICE,
  type IAdminIdentityService,
} from '../interfaces/admin-identity.interface';
import type { CreateAdminDto } from '../dto/create-admin.dto';

/** Shape returned by the admin roster. Deliberately thin. */
export interface AdminSummary {
  id: string;
  username: string;
  status: AccountStatus;
}

/**
 * Admin account provisioning.
 *
 * Enforces the four §1 rules that all reduce to one principle — only Super Admin
 * may change who is staff:
 *
 *  1. Only SUPER_ADMIN can create an Admin.
 *  2. An ADMIN therefore cannot create another Admin (falls out of rule 1).
 *  3. A SUPER_ADMIN target can never be suspended or deleted.
 *  4. Only SUPER_ADMIN can enumerate Admins.
 *
 * Every check reads roles from ROLE_SOURCE rather than trusting a JWT claim, so
 * a token minted before a demotion cannot still provision.
 */
@Injectable()
export class AdminProvisioningService {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: IAuthService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(ROLE_SOURCE) private readonly roles: IRoleSource,
    private readonly roleService: RoleService,
    @Inject(ADMIN_IDENTITY_SERVICE) private readonly identity: IAdminIdentityService,
    private readonly audit: AuditLogService,
  ) {}

  async createAdmin(actorId: string, dto: CreateAdminDto, ctx: AuthContext) {
    await this.assertSuperAdmin(actorId);

    // Account creation goes through the auth module so password hashing,
    // credential storage and uniqueness rules stay in one place.
    const result = await this.auth.register(
      {
        fullName: dto.fullName,
        username: dto.username,
        mobile: dto.mobile,
        email: dto.email,
        password: dto.password,
        dateOfBirth: dto.dateOfBirth,
        country: dto.country,
      },
      ctx,
    );

    const newAdminId = result.user.id;
    await this.roleService.assignRoleByName(newAdminId, 'ADMIN', actorId);
    // Hide immediately rather than relying on the role event, so there is no
    // window — however brief — in which a new Admin is publicly visible.
    await this.identity.syncHiddenState(newAdminId);

    // Note the absence of `dto` here: the password must never reach the log.
    await this.audit.logAction({
      actorId,
      action: 'admin.created',
      resource: 'admin_account',
      resourceId: newAdminId,
      details: { username: dto.username, email: dto.email },
      ipAddress: ctx.ip,
      status: 'SUCCESS',
    });

    return { id: newAdminId, username: dto.username };
  }

  async setStatus(actorId: string, targetId: string, status: AccountStatus) {
    await this.assertSuperAdmin(actorId);

    const targetRoles = await this.roles.getRoleNames(targetId);
    if (targetRoles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Super Admin accounts cannot be suspended or removed');
    }

    await this.users.setStatus(targetId, status);
    await this.audit.logAction({
      actorId,
      action: 'admin.status_changed',
      resource: 'admin_account',
      resourceId: targetId,
      details: { status },
      status: 'SUCCESS',
    });

    return { id: targetId, status };
  }

  async listAdmins(actorId: string): Promise<AdminSummary[]> {
    await this.assertSuperAdmin(actorId);

    // ADMIN only — Super Admins are not enumerable even here, so a compromised
    // Super Admin session cannot trivially produce the full staff roster.
    const ids = await this.roles.getUserIdsWithAnyRole(['ADMIN']);
    const rows = await Promise.all(ids.map((id) => this.users.findById(id)));
    return rows
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .map((u) => ({ id: u.id, username: u.username, status: u.status }));
  }

  private async assertSuperAdmin(actorId: string): Promise<void> {
    const names = await this.roles.getRoleNames(actorId);
    if (!names.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Only Super Admin may manage Admin accounts');
    }
  }
}
