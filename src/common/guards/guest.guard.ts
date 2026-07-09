import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NOT_GUEST_KEY } from '../constants';
import { BusinessException, ERROR_CODES } from '../exceptions';
import { HttpStatus } from '@nestjs/common';
import type { AuthenticatedUser } from '../interfaces/authenticated-user';

/**
 * Blocks guest accounts from routes marked @NotGuest(). Runs after JwtAuthGuard
 * so `request.user` is populated from the access-token claims. Guests must
 * register (promote) before purchasing coins/VIP or creating rooms — the
 * business rule from the PRD. Applied per-route via the @NotGuest() decorator.
 */
@Injectable()
export class GuestGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const guarded = this.reflector.getAllAndOverride<boolean>(NOT_GUEST_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!guarded) return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (user?.isGuest) {
      throw new BusinessException(
        ERROR_CODES.GUEST_FORBIDDEN,
        'Guest accounts must register before performing this action',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
