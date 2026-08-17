import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
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
    user: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    roomReport: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    videoRoomReport: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    liveStreamReport: { count: jest.fn().mockResolvedValue(0) },
    investigationRecording: { count: jest.fn().mockResolvedValue(0) },
    audioRoom: { findMany: jest.fn().mockResolvedValue([]) },
    videoRoom: { findMany: jest.fn().mockResolvedValue([]) },
    liveStream: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const scope = { userScopeFilter: jest.fn(), describeScope: jest.fn() };
  const scopes = { getUserScopes: jest.fn().mockResolvedValue([]) };

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

  it('narrows the moderation queue to reporters in scope', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);

    await service.moderationQueue('official-1');

    const where = prisma.roomReport.findMany.mock.calls[0][0].where;
    expect(where.reporterId).toEqual({ in: ['u-1', 'u-2'] });
  });

  it('does not filter the moderation queue by reporter when unrestricted', async () => {
    scope.userScopeFilter.mockResolvedValue({});

    await service.moderationQueue('admin-1');

    const where = prisma.roomReport.findMany.mock.calls[0][0].where;
    expect(where.reporterId).toBeUndefined();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  describe('regionalDailyActivity — the Dashboard\'s "Assigned X" cards', () => {
    it('scopes rooms/streams by the in-scope owner ids, and investigations by their resolved room/stream ids', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);
      scope.userScopeFilter.mockResolvedValue({ OR: [{ stateId: 's-ka' }] });
      prisma.audioRoom.findMany.mockResolvedValueOnce([{ id: 'room-a' }]).mockResolvedValueOnce([]);
      prisma.liveStream.findMany.mockResolvedValueOnce([{ id: 'stream-a' }]).mockResolvedValueOnce([]);

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
        where: { roomId: { in: ['room-a', 'room-b'] } },
      });
      expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({
        where: { roomId: { in: ['vroom-a'] } },
      });
      expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({
        where: { streamId: { in: ['stream-a'] } },
      });
    });

    it('is unrestricted for platform staff: counts all reports with no id filter', async () => {
      scope.userScopeFilter.mockResolvedValue({});
      await service.regionalDailyActivity('admin-1');
      expect(prisma.roomReport.count).toHaveBeenCalledWith({ where: {} });
      expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({ where: {} });
      expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({ where: {} });
    });

    it('assignedReportsCount is the sum across all three report surfaces', async () => {
      scope.userScopeFilter.mockResolvedValue({});
      prisma.roomReport.count.mockResolvedValue(3);
      prisma.videoRoomReport.count.mockResolvedValue(2);
      prisma.liveStreamReport.count.mockResolvedValue(1);
      const result = await service.regionalDailyActivity('admin-1');
      expect(result.assignedReportsCount).toBe(6);
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
});
