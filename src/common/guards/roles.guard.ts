import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type PlatformRole } from '../constants';
import type { AuthenticatedUser } from '../interfaces/authenticated-user';
import { ROLE_SOURCE, type IRoleSource } from '../interfaces/role-source.interface';

/**
 * Enforces @Roles(...) on a route. Runs after JwtAuthGuard, so `request.user`
 * is populated. SUPER_ADMIN always passes.
 *
 * Roles are resolved from the RBAC store rather than the token claim, so a
 * promotion or revocation takes effect on the next request instead of at the
 * next login — the same rule RbacPermissionsGuard applies to permissions.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ROLE_SOURCE) private readonly roleSource: IRoleSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PlatformRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user?.id) throw new ForbiddenException('Insufficient role');

    const roles = await this.roleSource.getRoleNames(user.id);
    if (roles.includes('SUPER_ADMIN') || required.some((r) => roles.includes(r))) {
      return true;
    }
    throw new ForbiddenException('Insufficient role');
  }
}
