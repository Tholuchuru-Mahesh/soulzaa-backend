import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read models for the operations dashboards: platform overview, users, events,
 * tasks & missions, notifications and analytics.
 *
 * Read-only. The console reports on the engines; it never advances an event,
 * completes a task or sends a notification itself.
 */
@Injectable()
export class DashboardOperationsService {
  private readonly logger = new Logger(DashboardOperationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Platform overview: population, live activity and today's growth. */
  async platformOverview() {
    const dayAgo = new Date(Date.now() - DAY_MS);

    const [users, active, newToday, rooms, videoRooms, families] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.audioRoom.count({ where: { status: 'LIVE' } }),
      this.prisma.videoRoom.count({ where: { status: 'LIVE' } }),
      this.prisma.family.count(),
    ]);

    // Distinct users, since one person may hold several sessions.
    const activeSessions = await this.prisma.userSession.findMany({
      where: { lastActivityAt: { gte: dayAgo } },
      select: { userId: true },
      distinct: ['userId'],
    });

    return {
      totalUsers: users,
      activeUsers: active,
      newUsersToday: newToday,
      dailyActiveUsers: activeSessions.length,
      liveAudioRooms: rooms,
      liveVideoRooms: videoRooms,
      totalFamilies: families,
    };
  }

  /** User overview: account state mix, role distribution and newest signups. */
  async userOverview(recentLimit = 25) {
    const [byStatus, roleRows, recent] = await Promise.all([
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.userRole.groupBy({ by: ['roleId'], _count: { _all: true } }),
      this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: recentLimit,
        select: { id: true, username: true, email: true, status: true, createdAt: true },
      }),
    ]);

    // Resolve role names so the console does not have to hold an id→name map.
    const roles = await this.prisma.role.findMany({ select: { id: true, name: true } });
    const roleNameById = new Map(roles.map((r) => [r.id, r.name]));

    return {
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      byRole: roleRows.map((row) => ({
        role: roleNameById.get(row.roleId) ?? row.roleId,
        users: row._count._all,
      })),
      recentSignups: recent,
    };
  }

  /** Events management: lifecycle mix and what is running now. */
  async eventsDashboard(activeLimit = 25) {
    const [byStatus, registrations, participants, active] = await Promise.all([
      this.prisma.eventDefinition.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.eventRegistration.count(),
      this.prisma.eventParticipant.count(),
      this.prisma.eventDefinition.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { endTime: 'asc' },
        take: activeLimit,
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          startTime: true,
          endTime: true,
        },
      }),
    ]);

    return {
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      totalRegistrations: registrations,
      totalParticipants: participants,
      // Soonest to end first — those are the ones needing attention.
      activeEvents: active,
    };
  }

  /** Tasks & missions: definition mix and completion throughput. */
  async tasksDashboard() {
    const [taskCount, missionCount, byResetPolicy, progressRows, completed] = await Promise.all([
      this.prisma.taskDefinition.count(),
      this.prisma.missionDefinition.count(),
      this.prisma.taskDefinition.groupBy({ by: ['resetPolicy'], _count: { _all: true } }),
      this.prisma.taskProgress.count(),
      this.prisma.taskProgress.count({ where: { isCompleted: true } }),
    ]);

    return {
      taskDefinitions: taskCount,
      missionDefinitions: missionCount,
      byResetPolicy: byResetPolicy.map((row) => ({
        resetPolicy: row.resetPolicy,
        tasks: row._count._all,
      })),
      progressRecords: progressRows,
      completedTasks: completed,
      completionRatePct: progressRows > 0 ? Math.round((completed / progressRows) * 100) : 0,
    };
  }

  /** Notification centre: send volume and per-channel delivery health. */
  async notificationsDashboard() {
    const [notifications, byChannel, byStatus, unreadInbox] = await Promise.all([
      this.prisma.enterpriseNotification.count(),
      this.prisma.notificationHistory.groupBy({ by: ['channel'], _count: { _all: true } }),
      this.prisma.notificationHistory.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.notificationInbox.count({ where: { readAt: null } }),
    ]);

    const delivered = byStatus.find((r) => r.status === 'SENT')?._count._all ?? 0;
    const failed = byStatus.find((r) => r.status === 'FAILED')?._count._all ?? 0;
    const attempted = delivered + failed;

    return {
      totalNotifications: notifications,
      byChannel: byChannel.map((row) => ({ channel: row.channel, deliveries: row._count._all })),
      delivered,
      failed,
      // Surfaces a silently broken transport — the reason delivery is now tracked
      // honestly rather than always reporting success.
      deliverySuccessPct: attempted > 0 ? Math.round((delivered / attempted) * 100) : 0,
      unreadInboxItems: unreadInbox,
    };
  }

  /** Analytics dashboard: generated reports, snapshots and exports. */
  async analyticsDashboard(recentLimit = 20) {
    const [reports, snapshots, exports, recent] = await Promise.all([
      this.prisma.analyticsReport.count(),
      this.prisma.analyticsSnapshot.count(),
      this.prisma.reportExport.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.analyticsReport.findMany({
        orderBy: { createdAt: 'desc' },
        take: recentLimit,
        select: { id: true, name: true, domain: true, createdAt: true },
      }),
    ]);

    return {
      totalReports: reports,
      totalSnapshots: snapshots,
      exportsByStatus: exports.map((row) => ({ status: row.status, count: row._count._all })),
      recentReports: recent,
    };
  }
}
