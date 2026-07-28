import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { PolicyEngineService } from 'src/modules/authorization/services/policy-engine.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { LockAccountDto, SuspendAccountDto } from '../dto/account-status.dto';

@Injectable()
export class AccountLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly authCacheService: AuthorizationCacheService,
    private readonly roleResolver: RoleResolver,
    private readonly policyEngine: PolicyEngineService,
  ) {}

  /**
   * Rank gate for account-state changes: holding `user.status.*` says an actor may
   * manage accounts, not that they may manage *this* account. Without it an ADMIN
   * could suspend a SUPER_ADMIN, or two peers could lock each other out.
   */
  private async assertMayActOn(actorId: string, targetUserId: string, action: string) {
    const [actorRoles, targetRoles] = await Promise.all([
      this.roleResolver.getRoleNames(actorId),
      this.roleResolver.getRoleNames(targetUserId),
    ]);

    const allowed = await this.policyEngine.evaluate({
      actorUserId: actorId,
      actorRoles,
      action,
      targetUserId,
      targetRoles,
    });

    if (!allowed) {
      throw new ForbiddenException(`Insufficient authority to perform '${action}' on this account`);
    }
  }

  /**
   * Activates an account.
   */
  async activateAccount(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    await this.assertMayActOn(actorId, userId, 'user.status.activate');

    if (user.status === AccountStatus.DELETED) {
      throw new BadRequestException(`Cannot activate deleted account`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: AccountStatus.ACTIVE, updatedBy: actorId },
    });

    await this.authCacheService.invalidateUser(userId);

    return {
      message: `Account '${user.username}' activated successfully`,
      userId: user.id,
      previousStatus: user.status,
      newStatus: updatedUser.status,
    };
  }

  /**
   * Suspends an account with an optional reason.
   */
  async suspendAccount(userId: string, dto: SuspendAccountDto, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    await this.assertMayActOn(actorId, userId, 'user.status.suspend');

    if (user.status === AccountStatus.DELETED) {
      throw new BadRequestException(`Cannot suspend deleted account`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: AccountStatus.SUSPENDED, updatedBy: actorId },
    });

    // Invalidate auth cache & force logout active session
    await this.forceLogout(userId, actorId);

    return {
      message: `Account '${user.username}' suspended successfully`,
      userId: user.id,
      reason: dto.reason,
      durationDays: dto.durationDays,
      previousStatus: user.status,
      newStatus: updatedUser.status,
    };
  }

  /**
   * Reactivates a suspended or inactive account.
   */
  async reactivateAccount(userId: string, actorId: string) {
    return this.activateAccount(userId, actorId);
  }

  /**
   * Locks an account due to security or compliance policy.
   */
  async lockAccount(userId: string, dto: LockAccountDto, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    await this.assertMayActOn(actorId, userId, 'user.status.lock');

    if (user.status === AccountStatus.DELETED) {
      throw new BadRequestException(`Cannot lock deleted account`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: AccountStatus.LOCKED, updatedBy: actorId },
    });

    // Force logout active session
    await this.forceLogout(userId, actorId);

    return {
      message: `Account '${user.username}' locked successfully`,
      userId: user.id,
      reason: dto.reason,
      previousStatus: user.status,
      newStatus: updatedUser.status,
    };
  }

  /**
   * Unlocks a locked account.
   */
  async unlockAccount(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    await this.assertMayActOn(actorId, userId, 'user.status.unlock');

    if (user.status !== AccountStatus.LOCKED) {
      throw new BadRequestException(`Account '${user.username}' is not in locked status`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: AccountStatus.ACTIVE, updatedBy: actorId },
    });

    await this.authCacheService.invalidateUser(userId);

    return {
      message: `Account '${user.username}' unlocked successfully`,
      userId: user.id,
      previousStatus: user.status,
      newStatus: updatedUser.status,
    };
  }

  /**
   * Force logout user sessions and invalidates active session tokens in Redis.
   */
  async forceLogout(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    await this.assertMayActOn(actorId, userId, 'user.session.force_logout');

    // Clear session tokens in Redis
    await Promise.all([
      this.cacheService.del(`session:user:${userId}`),
      this.cacheService.del(`session:tokens:${userId}`),
      this.authCacheService.invalidateUser(userId),
    ]);

    return {
      message: `Active sessions for user '${user.username}' invalidated successfully`,
      userId: user.id,
      invalidatedAt: new Date(),
    };
  }
}
