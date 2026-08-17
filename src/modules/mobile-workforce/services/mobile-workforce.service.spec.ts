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
    roomReport: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    videoRoomReport: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
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
    it("scopes rooms by the room's own region and streams/investigations by regionId", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);
      scope.userScopeFilter.mockResolvedValue({ OR: [{ regionId: 'r-1' }] });

      await service.regionalDailyActivity('mod-1');

      expect(prisma.investigationRecording.count).toHaveBeenCalledWith({
        where: { status: 'ACTIVE', OR: [{ regionId: 'r-1' }] },
      });
      // The displayed room lists filter on AudioRoom/VideoRoom.region — the
      // room's own region snapshot — never on the owner's profile geography.
      expect(prisma.audioRoom.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ region: 'r-1' }], status: 'LIVE' } }),
      );
      expect(prisma.videoRoom.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ region: 'r-1' }], status: 'LIVE' } }),
      );
      expect(prisma.liveStream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'ACTIVE', OR: [{ regionId: 'r-1' }] },
        }),
      );
    });

    // The bug this replaced: the display lists were filtered by
    // `ownerId IN (users in my scope)`, so a room whose OWNER lives in my
    // region but which itself was created in another region leaked in, and a
    // room in my region owned by an out-of-region host went missing.
    it("includes/excludes a room by the room's own region, not its owner's profile region", async () => {
      scope.userScopeFilter.mockResolvedValue({ OR: [{ regionId: 'r-1' }] });
      // The owner-scope lookup resolves an owner who is NOT the in-region
      // room's owner — if the old ownerFilter were still in play these ids
      // would drive the query and the assertion below would fail.
      prisma.user.findMany.mockResolvedValue([{ id: 'owner-in-my-region' }]);
      prisma.audioRoom.findMany.mockResolvedValue([
        { id: 'room-in-r1', name: 'in region', status: 'LIVE', ownerId: 'owner-elsewhere' },
      ]);

      const result = await service.regionalDailyActivity('mod-1');

      const displayWhere = prisma.audioRoom.findMany.mock.calls[1][0].where;
      expect(displayWhere).toEqual({ OR: [{ region: 'r-1' }], status: 'LIVE' });
      expect(displayWhere.ownerId).toBeUndefined();
      // A room in my region survives even though its owner's profile is not.
      expect(result.assignedAudioRooms.map((r: any) => r.id)).toEqual(['room-in-r1']);
    });

    it('scopes report counts by the target room/stream region, not the reporter', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);
      scope.userScopeFilter.mockResolvedValue({ OR: [{ regionId: 'r-1' }] });
      prisma.audioRoom.findMany.mockResolvedValue([{ id: 'room-a' }, { id: 'room-b' }]);
      prisma.videoRoom.findMany.mockResolvedValue([{ id: 'vroom-a' }]);
      prisma.liveStream.findMany.mockResolvedValue([{ id: 'stream-a' }]);

      await service.regionalDailyActivity('mod-1');

      expect(prisma.roomReport.count).toHaveBeenCalledWith({ where: { roomId: { in: ['room-a', 'room-b'] } } });
      expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({ where: { roomId: { in: ['vroom-a'] } } });
      expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({ where: { streamId: { in: ['stream-a'] } } });
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

    it('matches nothing (not everything) when restricted but no region predicate applies', async () => {
      scope.userScopeFilter.mockResolvedValue({ OR: [{ stateId: 's-1' }] });
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }]);

      await service.regionalDailyActivity('mod-1');

      const investigationWhere = prisma.investigationRecording.count.mock.calls[0][0].where;
      expect(investigationWhere.OR).toEqual([]);
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
