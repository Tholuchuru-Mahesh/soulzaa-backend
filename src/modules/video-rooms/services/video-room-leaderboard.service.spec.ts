import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import {
  VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
  VideoRoomRankingDimension,
} from '../constants/video-room-ranking.constants';
import { VideoRoomLeaderboardService } from './video-room-leaderboard.service';

const VIEWER = { id: 'me', isGuest: false };

describe('VideoRoomLeaderboardService', () => {
  let store: any;
  let social: { friendIds: jest.Mock; followerIds: jest.Mock };
  let repo: { hydrateTargets: jest.Mock };
  let service: VideoRoomLeaderboardService;

  beforeEach(() => {
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      scoreMany: jest.fn().mockResolvedValue([300, null, 900]),
    };
    social = {
      friendIds: jest.fn().mockResolvedValue(['f1', 'f2', 'f3']),
      followerIds: jest.fn().mockResolvedValue(['x1']),
    };
    repo = {
      hydrateTargets: jest.fn().mockResolvedValue([
        { id: 'f1', username: 'a', avatarKey: null, level: 1, vipLevel: 0 },
        { id: 'f3', username: 'c', avatarKey: null, level: 1, vipLevel: 0 },
      ]),
    };
    service = new VideoRoomLeaderboardService(
      store,
      new RankingPeriodResolver(),
      social as never,
      repo as never,
    );
  });

  const query = () => ({
    dimension: VideoRoomRankingDimension.GIFTERS,
    period: 'daily' as const,
    limit: 20,
    page: 1,
  });

  it('projects the friend set onto the ladder with ZMSCORE, not a separate ZSET', async () => {
    await service.projectAudience(VIEWER, query(), 'friends');
    expect(store.scoreMany).toHaveBeenCalledWith(expect.any(String), ['f1', 'f2', 'f3']);
  });

  it('drops friends with no score rather than ranking them at zero', async () => {
    const page = await service.projectAudience(VIEWER, query(), 'friends');
    expect(page.items.map((i) => i.targetId)).toEqual(['f3', 'f1']);
  });

  it('sorts descending and assigns 1-based ranks within the projection', async () => {
    const page = await service.projectAudience(VIEWER, query(), 'friends');
    expect(page.items[0]).toEqual(expect.objectContaining({ rank: 1, targetId: 'f3', score: 900 }));
    expect(page.items[1]).toEqual(expect.objectContaining({ rank: 2, targetId: 'f1', score: 300 }));
  });

  it('uses the follower set for a following projection', async () => {
    store.scoreMany.mockResolvedValue([50]);
    repo.hydrateTargets.mockResolvedValue([
      { id: 'x1', username: 'x', avatarKey: null, level: 1, vipLevel: 0 },
    ]);
    await service.projectAudience(VIEWER, query(), 'following');
    expect(social.followerIds).toHaveBeenCalledWith('me');
  });

  it('returns an empty page when the audience set is empty', async () => {
    social.friendIds.mockResolvedValue([]);
    const page = await service.projectAudience(VIEWER, query(), 'friends');
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(store.scoreMany).not.toHaveBeenCalled();
  });

  it('refuses a guest — a projection needs a social graph', async () => {
    await expect(
      service.projectAudience({ id: 'g', isGuest: true }, query(), 'friends'),
    ).rejects.toThrow();
  });

  describe('Finding 4: the projection has a page-size ceiling', () => {
    it('clamps an oversized limit to VIDEO_ROOM_RANKING_MAX_PAGE_SIZE', async () => {
      store.scoreMany.mockResolvedValue([300, null, 900]);
      const page = await service.projectAudience(VIEWER, { ...query(), limit: 10_000 }, 'friends');
      expect(page.limit).toBe(VIDEO_ROOM_RANKING_MAX_PAGE_SIZE);
      expect(page.items.length).toBeLessThanOrEqual(VIDEO_ROOM_RANKING_MAX_PAGE_SIZE);
    });

    it('never slices more than the max page size out of the ranked list', async () => {
      const manyFriends = Array.from({ length: 250 }, (_, i) => `f${i}`);
      social.friendIds.mockResolvedValue(manyFriends);
      store.scoreMany.mockResolvedValue(manyFriends.map((_, i) => 250 - i));
      repo.hydrateTargets.mockResolvedValue(
        manyFriends.map((id) => ({ id, username: id, avatarKey: null, level: 1, vipLevel: 0 })),
      );
      const page = await service.projectAudience(
        VIEWER,
        { ...query(), limit: 10_000, page: 1 },
        'friends',
      );
      expect(page.items.length).toBe(VIDEO_ROOM_RANKING_MAX_PAGE_SIZE);
    });
  });
});
