import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type PlatformRole } from '../constants';
import type { AuthenticatedUser } from '../interfaces/authenticated-user';

/**
 * Enforces @Roles(...) on a route. Runs after JwtAuthGuard, so `request.user`
 * is populated. SUPER_ADMIN always passes.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PlatformRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    const roles = user?.roles ?? [];
    if (roles.includes('SUPER_ADMIN') || required.some((r) => roles.includes(r))) {
      return true;
    }
    throw new ForbiddenException('Insufficient role');
  }
}
