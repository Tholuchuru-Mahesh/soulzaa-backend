import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { PermissionResolver } from '../services/permission-resolver.service';

@Injectable()
export class RbacPermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Unauthenticated user context');
    }

    // Dynamic database-backed permission check via PermissionResolver
    const hasPermissions = await this.permissionResolver.checkUserHasPermissions(
      user.id,
      requiredPermissions,
    );
    if (!hasPermissions) {
      throw new ForbiddenException(
        `Insufficient permissions. Required: [${requiredPermissions.join(', ')}]`,
      );
    }

    return true;
  }
}
