import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../../common/constants';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user';
import { RoleResolver } from '../services/role-resolver.service';

@Injectable()
export class RbacRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roleResolver: RoleResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Unauthenticated user context');
    }

    // Resolve user's complete role set (direct + inherited child roles)
    const userRoles = await this.roleResolver.resolveAllUserRoles(user.id);
    const roleNames = userRoles.map((r) => r.roleName);

    // SUPER_ADMIN bypass
    if (roleNames.includes('SUPER_ADMIN')) {
      return true;
    }

    const hasAnyRole = requiredRoles.some((role) => roleNames.includes(role));
    if (!hasAnyRole) {
      throw new ForbiddenException(
        `Insufficient role. Required one of: [${requiredRoles.join(', ')}]`,
      );
    }

    return true;
  }
}
