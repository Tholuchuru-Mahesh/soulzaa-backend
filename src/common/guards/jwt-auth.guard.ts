import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY, PLATFORM_ROLES, type PlatformRole } from '../constants';
import { ROLE_SOURCE, type IRoleSource } from '../interfaces/role-source.interface';

/**
 * Global JWT guard. Applied app-wide in AppModule; routes decorated with
 * @Public() bypass it. Uses the passport 'jwt' strategy from infra/auth.
 *
 * After authentication it replaces the token's `roles` claim with the roles the
 * RBAC store currently reports. The claim is only a projection minted at login,
 * so it goes stale the moment a role is granted or revoked — and code reading
 * `request.user.roles` to decide access (the audio/video room platform-staff
 * bypasses) would otherwise honour a role the store has already taken away.
 * RolesGuard and RbacPermissionsGuard already resolve per request; this puts the
 * rest of the request on the same authority.
 *
 * Costs one cache-backed lookup per authenticated request, alongside the token
 * epoch and session reads the JWT strategy already performs.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ROLE_SOURCE) private readonly roleSource: IRoleSource,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest();
      if (request?.user?.id) {
        request.user.roles = await this.resolvePlatformRoles(request.user.id);
      }
    }

    return true;
  }

  /**
   * Effective roles narrowed to the platform enum. Custom roles created through
   * role management are still honoured by permission checks; they are dropped
   * here only because `AuthenticatedUser.roles` is typed to the enum.
   */
  private async resolvePlatformRoles(userId: string): Promise<PlatformRole[]> {
    const names = await this.roleSource.getRoleNames(userId);
    return names.filter((name): name is PlatformRole =>
      (PLATFORM_ROLES as readonly string[]).includes(name),
    );
  }
}
