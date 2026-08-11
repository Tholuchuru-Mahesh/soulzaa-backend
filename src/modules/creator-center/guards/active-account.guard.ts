import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { USERS_SERVICE, type IUsersService } from 'src/modules/users/interfaces/users.service.interface';

/**
 * Defense-in-depth for Creator Center routes: re-checks the account's current
 * lifecycle status against the database on every request, rather than trusting
 * the JWT (which only carries status at login time — a long-lived access token
 * for an account banned/suspended mid-session must not keep granting creator
 * actions). Mirrors `AuthService.assertActive()`'s rule; applied here instead of
 * globally because only money/room-affecting creator actions need the extra
 * per-request lookup.
 */
@Injectable()
export class ActiveAccountGuard implements CanActivate {
  constructor(@Inject(USERS_SERVICE) private readonly users: IUsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const userId = request.user?.id;
    if (!userId) return false;

    const identity = await this.users.findById(userId);
    if (!identity || identity.status !== 'ACTIVE') {
      throw new BusinessException(
        ERROR_CODES.ACCOUNT_INACTIVE,
        'Account is not active',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
