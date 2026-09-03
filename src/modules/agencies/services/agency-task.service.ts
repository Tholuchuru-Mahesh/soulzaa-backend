import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AgencyCommunityService } from './agency-community.service';

const MAX_PAGE_SIZE = 100;

/** What a task's progress looks like once measured. */
export interface AgencyTaskProgress {
  current: string | null;
  target: string | null;
  /** 0–100, clamped. Null when the task has no measurable target. */
  percent: number | null;
}

/**
 * Operational targets an Official sets for an agency.
 *
 * Progress is *derived*, never stored: the figure is recomputed from the same
 * ledgers the rest of the platform reads. A stored counter would drift from
 * the transactions behind it, and this is what an agency is judged on.
 *
 * `MANUAL` is the exception — nothing can measure "conduct an agency event",
 * so those carry no number and are completed by an Official.
 */
@Injectable()
export class AgencyTaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly community: AgencyCommunityService,
  ) {}

  /** The agency's tasks, soonest deadline first. */
  async list(
    agencyId: string,
    options: { status?: 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED'; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_PAGE_SIZE);

    const tasks = await this.prisma.agencyTask.findMany({
      where: { agencyId, ...(options.status ? { status: options.status } : {}) },
      // Soonest deadline first: the list is a to-do, so what expires next
      // matters more than what was created last.
      orderBy: [{ periodEnd: 'asc' }, { createdAt: 'desc' }],
      take: limit,
    });

    const items = await Promise.all(tasks.map((task) => this.withProgress(agencyId, task)));
    return { items, total: items.length };
  }

  /** One task, scoped to the calling agency. */
  async get(agencyId: string, taskId: string) {
    const task = await this.prisma.agencyTask.findFirst({
      where: { id: taskId, agencyId },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return this.withProgress(agencyId, task);
  }

  /** Counts for the tasks screen's summary row. */
  async summary(agencyId: string) {
    const [active, completed, expired] = await Promise.all([
      this.prisma.agencyTask.count({ where: { agencyId, status: 'ACTIVE' } }),
      this.prisma.agencyTask.count({ where: { agencyId, status: 'COMPLETED' } }),
      this.prisma.agencyTask.count({ where: { agencyId, status: 'EXPIRED' } }),
    ]);
    return { active, completed, expired };
  }

  private async withProgress(
    agencyId: string,
    task: {
      id: string;
      title: string;
      description: string | null;
      metric: string;
      targetValue: bigint | null;
      periodStart: Date;
      periodEnd: Date;
      status: string;
      priority: string;
      completedAt: Date | null;
      createdAt: Date;
      assignedById?: string | null;
    },
  ) {
    const progress = await this.measure(agencyId, task);

    // Derived, not stored: a task whose window has closed without the target
    // being met reads as expired even if nothing has run to update the row.
    const isOverdue = task.status === 'ACTIVE' && task.periodEnd.getTime() < Date.now();

    let assignedByName = 'Official Team';
    if (task.assignedById) {
      const assigner = await this.prisma.user.findUnique({
        where: { id: task.assignedById },
        select: { fullName: true, username: true },
      });
      if (assigner) {
        assignedByName = assigner.fullName || assigner.username || 'Official Team';
      }
    }

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      metric: task.metric,
      targetValue: task.targetValue !== null ? task.targetValue.toString() : null,
      priority: task.priority,
      status: task.status === 'ACTIVE' && isOverdue ? 'EXPIRED' : task.status,
      periodStart: task.periodStart,
      periodEnd: task.periodEnd,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      assignedById: task.assignedById ?? null,
      assignedByName,
      progress,
    };
  }

  /**
   * Measures one task against the ledger its metric names.
   *
   * Everything is counted inside the task's own window — progress an agency
   * made before the target was set does not count toward it.
   */
  private async measure(
    agencyId: string,
    task: { metric: string; targetValue: bigint | null; periodStart: Date; periodEnd: Date },
  ): Promise<AgencyTaskProgress> {
    if (task.metric === 'MANUAL' || task.targetValue === null) {
      // Nothing to measure. A manual task is either done or it is not, which
      // the status already says.
      return { current: null, target: null, percent: null };
    }

    const target = task.targetValue;
    const current = await this.currentValue(agencyId, task);

    const percent =
      target > BigInt(0)
        ? Math.min(100, Math.round((Number(current) / Number(target)) * 100))
        : null;

    return { current: current.toString(), target: target.toString(), percent };
  }

  /**
   * The live figure for one metric, over the task's own window.
   *
   * Every branch is filtered by this agency. An unfiltered count here would
   * measure the whole platform and hand every agency a completed task.
   */
  private async currentValue(
    agencyId: string,
    task: { metric: string; periodStart: Date; periodEnd: Date },
  ): Promise<bigint> {
    const gte = task.periodStart;
    const lte = task.periodEnd;

    switch (task.metric) {
      case 'NEW_MEMBERS': {
        const count = await this.prisma.agencyRelationship.count({
          where: { agencyId, effectiveFrom: { gte, lte } },
        });
        return BigInt(count);
      }

      case 'ACTIVE_MEMBERS': {
        const hostIds = await this.community.getActiveHostIds(agencyId);
        if (hostIds.length === 0) return BigInt(0);
        const rows = await this.prisma.userSession.findMany({
          where: { userId: { in: hostIds }, lastActivityAt: { gte, lte } },
          select: { userId: true },
          distinct: ['userId'],
        });
        return BigInt(rows.length);
      }

      case 'COIN_SALES': {
        const sum = await this.prisma.coinSellerUserSaleTransaction.aggregate({
          _sum: { coinAmount: true },
          where: { sellerId: agencyId, status: 'COMPLETED', createdAt: { gte, lte } },
        });
        return sum._sum.coinAmount ?? BigInt(0);
      }

      case 'GIFT_REVENUE': {
        // Gift value sent by the agency's own members, which is what the
        // agency is credited with growing.
        const hostIds = await this.community.getActiveHostIds(agencyId);
        if (hostIds.length === 0) return BigInt(0);
        const sum = await this.prisma.giftTransaction.aggregate({
          _sum: { totalCoinValue: true },
          where: { senderId: { in: hostIds }, createdAt: { gte, lte } },
        });
        return sum._sum.totalCoinValue ?? BigInt(0);
      }

      case 'REWARDS_DISTRIBUTED': {
        const sum = await this.prisma.agencyRewardDistribution.aggregate({
          _sum: { quantity: true },
          where: { agencyId, createdAt: { gte, lte } },
        });
        return BigInt(sum._sum.quantity ?? 0);
      }

      default:
        // An unknown metric measures nothing rather than guessing — a wrong
        // number here would misreport whether a target was met.
        return BigInt(0);
    }
  }
}
