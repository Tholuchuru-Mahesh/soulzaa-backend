import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, type Permission } from '../constants';
import type { AuthenticatedUser } from '../interfaces/authenticated-user';

/**
 * Enforces @RequirePermissions(...) on a route. Runs after JwtAuthGuard so
 * `request.user` is populated. Permissions come from the user's token claims;
 * SUPER_ADMIN always passes. Routes without @RequirePermissions are unaffected.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    const roles = user?.roles ?? [];
    if (roles.includes('SUPER_ADMIN')) return true;

    const permissions = user?.permissions ?? [];
    if (required.every((permission) => permissions.includes(permission))) {
      return true;
    }
    throw new ForbiddenException('Insufficient permissions');
  }
}
