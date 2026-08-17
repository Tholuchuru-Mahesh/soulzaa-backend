import { AgencyMemberScoreService } from './agency-member-score.service';

/**
 * The rules these cover: a ranking must cost a fixed number of queries no
 * matter how large the agency, and it must be stable between two page loads.
 */
describe('AgencyMemberScoreService', () => {
  const AGENCY = 'agency-1';

  function build(
    rows: {
      logins?: { userId: string; createdAt: Date }[];
      audio?: { userId: string }[];
      video?: { userId: string }[];
      sent?: { senderId: string; _count: number }[];
      received?: { receiverId: string; _count: number }[];
      members?: string[];
    } = {},
  ) {
    const prisma: any = {
      sessionHistory: { findMany: jest.fn().mockResolvedValue(rows.logins ?? []) },
      roomMember: { findMany: jest.fn().mockResolvedValue(rows.audio ?? []) },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue(rows.video ?? []) },
      giftTransaction: {
        groupBy: jest
          .fn()
          .mockImplementation(({ by }: { by: string[] }) =>
            Promise.resolve(by[0] === 'senderId' ? (rows.sent ?? []) : (rows.received ?? [])),
          ),
      },
    };
    const store = new Map<string, string>();
    const redis: any = {
      client: {
        get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
        set: jest.fn((key: string, value: string) => {
          store.set(key, value);
          return Promise.resolve('OK');
        }),
      },
    };
    const community: any = {
      getActiveHostIds: jest.fn().mockResolvedValue(rows.members ?? []),
    };
    const service = new AgencyMemberScoreService(prisma, redis, community);
    return { service, prisma, redis, community, store };
  }

  function day(n: number): Date {
    return new Date(Date.UTC(2026, 7, n));
  }

  it('returns an empty ranking for an agency with no members, without querying', async () => {
    const { service, prisma } = build({ members: [] });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.size).toBe(0);
    expect(prisma.giftTransaction.groupBy).not.toHaveBeenCalled();
  });

  it('costs a fixed number of queries regardless of member count', async () => {
    // 200 members must not mean 800 queries.
    const members = Array.from({ length: 200 }, (_, i) => `m${i}`);
    const { service, prisma } = build({ members });

    await service.rankAgency(AGENCY);

    expect(prisma.sessionHistory.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.roomMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.giftTransaction.groupBy).toHaveBeenCalledTimes(2);
  });

  it('counts distinct login days, not login events', async () => {
    // Three logins on one day is one active day, not three.
    const { service } = build({
      members: ['a'],
      logins: [
        { userId: 'a', createdAt: day(1) },
        { userId: 'a', createdAt: new Date(day(1).getTime() + 3600_000) },
        { userId: 'a', createdAt: day(2) },
      ],
    });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a')!.inputs.loginDays).toBe(2);
  });

  it('adds audio and video joins into one rooms figure', async () => {
    const { service } = build({
      members: ['a'],
      audio: [{ userId: 'a' }, { userId: 'a' }],
      video: [{ userId: 'a' }],
    });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a')!.inputs.roomsJoined).toBe(3);
  });

  it('ranks the higher score first', async () => {
    const { service } = build({
      members: ['low', 'high'],
      sent: [
        { senderId: 'high', _count: 50 },
        { senderId: 'low', _count: 1 },
      ],
    });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('high')!.rank).toBe(1);
    expect(ranked.get('low')!.rank).toBe(2);
    expect(ranked.get('high')!.totalMembers).toBe(2);
  });

  it('breaks ties by user id, so two equal members never swap between loads', async () => {
    const { service } = build({ members: ['b-user', 'a-user'] });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a-user')!.rank).toBe(1);
    expect(ranked.get('b-user')!.rank).toBe(2);
  });

  it('withholds a percentile from an agency too small to have one', async () => {
    const { service } = build({ members: ['a', 'b'] });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a')!.topPercent).toBeNull();
  });

  it('serves a second call from cache instead of recomputing', async () => {
    const members = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const { service, prisma } = build({ members });

    await service.rankAgency(AGENCY);
    const second = await service.rankAgency(AGENCY);

    expect(prisma.giftTransaction.groupBy).toHaveBeenCalledTimes(2); // from the first call only
    expect(second.get('m0')!.rank).toBeGreaterThan(0);
  });

  it('caches under a key scoped to the agency, so agencies cannot read each other', async () => {
    const { service, redis } = build({ members: ['a'] });

    await service.rankAgency(AGENCY);

    // Keyed by agency, window and day: the agency segment is what stops one
    // agency reading another's, and the window segment is what stops the daily
    // leaderboard serving the monthly board's positions.
    expect(redis.client.set).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^agency:member-rank:${AGENCY}:monthly:\\d{4}-\\d{2}-\\d{2}$`),
      ),
      expect.any(String),
      'EX',
      300,
    );
  });

  it('keys each window separately, so daily and monthly cannot collide', async () => {
    const { service, redis } = build({ members: ['a'] });

    await service.rankAgencyOver(AGENCY, 1, 'daily');
    await service.rankAgencyOver(AGENCY, 30, 'monthly');

    const keys: string[] = redis.client.set.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(keys.some((k: string) => k.includes(':daily:'))).toBe(true);
    expect(keys.some((k: string) => k.includes(':monthly:'))).toBe(true);
  });
});
