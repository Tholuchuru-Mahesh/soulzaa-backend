import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Read models for the moderation dashboards: the report queue, enforcement
 * volume, account standing, and the operational audit log.
 *
 * Read-only. Acting on a report — banning, muting, resolving an appeal — stays
 * with the room moderation services, which enforce the rank rules the console
 * has no business re-implementing.
 */
@Injectable()
export class DashboardModerationService {
  private readonly logger = new Logger(DashboardModerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Moderation dashboard: what is waiting to be actioned, across both room types.
   *
   * Audio and video rooms keep separate report tables, so the queue is reported
   * per surface rather than summed — a moderator works one surface at a time and
   * a combined figure hides which one is backing up.
   */
  async moderationDashboard(queueLimit = 25) {
    const [audioByStatus, videoByStatus, appealsByStatus, pendingAudio, pendingVideo, enforcement] =
      await Promise.all([
        this.prisma.roomReport.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.videoRoomReport.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.roomAppeal.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.roomReport.findMany({
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          take: queueLimit,
        }),
        this.prisma.videoRoomReport.findMany({
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          take: queueLimit,
        }),
        this.enforcementCounts(),
      ]);

    return {
      audioRoomReports: audioByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      videoRoomReports: videoByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      appeals: appealsByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      // Oldest first — the queue is worked front to back.
      pendingAudioQueue: pendingAudio,
      pendingVideoQueue: pendingVideo,
      enforcement,
    };
  }

  /** Enforcement volume and current account standing. */
  private async enforcementCounts() {
    const [kicks, bans, mutes, suspended, locked, banned] = await Promise.all([
      this.prisma.roomKick.count(),
      this.prisma.roomBan.count(),
      this.prisma.roomMute.count(),
      this.prisma.user.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.user.count({ where: { status: 'LOCKED' } }),
      this.prisma.user.count({ where: { status: 'BANNED' } }),
    ]);

    return {
      roomKicks: kicks,
      roomBans: bans,
      roomMutes: mutes,
      suspendedAccounts: suspended,
      lockedAccounts: locked,
      bannedAccounts: banned,
    };
  }

  /**
   * Operational logs: the privileged-action audit trail.
   *
   * Filterable by actor, action and resource because the question an operator
   * actually asks is "who did this to that account", not "show me everything".
   */
  async operationalLogs(filter: {
    actorId?: string;
    action?: string;
    resource?: string;
    limit?: number;
    offset?: number;
  }) {
    const { actorId, action, resource, limit = 50, offset = 0 } = filter;

    const where = {
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(resource ? { resource } : {}),
    };

    const [total, entries, byAction] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
        skip: offset,
      }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 20,
      }),
    ]);

    return {
      total,
      entries,
      topActions: byAction.map((row) => ({ action: row.action, count: row._count._all })),
    };
  }
}
