import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModeratorShiftService } from '../services/moderator-shift.service';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';

/**
 * Guard that enforces Moderator working-shift time windows.
 *
 * Apply with @UseGuards(ShiftActiveGuard) on any moderation action endpoint.
 * Passes through immediately for ADMIN / SUPER_ADMIN regardless of shift.
 * Returns 403 for MODERATOR accounts outside their assigned shift window.
 * If the moderator has no shift assigned, defaults to DENY (safe).
 */
@Injectable()
export class ShiftActiveGuard implements CanActivate {
  private readonly logger = new Logger(ShiftActiveGuard.name);

  constructor(private readonly shiftService: ModeratorShiftService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) return false;

    const roles: string[] = user.roles ?? [];

    // Admins and Super Admins are always permitted — they have no shift constraint.
    if (roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN')) return true;

    // Only enforce for MODERATOR role.
    if (!roles.includes('MODERATOR')) return true;

    const withinShift = await this.shiftService.isWithinShift(user.id);

    if (!withinShift) {
      this.logger.warn(`Moderator ${user.id} attempted action outside shift hours`);
      throw new ForbiddenException(
        'This action is only permitted during your assigned working shift.',
      );
    }

    return true;
  }
}
