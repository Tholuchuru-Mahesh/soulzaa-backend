import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { SYSTEM_MODERATOR_ID } from 'src/modules/audio-rooms/constants/moderation.constants';
import { MobileWorkforceService } from './mobile-workforce.service';
import { WorkforceScopeService } from './workforce-scope.service';

/**
 * The scope filter is an `OR`. Any query that adds its own `OR` must compose
 * with `AND` rather than spreading, or the second `OR` replaces the first and
 * the scope silently disappears.
 */
describe('MobileWorkforceService scope composition', () => {
  let service: MobileWorkforceService;

  const prisma = {
    user: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    roomReport: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    videoRoomReport: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    liveStreamReport: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    investigationRecording: { count: jest.fn().mockResolvedValue(0) },
    moderator_task_assignments: { count: jest.fn().mockResolvedValue(0) },
    audioRoom: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    videoRoom: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    liveStream: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    roomMember: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    videoRoomMember: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    roomMessage: { findMany: jest.fn().mockResolvedValue([]) },
    videoRoomMessage: { findMany: jest.fn().mockResolvedValue([]) },
    roomLiveSession: { findFirst: jest.fn().mockResolvedValue(null) },
    platformUserBan: { count: jest.fn().mockResolvedValue(0) },
    userProfile: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    userStatistics: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    roomBan: { count: jest.fn().mockResolvedValue(0) },
    videoRoomBlock: { count: jest.fn().mockResolvedValue(0) },
    liveStreamBan: { count: jest.fn().mockResolvedValue(0) },
  };
  const scope = {
    userScopeFilter: jest.fn(),
    describeScope: jest.fn(),
    assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
  };
  const scopes = { getUserScopes: jest.fn().mockResolvedValue([]) };
  const shiftService = {
    shiftStatus: jest
      .fn()
      .mockResolvedValue({ isActive: false, shift: null, nextShiftStartsInSeconds: null }),
    isWithinShift: jest.fn().mockResolvedValue(false),
  };
  const audioModeration = {
    reviewReport: jest.fn(),
    dismissReport: jest.fn(),
    escalateViolation: jest.fn(),
  };
  const videoReports = { reviewReport: jest.fn(), dismissReport: jest.fn() };
  const videoModeration = { escalateViolation: jest.fn() };
  const liveStreamReports = { reviewReport: jest.fn() };
  const liveStream = { escalateViolation: jest.fn() };
  const platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
  const investigationRecording = {
    getCaseView: jest.fn().mockResolvedValue({ recordings: [], auditLogs: [] }),
  };
  const permissionResolver = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    hasPermission: jest.fn().mockReturnValue(false),
  };

  const SCOPE_FILTER = { OR: [{ stateId: 's-ka' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);
    scope.userScopeFilter.mockResolvedValue(SCOPE_FILTER);
    service = new MobileWorkforceService(
      prisma as unknown as PrismaService,
      scope as unknown as WorkforceScopeService,
      scopes as unknown as GeographicScopeResolver,
      shiftService as any,
      undefined,
      audioModeration as any,
      videoReports as any,
      videoModeration as any,
      liveStreamReports as any,
      liveStream as any,
      investigationRecording as any,
      permissionResolver as any,
      platformBans as any,
    );
  });

  it('keeps the scope filter when a search term is supplied', async () => {
    await service.users('official-1', 'alice');

    const where = prisma.user.findMany.mock.calls[0][0].where;
    // The scope clause must survive alongside the search clause.
    expect(where.AND).toContainEqual(SCOPE_FILTER);
    expect(JSON.stringify(where)).toContain('alice');
  });

  it('applies the scope filter with no search term', async () => {
    await service.users('official-1');

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([SCOPE_FILTER]);
  });

  it('counts against the same filter it lists with', async () => {
    await service.users('official-1', 'alice');

    const listWhere = prisma.user.findMany.mock.calls[0][0].where;
    const countWhere = prisma.user.count.mock.calls[0][0].where;
    // A count that disagrees with the list produces broken pagination.
    expect(countWhere).toEqual(listWhere);
  });

  it('narrows the moderation queue to rooms/streams owned by users in scope', async () => {
    // Scoping now mirrors reportDetails/actionReport: by room/stream OWNER,
    // not by reporter — a report with an in-region reporter but an
    // out-of-region room owner must not appear (it would 403 on open).
    prisma.user.findMany.mockResolvedValue([{ id: 'owner-1' }, { id: 'owner-2' }]);
    prisma.audioRoom.findMany.mockResolvedValueOnce([{ id: 'room-1' }]);
    prisma.videoRoom.findMany.mockResolvedValueOnce([]);
    prisma.liveStream.findMany.mockResolvedValueOnce([]);

    await service.moderationQueue('official-1');

    expect(prisma.audioRoom.findMany.mock.calls[0][0].where).toEqual({
      ownerId: { in: ['owner-1', 'owner-2'] },
    });
    expect(prisma.roomReport.findMany.mock.calls[0][0].where).toEqual({
      roomId: { in: ['room-1'] },
    });
    expect(prisma.videoRoomReport.findMany.mock.calls[0][0].where).toEqual({
      roomId: { in: [] },
    });
    expect(prisma.liveStreamReport.findMany.mock.calls[0][0].where).toEqual({
      streamId: { in: [] },
    });
  });

  it('does not filter the moderation queue by room/stream owner when unrestricted', async () => {
    scope.userScopeFilter.mockResolvedValue({});

    await service.moderationQueue('admin-1');

    expect(prisma.roomReport.findMany.mock.calls[0][0].where).toEqual({});
    expect(prisma.videoRoomReport.findMany.mock.calls[0][0].where).toEqual({});
    expect(prisma.liveStreamReport.findMany.mock.calls[0][0].where).toEqual({});
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.audioRoom.findMany).not.toHaveBeenCalled();
  });

  describe('regionalDailyActivity — the Dashboard\'s "Assigned X" cards', () => {
    it('scopes rooms/streams by the in-scope owner ids, and investigations by their resolved room/stream ids', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);
      scope.userScopeFilter.mockResolvedValue({ OR: [{ stateId: 's-ka' }] });
      prisma.audioRoom.findMany.mockResolvedValueOnce([{ id: 'room-a' }]).mockResolvedValueOnce([]);
      prisma.liveStream.findMany
        .mockResolvedValueOnce([{ id: 'stream-a' }])
        .mockResolvedValueOnce([]);

      await service.regionalDailyActivity('mod-1');

      // AudioRoom/VideoRoom/LiveStream carry no territory snapshot column —
      // matched by ownerId/hostId against the resolved in-scope user ids.
      expect(prisma.audioRoom.findMany).toHaveBeenNthCalledWith(1, {
        where: { ownerId: { in: ['u-1', 'u-2'] } },
        select: { id: true },
      });
      expect(prisma.liveStream.findMany).toHaveBeenNthCalledWith(1, {
        where: { hostId: { in: ['u-1', 'u-2'] } },
        select: { id: true },
      });
      expect(prisma.investigationRecording.count).toHaveBeenCalledWith({
        where: {
          status: 'ACTIVE',
          OR: [{ roomId: { in: ['room-a'] } }, { liveStreamId: { in: ['stream-a'] } }],
        },
      });
    });

    it('assigned rooms are filtered by the same owner-scoped clause as the in-scope id lookup', async () => {
      scope.userScopeFilter.mockResolvedValue({ OR: [{ stateId: 's-ka' }] });
      prisma.user.findMany.mockResolvedValue([{ id: 'owner-1' }]);
      prisma.audioRoom.findMany.mockResolvedValue([
        { id: 'room-1', name: 'in scope', status: 'LIVE', ownerId: 'owner-1' },
      ]);

      const result = await service.regionalDailyActivity('mod-1');

      const displayWhere = prisma.audioRoom.findMany.mock.calls[1][0].where;
      expect(displayWhere).toEqual({ ownerId: { in: ['owner-1'] }, status: 'LIVE' });
      expect(result.assignedAudioRooms.map((r: any) => r.id)).toEqual(['room-1']);
    });

    it('scopes report counts by the target room/stream region, not the reporter', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);
      scope.userScopeFilter.mockResolvedValue({ OR: [{ regionId: 'r-1' }] });
      prisma.audioRoom.findMany.mockResolvedValue([{ id: 'room-a' }, { id: 'room-b' }]);
      prisma.videoRoom.findMany.mockResolvedValue([{ id: 'vroom-a' }]);
      prisma.liveStream.findMany.mockResolvedValue([{ id: 'stream-a' }]);

      await service.regionalDailyActivity('mod-1');

      expect(prisma.roomReport.count).toHaveBeenCalledWith({
        where: { roomId: { in: ['room-a', 'room-b'] }, status: 'PENDING' },
      });
      expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({
        where: { roomId: { in: ['vroom-a'] }, status: 'PENDING' },
      });
      expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({
        where: { streamId: { in: ['stream-a'] }, status: 'PENDING' },
      });
    });

    it('is unrestricted for platform staff: counts all reports with no id filter', async () => {
      scope.userScopeFilter.mockResolvedValue({});
      await service.regionalDailyActivity('admin-1');
      expect(prisma.roomReport.count).toHaveBeenCalledWith({ where: { status: 'PENDING' } });
      expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({ where: { status: 'PENDING' } });
      expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({ where: { status: 'PENDING' } });
    });

    it('assignedReportsCount is the sum across all three report surfaces, and only counts PENDING (open) reports', async () => {
      // Regression guard: this count previously had no status filter at
      // all, so it kept growing forever instead of reflecting the open
      // backlog — REVIEWED/DISMISSED/ACTIONED reports must not count.
      scope.userScopeFilter.mockResolvedValue({});
      prisma.roomReport.count.mockResolvedValue(3);
      prisma.videoRoomReport.count.mockResolvedValue(2);
      prisma.liveStreamReport.count.mockResolvedValue(1);
      const result = await service.regionalDailyActivity('admin-1');
      expect(result.assignedReportsCount).toBe(6);
      for (const call of prisma.roomReport.count.mock.calls) {
        if ('status' in call[0].where) expect(call[0].where.status).toBe('PENDING');
      }
    });

    it('reports new-report volume for today and yesterday separately, for the "vs yesterday" delta', async () => {
      scope.userScopeFilter.mockResolvedValue({});
      // Calls are: [PENDING, PENDING, PENDING, investigations, today x3, yesterday x3].
      prisma.roomReport.count
        .mockResolvedValueOnce(0) // PENDING
        .mockResolvedValueOnce(5) // new today
        .mockResolvedValueOnce(3); // new yesterday
      prisma.videoRoomReport.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      prisma.liveStreamReport.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      const result = await service.regionalDailyActivity('admin-1');

      expect(result.newReportsToday).toBe(8);
      expect(result.newReportsYesterday).toBe(4);
    });

    it('matches nothing (not everything) when a STATE scope resolves to zero in-scope owners', async () => {
      // Moderators are provisioned at STATE granularity; a state with no
      // users located in it yet must show no data, not everyone's data.
      scope.userScopeFilter.mockResolvedValue({ OR: [{ stateId: 's-empty' }] });
      prisma.user.findMany.mockResolvedValue([]);
      // Earlier tests in this describe block leave these mocks holding
      // non-empty resolved values (jest.clearAllMocks() clears call history,
      // not implementations) — reset explicitly so this "zero owners" case
      // isn't accidentally fed leftover rooms/streams from another test.
      prisma.audioRoom.findMany.mockResolvedValue([]);
      prisma.videoRoom.findMany.mockResolvedValue([]);
      prisma.liveStream.findMany.mockResolvedValue([]);

      await service.regionalDailyActivity('mod-1');

      expect(prisma.audioRoom.findMany).toHaveBeenNthCalledWith(1, {
        where: { ownerId: { in: [] } },
        select: { id: true },
      });
      const investigationWhere = prisma.investigationRecording.count.mock.calls[0][0].where;
      expect(investigationWhere.OR).toEqual([{ roomId: { in: [] } }, { liveStreamId: { in: [] } }]);
    });

    it('is unrestricted for platform staff (empty scope filter)', async () => {
      scope.userScopeFilter.mockResolvedValue({});

      await service.regionalDailyActivity('admin-1');

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      const investigationWhere = prisma.investigationRecording.count.mock.calls[0][0].where;
      expect(investigationWhere.OR).toBeUndefined();
      const roomWhere = prisma.audioRoom.findMany.mock.calls[0][0].where;
      expect(roomWhere.ownerId).toBeUndefined();
    });
  });

  describe('buildDelta — dashboard "vs yesterday" tile math', () => {
    it('computes a signed percentage change', () => {
      expect((service as any).buildDelta(46, 40, true)).toEqual({ percent: 15, favorable: true });
    });

    it('flags a decrease as unfavorable for a higher-is-better metric (e.g. reports solved)', () => {
      expect((service as any).buildDelta(10, 20, true)).toEqual({ percent: -50, favorable: false });
    });

    it('flags an increase as unfavorable for a lower-is-better metric (e.g. avg. resolution time)', () => {
      expect((service as any).buildDelta(24, 20, false)).toEqual({ percent: 20, favorable: false });
    });

    it('flags a decrease as favorable for a lower-is-better metric', () => {
      expect((service as any).buildDelta(15, 20, false)).toEqual({ percent: -25, favorable: true });
    });

    it('returns no percentage when both today and yesterday are zero (nothing to compare)', () => {
      expect((service as any).buildDelta(0, 0, true)).toEqual({ percent: null, favorable: true });
    });

    it('returns no percentage — not Infinity% — when yesterday was zero but today is not', () => {
      expect((service as any).buildDelta(5, 0, true)).toEqual({ percent: null, favorable: true });
      expect((service as any).buildDelta(5, 0, false)).toEqual({ percent: null, favorable: false });
    });
  });

  describe('taskCompletionRateAsOf — live rate, not the ModeratorDailyStats column nothing writes', () => {
    it('computes completed/assigned as of the cutoff from assignment timestamps', async () => {
      prisma.moderator_task_assignments.count
        .mockResolvedValueOnce(10) // assigned as of cutoff
        .mockResolvedValueOnce(6); // completed as of cutoff
      const cutoff = new Date('2026-08-18T00:00:00.000Z');

      const rate = await (service as any).taskCompletionRateAsOf('mod-1', cutoff);

      expect(rate).toBe(60);
      expect(prisma.moderator_task_assignments.count).toHaveBeenNthCalledWith(1, {
        where: { moderatorId: 'mod-1', createdAt: { lte: cutoff } },
      });
      expect(prisma.moderator_task_assignments.count).toHaveBeenNthCalledWith(2, {
        where: { moderatorId: 'mod-1', completedAt: { lte: cutoff } },
      });
    });

    it('returns 0 (not NaN) when nothing was assigned yet as of the cutoff', async () => {
      prisma.moderator_task_assignments.count.mockResolvedValue(0);

      const rate = await (service as any).taskCompletionRateAsOf('mod-1', new Date());

      expect(rate).toBe(0);
    });
  });

  describe('resolveReportContext', () => {
    it('resolves an audio report and maps roomId from RoomReport', async () => {
      prisma.roomReport.findUnique = jest.fn().mockResolvedValue({
        id: 'r-1',
        roomId: 'room-1',
        reporterId: 'u-1',
        targetUserId: 'u-2',
        reason: 'HARASSMENT',
        description: null,
        status: 'PENDING',
        createdAt: new Date('2026-08-18'),
        assignedAt: null,
      });
      prisma.videoRoomReport.findUnique = jest.fn();
      prisma.liveStreamReport.findUnique = jest.fn();

      const ctx = await (service as any).resolveReportContext('r-1');

      expect(ctx.roomType).toBe('audio');
      expect(ctx.roomId).toBe('room-1');
      expect(prisma.videoRoomReport.findUnique).not.toHaveBeenCalled();
    });

    it('falls through to video, then live-stream, before giving up', async () => {
      prisma.roomReport.findUnique = jest.fn().mockResolvedValue(null);
      prisma.videoRoomReport.findUnique = jest.fn().mockResolvedValue(null);
      prisma.liveStreamReport.findUnique = jest.fn().mockResolvedValue({
        id: 'r-3',
        streamId: 'stream-1',
        reporterId: 'u-1',
        targetUserId: 'u-2',
        reason: 'SPAM',
        description: null,
        status: 'PENDING',
        createdAt: new Date('2026-08-18'),
      });

      const ctx = await (service as any).resolveReportContext('r-3');

      expect(ctx.roomType).toBe('stream');
      expect(ctx.roomId).toBe('stream-1');
      expect(ctx.assignedAt).toBeNull();
    });

    it('throws NotFoundException when no table has the id', async () => {
      prisma.roomReport.findUnique = jest.fn().mockResolvedValue(null);
      prisma.videoRoomReport.findUnique = jest.fn().mockResolvedValue(null);
      prisma.liveStreamReport.findUnique = jest.fn().mockResolvedValue(null);

      await expect((service as any).resolveReportContext('missing')).rejects.toThrow(
        'Report not found.',
      );
    });
  });

  describe('moderationQueue — real priority, rule-violated, and live-stream inclusion', () => {
    beforeEach(() => {
      scope.userScopeFilter.mockResolvedValue({});
      prisma.liveStreamReport.findMany = jest.fn().mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);
    });

    it('includes live-stream reports alongside audio and video', async () => {
      prisma.roomReport.findMany.mockResolvedValue([]);
      prisma.videoRoomReport.findMany.mockResolvedValue([]);
      prisma.liveStreamReport.findMany.mockResolvedValue([
        {
          id: 'ls-1',
          streamId: 'stream-1',
          reporterId: 'u-1',
          targetUserId: 'u-2',
          reason: 'HATE_SPEECH',
          description: null,
          status: 'PENDING',
          createdAt: new Date('2026-08-18T10:00:00Z'),
          assignedAt: null,
        },
      ]);
      prisma.liveStream = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'stream-1', title: 'Live zone', hostId: 'host-1' }]),
        findUnique: jest.fn().mockResolvedValue(null),
      };
      prisma.user.findMany.mockResolvedValue([
        { id: 'u-1', username: 'reporter', fullName: 'Reporter' },
        { id: 'u-2', username: 'target', fullName: 'Target' },
        { id: 'host-1', locationState: { name: 'Karnataka' } },
      ]);

      const result = await service.moderationQueue('mod-1');

      expect(result).toHaveLength(1);
      expect(result[0].roomType).toBe('stream');
      expect(result[0].priority).toBe('Medium priority'); // HATE_SPEECH
      expect(result[0].region).toBe('Karnataka');
    });

    it('derives priority from the real reason, not the room type', async () => {
      prisma.roomReport.findMany.mockResolvedValue([
        {
          id: 'ar-1',
          roomId: 'room-1',
          reporterId: 'u-1',
          targetUserId: 'u-2',
          reason: 'THREATS',
          description: null,
          status: 'PENDING',
          createdAt: new Date('2026-08-18T10:00:00Z'),
          assignedAt: null,
        },
      ]);
      prisma.videoRoomReport.findMany.mockResolvedValue([]);
      prisma.audioRoom.findMany.mockResolvedValue([
        { id: 'room-1', name: 'Chill vibes', ownerId: 'owner-1' },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u-1', username: 'reporter', fullName: 'Reporter' },
        { id: 'u-2', username: 'target', fullName: 'Target' },
        { id: 'owner-1', locationState: null },
      ]);

      const result = await service.moderationQueue('mod-1');

      // Old behavior hardcoded every audio report to "Medium priority" regardless
      // of reason — THREATS must now come back Highest.
      expect(result[0].priority).toBe('Highest priority');
      expect(result[0].ruleViolated).toBe('Threats & violence (2.3)');
    });

    it('collapses REVIEWED/ACTIONED/DISMISSED to "Resolved" and PENDING to "Under review"', async () => {
      prisma.roomReport.findMany.mockResolvedValue([
        {
          id: 'ar-1',
          roomId: 'room-1',
          reporterId: 'u-1',
          targetUserId: 'u-2',
          reason: 'SPAM',
          description: null,
          status: 'ACTIONED',
          createdAt: new Date(),
          assignedAt: null,
        },
      ]);
      prisma.videoRoomReport.findMany.mockResolvedValue([]);
      prisma.audioRoom.findMany.mockResolvedValue([
        { id: 'room-1', name: 'Room', ownerId: 'owner-1' },
      ]);
      prisma.user.findMany.mockResolvedValue([{ id: 'owner-1', locationState: null }]);

      const result = await service.moderationQueue('mod-1');

      expect(result[0].status).toBe('Resolved');
    });
  });

  describe('reportDetails', () => {
    const actorRoles = ['MODERATOR'] as any;
    const usersById: Record<
      string,
      { username?: string; fullName?: string; locationState?: { name: string } | null }
    > = {
      'u-1': { username: 'reporter', fullName: 'Reporter' },
      'u-2': { username: 'target', fullName: 'Target' },
      'owner-1': { locationState: { name: 'Karnataka' } },
    };

    beforeEach(() => {
      prisma.roomReport.findUnique = jest.fn();
      prisma.videoRoomReport.findUnique = jest.fn();
      prisma.liveStreamReport.findUnique = jest.fn();
      prisma.audioRoom.findUnique = jest.fn();
      prisma.videoRoom.findUnique = jest.fn();
      prisma.liveStream.findUnique = jest.fn();
      prisma.user.findUnique = jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(usersById[where.id] ?? null),
        );
      prisma.roomReport.count = jest.fn().mockResolvedValue(0);
      prisma.videoRoomReport.count = jest.fn().mockResolvedValue(0);
      prisma.liveStreamReport.count = jest.fn().mockResolvedValue(0);
      scope.userScopeFilter.mockResolvedValue({});
      scope.assertModeratorInScope.mockResolvedValue(undefined);
      permissionResolver.resolveUserPermissions.mockResolvedValue(new Set());
      permissionResolver.hasPermission.mockReturnValue(false);
      investigationRecording.getCaseView.mockResolvedValue({ recordings: [], auditLogs: [] });
      shiftService.shiftStatus.mockResolvedValue({
        isActive: false,
        shift: null,
        nextShiftStartsInSeconds: null,
      });
    });

    const baseAudioReport = {
      id: 'r-1',
      roomId: 'room-1',
      reporterId: 'u-1',
      targetUserId: 'u-2',
      reason: 'THREATS',
      description: 'desc',
      status: 'PENDING',
      createdAt: new Date('2026-08-18T10:30:00Z'),
      assignedAt: new Date('2026-08-18T10:32:00Z'),
    };

    it('404s when the report id matches no table', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(null);
      prisma.videoRoomReport.findUnique.mockResolvedValue(null);
      prisma.liveStreamReport.findUnique.mockResolvedValue(null);

      await expect(service.reportDetails('mod-1', 'missing', actorRoles)).rejects.toThrow(
        'Report not found.',
      );
    });

    it('shows evidenceId "Pending" with no recording when the report has not been actioned yet', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
      prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Chill vibes', ownerId: 'owner-1' });

      const detail = await service.reportDetails('mod-1', 'r-1', actorRoles);

      expect(detail.evidenceId).toBe('Pending');
      expect(detail.recordingUrl).toBeNull();
      expect(detail.priority).toBe('Highest priority'); // THREATS
      expect(detail.region).toBe('Karnataka');
      expect(detail.targetUserName).toBe('Target');
    });

    it('shows the real recording once one exists, gated by canViewFullEvidence', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
      prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Chill vibes', ownerId: 'owner-1' });
      investigationRecording.getCaseView.mockResolvedValue({
        recordings: [
          {
            roomId: 'room-1',
            liveStreamId: null,
            evidenceId: 'EVD-abc123',
            recordingUrl: 'https://cdn/rec.mp4',
            startedAt: new Date('2026-08-18T10:35:00Z'),
          },
        ],
        auditLogs: [],
      });

      const withoutPermission = await service.reportDetails('mod-1', 'r-1', actorRoles);
      expect(withoutPermission.evidenceId).toBe('EVD-abc123');
      expect(withoutPermission.recordingUrl).toBeNull();
      expect(withoutPermission.canViewFullEvidence).toBe(false);

      permissionResolver.hasPermission.mockReturnValue(true);
      const withPermission = await service.reportDetails('mod-1', 'r-1', actorRoles);
      expect(withPermission.recordingUrl).toBe('https://cdn/rec.mp4');
      expect(withPermission.canViewFullEvidence).toBe(true);
    });

    it('counts previous reports against the same target user across all 3 tables, excluding this one', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
      prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Room', ownerId: 'owner-1' });
      prisma.roomReport.count.mockResolvedValue(2);
      prisma.videoRoomReport.count.mockResolvedValue(1);
      prisma.liveStreamReport.count.mockResolvedValue(0);

      const detail = await service.reportDetails('mod-1', 'r-1', actorRoles);

      // previousReportCount is a display string ("N previous report(s)"), not a number.
      expect(detail.previousReportCount).toBe('3 previous reports');
      expect(prisma.roomReport.count).toHaveBeenCalledWith({
        where: { targetUserId: 'u-2', id: { not: 'r-1' } },
      });
    });

    it('gates shiftActive/canTakeAction on the real shift status for a MODERATOR caller', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
      prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Chill vibes', ownerId: 'owner-1' });
      shiftService.shiftStatus.mockResolvedValue({
        isActive: false,
        shift: null,
        nextShiftStartsInSeconds: null,
      });

      const detail = await service.reportDetails('mod-1', 'r-1', actorRoles);

      expect(shiftService.shiftStatus).toHaveBeenCalledWith('mod-1');
      expect(detail.shiftActive).toBe(false);
      expect(detail.canTakeAction).toBe(false);
    });

    it('exempts a non-MODERATOR caller (e.g. OFFICIAL) from shift gating, mirroring ShiftActiveGuard', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
      prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Chill vibes', ownerId: 'owner-1' });
      // Shift status says inactive — an OFFICIAL caller must not be gated by
      // it at all, proving the exemption actually runs, not just compiles.
      shiftService.shiftStatus.mockResolvedValue({
        isActive: false,
        shift: null,
        nextShiftStartsInSeconds: null,
      });

      const detail = await service.reportDetails('mod-1', 'r-1', ['OFFICIAL'] as any);

      expect(detail.shiftActive).toBe(true);
      expect(detail.canTakeAction).toBe(true);
    });
  });

  describe('actionReport', () => {
    const actorRoles = ['MODERATOR'] as any;
    const audioCtx = {
      id: 'r-1',
      roomId: 'room-1',
      reporterId: 'u-1',
      targetUserId: 'u-2',
      reason: 'HARASSMENT',
      description: null,
      status: 'PENDING',
      createdAt: new Date(),
      assignedAt: null,
    };

    beforeEach(() => {
      prisma.roomReport.findUnique = jest.fn().mockResolvedValue(audioCtx);
      prisma.videoRoomReport.findUnique = jest.fn().mockResolvedValue(null);
      prisma.liveStreamReport.findUnique = jest.fn().mockResolvedValue(null);
      // resolveOwnerId needs findUnique on whichever table the resolved
      // roomType points to — stub all three so any test (audio, video, or
      // live-stream routing) finds an owner without a "not a function" crash.
      prisma.audioRoom.findUnique = jest.fn().mockResolvedValue({ ownerId: 'owner-1' });
      prisma.videoRoom.findUnique = jest.fn().mockResolvedValue({ ownerId: 'owner-1' });
      prisma.liveStream.findUnique = jest.fn().mockResolvedValue({ hostId: 'owner-1' });
      scope.assertModeratorInScope.mockResolvedValue(undefined);
      audioModeration.reviewReport.mockResolvedValue(undefined);
      audioModeration.dismissReport.mockResolvedValue(undefined);
      audioModeration.escalateViolation.mockResolvedValue(undefined);
    });

    it('rejects a blank note before touching any moderation service', async () => {
      await expect(
        service.actionReport('mod-1', 'r-1', { action: 'Warn', note: '   ' }, actorRoles),
      ).rejects.toThrow('note');
      expect(audioModeration.reviewReport).not.toHaveBeenCalled();
    });

    it('rejects an unrecognized action', async () => {
      await expect(
        service.actionReport('mod-1', 'r-1', { action: 'Nonsense', note: 'x' }, actorRoles),
      ).rejects.toThrow();
    });

    it('Warn calls reviewReport with recommendedAction WARNING on the audio surface', async () => {
      const result = await service.actionReport(
        'mod-1',
        'r-1',
        { action: 'Warn', note: 'be nice' },
        actorRoles,
      );

      expect(audioModeration.reviewReport).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'room-1',
        'r-1',
        { status: 'ACTIONED', resolution: 'be nice', recommendedAction: 'WARNING' },
      );
      expect(result.outcome).toBe('executed');
    });

    it('Ban executes immediately via PlatformBanService, not the approval queue', async () => {
      const result = await service.actionReport(
        'mod-1',
        'r-1',
        { action: 'Ban', note: 'severe' },
        actorRoles,
      );

      expect(audioModeration.reviewReport).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'room-1',
        'r-1',
        { status: 'ACTIONED', resolution: 'severe' },
      );
      expect(platformBans.banUser).toHaveBeenCalledWith({
        moderatorId: 'mod-1',
        targetUserId: 'u-2',
        reason: 'severe',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
        reportId: 'r-1',
      });
      expect(result.outcome).toBe('executed');
    });

    it('Ban issues the platform ban BEFORE marking the report actioned', async () => {
      // Ordering invariant, not per-surface behaviour (audio stands in for all
      // three). If the status update ran first and banUser then threw, the
      // report would be left ACTIONED with no ban issued — and every
      // reviewReport implementation 409s on a non-PENDING report, so the
      // moderator could never retry. Ban-first means a banUser failure leaves
      // the report PENDING and retryable.
      await service.actionReport('mod-1', 'r-1', { action: 'Ban', note: 'severe' }, actorRoles);

      expect(platformBans.banUser.mock.invocationCallOrder[0]).toBeLessThan(
        audioModeration.reviewReport.mock.invocationCallOrder[0],
      );
    });

    it.each([['OFFICIAL'], ['COUNTRY_MANAGER']])(
      'Ban refuses a %s actor without issuing the ban',
      async (role) => {
        // The decision route is gated only on `mobile.workforce.view`, which
        // OFFICIAL and COUNTRY_MANAGER both hold — it does not require
        // `user.ban`. Moderator authority used to be enforced incidentally,
        // by the per-surface reviewReport call that ran first; now that the
        // ban runs first (see the ordering test above) that no longer covers
        // it, so the BAN branch asserts authority itself. Without this, either
        // role could trigger an immediate platform-wide ban.
        await expect(
          service.actionReport('mod-1', 'r-1', { action: 'Ban', note: 'severe' }, [role] as any),
        ).rejects.toThrow(ForbiddenException);

        expect(platformBans.banUser).not.toHaveBeenCalled();
        expect(audioModeration.reviewReport).not.toHaveBeenCalled();
      },
    );

    it('Ban refuses an actor with no roles at all with 403, not a TypeError', async () => {
      await expect(
        service.actionReport('mod-1', 'r-1', { action: 'Ban', note: 'severe' }, undefined as any),
      ).rejects.toThrow(ForbiddenException);
      expect(platformBans.banUser).not.toHaveBeenCalled();
    });

    it('Ban refuses an already-reviewed report instead of issuing a duplicate ban', async () => {
      // The ban now runs before the status update, so reviewReport's internal
      // 409 no longer stands between a re-POSTed "Ban" and a real side effect.
      // Without an explicit precheck, re-submitting Ban on an already-ACTIONED
      // report (or retrying after the ban landed but the status update failed)
      // would issue a SECOND 24h platform ban — new row, new Redis TTL, rooms
      // re-ended, sockets re-disconnected — and only then hit the 409.
      prisma.roomReport.findUnique.mockResolvedValue({ ...audioCtx, status: 'ACTIONED' });

      await expect(
        service.actionReport('mod-1', 'r-1', { action: 'Ban', note: 'severe' }, actorRoles),
      ).rejects.toThrow(ConflictException);

      expect(platformBans.banUser).not.toHaveBeenCalled();
    });

    it('"Close false report" calls dismissReport, not reviewReport', async () => {
      const result = await service.actionReport(
        'mod-1',
        'r-1',
        { action: 'Close false report', note: 'not a real violation' },
        actorRoles,
      );

      expect(audioModeration.dismissReport).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'room-1',
        'r-1',
        'not a real violation',
      );
      expect(result.outcome).toBe('dismissed');
    });

    it('Escalate reviews the report as REVIEWED then always escalates at EMERGENCY severity, tagged with the report id', async () => {
      const result = await service.actionReport(
        'mod-1',
        'r-1',
        { action: 'Escalate', note: 'urgent' },
        actorRoles,
      );

      expect(audioModeration.reviewReport).toHaveBeenCalledWith(
        expect.anything(),
        'room-1',
        'r-1',
        { status: 'REVIEWED', resolution: 'urgent' },
      );
      // Always EMERGENCY — resolveEscalationRecipients resolves that tier to
      // every ADMIN/SUPER_ADMIN unconditionally, regardless of report
      // priority (HARASSMENT would otherwise derive to HIGH, not EMERGENCY).
      expect(audioModeration.escalateViolation).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'room-1',
        'u-2',
        '[Report #r-1 escalation] urgent',
        'EMERGENCY',
      );
      expect(result.outcome).toBe('escalated');
    });

    it('routes to the live-stream surface with recommendedAction WARN (not WARNING)', async () => {
      prisma.roomReport.findUnique.mockResolvedValue(null);
      prisma.liveStreamReport.findUnique.mockResolvedValue({
        id: 'r-2',
        streamId: 'stream-1',
        reporterId: 'u-1',
        targetUserId: 'u-2',
        reason: 'THREATS',
        description: null,
        status: 'PENDING',
        createdAt: new Date(),
      });
      liveStreamReports.reviewReport.mockResolvedValue(undefined);

      await service.actionReport('mod-1', 'r-2', { action: 'Warn', note: 'be nice' }, actorRoles);

      expect(liveStreamReports.reviewReport).toHaveBeenCalledWith(
        {
          reportId: 'r-2',
          streamId: 'stream-1',
          moderatorId: 'mod-1',
          actorRoles,
          status: 'ACTIONED',
          resolution: 'be nice',
          recommendedAction: 'WARN',
        },
        undefined,
      );
    });

    // BAN and ESCALATE were originally only exercised on the audio surface;
    // the video and live-stream branches of both are covered below.

    const videoCtx = {
      id: 'r-3',
      roomId: 'vroom-1',
      reporterId: 'u-1',
      targetUserId: 'u-2',
      reason: 'HARASSMENT',
      description: null,
      status: 'PENDING',
      createdAt: new Date(),
      assignedAt: null,
    };

    const streamCtx = {
      id: 'r-4',
      streamId: 'stream-1',
      reporterId: 'u-1',
      targetUserId: 'u-2',
      reason: 'THREATS',
      description: null,
      status: 'PENDING',
      createdAt: new Date(),
    };

    /** Routes resolveReportContext to the video table by emptying the others. */
    const routeToVideo = () => {
      prisma.roomReport.findUnique.mockResolvedValue(null);
      prisma.videoRoomReport.findUnique.mockResolvedValue(videoCtx);
      prisma.liveStreamReport.findUnique.mockResolvedValue(null);
    };

    /** Routes resolveReportContext to the live-stream table. */
    const routeToStream = () => {
      prisma.roomReport.findUnique.mockResolvedValue(null);
      prisma.videoRoomReport.findUnique.mockResolvedValue(null);
      prisma.liveStreamReport.findUnique.mockResolvedValue(streamCtx);
    };

    it('Ban routes to the video surface and bans with roomType VIDEO_ROOM', async () => {
      routeToVideo();
      videoReports.reviewReport.mockResolvedValue(undefined);

      const result = await service.actionReport(
        'mod-1',
        'r-3',
        { action: 'Ban', note: 'severe' },
        actorRoles,
      );

      expect(videoReports.reviewReport).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'vroom-1',
        'r-3',
        { status: 'ACTIONED', resolutionAction: 'severe' },
        undefined,
      );
      expect(platformBans.banUser).toHaveBeenCalledWith({
        moderatorId: 'mod-1',
        targetUserId: 'u-2',
        reason: 'severe',
        roomType: 'VIDEO_ROOM',
        originRoomId: 'vroom-1',
        reportId: 'r-3',
      });
      expect(result.outcome).toBe('executed');
    });

    it('Ban routes to the live-stream surface and bans with roomType LIVE_STREAM', async () => {
      routeToStream();
      liveStreamReports.reviewReport.mockResolvedValue(undefined);

      const result = await service.actionReport(
        'mod-1',
        'r-4',
        { action: 'Ban', note: 'severe' },
        actorRoles,
      );

      expect(liveStreamReports.reviewReport).toHaveBeenCalledWith(
        {
          reportId: 'r-4',
          streamId: 'stream-1',
          moderatorId: 'mod-1',
          actorRoles,
          status: 'ACTIONED',
          resolution: 'severe',
        },
        undefined,
      );
      expect(platformBans.banUser).toHaveBeenCalledWith({
        moderatorId: 'mod-1',
        targetUserId: 'u-2',
        reason: 'severe',
        roomType: 'LIVE_STREAM',
        originRoomId: 'stream-1',
        reportId: 'r-4',
      });
      expect(result.outcome).toBe('executed');
    });

    it('Escalate routes to the video surface at EMERGENCY severity', async () => {
      routeToVideo();
      videoReports.reviewReport.mockResolvedValue(undefined);
      videoModeration.escalateViolation.mockResolvedValue(undefined);

      const result = await service.actionReport(
        'mod-1',
        'r-3',
        { action: 'Escalate', note: 'urgent' },
        actorRoles,
      );

      expect(videoModeration.escalateViolation).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'vroom-1',
        'u-2',
        '[Report #r-3 escalation] urgent',
        'EMERGENCY',
      );
      expect(result.outcome).toBe('escalated');
    });

    it('Escalate routes to the live-stream surface at EMERGENCY severity', async () => {
      routeToStream();
      liveStreamReports.reviewReport.mockResolvedValue(undefined);
      liveStream.escalateViolation.mockResolvedValue(undefined);

      const result = await service.actionReport(
        'mod-1',
        'r-4',
        { action: 'Escalate', note: 'urgent' },
        actorRoles,
      );

      expect(liveStream.escalateViolation).toHaveBeenCalledWith(
        'stream-1',
        'mod-1',
        'u-2',
        '[Report #r-4 escalation] urgent',
        'EMERGENCY',
      );
      expect(result.outcome).toBe('escalated');
    });
  });

  describe('roomDetails — moderator "Room Details" chat card and participants', () => {
    const room = {
      id: 'room-1',
      name: 'Chill vibes',
      ownerId: 'owner-1',
      visibility: 'PUBLIC',
      createdAt: new Date('2026-08-19T09:00:00Z'),
      imageKey: null,
    };

    beforeEach(() => {
      prisma.audioRoom.findUnique.mockResolvedValue(room);
      prisma.videoRoom.findUnique.mockResolvedValue(null);
      prisma.liveStream.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        username: 'owner',
        fullName: 'Owner Name',
      });
      prisma.roomMember.findMany.mockResolvedValue([]);
      prisma.roomMember.count.mockResolvedValue(0);
      prisma.roomMessage.findMany.mockResolvedValue([]);
      prisma.roomReport.findMany.mockResolvedValue([]);
      prisma.roomReport.count.mockResolvedValue(0);
      prisma.user.findMany.mockResolvedValue([]);
      prisma.userStatistics.findMany.mockResolvedValue([]);
      prisma.userStatistics.findUnique.mockResolvedValue(null);
      prisma.userProfile.findMany.mockResolvedValue([]);
      prisma.userProfile.findUnique.mockResolvedValue(null);
      prisma.roomBan.count.mockResolvedValue(0);
      prisma.platformUserBan.count.mockResolvedValue(0);
      prisma.roomLiveSession.findFirst.mockResolvedValue(null);
    });

    it('attributes SYSTEM and ANNOUNCEMENT messages to "System" and resolves a real sender name + avatar for normal messages, exactly like the in-room chat', async () => {
      prisma.roomMessage.findMany.mockResolvedValue([
        {
          id: 'm-sys',
          senderId: SYSTEM_MODERATOR_ID,
          type: 'SYSTEM',
          content: 'User was warned for spam.',
          createdAt: new Date('2026-08-19T10:05:00Z'),
        },
        {
          id: 'm-ann',
          senderId: 'mod-1',
          type: 'ANNOUNCEMENT',
          content: 'This room is being monitored.',
          createdAt: new Date('2026-08-19T10:06:00Z'),
        },
        {
          id: 'm-txt',
          senderId: 'user-2',
          type: 'TEXT',
          content: 'hii',
          createdAt: new Date('2026-08-19T10:07:00Z'),
        },
      ]);
      // mod-1 is a real moderator account but must still read as System because
      // the message TYPE is ANNOUNCEMENT — matching the audio-rooms-admin
      // "getLiveSession" reference implementation.
      // user-2's fullName is deliberately set to something that is NOT their
      // username (mirroring real data: a user's fullName can coincidentally
      // match unrelated text, e.g. their own room's name). The live in-room
      // chat (chat_author_provider.dart) resolves senders by username only,
      // never fullName, so the moderator chat card must match that — not
      // fall back to fullName first.
      prisma.user.findMany.mockResolvedValue([
        { id: 'mod-1', username: 'mod1', fullName: 'Moderator One' },
        { id: 'user-2', username: 'user2', fullName: 'Not The Username' },
      ]);
      prisma.userProfile.findMany.mockResolvedValue([
        { userId: 'user-2', avatarKey: 'avatars/user2.jpg' },
      ]);

      const detail = await service.roomDetails('mod-1', 'room-1');

      expect(detail.chatMessages).toEqual([
        expect.objectContaining({
          id: 'm-sys',
          sender: 'System',
          isSystem: true,
          avatarUrl: null,
          message: 'User was warned for spam.',
        }),
        expect.objectContaining({
          id: 'm-ann',
          sender: 'System',
          isSystem: true,
          avatarUrl: null,
          message: 'This room is being monitored.',
        }),
        expect.objectContaining({
          id: 'm-txt',
          sender: 'user2',
          isSystem: false,
          avatarUrl: 'avatars/user2.jpg',
          message: 'hii',
        }),
      ]);
    });

    it("fetches each participant's real level and avatar from UserStatistics/UserProfile instead of a hardcoded constant", async () => {
      prisma.roomMember.findMany.mockResolvedValue([
        {
          userId: 'user-3',
          roomId: 'room-1',
          role: 'MEMBER',
          isActive: true,
          joinedAt: new Date('2026-08-19T09:30:00Z'),
        },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'user-3', username: 'user3', fullName: 'User Three' },
      ]);
      prisma.userStatistics.findMany.mockResolvedValue([{ userId: 'user-3', level: 27 }]);
      prisma.userProfile.findMany.mockResolvedValue([
        { userId: 'user-3', avatarKey: 'avatars/user3.jpg' },
      ]);

      const detail = await service.roomDetails('mod-1', 'room-1');

      expect(detail.participants).toEqual([
        expect.objectContaining({
          id: 'user-3',
          name: 'User Three',
          handle: '@user3',
          level: 27,
          avatarUrl: 'avatars/user3.jpg',
        }),
      ]);
    });

    it('reportsCount reflects the true total, not the take:20 display-list length', async () => {
      // findMany is capped for the display list; count is the source of truth
      // for the stat-bar number and must not silently cap at the same 20.
      prisma.roomReport.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          id: `r-${i}`,
          reporterId: 'u-1',
          reason: 'SPAM',
          createdAt: new Date('2026-08-19T10:00:00Z'),
        })),
      );
      prisma.roomReport.count.mockResolvedValue(47);

      const detail = await service.roomDetails('mod-1', 'room-1');

      expect(detail.reportsCount).toBe(47);
      expect(detail.activeReports).toHaveLength(20);
      expect(prisma.roomReport.count).toHaveBeenCalledWith({
        where: { roomId: 'room-1', status: 'PENDING' },
      });
    });

    it('bansCount is sourced from PlatformUserBan.originRoomId (the 24h global ban action), not the legacy room-scoped ban table', async () => {
      // A decoy value on the legacy table proves the stat no longer reads it.
      prisma.roomBan.count.mockResolvedValue(999);
      prisma.platformUserBan.count.mockResolvedValue(3);

      const detail = await service.roomDetails('mod-1', 'room-1');

      expect(detail.bansCount).toBe(3);
      expect(prisma.platformUserBan.count).toHaveBeenCalledWith({
        where: { originRoomId: 'room-1', roomType: 'AUDIO_ROOM' },
      });
    });

    it('participantsCount reflects a true count, not the paginated member-list length', async () => {
      // The member list itself stays capped (take: 50) for display, but the
      // stat-bar number must come from a real count query.
      prisma.roomMember.findMany.mockResolvedValue([]);
      prisma.roomMember.count.mockResolvedValue(73);

      const detail = await service.roomDetails('mod-1', 'room-1');

      expect(detail.participantsCount).toBe(73);
      expect(prisma.roomMember.count).toHaveBeenCalledWith({
        where: { roomId: 'room-1', isActive: true },
      });
    });

    it("sessionTime is measured from this broadcast's RoomLiveSession, not the permanent room row's createdAt", async () => {
      // AudioRoom.ownerId is unique — one room row is reused across every
      // broadcast, so room.createdAt (10 days ago here) is the wrong basis
      // for "how long has THIS session been live".
      jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:05:00Z'));
      try {
        prisma.audioRoom.findUnique.mockResolvedValue({
          ...room,
          createdAt: new Date('2026-08-09T12:00:00Z'),
        });
        prisma.roomLiveSession.findFirst.mockResolvedValue({
          startedAt: new Date('2026-08-19T12:00:00Z'),
        });

        const detail = await service.roomDetails('mod-1', 'room-1');

        expect(detail.sessionTime).toBe('5m');
        expect(prisma.roomLiveSession.findFirst).toHaveBeenCalledWith({
          where: { roomId: 'room-1', status: 'LIVE' },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true },
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
