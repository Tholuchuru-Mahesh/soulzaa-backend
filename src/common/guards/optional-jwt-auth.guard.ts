import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthenticatedUser } from '../interfaces/authenticated-user';

/**
 * Optional JWT auth. Unlike JwtAuthGuard it never rejects: when a valid Bearer
 * is present `request.user` is populated (so handlers can personalise), and when
 * it's missing/invalid the request proceeds anonymously. Use together with
 * @Public() on a globally-guarded route so the global JwtAuthGuard steps aside
 * and this guard runs its best-effort authentication.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // No / invalid token — continue anonymously.
    }
    return true;
  }

  handleRequest<TUser = AuthenticatedUser>(_err: unknown, user: TUser): TUser {
    // Return the user when present; never throw on a missing/invalid token.
    return (user || undefined) as TUser;
  }
}
