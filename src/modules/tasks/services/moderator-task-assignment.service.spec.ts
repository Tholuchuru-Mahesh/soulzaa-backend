import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ModeratorTaskAssignmentService } from './moderator-task-assignment.service';
import type { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import type { INotificationService } from 'src/modules/notification/interfaces/notification.interface';
import type { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';

const OFFICIAL = 'official-1';
const MODERATOR = 'mod-1';
const TASK = 'task-1';
const ASSIGNMENT = 'assignment-1';

/** A stored row as Prisma would return it, with the task relation included. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT,
    taskId: TASK,
    moderatorId: MODERATOR,
    assignedBy: OFFICIAL,
    status: 'PENDING',
    priority: 'HIGH',
    taskType: 'GENERAL',
    targetUserId: null,
    targetUserIds: [],
    bannedUserIds: [],
    banReason: null,
    startDate: null,
    dueAt: null,
    targetCount: 100,
    currentProgress: 0,
    completedAt: null,
    notes: null,
    remarks: null,
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    task_definitions: {
      id: TASK,
      name: 'Review 100 Reports',
      description: 'Review assigned reports.',
      category: 'Report Moderation',
      priority: 25,
    },
    ...overrides,
  };
}

describe('ModeratorTaskAssignmentService', () => {
  let prisma: any;
  let notifications: { create: jest.Mock };
  let scope: { userScopeFilter: jest.Mock };
  let platformBans: { banUser: jest.Mock };
  let service: ModeratorTaskAssignmentService;

  beforeEach(() => {
    prisma = {
      taskDefinition: { findUnique: jest.fn() },
      user: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      moderator_task_assignments: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    scope = { userScopeFilter: jest.fn().mockResolvedValue({}) };
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };

    service = new ModeratorTaskAssignmentService(
      prisma as unknown as PrismaService,
      notifications as unknown as INotificationService,
      scope as unknown as WorkforceScopeService,
      platformBans as unknown as PlatformBanService,
    );
  });

  describe('assignTask', () => {
    beforeEach(() => {
      prisma.taskDefinition.findUnique.mockResolvedValue({
        id: TASK,
        name: 'Review 100 Reports',
      });
      prisma.user.findFirst.mockResolvedValue({ id: MODERATOR, roles: ['MODERATOR'] });
      // No OPEN assignment for this (task, moderator) pair by default.
      prisma.moderator_task_assignments.findFirst.mockResolvedValue(null);
      prisma.moderator_task_assignments.findUnique.mockResolvedValue(row()); // presentOne
      prisma.moderator_task_assignments.create.mockResolvedValue(row());
    });

    it('stores the official-defined target and notifies the moderator', async () => {
      await service.assignTask({
        taskId: TASK,
        moderatorId: MODERATOR,
        assignedBy: OFFICIAL,
        targetCount: 100,
      });

      const created = prisma.moderator_task_assignments.create.mock.calls[0][0].data;
      expect(created.targetCount).toBe(100);
      expect(created.currentProgress).toBe(0);
      expect(created.status).toBe('PENDING');

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: MODERATOR, actorId: OFFICIAL }),
      );
    });

    it('refuses a moderator outside the official geographic scope', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.assignTask({ taskId: TASK, moderatorId: MODERATOR, assignedBy: OFFICIAL }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.moderator_task_assignments.create).not.toHaveBeenCalled();
    });

    it('refuses a target user who is not a moderator', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: MODERATOR, roles: ['AGENCY'] });

      await expect(
        service.assignTask({ taskId: TASK, moderatorId: MODERATOR, assignedBy: OFFICIAL }),
      ).rejects.toThrow('Target user is not a moderator.');
    });

    it('rejects re-assigning a task the moderator still has OPEN', async () => {
      prisma.moderator_task_assignments.findFirst.mockResolvedValue({ id: 'open-1' });

      await expect(
        service.assignTask({ taskId: TASK, moderatorId: MODERATOR, assignedBy: OFFICIAL }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.moderator_task_assignments.create).not.toHaveBeenCalled();
    });

    it('only an unfinished assignment blocks — the check excludes COMPLETED', async () => {
      await service.assignTask({
        taskId: TASK,
        moderatorId: MODERATOR,
        assignedBy: OFFICIAL,
      });

      expect(prisma.moderator_task_assignments.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            taskId: TASK,
            moderatorId: MODERATOR,
            status: { not: 'COMPLETED' },
          }),
        }),
      );
    });

    it(
      'REGRESSION: the same task can be assigned again once the moderator has ' +
        'completed it — recurring work must be re-issuable',
      async () => {
        // The old guard rejected on ANY existing row for the pair, so the first
        // assignment was permanent: an Official was told "Task is already
        // assigned to this moderator" for work that moderator had long since
        // finished. Only a still-open assignment may block a new one, so a
        // completed one leaves `findFirst` (scoped to status != COMPLETED)
        // empty and the assignment goes through.
        prisma.moderator_task_assignments.findFirst.mockResolvedValue(null);

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            targetCount: 100,
          }),
        ).resolves.toBeDefined();

        expect(prisma.moderator_task_assignments.create).toHaveBeenCalled();
      },
    );

    it('a moderator can hold several DIFFERENT tasks at once', async () => {
      await service.assignTask({
        taskId: TASK,
        moderatorId: MODERATOR,
        assignedBy: OFFICIAL,
      });
      await service.assignTask({
        taskId: 'task-2',
        moderatorId: MODERATOR,
        assignedBy: OFFICIAL,
      });

      expect(prisma.moderator_task_assignments.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateProgress', () => {
    it('persists partial progress and moves the task to IN_PROGRESS', async () => {
      prisma.moderator_task_assignments.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValue(row({ currentProgress: 50, status: 'IN_PROGRESS' }));

      const result = await service.updateProgress(ASSIGNMENT, MODERATOR, 50);

      const data = prisma.moderator_task_assignments.update.mock.calls[0][0].data;
      expect(data.currentProgress).toBe(50);
      expect(data.status).toBe('IN_PROGRESS');
      expect(data.completedAt).toBeUndefined();

      expect(result.progressText).toBe('50 / 100');
      expect(result.percentComplete).toBe(50);
      // Partial progress is not a completion, so the Official is not pinged yet.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('completes the task and notifies the official once the target is reached', async () => {
      prisma.moderator_task_assignments.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValue(row({ currentProgress: 100, status: 'COMPLETED' }));

      await service.updateProgress(ASSIGNMENT, MODERATOR, 100);

      const data = prisma.moderator_task_assignments.update.mock.calls[0][0].data;
      expect(data.status).toBe('COMPLETED');
      expect(data.completedAt).toBeInstanceOf(Date);

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OFFICIAL,
          type: 'MODERATOR_TASK_COMPLETED',
          actorId: MODERATOR,
        }),
      );
    });

    it('clamps progress above the target rather than overshooting', async () => {
      prisma.moderator_task_assignments.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValue(row({ currentProgress: 100, status: 'COMPLETED' }));

      await service.updateProgress(ASSIGNMENT, MODERATOR, 500);

      expect(prisma.moderator_task_assignments.update.mock.calls[0][0].data.currentProgress).toBe(
        100,
      );
    });

    it('refuses progress from a moderator the task is not assigned to', async () => {
      prisma.moderator_task_assignments.findUnique.mockResolvedValue(row());

      await expect(service.updateProgress(ASSIGNMENT, 'someone-else', 10)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(prisma.moderator_task_assignments.update).not.toHaveBeenCalled();
    });

    it('404s on an unknown assignment', async () => {
      prisma.moderator_task_assignments.findUnique.mockResolvedValue(null);

      await expect(service.updateProgress(ASSIGNMENT, MODERATOR, 10)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateAssignmentStatus', () => {
    it('fills progress to the target when marked completed directly', async () => {
      prisma.moderator_task_assignments.findUnique
        .mockResolvedValueOnce(row({ currentProgress: 45 }))
        .mockResolvedValue(row({ currentProgress: 100, status: 'COMPLETED' }));

      await service.updateAssignmentStatus(ASSIGNMENT, MODERATOR, 'COMPLETED');

      // Otherwise the Official would see "Completed" beside a stale 45/100.
      expect(prisma.moderator_task_assignments.update.mock.calls[0][0].data.currentProgress).toBe(
        100,
      );
    });

    it('rejects re-completing an already completed task', async () => {
      prisma.moderator_task_assignments.findUnique.mockResolvedValue(row({ status: 'COMPLETED' }));

      await expect(
        service.updateAssignmentStatus(ASSIGNMENT, MODERATOR, 'COMPLETED'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('derived OVERDUE status', () => {
    it('reports an open past-due task as OVERDUE without storing that state', async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      prisma.moderator_task_assignments.findMany.mockResolvedValue([
        row({ dueAt: past, status: 'IN_PROGRESS' }),
      ]);

      const [task] = await service.getModeratorAssignments(MODERATOR);

      expect(task.status).toBe('OVERDUE');
      expect(task.rawStatus).toBe('IN_PROGRESS');
      expect(task.isOverdue).toBe(true);
    });

    it('never marks a completed task overdue, even past its due date', async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      prisma.moderator_task_assignments.findMany.mockResolvedValue([
        row({ dueAt: past, status: 'COMPLETED' }),
      ]);

      const [task] = await service.getModeratorAssignments(MODERATOR);

      expect(task.status).toBe('COMPLETED');
      expect(task.isOverdue).toBe(false);
    });

    it('translates an OVERDUE filter into column predicates', async () => {
      await service.getModeratorAssignments(MODERATOR, 'OVERDUE');

      const where = prisma.moderator_task_assignments.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ not: 'COMPLETED' });
      expect(where.dueAt.lt).toBeInstanceOf(Date);
    });
  });

  describe('priority', () => {
    beforeEach(() => {
      prisma.taskDefinition.findUnique.mockResolvedValue({ id: TASK, name: 'Review 100 Reports' });
      prisma.user.findFirst.mockResolvedValue({ id: MODERATOR, roles: ['MODERATOR'] });
      prisma.moderator_task_assignments.findFirst.mockResolvedValue(null);
      prisma.moderator_task_assignments.findUnique.mockResolvedValue(row());
      prisma.moderator_task_assignments.create.mockResolvedValue(row());
    });

    it('stores the priority the official picked', async () => {
      await service.assignTask({
        taskId: TASK,
        moderatorId: MODERATOR,
        assignedBy: OFFICIAL,
        priority: 'URGENT',
      });

      expect(prisma.moderator_task_assignments.create.mock.calls[0][0].data.priority).toBe(
        'URGENT',
      );
    });

    it('accepts lowercase input', async () => {
      await service.assignTask({
        taskId: TASK,
        moderatorId: MODERATOR,
        assignedBy: OFFICIAL,
        priority: 'high',
      });

      expect(prisma.moderator_task_assignments.create.mock.calls[0][0].data.priority).toBe('HIGH');
    });

    it('defaults to MEDIUM when the official does not choose', async () => {
      await service.assignTask({ taskId: TASK, moderatorId: MODERATOR, assignedBy: OFFICIAL });

      expect(prisma.moderator_task_assignments.create.mock.calls[0][0].data.priority).toBe(
        'MEDIUM',
      );
    });

    it('rejects a value outside the allowed set', async () => {
      await expect(
        service.assignTask({
          taskId: TASK,
          moderatorId: MODERATOR,
          assignedBy: OFFICIAL,
          priority: 'SOMEDAY',
        }),
      ).rejects.toThrow('priority must be one of LOW, MEDIUM, HIGH, URGENT.');

      expect(prisma.moderator_task_assignments.create).not.toHaveBeenCalled();
    });

    it('presents the stored priority, not one derived from the definition', async () => {
      prisma.moderator_task_assignments.findMany.mockResolvedValue([row({ priority: 'URGENT' })]);

      const [task] = await service.getModeratorAssignments(MODERATOR);

      expect(task.priority).toBe('URGENT');
    });

    it('falls back to MEDIUM for a legacy row with no priority', async () => {
      prisma.moderator_task_assignments.findMany.mockResolvedValue([row({ priority: null })]);

      const [task] = await service.getModeratorAssignments(MODERATOR);

      expect(task.priority).toBe('MEDIUM');
    });
  });

  describe('BAN_USER tasks', () => {
    const TARGET = 'target-user-1';

    const banRow = (overrides: Record<string, unknown> = {}) =>
      row({
        taskType: 'BAN_USER',
        targetUserId: TARGET,
        targetUserIds: [TARGET],
        bannedUserIds: [],
        banReason: 'Community Guidelines Violation',
        ...overrides,
      });

    describe('assignment', () => {
      beforeEach(() => {
        prisma.taskDefinition.findUnique.mockResolvedValue({ id: TASK, name: 'Ban User' });
        prisma.moderator_task_assignments.findFirst.mockResolvedValue(null);
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.moderator_task_assignments.create.mockResolvedValue(banRow());
      });

      it('stores the target and reason', async () => {
        // Order: target in official scope, target reachable by moderator, then
        // the moderator-assignable check.
        prisma.user.findFirst
          .mockResolvedValueOnce({ id: TARGET, roles: ['USER'] })
          .mockResolvedValueOnce({ id: TARGET })
          .mockResolvedValueOnce({ id: MODERATOR, roles: ['MODERATOR'] });

        await service.assignTask({
          taskId: TASK,
          moderatorId: MODERATOR,
          assignedBy: OFFICIAL,
          taskType: 'BAN_USER',
          targetUserId: TARGET,
          banReason: 'Community Guidelines Violation',
        });

        const data = prisma.moderator_task_assignments.create.mock.calls[0][0].data;
        expect(data.taskType).toBe('BAN_USER');
        expect(data.targetUserId).toBe(TARGET);
        expect(data.banReason).toBe('Community Guidelines Violation');
      });

      it('requires a target user', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: MODERATOR, roles: ['MODERATOR'] });

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            taskType: 'BAN_USER',
            banReason: 'x',
          }),
        ).rejects.toThrow('At least one target user is required for a BAN_USER task.');
      });

      it('requires a ban reason', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: MODERATOR, roles: ['MODERATOR'] });

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            taskType: 'BAN_USER',
            targetUserId: TARGET,
          }),
        ).rejects.toThrow('banReason is required for a BAN_USER task.');
      });

      it('refuses a target outside the official scope', async () => {
        prisma.user.findFirst.mockResolvedValueOnce(null); // target not in official scope

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            taskType: 'BAN_USER',
            targetUserId: TARGET,
            banReason: 'x',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('refuses a target the chosen moderator cannot reach (spec 7)', async () => {
        prisma.user.findFirst
          .mockResolvedValueOnce({ id: TARGET, roles: ['USER'] }) // in official scope
          .mockResolvedValueOnce(null); // but out of moderator region

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            taskType: 'BAN_USER',
            targetUserId: TARGET,
            banReason: 'x',
          }),
        ).rejects.toThrow(/outside the selected moderator/);

        expect(prisma.moderator_task_assignments.create).not.toHaveBeenCalled();
      });

      it('refuses to target a staff account', async () => {
        prisma.user.findFirst.mockResolvedValueOnce({ id: TARGET, roles: ['MODERATOR'] });

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            taskType: 'BAN_USER',
            targetUserId: TARGET,
            banReason: 'x',
          }),
        ).rejects.toThrow('Staff accounts cannot be targeted by a ban task.');
      });
    });

    describe('multiple targets', () => {
      const T2 = 'target-user-2';

      it('validates every target and stores the full list', async () => {
        prisma.taskDefinition.findUnique.mockResolvedValue({ id: TASK, name: 'Ban Users' });
        prisma.moderator_task_assignments.findFirst.mockResolvedValue(null);
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.moderator_task_assignments.create.mockResolvedValue(banRow());
        // Per target: official-scope check + moderator-reach check, then the
        // moderator-assignable check once.
        prisma.user.findFirst
          .mockResolvedValueOnce({ id: TARGET, roles: ['USER'] })
          .mockResolvedValueOnce({ id: TARGET })
          .mockResolvedValueOnce({ id: T2, roles: ['USER'] })
          .mockResolvedValueOnce({ id: T2 })
          .mockResolvedValueOnce({ id: MODERATOR, roles: ['MODERATOR'] });

        await service.assignTask({
          taskId: TASK,
          moderatorId: MODERATOR,
          assignedBy: OFFICIAL,
          taskType: 'BAN_USER',
          targetUserIds: [TARGET, T2],
          banReason: 'x',
        });

        const data = prisma.moderator_task_assignments.create.mock.calls[0][0].data;
        expect(data.targetUserIds).toEqual([TARGET, T2]);
        // Progress is measured in targets banned.
        expect(data.targetCount).toBe(2);
        expect(data.targetUserId).toBe(TARGET);
      });

      it('rejects the whole task if any one target is out of scope', async () => {
        prisma.taskDefinition.findUnique.mockResolvedValue({ id: TASK, name: 'Ban Users' });
        prisma.user.findFirst
          .mockResolvedValueOnce({ id: TARGET, roles: ['USER'] })
          .mockResolvedValueOnce({ id: TARGET })
          .mockResolvedValueOnce(null); // second target out of scope

        await expect(
          service.assignTask({
            taskId: TASK,
            moderatorId: MODERATOR,
            assignedBy: OFFICIAL,
            taskType: 'BAN_USER',
            targetUserIds: [TARGET, T2],
            banReason: 'x',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.moderator_task_assignments.create).not.toHaveBeenCalled();
      });

      it('stays IN_PROGRESS until every target is banned', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(
          banRow({ targetUserIds: [TARGET, T2], bannedUserIds: [], targetCount: 2 }),
        );
        prisma.user.findFirst.mockResolvedValue({
          id: TARGET,
          username: 'u',
          fullName: 'U',
          status: 'ACTIVE',
          locationState: { name: 'AP' },
          locationRegion: null,
          locationCountry: null,
        });

        await service.executeBanTask(ASSIGNMENT, MODERATOR);

        const data = prisma.moderator_task_assignments.update.mock.calls[0][0].data;
        expect(data.status).toBe('IN_PROGRESS');
        expect(data.bannedUserIds).toEqual([TARGET]);
        expect(data.currentProgress).toBe(1);
        // The Official is not told until the whole task is done.
        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('completes once the last target is banned', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(
          banRow({ targetUserIds: [TARGET, T2], bannedUserIds: [TARGET], targetCount: 2 }),
        );
        prisma.user.findFirst.mockResolvedValue({
          id: T2,
          username: 'u2',
          fullName: 'U2',
          status: 'ACTIVE',
          locationState: { name: 'AP' },
          locationRegion: null,
          locationCountry: null,
        });

        await service.executeBanTask(ASSIGNMENT, MODERATOR);

        const data = prisma.moderator_task_assignments.update.mock.calls[0][0].data;
        expect(data.status).toBe('COMPLETED');
        expect(data.bannedUserIds).toEqual([TARGET, T2]);
        expect(notifications.create).toHaveBeenCalledWith(
          expect.objectContaining({ userId: OFFICIAL, type: 'MODERATOR_TASK_COMPLETED' }),
        );
      });

      it('refuses to ban the same target twice', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(
          banRow({ targetUserIds: [TARGET, T2], bannedUserIds: [TARGET] }),
        );

        await expect(
          service.resolveBanTarget(ASSIGNMENT, MODERATOR, TARGET),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    describe('resolveBanTarget', () => {
      it('returns the profile for the correct id inside the region', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.user.findFirst.mockResolvedValue({
          id: TARGET,
          username: 'exampleuser',
          fullName: 'Example User',
          status: 'ACTIVE',
          locationState: { name: 'Andhra Pradesh' },
          locationRegion: null,
          locationCountry: null,
        });

        const found = await service.resolveBanTarget(ASSIGNMENT, MODERATOR, TARGET);

        expect(found.id).toBe(TARGET);
        expect(found.region).toBe('Andhra Pradesh');
      });

      it('rejects a different user id than the task target (spec 12/26)', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());

        await expect(
          service.resolveBanTarget(ASSIGNMENT, MODERATOR, 'someone-else'),
        ).rejects.toThrow('This user is not assigned to this task.');

        // No lookup should even be attempted for a non-target id.
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
      });

      it('refuses a target outside the moderator region (spec 13/25)', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(service.resolveBanTarget(ASSIGNMENT, MODERATOR, TARGET)).rejects.toThrow(
          'This user is not available for your authorized region.',
        );
      });

      it('refuses a moderator the task is not assigned to', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());

        await expect(
          service.resolveBanTarget(ASSIGNMENT, 'other-mod', TARGET),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('rejects a non-ban task', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(row());

        await expect(service.resolveBanTarget(ASSIGNMENT, MODERATOR, TARGET)).rejects.toThrow(
          'This task is not a ban task.',
        );
      });
    });

    describe('executeBanTask', () => {
      const inRegionUser = {
        id: TARGET,
        username: 'exampleuser',
        fullName: 'Example User',
        status: 'ACTIVE',
        locationState: { name: 'Andhra Pradesh' },
        locationRegion: null,
        locationCountry: null,
      };

      it('delegates to the shared ban engine and completes the task', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.user.findFirst.mockResolvedValue(inRegionUser);

        await service.executeBanTask(ASSIGNMENT, MODERATOR);

        // The same service the in-room Individual Ban uses (spec 16).
        expect(platformBans.banUser).toHaveBeenCalledWith(
          expect.objectContaining({
            moderatorId: MODERATOR,
            targetUserId: TARGET,
            reason: 'Community Guidelines Violation',
            originRoomId: null,
          }),
        );

        const data = prisma.moderator_task_assignments.update.mock.calls[0][0].data;
        expect(data.status).toBe('COMPLETED');
        expect(data.completedAt).toBeInstanceOf(Date);

        // The assigning Official is told.
        expect(notifications.create).toHaveBeenCalledWith(
          expect.objectContaining({ userId: OFFICIAL, type: 'MODERATOR_TASK_COMPLETED' }),
        );
      });

      it('does not ban when the target is out of region', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(service.executeBanTask(ASSIGNMENT, MODERATOR)).rejects.toThrow(
          'This user is not available for your authorized region.',
        );

        expect(platformBans.banUser).not.toHaveBeenCalled();
        expect(prisma.moderator_task_assignments.update).not.toHaveBeenCalled();
      });

      it('does not ban for a moderator the task is not assigned to', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());

        await expect(service.executeBanTask(ASSIGNMENT, 'other-mod')).rejects.toBeInstanceOf(
          ForbiddenException,
        );

        expect(platformBans.banUser).not.toHaveBeenCalled();
      });

      it('refuses to re-ban an already completed task', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(
          banRow({ status: 'COMPLETED' }),
        );

        await expect(service.executeBanTask(ASSIGNMENT, MODERATOR)).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(platformBans.banUser).not.toHaveBeenCalled();
      });

      it('honours a moderator-chosen reason over the task default', async () => {
        prisma.moderator_task_assignments.findUnique.mockResolvedValue(banRow());
        prisma.user.findFirst.mockResolvedValue(inRegionUser);

        await service.executeBanTask(ASSIGNMENT, MODERATOR, 'Harassment');

        expect(platformBans.banUser).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'Harassment' }),
        );
      });
    });

    it('leaves ordinary tasks untouched (spec 22)', async () => {
      prisma.moderator_task_assignments.findMany.mockResolvedValue([row()]);

      const [task] = await service.getModeratorAssignments(MODERATOR);

      expect(task.taskType).toBe('GENERAL');
      expect(task.targetUserId).toBeNull();
      expect(task.banReason).toBeNull();
    });
  });

  describe('user field selection', () => {
    // A bad `select` key is a runtime-only Prisma error — `tsc` cannot catch it
    // through the `as const` select object, which is exactly how `avatarKey`
    // (a UserProfile field, not a User one) reached production as a 500.
    const USER_FIELDS = ['id', 'username', 'fullName', 'status'];

    it('selects only fields that exist on the User model', async () => {
      await service.getAssignableModerators(OFFICIAL);

      const select = prisma.user.findMany.mock.calls[0][0].select;
      expect(Object.keys(select).sort()).toEqual([...USER_FIELDS].sort());
    });

    it('hydrates assignments using only real User fields', async () => {
      prisma.moderator_task_assignments.findMany.mockResolvedValue([row()]);

      await service.getModeratorAssignments(MODERATOR);

      const select = prisma.user.findMany.mock.calls[0][0].select;
      for (const key of Object.keys(select)) {
        expect(USER_FIELDS).toContain(key);
      }
    });
  });

  describe('scoping', () => {
    it('scopes a moderator list query to the calling moderator', async () => {
      await service.getModeratorAssignments(MODERATOR);

      expect(prisma.moderator_task_assignments.findMany.mock.calls[0][0].where.moderatorId).toBe(
        MODERATOR,
      );
    });

    it('does not filter oversight by moderator for an unrestricted viewer', async () => {
      scope.userScopeFilter.mockResolvedValue({});

      await service.getOversightAssignments('admin-1');

      expect(
        prisma.moderator_task_assignments.findMany.mock.calls[0][0].where.moderatorId,
      ).toBeUndefined();
    });

    it('limits oversight to in-scope moderators for a restricted viewer', async () => {
      scope.userScopeFilter.mockResolvedValue({ OR: [{ regionId: 'r1' }] });
      prisma.user.findMany.mockResolvedValue([{ id: MODERATOR }]);

      await service.getOversightAssignments(OFFICIAL);

      expect(prisma.moderator_task_assignments.findMany.mock.calls[0][0].where.moderatorId).toEqual(
        { in: [MODERATOR] },
      );
    });
  });
});
