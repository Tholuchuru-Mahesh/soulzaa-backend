import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, DayOfWeek, ScopeType } from '@prisma/client';
import { randomToken } from 'src/modules/auth/services/hash.util';
import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import { PasswordService } from 'src/infra/auth/password.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { ModeratorShiftService } from 'src/modules/moderator-shift/services/moderator-shift.service';
import { UserLocationService } from 'src/modules/organization/services/user-location.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  ADMIN_IDENTITY_SERVICE,
  type IAdminIdentityService,
} from '../interfaces/admin-identity.interface';
import type { CreateModeratorDto } from '../dto/create-moderator.dto';
import type { SetModeratorShiftDto } from '../dto/set-moderator-shift.dto';

const ALL_DAYS_OF_WEEK: DayOfWeek[] = [
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
  DayOfWeek.SATURDAY,
  DayOfWeek.SUNDAY,
];

export interface ModeratorStateDetail {
  id: string;
  name: string;
  code: string;
  moderatorRegionCode: string | null;
  countryId: string;
  countryCode: string | null;
  countryName: string | null;
}

export interface ModeratorShiftDetail {
  id: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  timezone: string;
  daysOfWeek: DayOfWeek[];
  isActive: boolean;
}

/** Shape returned by the moderator roster. */
export interface ModeratorSummary {
  id: string;
  username: string;
  email: string | null;
  status: AccountStatus;
  states?: ModeratorStateDetail[];
  shift?: ModeratorShiftDetail | null;
}

/**
 * Moderator account provisioning (Admin and Super Admin).
 *
 * The admin supplies only email, password, operational state(s), and shift
 * timings. Username and full name are derived automatically. The RBAC
 * scope (`RoleScope`) that actually gates what the moderator can see
 * is assigned from the given states via `setModeratorStates`. Profile
 * geography (`User.country` and its FKs) is never read or written here —
 * it is completely independent of operational scope; see
 * `setModeratorStates`/`getModeratorStates` below.
 *
 *  1. Creating a brand new Moderator account from scratch.
 *  2. Upgrading / converting an existing account (by email) into a hidden
 *     Moderator and setting their staff password.
 */
@Injectable()
export class ModeratorProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(ROLE_SOURCE) private readonly roles: IRoleSource,
    private readonly roleService: RoleService,
    @Inject(ADMIN_IDENTITY_SERVICE) private readonly identity: IAdminIdentityService,
    private readonly audit: AuditLogService,
    private readonly passwords: PasswordService,
    private readonly userLocation: UserLocationService,
    private readonly moderatorShift: ModeratorShiftService,
    private readonly socketManager?: SocketManager,
  ) {}

  async createModerator(
    actorId: string,
    dto: CreateModeratorDto,
    ctx?: { ip?: string; userAgent?: string },
  ) {
    await this.assertAdminOrAbove(actorId);

    const email = dto.email.toLowerCase().trim();

    // Check if user already exists
    const existingUser = await this.prisma.user.findFirst({ where: { email } });

    let userId: string;
    let username: string;

    if (existingUser) {
      userId = existingUser.id;
      username = existingUser.username;

      const currentRoles = (existingUser.roles as string[]) || [];
      const updatedRoles = Array.from(new Set([...currentRoles, 'USER', 'MODERATOR']));

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          roles: updatedRoles as any,
          emailVerifiedAt: existingUser.emailVerifiedAt || new Date(),
          status: 'ACTIVE',
        },
      });
    } else {
      username = await this.generateUsername(email);
      const newUser = await this.users.createIdentity({
        username,
        email,
        fullName: `Moderator ${username}`,
        dateOfBirth: new Date('2000-01-01'),
        roles: ['USER', 'MODERATOR'],
        isGuest: false,
      });
      userId = newUser.id;
    }

    // 2. Set / update password hash
    const passwordHash = await this.passwords.hash(dto.password);
    await this.prisma.userCredential.upsert({
      where: { userId },
      create: { userId, passwordHash, passwordUpdatedAt: new Date() },
      update: { passwordHash, passwordUpdatedAt: new Date() },
    });

    // 3. Ensure AuthProvider is active
    await this.prisma.userAuthProvider.upsert({
      where: { provider_providerUserId: { provider: 'PASSWORD', providerUserId: userId } },
      create: { userId, provider: 'PASSWORD', providerUserId: userId, email },
      update: { email },
    });

    // 4. Assign the MODERATOR role + operational states.
    const { stateIds } = await this.setModeratorStates(userId, dto.stateIds, actorId);

    // 5. Assign the working shift (unchanged by this task — still reads the
    // same shift fields off dto, still deactivates any prior active shift).
    await this.moderatorShift.assignShift({
      moderatorId: userId,
      daysOfWeek:
        dto.shiftDaysOfWeek && dto.shiftDaysOfWeek.length > 0
          ? dto.shiftDaysOfWeek
          : ALL_DAYS_OF_WEEK,
      startHour: dto.shiftStartHour,
      startMinute: dto.shiftStartMinute,
      endHour: dto.shiftEndHour,
      endMinute: dto.shiftEndMinute,
      timezone: dto.shiftTimezone ?? 'UTC',
      assignedBy: actorId,
    });

    // 6. Hide the account immediately from all public surfaces
    await this.identity.syncHiddenState(userId);

    // 7. Audit log
    await this.audit.logAction({
      actorId,
      action: 'moderator.created',
      resource: 'moderator_account',
      resourceId: userId,
      details: { username, email, stateIds },
      ipAddress: ctx?.ip,
      status: 'SUCCESS',
    });

    if (this.socketManager) {
      this.socketManager.emitToUserEverywhere(userId, 'moderator:dashboard_updated', {
        moderatorId: userId,
        type: 'created',
        timestamp: new Date().toISOString(),
      });
    }

    return { id: userId, username, email, stateIds };
  }

  async setModeratorStates(
    userId: string,
    stateIds: string[],
    actorId: string,
  ): Promise<{ stateIds: string[] }> {
    await this.assertAdminOrAbove(actorId);

    const states = await this.prisma.state.findMany({
      where: { id: { in: stateIds } },
      include: { country: true },
    });
    const foundIds = new Set(states.map((s) => s.id));
    const missing = stateIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`State(s) not found: ${missing.join(', ')}`);
    }
    const inactive = states.find((s) => !s.isActive || !s.country.isActive);
    if (inactive) {
      throw new BadRequestException(`Cannot assign moderator to inactive state '${inactive.name}'`);
    }

    const userRole = await this.roleService.assignRoleByName(userId, 'MODERATOR', actorId);

    const existingScopes = await this.prisma.roleScope.findMany({
      where: { userRoleId: userRole.id, scopeType: ScopeType.STATE },
    });
    const targetIds = new Set(stateIds);
    const existingIds = new Set(
      existingScopes.map((s) => s.stateId).filter((id): id is string => !!id),
    );

    const toRemove = existingScopes.filter((s) => s.stateId && !targetIds.has(s.stateId));
    const toAdd = states.filter((s) => !existingIds.has(s.id));

    await Promise.all(toRemove.map((scope) => this.roleService.removeRoleScope(scope.id)));
    await Promise.all(
      toAdd.map((state) =>
        this.roleService.assignRoleScope({
          userRoleId: userRole.id,
          scopeType: ScopeType.STATE,
          countryId: state.countryId,
          stateId: state.id,
        }),
      ),
    );

    if (this.socketManager) {
      this.socketManager.emitToUserEverywhere(userId, 'moderator:scope_updated', {
        moderatorId: userId,
        stateIds,
        timestamp: new Date().toISOString(),
      });
      this.socketManager.emitToUserEverywhere(userId, 'moderator:dashboard_updated', {
        moderatorId: userId,
        type: 'scope_updated',
        timestamp: new Date().toISOString(),
      });
    }

    return { stateIds };
  }

  async getModeratorStates(
    actorId: string,
    targetId: string,
  ): Promise<{ stateIds: string[]; states: ModeratorStateDetail[] }> {
    await this.assertAdminOrAbove(actorId);

    const role = await this.prisma.role.findUnique({ where: { name: 'MODERATOR' } });
    const userRole = role
      ? await this.prisma.userRole.findFirst({
          where: { userId: targetId, roleId: role.id },
          include: {
            roleScopes: {
              where: { scopeType: ScopeType.STATE },
              include: {
                state: {
                  include: { country: true },
                },
              },
            },
          },
        })
      : null;
    if (!userRole) return { stateIds: [], states: [] };

    const stateList: ModeratorStateDetail[] = [];
    const stateIds: string[] = [];

    for (const scope of userRole.roleScopes || []) {
      const sId = scope.stateId || scope.state?.id;
      if (sId) stateIds.push(sId);
      if (scope.state) {
        stateList.push({
          id: scope.state.id,
          name: scope.state.name,
          code: scope.state.code,
          moderatorRegionCode: scope.state.moderatorRegionCode,
          countryId: scope.state.countryId,
          countryCode: scope.state.country?.code ?? null,
          countryName: scope.state.country?.name ?? null,
        });
      }
    }

    return { stateIds, states: stateList };
  }

  async listModerators(actorId: string): Promise<ModeratorSummary[]> {
    await this.assertAdminOrAbove(actorId);

    const ids = await this.roles.getUserIdsWithAnyRole(['MODERATOR']);
    const [rows, userRoles, shifts] = await Promise.all([
      Promise.all(ids.map((id) => this.users.findById(id))),
      this.prisma.userRole.findMany({
        where: { userId: { in: ids }, role: { name: 'MODERATOR' } },
        include: {
          roleScopes: {
            where: { scopeType: ScopeType.STATE },
            include: {
              state: {
                include: { country: true },
              },
            },
          },
        },
      }),
      this.prisma.moderatorShift.findMany({
        where: { moderatorId: { in: ids }, isActive: true },
      }),
    ]);

    const statesByUser = new Map<string, ModeratorStateDetail[]>();
    for (const ur of userRoles) {
      const list: ModeratorStateDetail[] = [];
      for (const rs of ur.roleScopes) {
        if (rs.state) {
          list.push({
            id: rs.state.id,
            name: rs.state.name,
            code: rs.state.code,
            moderatorRegionCode: rs.state.moderatorRegionCode,
            countryId: rs.state.countryId,
            countryCode: rs.state.country?.code ?? null,
            countryName: rs.state.country?.name ?? null,
          });
        }
      }
      statesByUser.set(ur.userId, list);
    }

    const shiftByUser = new Map<string, ModeratorShiftDetail>();
    for (const s of shifts) {
      shiftByUser.set(s.moderatorId, {
        id: s.id,
        startHour: s.startHour,
        startMinute: s.startMinute,
        endHour: s.endHour,
        endMinute: s.endMinute,
        timezone: s.timezone,
        daysOfWeek: s.daysOfWeek,
        isActive: s.isActive,
      });
    }

    return rows
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email ?? null,
        status: u.status,
        states: statesByUser.get(u.id) ?? [],
        shift: shiftByUser.get(u.id) ?? null,
      }));
  }

  async getModeratorShift(
    actorId: string,
    targetId: string,
  ): Promise<{ shift: ModeratorShiftDetail | null }> {
    await this.assertAdminOrAbove(actorId);

    const shift = await this.prisma.moderatorShift.findFirst({
      where: { moderatorId: targetId, isActive: true },
    });

    if (!shift) return { shift: null };

    return {
      shift: {
        id: shift.id,
        startHour: shift.startHour,
        startMinute: shift.startMinute,
        endHour: shift.endHour,
        endMinute: shift.endMinute,
        timezone: shift.timezone,
        daysOfWeek: shift.daysOfWeek,
        isActive: shift.isActive,
      },
    };
  }

  async setModeratorShift(
    actorId: string,
    targetId: string,
    dto: SetModeratorShiftDto,
  ): Promise<{ shift: ModeratorShiftDetail }> {
    await this.assertAdminOrAbove(actorId);

    const user = await this.users.findById(targetId);
    if (!user) {
      throw new NotFoundException(`User with ID '${targetId}' not found`);
    }

    const result = await this.moderatorShift.assignShift({
      moderatorId: targetId,
      daysOfWeek:
        dto.shiftDaysOfWeek && dto.shiftDaysOfWeek.length > 0
          ? dto.shiftDaysOfWeek
          : ALL_DAYS_OF_WEEK,
      startHour: dto.shiftStartHour,
      startMinute: dto.shiftStartMinute,
      endHour: dto.shiftEndHour,
      endMinute: dto.shiftEndMinute,
      timezone: dto.shiftTimezone ?? 'UTC',
      assignedBy: actorId,
    });

    await this.audit.logAction({
      actorId,
      action: 'moderator.shift_updated',
      resource: 'moderator_shift',
      resourceId: targetId,
      details: {
        shiftId: result.id,
        startHour: dto.shiftStartHour,
        startMinute: dto.shiftStartMinute,
        endHour: dto.shiftEndHour,
        endMinute: dto.shiftEndMinute,
        daysOfWeek: dto.shiftDaysOfWeek,
      },
      status: 'SUCCESS',
    });

    if (this.socketManager) {
      this.socketManager.emitToUserEverywhere(targetId, 'moderator:shift_updated', {
        moderatorId: targetId,
        shift: result,
        timestamp: new Date().toISOString(),
      });
      this.socketManager.emitToUserEverywhere(targetId, 'moderator:dashboard_updated', {
        moderatorId: targetId,
        type: 'shift_updated',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      shift: {
        id: result.id,
        startHour: result.startHour,
        startMinute: result.startMinute,
        endHour: result.endHour,
        endMinute: result.endMinute,
        timezone: result.timezone,
        daysOfWeek: result.daysOfWeek,
        isActive: result.isActive,
      },
    };
  }

  async setModeratorStatus(actorId: string, targetId: string, status: AccountStatus) {
    await this.assertAdminOrAbove(actorId);

    const targetRoles = await this.roles.getRoleNames(targetId);
    if (targetRoles.includes('SUPER_ADMIN') || targetRoles.includes('ADMIN')) {
      throw new ForbiddenException('Cannot change status of Admin or Super Admin accounts here');
    }

    await this.users.setStatus(targetId, status);
    await this.audit.logAction({
      actorId,
      action: 'moderator.status_changed',
      resource: 'moderator_account',
      resourceId: targetId,
      details: { status },
      status: 'SUCCESS',
    });

    return { id: targetId, status };
  }

  /** Derives a unique username from the moderator's email, falling back to random. */
  private async generateUsername(email: string): Promise<string> {
    const base = email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 15)
      .padEnd(4, '0');
    for (let i = 0; i < 5; i++) {
      const candidate = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      if (!(await this.users.isUsernameTaken(candidate))) return candidate;
    }
    return `${base}${randomToken(4)}`;
  }

  private async assertAdminOrAbove(actorId: string): Promise<void> {
    const names = await this.roles.getRoleNames(actorId);
    if (!names.includes('ADMIN') && !names.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Only Admin or Super Admin may provision Moderator accounts');
    }
  }
}
