import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import {
  QueryRankingDto,
  RankingAudienceDto,
  RankingPeriodDto,
} from '../dto/video-room-ranking.dto';
import { VideoRoomsRankingsController } from './video-rooms-rankings.controller';

const USER = { id: 'u1', roles: [], isGuest: false } as never;
const GUEST = { id: 'g1', roles: [], isGuest: true } as never;

const dto = (over: Partial<QueryRankingDto> = {}): QueryRankingDto =>
  Object.assign(new QueryRankingDto(), {
    dimension: VideoRoomRankingDimension.HOSTS,
    period: RankingPeriodDto.DAILY,
    audience: RankingAudienceDto.ALL,
    limit: 20,
    page: 1,
    ...over,
  });

/**
 * The 7 routes whose whole reason for existing is to hard-code a dimension,
 * ignoring whatever `?dimension=` the caller sent. A copy-paste error wiring
 * e.g. `vip()` to `PK` would only be caught by asserting BOTH that the
 * route's own dimension wins AND that a different query-string dimension is
 * ignored — wiring alone (dimension present at all) would pass either way.
 */
const FORCED_DIMENSION_ROUTES: {
  name: string;
  dimension: VideoRoomRankingDimension;
  invoke: (c: VideoRoomsRankingsController, d: QueryRankingDto) => unknown;
}[] = [
  {
    name: 'hosts',
    dimension: VideoRoomRankingDimension.HOSTS,
    invoke: (c, d) => c.hosts(USER, d),
  },
  {
    name: 'gifters',
    dimension: VideoRoomRankingDimension.GIFTERS,
    invoke: (c, d) => c.gifters(USER, d),
  },
  {
    name: 'receivers',
    dimension: VideoRoomRankingDimension.RECEIVERS,
    invoke: (c, d) => c.receivers(USER, d),
  },
  {
    name: 'rooms',
    dimension: VideoRoomRankingDimension.ROOMS,
    invoke: (c, d) => c.rooms(USER, d),
  },
  { name: 'pk', dimension: VideoRoomRankingDimension.PK, invoke: (c, d) => c.pk(USER, d) },
  {
    name: 'treasure',
    dimension: VideoRoomRankingDimension.TREASURE,
    invoke: (c, d) => c.treasure(USER, d),
  },
  { name: 'vip', dimension: VideoRoomRankingDimension.VIP, invoke: (c, d) => c.vip(USER, d) },
];

describe('VideoRoomsRankingsController', () => {
  let query: { getLadder: jest.Mock; getSelfRank: jest.Mock; getHistory: jest.Mock };
  let boards: { projectAudience: jest.Mock };
  let controller: VideoRoomsRankingsController;

  beforeEach(() => {
    query = {
      getLadder: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
      getSelfRank: jest.fn().mockResolvedValue({ rank: 5 }),
      getHistory: jest.fn().mockResolvedValue([]),
    };
    boards = { projectAudience: jest.fn().mockResolvedValue({ items: [] }) };
    controller = new VideoRoomsRankingsController(query as never, boards as never);
  });

  describe.each(FORCED_DIMENSION_ROUTES)('$name', ({ dimension, invoke }) => {
    it('forces its own dimension into the query service, ignoring a different ?dimension=', async () => {
      // A different dimension than the one this route should force, so the
      // assertion below only passes if the route actually overrides it.
      const other =
        dimension === VideoRoomRankingDimension.PK
          ? VideoRoomRankingDimension.HOSTS
          : VideoRoomRankingDimension.PK;

      await invoke(controller, dto({ dimension: other }));

      expect(query.getLadder).toHaveBeenCalledTimes(1);
      expect(query.getLadder.mock.calls[0][1].dimension).toBe(dimension);
    });
  });

  it('reads the dimension from the query on /global, unlike the forced routes', async () => {
    await controller.global(USER, dto({ dimension: VideoRoomRankingDimension.PK }));
    expect(query.getLadder.mock.calls[0][1].dimension).toBe(VideoRoomRankingDimension.PK);

    await controller.global(USER, dto({ dimension: VideoRoomRankingDimension.VIP }));
    expect(query.getLadder.mock.calls[1][1].dimension).toBe(VideoRoomRankingDimension.VIP);
  });

  it('passes the caller through as a viewer with the guest flag intact', async () => {
    await controller.hosts(GUEST, dto());
    expect(query.getLadder.mock.calls[0][0]).toEqual({ id: 'g1', isGuest: true });
  });

  it('treats a missing isGuest flag as not-a-guest', async () => {
    await controller.hosts({ id: 'u2', roles: [] } as never, dto());
    expect(query.getLadder.mock.calls[0][0].isGuest).toBe(false);
  });

  it('routes an audience projection to the leaderboard service, not the ladder', async () => {
    await controller.gifters(USER, dto({ audience: RankingAudienceDto.FRIENDS }));
    expect(boards.projectAudience).toHaveBeenCalledWith(
      { id: 'u1', isGuest: false },
      expect.objectContaining({ dimension: VideoRoomRankingDimension.GIFTERS }),
      'friends',
    );
    expect(query.getLadder).not.toHaveBeenCalled();
  });

  it('builds a country scope from the query parameter', async () => {
    await controller.country(USER, dto({ country: 'in' }));
    expect(query.getLadder.mock.calls[0][1].scope).toBe('c:IN');
  });

  it('builds a room scope from the path parameter', async () => {
    await controller.roomLadder(USER, 'room-1', dto());
    expect(query.getLadder.mock.calls[0][1].scope).toBe('r:room-1');
  });

  it('prefers city over country when both are supplied', async () => {
    await controller.country(USER, dto({ country: 'IN', city: 'city-9' }));
    expect(query.getLadder.mock.calls[0][1].scope).toBe('y:city-9');
  });

  describe('me', () => {
    it('calls getSelfRank with the viewer, dimension, period and global scope', async () => {
      await controller.me(
        USER,
        dto({ dimension: VideoRoomRankingDimension.VIP, period: RankingPeriodDto.WEEKLY }),
      );
      expect(query.getSelfRank).toHaveBeenCalledWith(
        { id: 'u1', isGuest: false },
        VideoRoomRankingDimension.VIP,
        RankingPeriodDto.WEEKLY,
        'g',
      );
    });

    it('prefers city over country in scope, same as the country route', async () => {
      await controller.me(USER, dto({ country: 'IN', city: 'city-9' }));
      expect(query.getSelfRank).toHaveBeenCalledWith(
        { id: 'u1', isGuest: false },
        VideoRoomRankingDimension.HOSTS,
        RankingPeriodDto.DAILY,
        'y:city-9',
      );
    });

    it('falls back to a country scope when only country is supplied', async () => {
      await controller.me(USER, dto({ country: 'in' }));
      expect(query.getSelfRank.mock.calls[0][3]).toBe('c:IN');
    });
  });

  describe('history', () => {
    const TARGET_ID = 'a1a2a3a4-b1b2-4c1c-8d1d-e1e2e3e4e5e6';

    it('calls getHistory with the explicit targetId, dimension, period and limit when provided', async () => {
      await controller.history(
        USER,
        dto({
          dimension: VideoRoomRankingDimension.PK,
          period: RankingPeriodDto.WEEKLY,
          limit: 15,
        }),
        TARGET_ID,
      );
      expect(query.getHistory).toHaveBeenCalledWith(
        { id: 'u1', isGuest: false },
        TARGET_ID,
        VideoRoomRankingDimension.PK,
        RankingPeriodDto.WEEKLY,
        15,
      );
    });

    it('falls back to the caller id when targetId is omitted', async () => {
      await controller.history(USER, dto(), undefined);
      expect(query.getHistory).toHaveBeenCalledWith(
        { id: 'u1', isGuest: false },
        'u1',
        VideoRoomRankingDimension.HOSTS,
        RankingPeriodDto.DAILY,
        20,
      );
    });
  });
});
