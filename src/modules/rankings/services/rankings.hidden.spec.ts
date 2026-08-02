import { RankingsService } from './rankings.service';

/**
 * Rankings bypass the card resolver — they hydrate straight from the users
 * table — so they need their own filter. A staff account must not appear on a
 * leaderboard, and removing one must not leave a hole in the rank numbering.
 */
describe('RankingsService — hidden accounts', () => {
  const entries = [
    { member: 'u-1', score: 300 },
    { member: 'admin-1', score: 200 },
    { member: 'u-2', score: 100 },
  ];

  const repo = {
    getRangeFromRedis: jest.fn().mockResolvedValue(entries),
    getCountFromRedis: jest.fn().mockResolvedValue(3),
    getSnapshots: jest.fn(),
    getUsersDetails: jest.fn().mockResolvedValue([
      { id: 'u-1', username: 'one', fullName: null, isHiddenAccount: false },
      { id: 'admin-1', username: 'ops', fullName: null, isHiddenAccount: true },
      { id: 'u-2', username: 'two', fullName: null, isHiddenAccount: false },
    ]),
    getUserProfilesAndStats: jest.fn().mockResolvedValue({ profiles: [], statistics: [] }),
  } as any;

  const periods = {
    resolve: jest.fn().mockReturnValue({ key: 'gifters:daily', isPast: false, dateKey: 'd' }),
  } as any;

  let service: RankingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = Object.create(RankingsService.prototype) as RankingsService;
    Object.assign(service, { repo, periods });
    (service as unknown as { resolveRankingKey: () => unknown }).resolveRankingKey = () => ({
      key: 'gifters:daily',
      isPast: false,
      dateKey: 'd',
    });
  });

  it('omits a hidden account from the gifters leaderboard', async () => {
    const page = await service.getGifters('DAILY' as never, 10, 1);
    expect(page.items.map((i) => i.userId)).toEqual(['u-1', 'u-2']);
  });

  it('renumbers ranks so removal leaves no gap', async () => {
    const page = await service.getGifters('DAILY' as never, 10, 1);
    expect(page.items.map((i) => i.rank)).toEqual([1, 2]);
  });

  it('omits a hidden account from the receivers leaderboard', async () => {
    const page = await service.getReceivers('DAILY' as never, 10, 1);
    expect(page.items.map((i) => i.userId)).not.toContain('admin-1');
  });

  it('omits a hidden account from the streamers leaderboard', async () => {
    const page = await service.getStreamers('DAILY' as never, 10, 1);
    expect(page.items.map((i) => i.userId)).not.toContain('admin-1');
  });
});
