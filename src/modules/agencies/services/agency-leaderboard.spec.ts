import { AgencyLeaderboardService } from './agency-leaderboard.service';

/**
 * The rule that matters most: the monthly board must agree with the member
 * profile's "Rank in Agency", because the profile links straight to it.
 */
describe('AgencyLeaderboardService', () => {
  const AGENCY = 'agency-1';

  function score(userId: string, rank: number, value: number) {
    return {
      userId,
      score: value,
      rank,
      totalMembers: 3,
      topPercent: null,
      grade: { min: 0, code: 'FAIR', label: 'Fair', caption: '' },
      inputs: { loginDays: 0, roomsJoined: 0, giftsSent: 0, giftsReceived: 0 },
    };
  }

  function build(
    current: Map<string, unknown> = new Map(),
    previous: Map<string, unknown> = new Map(),
  ) {
    const scores = {
      rankAgencyOver: jest
        .fn()
        .mockImplementation((_a: string, _d: number, kind: string) =>
          Promise.resolve(kind.endsWith('-prev') ? previous : current),
        ),
    };
    const profiles = {
      resolvePublicIdentities: jest
        .fn()
        .mockResolvedValue(
          new Map([['a', { displayName: 'balayya', avatarUrl: 'https://cdn/a.png' }]]),
        ),
    };
    const service = new AgencyLeaderboardService(scores as never, profiles as never);
    return { service, scores, profiles };
  }

  it('returns an empty board for an agency with nobody ranked', async () => {
    const { service } = build();

    const res = await service.getLeaderboard(AGENCY);

    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('defaults to monthly, so it agrees with the profile rank it is linked from', async () => {
    const { service, scores } = build(new Map([['a', score('a', 1, 72)]]));

    const res = await service.getLeaderboard(AGENCY);

    expect(res.range).toBe('monthly');
    // 30 days — the same window the member profile scores over.
    expect(scores.rankAgencyOver).toHaveBeenCalledWith(AGENCY, 30, 'monthly', expect.any(Date));
  });

  it.each([
    ['daily', 1],
    ['weekly', 7],
    ['monthly', 30],
  ] as const)('measures %s over %i day(s)', async (range, days) => {
    const { service, scores } = build(new Map([['a', score('a', 1, 10)]]));

    await service.getLeaderboard(AGENCY, { range });

    expect(scores.rankAgencyOver).toHaveBeenCalledWith(AGENCY, days, range, expect.any(Date));
  });

  it('orders by rank and carries the score as points', async () => {
    const { service } = build(
      new Map([
        ['b', score('b', 2, 40)],
        ['a', score('a', 1, 72)],
      ]),
    );

    const res = await service.getLeaderboard(AGENCY);

    expect(res.items.map((i) => i.userId)).toEqual(['a', 'b']);
    expect(res.items[0]).toMatchObject({ rank: 1, score: 72, displayName: 'balayya' });
  });

  it('reports places climbed since the previous window', async () => {
    const { service } = build(
      new Map([['a', score('a', 2, 50)]]),
      new Map([['a', score('a', 6, 20)]]),
    );

    const res = await service.getLeaderboard(AGENCY);

    // 6th last period, 2nd now — up four.
    expect(res.items[0].change).toBe(4);
  });

  it('reports a fall as a negative change', async () => {
    const { service } = build(
      new Map([['a', score('a', 5, 50)]]),
      new Map([['a', score('a', 1, 90)]]),
    );

    expect((await service.getLeaderboard(AGENCY)).items[0].change).toBe(-4);
  });

  it('reports null rather than +0 for a member who was not ranked before', async () => {
    // A new entrant has not moved — they have arrived.
    const { service } = build(new Map([['a', score('a', 3, 50)]]), new Map());

    expect((await service.getLeaderboard(AGENCY)).items[0].change).toBeNull();
  });

  it('compares against the window immediately before this one', async () => {
    const { service, scores } = build(new Map([['a', score('a', 1, 10)]]));

    await service.getLeaderboard(AGENCY, { range: 'weekly' });

    const [, , , currentEnd] = scores.rankAgencyOver.mock.calls[0];
    const [, , , previousEnd] = scores.rankAgencyOver.mock.calls[1];
    const gapDays = Math.round((currentEnd.getTime() - previousEnd.getTime()) / 86_400_000);
    expect(gapDays).toBe(7);
  });

  it('pages, and resolves identities only for the page', async () => {
    const many = new Map(
      Array.from({ length: 45 }, (_, i) => [`m${i}`, score(`m${i}`, i + 1, 100 - i)]),
    );
    const { service, profiles } = build(many);

    const res = await service.getLeaderboard(AGENCY, { page: 2, limit: 20 });

    expect(res).toMatchObject({ page: 2, total: 45, totalPages: 3 });
    expect(res.items).toHaveLength(20);
    expect(res.items[0].rank).toBe(21);
    expect(profiles.resolvePublicIdentities.mock.calls[0][0]).toHaveLength(20);
  });

  it('clamps an absurd page size', async () => {
    const many = new Map(
      Array.from({ length: 200 }, (_, i) => [`m${i}`, score(`m${i}`, i + 1, 1)]),
    );
    const { service } = build(many);

    expect((await service.getLeaderboard(AGENCY, { limit: 100_000 })).items).toHaveLength(100);
  });

  it('leaves an unresolved identity null rather than inventing a name', async () => {
    const { service, profiles } = build(new Map([['a', score('a', 1, 10)]]));
    profiles.resolvePublicIdentities.mockResolvedValue(new Map());

    const res = await service.getLeaderboard(AGENCY);

    expect(res.items[0].displayName).toBeNull();
    expect(res.items[0].avatarUrl).toBeNull();
  });
});
