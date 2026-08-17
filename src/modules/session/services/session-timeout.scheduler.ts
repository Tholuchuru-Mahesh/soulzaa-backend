import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SessionLoggedOutEvent } from '../events/session.events';
import { SessionService } from './session.service';

const MODERATOR_IDLE_TIMEOUT_MINUTES = 30;

@Injectable()
export class SessionTimeoutScheduler {
  private readonly logger = new Logger(SessionTimeoutScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleIdleSessionTimeouts(): Promise<void> {
    const cutoff = new Date(Date.now() - MODERATOR_IDLE_TIMEOUT_MINUTES * 60 * 1000);

    // Find all users with staff/moderator roles
    const staffRoles = await this.prisma.role.findMany({
      where: {
        name: {
          in: [
            'MODERATOR',
            'ADMIN',
            'SUPER_ADMIN',
            'COUNTRY_MANAGER',
            'STATE_MANAGER',
            'REGIONAL_MANAGER',
          ],
        },
      },
      select: { id: true },
    });

    if (staffRoles.length === 0) return;

    const staffUserRoles = await this.prisma.userRole.findMany({
      where: {
        roleId: { in: staffRoles.map((r) => r.id) },
        suspendedAt: null,
      },
      select: { userId: true },
    });

    const staffUserIds = Array.from(new Set(staffUserRoles.map((ur) => ur.userId)));
    if (staffUserIds.length === 0) return;

    // Find active sessions for staff users that are idle past cutoff
    const candidates = await this.prisma.userSession.findMany({
      where: {
        userId: { in: staffUserIds },
        revokedAt: null,
        lastActivityAt: { lt: cutoff },
      },
      select: { id: true, userId: true },
    });

    if (candidates.length === 0) return;

    // `lastActivityAt` only moves on login/refresh, not on every request, so a
    // session can look idle here while the operator is still actively using it
    // (each authenticated request slides the Redis session TTL forward — see
    // JwtStrategy.assertLiveSession). Treat that live cache entry as the source
    // of truth for real activity and only revoke sessions that have actually
    // gone quiet there too.
    const liveness = await Promise.all(
      candidates.map((session) => this.cache.getSession(session.id)),
    );
    const idleSessions = candidates.filter((_, i) => !liveness[i]);

    if (idleSessions.length === 0) return;

    this.logger.log(
      `Expiring ${idleSessions.length} idle staff sessions past ${MODERATOR_IDLE_TIMEOUT_MINUTES}m inactivity`,
    );

    for (const session of idleSessions) {
      try {
        await this.sessionService.revokeSession(session.userId, session.id, 'admin');
        await this.bus.publish(
          new SessionLoggedOutEvent({
            userId: session.userId,
            sessionId: session.id,
            allDevices: false,
          }),
        );
      } catch (err) {
        this.logger.error(
          `Failed to revoke idle session ${session.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
