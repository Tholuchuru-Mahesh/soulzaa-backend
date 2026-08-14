import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ModeratorWarningService } from '../services/moderator-warning.service';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';

/**
 * Guard that enforces Level 3 Moderator suspension.
 *
 * Apply with @UseGuards(SuspendedGuard) on any moderation action endpoint.
 * Passes through immediately for ADMIN / SUPER_ADMIN.
 * Returns 403 for MODERATOR accounts with an active Level 3 warning.
 */
@Injectable()
export class SuspendedGuard implements CanActivate {
  private readonly logger = new Logger(SuspendedGuard.name);

  constructor(private readonly warningService: ModeratorWarningService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) return false;

    const roles: string[] = user.roles ?? [];

    // Admins and Super Admins are always permitted
    if (roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN')) return true;

    // Only enforce for MODERATOR role
    if (!roles.includes('MODERATOR')) return true;

    const suspended = await this.warningService.isSuspended(user.id);

    if (suspended) {
      this.logger.warn(`Suspended moderator ${user.id} attempted action`);
      throw new ForbiddenException(
        'Your account is currently suspended due to an active Level 3 warning.',
      );
    }

    return true;
  }
}
