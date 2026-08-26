import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
import { randomUUID } from 'crypto';

export interface AssignModeratorTaskInput {
  taskId: string;
  moderatorId: string;
  assignedBy: string;
  startDate?: Date;
  dueAt?: Date;
  /// Measurable target, e.g. "Review 100 Reports" -> 100. Defaults to 1.
  targetCount?: number;
  /// LOW | MEDIUM | HIGH | URGENT. Defaults to MEDIUM.
  priority?: string;
  /// GENERAL (default) or BAN_USER.
  taskType?: string;
  /// BAN_USER only — the account(s) to be banned. `targetUserIds` supersedes
  /// the singular form; either may be supplied.
  targetUserId?: string;
  targetUserIds?: string[];
  /// BAN_USER only — why.
  banReason?: string;
  notes?: string;
}

/** Task shapes an assignment can take. */
export const ASSIGNMENT_TASK_TYPES = ['GENERAL', 'BAN_USER'] as const;
export type AssignmentTaskType = (typeof ASSIGNMENT_TASK_TYPES)[number];

/** Priorities an Official may set on an assignment, lowest first. */
export const ASSIGNMENT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type AssignmentPriority = (typeof ASSIGNMENT_PRIORITIES)[number];

/** Stored states an assignment may hold. */
export const ASSIGNMENT_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * The status a client sees. `OVERDUE` is *derived*, never stored: an assignment
 * is overdue when it is still open and `dueAt` has passed. Storing it would
 * need a cron to stay truthful, and would go stale the moment one run failed.
 */
export type DerivedAssignmentStatus = AssignmentStatus | 'OVERDUE';

/**
 * `User` carries identity only — the avatar lives on `UserProfile`, which has no
 * relation from here. Both surfaces render an initial-letter avatar, so nothing
 * needs the image and no extra query is worth adding for it.
 */
const USER_SUMMARY_SELECT = {
  id: true,
  username: true,
  fullName: true,
} as const;

/**
 * Priority is stored on the assignment as a label the Official picked. Older
 * rows predating that column fall back to MEDIUM rather than inventing a value
 * from the definition's unrelated Int weight.
 */
/** Upper bound on one ban task, so a single task cannot sweep a whole region. */
export const MAX_BAN_TARGETS = 50;

/**
 * The task's full target list. Falls back to the singular column for rows
 * written before multi-target support.
 */
function banTargets(row: {
  targetUserIds?: string[] | null;
  targetUserId?: string | null;
}): string[] {
  if (row.targetUserIds?.length) return row.targetUserIds;
  return row.targetUserId ? [row.targetUserId] : [];
}

function normalisePriority(value: unknown): string {
  const upper = typeof value === 'string' ? value.toUpperCase() : '';
  return (ASSIGNMENT_PRIORITIES as readonly string[]).includes(upper) ? upper : 'MEDIUM';
}

@Injectable()
export class ModeratorTaskAssignmentService {
  private readonly logger = new Logger(ModeratorTaskAssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SERVICE) private readonly notificationService: INotificationService,
    private readonly scope: WorkforceScopeService,
    private readonly platformBans: PlatformBanService,
  ) {}

  /**
   * Officials may only assign to moderators inside their geographic scope.
   * Without this an official in one region could hand work to any moderator on
   * the platform, which the scope model exists to prevent.
   */
  private async assertModeratorAssignable(moderatorId: string, assignedBy: string) {
    const scopeWhere = (await this.scope.userScopeFilter(assignedBy)) as Record<string, unknown>;

    const moderator = await this.prisma.user.findFirst({
      where: { AND: [{ id: moderatorId }, scopeWhere] },
      select: { id: true, roles: true },
    });

    if (!moderator) {
      throw new ForbiddenException('That moderator is outside your assigned scope.');
    }
    if (!moderator.roles?.includes('MODERATOR')) {
      throw new BadRequestException('Target user is not a moderator.');
    }
  }

  async assignTask(input: AssignModeratorTaskInput) {
    const task = await this.prisma.taskDefinition.findUnique({
      where: { id: input.taskId },
    });
    if (!task) throw new NotFoundException('Task definition not found');

    if (input.dueAt && Number.isNaN(input.dueAt.getTime())) {
      throw new BadRequestException('dueAt is not a valid date.');
    }

    const taskType = input.taskType ? input.taskType.toUpperCase() : 'GENERAL';
    if (!(ASSIGNMENT_TASK_TYPES as readonly string[]).includes(taskType)) {
      throw new BadRequestException(`taskType must be one of ${ASSIGNMENT_TASK_TYPES.join(', ')}.`);
    }

    let targetUserIds: string[] = [];
    if (taskType === 'BAN_USER') {
      // De-duplicate so the same account cannot be listed twice.
      const requested = Array.from(
        new Set(
          [...(input.targetUserIds ?? []), ...(input.targetUserId ? [input.targetUserId] : [])]
            .map((id) => id?.trim())
            .filter((id): id is string => Boolean(id)),
        ),
      );

      if (requested.length === 0) {
        throw new BadRequestException('At least one target user is required for a BAN_USER task.');
      }
      if (requested.length > MAX_BAN_TARGETS) {
        throw new BadRequestException(`A ban task can target at most ${MAX_BAN_TARGETS} users.`);
      }
      if (!input.banReason?.trim()) {
        throw new BadRequestException('banReason is required for a BAN_USER task.');
      }

      // Every target must sit inside the Official's own scope AND be reachable
      // by the moderator who will act on it — otherwise the task could never be
      // completed (spec §7). Validated up front so a task is never created with
      // a target the moderator would later be refused.
      targetUserIds = [];
      for (const id of requested) {
        targetUserIds.push(
          await this.assertBanTargetInScope(id, input.assignedBy, input.moderatorId),
        );
      }
    }

    const priority = input.priority ? input.priority.toUpperCase() : 'MEDIUM';
    if (!(ASSIGNMENT_PRIORITIES as readonly string[]).includes(priority)) {
      throw new BadRequestException(`priority must be one of ${ASSIGNMENT_PRIORITIES.join(', ')}.`);
    }

    await this.assertModeratorAssignable(input.moderatorId, input.assignedBy);

    // Only an assignment the moderator has NOT finished blocks a new one.
    //
    // This used to reject on any existing row for the (task, moderator) pair,
    // which made the first assignment permanent: once a moderator had been
    // given a definition and completed it, the Official could never issue it to
    // them again. Recurring work — "Review 100 reports", a second Ban User task
    // — is exactly what an Official needs to re-assign, and they were told
    // "Task is already assigned to this moderator" for a task the moderator had
    // long since finished.
    //
    // Re-issuing while the previous run is still open is still refused: that is
    // a duplicate, not a repeat, and would leave two live rows competing to
    // track the same work.
    const openAssignment = await this.prisma.moderator_task_assignments.findFirst({
      where: {
        taskId: input.taskId,
        moderatorId: input.moderatorId,
        status: { not: 'COMPLETED' },
      },
      select: { id: true },
    });

    if (openAssignment) {
      throw new ConflictException(
        'This moderator already has that task open. Wait for it to be completed before assigning it again.',
      );
    }

    const assignment = await this.prisma.moderator_task_assignments.create({
      data: {
        id: randomUUID(),
        taskId: input.taskId,
        moderatorId: input.moderatorId,
        assignedBy: input.assignedBy,
        startDate: input.startDate ?? null,
        dueAt: input.dueAt ?? null,
        targetCount:
          taskType === 'BAN_USER'
            ? targetUserIds.length
            : Math.max(1, Math.trunc(input.targetCount ?? 1)),
        currentProgress: 0,
        priority,
        taskType,
        // The singular column mirrors the first target for older readers.
        targetUserId: targetUserIds[0] ?? null,
        targetUserIds,
        bannedUserIds: [],
        banReason: taskType === 'BAN_USER' ? input.banReason!.trim() : null,
        notes: input.notes ?? null,
        status: 'PENDING',
        updatedAt: new Date(),
      },
    });

    // Route through NotificationService so NotificationCreatedEvent fires for push/socket delivery
    await this.notificationService.create({
      userId: input.moderatorId,
      type: NotificationType.MODERATOR_TASK_ASSIGNED,
      actorId: input.assignedBy,
      entityType: 'moderator_task_assignment',
      entityId: assignment.id,
      data: {
        assignmentId: assignment.id,
        taskId: task.id,
        taskName: task.name,
        priority,
        dueAt: input.dueAt?.toISOString() ?? null,
        notes: input.notes ?? null,
      },
    });

    this.logger.log(
      `Task ${task.id} assigned to moderator ${input.moderatorId} by ${input.assignedBy}`,
    );

    return this.presentOne(assignment.id);
  }

  /** Derive OVERDUE at read time from `dueAt` + open status. */
  private deriveStatus(row: { status: string; dueAt: Date | null }): DerivedAssignmentStatus {
    const status = row.status as AssignmentStatus;
    if (status === 'COMPLETED') return 'COMPLETED';
    if (row.dueAt && row.dueAt.getTime() < Date.now()) return 'OVERDUE';
    return status;
  }

  /**
   * Shape one row for both the mobile client and the web oversight table. Both
   * surfaces read the same fields, so a task cannot look different depending on
   * who is looking at it.
   */
  private present(row: any) {
    const derived = this.deriveStatus(row);
    const dueAt: Date | null = row.dueAt ?? null;
    const dueInMinutes = dueAt ? Math.round((dueAt.getTime() - Date.now()) / 60000) : null;
    const target = Math.max(1, row.targetCount ?? 1);
    const progress = Math.min(row.currentProgress ?? 0, target);
    const percent = Math.round((progress / target) * 100);

    return {
      id: row.id,
      assignmentId: row.id,
      taskId: row.taskId,
      title: row.task_definitions?.name ?? 'Task',
      description: row.task_definitions?.description ?? row.notes ?? '',
      taskCategory: row.task_definitions?.category ?? 'General Moderation',
      category: row.task_definitions?.category ?? 'General Moderation',
      priority: normalisePriority(row.priority),
      taskType: row.taskType ?? 'GENERAL',
      targetUserId: row.targetUserId ?? null,
      targetUserIds: banTargets(row),
      bannedUserIds: row.bannedUserIds ?? [],
      banReason: row.banReason ?? null,
      status: derived,
      rawStatus: row.status,
      notes: row.notes ?? null,
      remarks: row.remarks ?? null,
      startDate: row.startDate ? row.startDate.toISOString() : null,
      dueAt: dueAt ? dueAt.toISOString() : null,
      dueInMinutes,
      dueText: this.formatDue(dueInMinutes),
      isOverdue: derived === 'OVERDUE',
      targetCount: target,
      currentProgress: progress,
      percentComplete: percent,
      progressText: `${progress} / ${target}`,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      assignedTo: row.moderator
        ? { id: row.moderator.id, name: row.moderator.fullName ?? row.moderator.username }
        : { id: row.moderatorId, name: 'Moderator' },
      assignedBy: row.assigner
        ? { id: row.assigner.id, name: row.assigner.fullName ?? row.assigner.username }
        : { id: row.assignedBy, name: 'Official' },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  private formatDue(minutes: number | null): string {
    if (minutes === null) return 'No due date';
    const abs = Math.abs(minutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const text = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
    return minutes < 0 ? `${text} overdue` : text;
  }

  /**
   * `moderatorId` and `assignedBy` are plain uuid columns with no Prisma
   * relation on this model, so the two users are resolved in one extra query
   * and stitched on rather than joined.
   */
  private async hydrate(rows: any[]) {
    if (rows.length === 0) return [];

    const userIds = Array.from(
      new Set(rows.flatMap((r) => [r.moderatorId, r.assignedBy]).filter(Boolean)),
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: USER_SUMMARY_SELECT,
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) =>
      this.present({
        ...r,
        moderator: byId.get(r.moderatorId) ?? null,
        assigner: byId.get(r.assignedBy) ?? null,
      }),
    );
  }

  private async presentOne(assignmentId: string) {
    const row = await this.prisma.moderator_task_assignments.findUnique({
      where: { id: assignmentId },
      include: { task_definitions: true },
    });
    if (!row) throw new NotFoundException('Task assignment not found');
    const [presented] = await this.hydrate([row]);
    return presented;
  }

  /**
   * Build the `where` fragment for a status filter, translating the derived
   * `OVERDUE` value into the column predicates that actually express it.
   */
  private statusWhere(status?: string): Record<string, unknown> {
    if (!status || status === 'ALL') return {};
    if (status === 'OVERDUE') {
      return { status: { not: 'COMPLETED' }, dueAt: { lt: new Date() } };
    }
    return { status };
  }

  /** A moderator's own assignments. */
  async getModeratorAssignments(moderatorId: string, status?: string) {
    const rows = await this.prisma.moderator_task_assignments.findMany({
      where: { moderatorId, ...this.statusWhere(status) },
      include: { task_definitions: true },
      // Soonest deadline first; the moderator's list is a work queue.
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    });

    return this.hydrate(rows);
  }

  /**
   * The moderators an official is allowed to pick from. This is the same scope
   * predicate `assignTask` enforces, so the picker can never offer a moderator
   * the assignment itself would then reject.
   */
  /**
   * Resolves one ban candidate for the Official who is building the task.
   *
   * The workforce user search matches username/email/fullName only, so pasting
   * a raw UUID there finds nothing — this accepts either an id or a username,
   * and applies the Official's own geographic scope.
   */
  async lookupBanCandidate(officialId: string, idOrUsername: string) {
    const term = idOrUsername.trim();
    if (!term) {
      throw new BadRequestException('Enter a user ID or username.');
    }

    const scopeWhere = (await this.scope.userScopeFilter(officialId)) as Record<string, unknown>;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);

    const user = await this.prisma.user.findFirst({
      where: {
        AND: [
          isUuid ? { id: term } : { username: { equals: term, mode: 'insensitive' as const } },
          { deletedAt: null },
          scopeWhere,
        ],
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        status: true,
        roles: true,
        locationState: { select: { name: true } },
        locationRegion: { select: { name: true } },
        locationCountry: { select: { name: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('No user with that ID in your region.');
    }
    if (user.roles?.includes('MODERATOR') || user.roles?.includes('ADMIN')) {
      throw new BadRequestException('Staff accounts cannot be targeted by a ban task.');
    }

    return {
      id: user.id,
      username: user.username,
      name: user.fullName ?? user.username,
      status: user.status,
      region:
        user.locationRegion?.name ??
        user.locationState?.name ??
        user.locationCountry?.name ??
        'Unknown',
    };
  }

  async getAssignableModerators(officialId: string, search?: string) {
    const scopeWhere = (await this.scope.userScopeFilter(officialId)) as Record<string, unknown>;
    const q = search?.trim();

    const rows = await this.prisma.user.findMany({
      where: {
        AND: [
          { roles: { has: 'MODERATOR' } },
          scopeWhere,
          ...(q
            ? [
                {
                  OR: [
                    { username: { contains: q, mode: 'insensitive' as const } },
                    { fullName: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
        ],
      },
      select: { ...USER_SUMMARY_SELECT, status: true },
      orderBy: { username: 'asc' },
      take: 100,
    });

    // Open workload per moderator, so the official can see who is already loaded
    // before adding more.
    const counts = await this.prisma.moderator_task_assignments.groupBy({
      by: ['moderatorId'],
      where: {
        moderatorId: { in: rows.map((r) => r.id) },
        status: { not: 'COMPLETED' },
      },
      _count: { _all: true },
    });
    const openByModerator = new Map(counts.map((c) => [c.moderatorId, c._count._all]));

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.fullName ?? r.username,
      status: r.status,
      openTaskCount: openByModerator.get(r.id) ?? 0,
    }));
  }

  /** Every assignment a given official created — their "tasks I assigned" view. */
  async getAssignedBy(assignedBy: string, status?: string) {
    const rows = await this.prisma.moderator_task_assignments.findMany({
      where: { assignedBy, ...this.statusWhere(status) },
      include: { task_definitions: true },
      orderBy: { createdAt: 'desc' },
    });

    return this.hydrate(rows);
  }

  /**
   * Oversight for Admin / Super Admin, and scope-limited for an Official.
   * `userScopeFilter` returns `{}` for unrestricted roles, so an admin sees
   * every assignment while an official sees only their own region's moderators.
   */
  async getOversightAssignments(viewerId: string, status?: string) {
    const scopeWhere = (await this.scope.userScopeFilter(viewerId)) as Record<string, unknown>;
    const unrestricted = Object.keys(scopeWhere).length === 0;

    let moderatorFilter: Record<string, unknown> = {};
    if (!unrestricted) {
      const inScope = await this.prisma.user.findMany({
        where: { AND: [{ roles: { has: 'MODERATOR' } }, scopeWhere] },
        select: { id: true },
      });
      moderatorFilter = { moderatorId: { in: inScope.map((u) => u.id) } };
    }

    const rows = await this.prisma.moderator_task_assignments.findMany({
      where: { ...moderatorFilter, ...this.statusWhere(status) },
      include: { task_definitions: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const items = await this.hydrate(rows);
    return { items, total: items.length };
  }

  /**
   * A ban target must be reachable by BOTH the Official creating the task and
   * the moderator who will execute it. Checking only the Official would let
   * them assign a ban the moderator is then forbidden to carry out; checking
   * only the moderator would let an Official reach outside their own scope.
   *
   * Returns the verified user id.
   */
  private async assertBanTargetInScope(
    targetUserId: string,
    officialId: string,
    moderatorId: string,
  ): Promise<string> {
    const officialScope = (await this.scope.userScopeFilter(officialId)) as Record<string, unknown>;

    const user = await this.prisma.user.findFirst({
      where: { AND: [{ id: targetUserId }, officialScope] },
      select: { id: true, roles: true },
    });
    if (!user) {
      throw new ForbiddenException('That user is outside your assigned scope.');
    }
    if (user.roles?.includes('MODERATOR') || user.roles?.includes('ADMIN')) {
      throw new BadRequestException('Staff accounts cannot be targeted by a ban task.');
    }

    const moderatorScope = (await this.scope.userScopeFilter(moderatorId)) as Record<
      string,
      unknown
    >;
    const reachable = await this.prisma.user.findFirst({
      where: { AND: [{ id: targetUserId }, moderatorScope] },
      select: { id: true },
    });
    if (!reachable) {
      throw new BadRequestException(
        "That user is outside the selected moderator's region. Pick a moderator who covers them.",
      );
    }

    return user.id;
  }

  /**
   * Resolves the ban target for a moderator opening their BAN_USER task.
   *
   * `searchedUserId` is what the moderator typed. It must match the id the
   * Official pinned to the task — a moderator cannot retarget their own ban
   * (spec §12) — and the user must still be inside their region (§13). Both
   * checks live here, server-side, because the frontend is not an authority.
   */
  async resolveBanTarget(assignmentId: string, moderatorId: string, searchedUserId: string) {
    const assignment = await this.prisma.moderator_task_assignments.findUnique({
      where: { id: assignmentId },
      select: {
        moderatorId: true,
        taskType: true,
        targetUserId: true,
        targetUserIds: true,
        bannedUserIds: true,
        banReason: true,
      },
    });

    if (!assignment) throw new NotFoundException('Task assignment not found');
    if (assignment.moderatorId !== moderatorId) {
      throw new ForbiddenException('You are not assigned to this task');
    }
    const targets = banTargets(assignment);
    if (assignment.taskType !== 'BAN_USER' || targets.length === 0) {
      throw new BadRequestException('This task is not a ban task.');
    }

    const searched = searchedUserId.trim();
    if (!targets.includes(searched)) {
      throw new BadRequestException('This user is not assigned to this task.');
    }
    if (assignment.bannedUserIds?.includes(searched)) {
      throw new ConflictException('This user has already been banned for this task.');
    }

    const scopeWhere = (await this.scope.userScopeFilter(moderatorId)) as Record<string, unknown>;
    const user = await this.prisma.user.findFirst({
      where: { AND: [{ id: searched }, scopeWhere] },
      select: {
        id: true,
        username: true,
        fullName: true,
        status: true,
        locationState: { select: { name: true } },
        locationRegion: { select: { name: true } },
        locationCountry: { select: { name: true } },
      },
    });

    // Deliberately the same shape of refusal whether the user is out of region
    // or absent — confirming existence would leak who lives outside the
    // moderator's territory (spec §13).
    if (!user) {
      throw new ForbiddenException('This user is not available for your authorized region.');
    }

    return {
      id: user.id,
      username: user.username,
      name: user.fullName ?? user.username,
      status: user.status,
      region:
        user.locationRegion?.name ??
        user.locationState?.name ??
        user.locationCountry?.name ??
        'Unknown',
      banReason: assignment.banReason,
    };
  }

  /**
   * Executes the ban the task describes, then completes the task.
   *
   * The ban itself is delegated to `PlatformBanService` — the very service the
   * in-room Individual Ban uses — so there is exactly one ban mechanism, one
   * banned-account state, and one notification path (spec §16/§17).
   */
  async executeBanTask(
    assignmentId: string,
    moderatorId: string,
    reason?: string,
    userId?: string,
  ) {
    const assignment = await this.prisma.moderator_task_assignments.findUnique({
      where: { id: assignmentId },
      include: { task_definitions: true },
    });

    if (!assignment) throw new NotFoundException('Task assignment not found');
    if (assignment.moderatorId !== moderatorId) {
      throw new ForbiddenException('You are not assigned to this task');
    }
    const targets = banTargets(assignment);
    if (assignment.taskType !== 'BAN_USER' || targets.length === 0) {
      throw new BadRequestException('This task is not a ban task.');
    }
    if (assignment.status === 'COMPLETED') {
      throw new ConflictException('This task is already completed.');
    }

    const alreadyBanned = assignment.bannedUserIds ?? [];
    // Ban the requested target, or the next one still outstanding.
    const target = userId?.trim() || targets.find((id) => !alreadyBanned.includes(id));
    if (!target) {
      throw new ConflictException('Every target on this task has already been banned.');
    }

    // Re-verify rather than trusting the client's earlier search: the region
    // could have changed, and the ban call must not be reachable by skipping
    // the lookup step entirely. This also rejects an id not on the task and one
    // already banned.
    await this.resolveBanTarget(assignmentId, moderatorId, target);

    const effectiveReason = (reason?.trim() || assignment.banReason || '').trim();
    if (!effectiveReason) {
      throw new BadRequestException('A ban reason is required.');
    }

    await this.platformBans.banUser({
      moderatorId,
      targetUserId: target,
      reason: effectiveReason,
      roomType: 'AUDIO_ROOM',
      // No originating room: this ban came from an assigned task, not a room.
      originRoomId: null,
    });

    const banned = [...alreadyBanned, target];
    // The task finishes only once every listed account is banned — a
    // multi-target task stays open until the moderator works through it.
    const isFinished = targets.every((id) => banned.includes(id));
    const wasOverdue = Boolean(assignment.dueAt && assignment.dueAt.getTime() < Date.now());

    await this.prisma.moderator_task_assignments.update({
      where: { id: assignmentId },
      data: {
        bannedUserIds: banned,
        currentProgress: banned.length,
        status: isFinished ? 'COMPLETED' : 'IN_PROGRESS',
        ...(isFinished ? { completedAt: new Date() } : {}),
        ...(reason?.trim() ? { banReason: effectiveReason } : {}),
      },
    });

    if (isFinished) {
      await this.notifyCompleted(assignment, moderatorId, wasOverdue);
    }

    this.logger.log(
      `BAN_USER task ${assignmentId}: ${moderatorId} banned ${target} ` +
        `(${banned.length}/${targets.length})`,
    );

    return this.presentOne(assignmentId);
  }

  /**
   * Persists the moderator's progress against a measurable target
   * (`50 / 100`). Progress lives on the one shared assignment row, so the
   * Official's monitoring view reads the very same number the moderator wrote —
   * there is no second copy to drift.
   *
   * Reaching the target completes the task automatically, which is what makes
   * "update to 100/100" and "mark completed" the same outcome rather than two
   * competing paths.
   */
  async updateProgress(
    assignmentId: string,
    moderatorId: string,
    currentProgress: number,
    remarks?: string,
  ) {
    if (!Number.isFinite(currentProgress) || currentProgress < 0) {
      throw new BadRequestException('currentProgress must be a non-negative number.');
    }

    const assignment = await this.prisma.moderator_task_assignments.findUnique({
      where: { id: assignmentId },
      include: { task_definitions: true },
    });

    if (!assignment) throw new NotFoundException('Task assignment not found');
    if (assignment.moderatorId !== moderatorId) {
      throw new ForbiddenException('You are not assigned to this task');
    }
    if (assignment.status === 'COMPLETED') {
      throw new ConflictException('This task is already completed.');
    }

    const target = Math.max(1, assignment.targetCount ?? 1);
    const clamped = Math.min(Math.trunc(currentProgress), target);
    const reachedTarget = clamped >= target;
    const wasOverdue = Boolean(assignment.dueAt && assignment.dueAt.getTime() < Date.now());

    await this.prisma.moderator_task_assignments.update({
      where: { id: assignmentId },
      data: {
        currentProgress: clamped,
        // Any recorded progress means work has started.
        status: reachedTarget ? 'COMPLETED' : 'IN_PROGRESS',
        ...(reachedTarget ? { completedAt: new Date() } : {}),
        ...(remarks !== undefined ? { remarks } : {}),
      },
    });

    if (reachedTarget) {
      await this.notifyCompleted(assignment, moderatorId, wasOverdue);
    }

    return this.presentOne(assignmentId);
  }

  /** Tells the assigning Official that the work is done. */
  private async notifyCompleted(assignment: any, moderatorId: string, wasOverdue: boolean) {
    await this.notificationService.create({
      userId: assignment.assignedBy,
      type: NotificationType.MODERATOR_TASK_COMPLETED,
      actorId: moderatorId,
      entityType: 'moderator_task_assignment',
      entityId: assignment.id,
      data: {
        assignmentId: assignment.id,
        taskId: assignment.taskId,
        taskName: assignment.task_definitions?.name ?? 'Task',
        completedAt: new Date().toISOString(),
        wasOverdue,
      },
    });
  }

  /**
   * Moderator moves their own assignment forward. Completion notifies the
   * official who assigned it — without that the official has no signal that the
   * work finished.
   */
  async updateAssignmentStatus(
    assignmentId: string,
    moderatorId: string,
    status: 'IN_PROGRESS' | 'COMPLETED',
  ) {
    if (status !== 'IN_PROGRESS' && status !== 'COMPLETED') {
      throw new BadRequestException('status must be IN_PROGRESS or COMPLETED.');
    }

    const assignment = await this.prisma.moderator_task_assignments.findUnique({
      where: { id: assignmentId },
      include: { task_definitions: true },
    });

    if (!assignment) throw new NotFoundException('Task assignment not found');
    if (assignment.moderatorId !== moderatorId) {
      throw new ForbiddenException('You are not assigned to this task');
    }
    if (assignment.status === 'COMPLETED') {
      throw new ConflictException('This task is already completed.');
    }

    const wasOverdue = Boolean(assignment.dueAt && assignment.dueAt.getTime() < Date.now());

    await this.prisma.moderator_task_assignments.update({
      where: { id: assignmentId },
      data: {
        status,
        // Completing fills progress to the target so the Official's monitoring
        // view never shows "Completed" next to a half-finished 45/100.
        ...(status === 'COMPLETED'
          ? {
              completedAt: new Date(),
              currentProgress: Math.max(1, assignment.targetCount ?? 1),
            }
          : {}),
      },
    });

    if (status === 'COMPLETED') {
      await this.notifyCompleted(assignment, moderatorId, wasOverdue);
    }

    return this.presentOne(assignmentId);
  }
}
