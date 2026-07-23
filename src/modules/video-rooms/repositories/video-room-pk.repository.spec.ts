import { VideoRoomPkStatus } from '@prisma/client';
import { VideoRoomPkRepository } from './video-room-pk.repository';

const prisma = () =>
  ({
    videoRoomPkBattle: { findFirst: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    videoRoomPkTeam: { updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    videoRoomPkParticipant: { updateMany: jest.fn(), findUnique: jest.fn() },
    videoRoomPkContribution: {
      create: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
    vipMembership: { findUnique: jest.fn() },
  }) as never;

describe('VideoRoomPkRepository', () => {
  it('findLive filters to LIVE only', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (
      db as never as { videoRoomPkBattle: { findFirst: jest.Mock } }
    ).videoRoomPkBattle.findFirst.mockResolvedValue(null);

    await repo.findLive('room-1');

    expect(
      (db as never as { videoRoomPkBattle: { findFirst: jest.Mock } }).videoRoomPkBattle.findFirst,
    ).toHaveBeenCalledWith({ where: { roomId: 'room-1', status: VideoRoomPkStatus.LIVE } });
  });

  // The transition MUST be conditional on the expected status, or two concurrent
  // commands both "succeed" and the FSM is decorative.
  it('transition guards on the expected from-status and returns null when it loses', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    const battles = (db as never as { videoRoomPkBattle: { updateMany: jest.Mock } })
      .videoRoomPkBattle;
    battles.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.transition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED);

    expect(battles.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: VideoRoomPkStatus.LIVE },
      data: expect.objectContaining({ status: VideoRoomPkStatus.PAUSED }),
    });
    expect(result).toBeNull();
  });

  // The CAS guard: the UPDATE must include the score the caller READ, so a
  // concurrent writer invalidates it rather than silently overwriting.
  it('addTeamScore compare-and-sets on the score the caller saw', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    const teams = (db as never as { videoRoomPkTeam: { updateMany: jest.Mock } }).videoRoomPkTeam;
    teams.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.addTeamScore('t1', 100n, 50n);

    expect(teams.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', score: 100n },
      data: { score: 150n, giftCount: { increment: 1 } },
    });
    expect(result).toBeNull();
  });

  // Mirrors the addTeamScore CAS test above: addParticipantScore is a hand-duplicated
  // twin against videoRoomPkParticipant, so it needs its own pin or a swap to
  // `{ increment: delta }` (or a dropped `score: seenScore` guard) would go unnoticed.
  it('addParticipantScore compare-and-sets on the score the caller saw', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    const participants = (db as never as { videoRoomPkParticipant: { updateMany: jest.Mock } })
      .videoRoomPkParticipant;
    participants.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.addParticipantScore('p1', 100n, 50n);

    expect(participants.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', score: 100n },
      data: { score: 150n, giftCount: { increment: 1 } },
    });
    expect(result).toBeNull();
  });

  it('sumBaseAmount returns 0n when the ledger is empty', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (
      db as never as { videoRoomPkContribution: { aggregate: jest.Mock } }
    ).videoRoomPkContribution.aggregate.mockResolvedValue({ _sum: { baseAmount: null } });

    expect(await repo.sumBaseAmount('b1')).toBe(0n);
  });

  // VR-12 Task 11 review fix: the VIP score strategy reads through this
  // repository (rather than a raw Prisma call in the service) precisely so it
  // can forward the gift's transaction client — pin both the query shape and
  // that a supplied `db` is actually used instead of the default `this.prisma`.
  it('getVipStatus queries vipMembership.findUnique by userId, using the passed db client', async () => {
    const defaultDb = prisma();
    const txDb = prisma();
    (
      txDb as never as { vipMembership: { findUnique: jest.Mock } }
    ).vipMembership.findUnique.mockResolvedValue({ userId: 'u1', level: 3, totalSpent: 200000n });
    const repo = new VideoRoomPkRepository(defaultDb);

    const result = await repo.getVipStatus('u1', txDb);

    expect(
      (txDb as never as { vipMembership: { findUnique: jest.Mock } }).vipMembership.findUnique,
    ).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(
      (defaultDb as never as { vipMembership: { findUnique: jest.Mock } }).vipMembership.findUnique,
    ).not.toHaveBeenCalled();
    expect(result).toEqual({ level: 'VIP_3', lifetimeRecharge: 200000n });
  });

  // The reversal path (Task 13) negates the ORIGINAL contribution row rather
  // than recomputing a multiplier that may have drifted since the gift — so
  // the lookup must be keyed on the exact same (battleId, giftTxnId) pair the
  // unique constraint uses, not just giftTxnId alone.
  it('findContributions queries by battleId and giftTxnId together', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (
      db as never as { videoRoomPkContribution: { findMany: jest.Mock } }
    ).videoRoomPkContribution.findMany.mockResolvedValue([]);

    await repo.findContributions('b1', 'txn-1');

    expect(
      (db as never as { videoRoomPkContribution: { findMany: jest.Mock } }).videoRoomPkContribution
        .findMany,
    ).toHaveBeenCalledWith({ where: { battleId: 'b1', giftTxnId: 'txn-1' } });
  });

  it('findStale filters by status set and deadline', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (db as never as { videoRoomPkBattle: { findMany?: jest.Mock } }).videoRoomPkBattle.findMany =
      jest.fn().mockResolvedValue([]);
    const now = new Date('2026-07-22T00:00:00Z');

    await repo.findStale(now, [VideoRoomPkStatus.LIVE], 50);

    expect(
      (db as never as { videoRoomPkBattle: { findMany: jest.Mock } }).videoRoomPkBattle.findMany,
    ).toHaveBeenCalledWith({
      where: { status: { in: [VideoRoomPkStatus.LIVE] }, endsAt: { lte: now } },
      take: 50,
      orderBy: { endsAt: 'asc' },
    });
  });

  // Task 20's recovery sweep needs COUNTDOWN/RECOVERING/LIVE fetched fleet-wide
  // (no roomId, no endsAt filter) because their deadlines are computed, not
  // columns — pin the where/orderBy shape so a status leak or a wrong sort
  // (which would break "cap the work, oldest first") is caught here.
  it('findByStatus filters by a single status, oldest first', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (db as never as { videoRoomPkBattle: { findMany?: jest.Mock } }).videoRoomPkBattle.findMany =
      jest.fn().mockResolvedValue([]);

    await repo.findByStatus(VideoRoomPkStatus.RECOVERING, 25);

    expect(
      (db as never as { videoRoomPkBattle: { findMany: jest.Mock } }).videoRoomPkBattle.findMany,
    ).toHaveBeenCalledWith({
      where: { status: VideoRoomPkStatus.RECOVERING },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });
  });

  // Task 17 needs a transaction boundary that stays a repository concern, not
  // `prisma.$transaction` inlined in the service. This is the whole contract:
  // the tx client `$transaction` hands back must be exactly what the caller's
  // function receives, and the result must pass straight through.
  it('runInTransaction forwards the transaction client from prisma.$transaction', async () => {
    const db = prisma();
    const tx = { marker: 'tx' } as never;
    (db as never as { $transaction: jest.Mock }).$transaction = jest
      .fn()
      .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx));
    const repo = new VideoRoomPkRepository(db);
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await repo.runInTransaction(fn);

    expect(fn).toHaveBeenCalledWith(tx);
    expect(result).toBe('ok');
  });

  // Task 21's history endpoint must never surface an in-progress battle. The
  // filter belongs in the WHERE clause (not applied by the caller after the
  // fetch), because post-fetch filtering would desync `total` from the page
  // actually returned — pin the exact status set here so that can't regress.
  it('listBattles filters to terminal statuses only, newest first', async () => {
    const db = prisma();
    const battles = (
      db as never as { videoRoomPkBattle: { findMany: jest.Mock; count: jest.Mock } }
    ).videoRoomPkBattle;
    battles.findMany = jest.fn().mockResolvedValue([]);
    battles.count = jest.fn().mockResolvedValue(0);
    (db as never as { $transaction: jest.Mock }).$transaction = jest
      .fn()
      .mockImplementation((queries: Promise<unknown>[]) => Promise.all(queries));
    const repo = new VideoRoomPkRepository(db);

    await repo.listBattles('room-1', 0, 20);

    const where = {
      roomId: 'room-1',
      status: {
        in: [VideoRoomPkStatus.COMPLETED, VideoRoomPkStatus.CANCELLED, VideoRoomPkStatus.FAILED],
      },
    };
    expect(battles.findMany).toHaveBeenCalledWith({
      where,
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    expect(battles.count).toHaveBeenCalledWith({ where });
  });

  // Room-wide rollup for the statistics endpoint: three independent battle
  // counts plus the contribution ledger, all scoped by `roomId` alone (no
  // per-battle looping). Pin the query shape so a future edit cannot quietly
  // start counting non-terminal battles as "wins".
  it('statistics rolls up terminal battles and the contribution ledger for the whole room', async () => {
    const db = prisma();
    const battles = (db as never as { videoRoomPkBattle: { count: jest.Mock } }).videoRoomPkBattle;
    const contributions = (
      db as never as { videoRoomPkContribution: { count: jest.Mock; aggregate: jest.Mock } }
    ).videoRoomPkContribution;
    battles.count = jest
      .fn()
      .mockResolvedValueOnce(5) // totalBattles
      .mockResolvedValueOnce(3) // totalWins
      .mockResolvedValueOnce(1); // totalDraws
    contributions.count = jest.fn().mockResolvedValue(42);
    contributions.aggregate = jest.fn().mockResolvedValue({ _sum: { baseAmount: 9_000n } });
    (db as never as { $transaction: jest.Mock }).$transaction = jest
      .fn()
      .mockImplementation((queries: Promise<unknown>[]) => Promise.all(queries));
    const repo = new VideoRoomPkRepository(db);

    const result = await repo.statistics('room-1');

    expect(result).toEqual({
      totalBattles: 5,
      totalWins: 3,
      totalDraws: 1,
      totalContributed: 9_000n,
      totalGiftCount: 42,
    });
    expect(battles.count).toHaveBeenNthCalledWith(2, {
      where: { roomId: 'room-1', status: VideoRoomPkStatus.COMPLETED, isDraw: false },
    });
    expect(battles.count).toHaveBeenNthCalledWith(3, {
      where: { roomId: 'room-1', status: VideoRoomPkStatus.COMPLETED, isDraw: true },
    });
  });

  // Mirrors sumBaseAmount's null-coalescing guard: an empty ledger must
  // resolve to 0n, not NaN/null, since this feeds straight into a Number()
  // conversion at the query-service boundary.
  it('statistics coalesces a null contribution sum to 0n on an empty ledger', async () => {
    const db = prisma();
    const battles = (db as never as { videoRoomPkBattle: { count: jest.Mock } }).videoRoomPkBattle;
    const contributions = (
      db as never as { videoRoomPkContribution: { count: jest.Mock; aggregate: jest.Mock } }
    ).videoRoomPkContribution;
    battles.count = jest.fn().mockResolvedValue(0);
    contributions.count = jest.fn().mockResolvedValue(0);
    contributions.aggregate = jest.fn().mockResolvedValue({ _sum: { baseAmount: null } });
    (db as never as { $transaction: jest.Mock }).$transaction = jest
      .fn()
      .mockImplementation((queries: Promise<unknown>[]) => Promise.all(queries));
    const repo = new VideoRoomPkRepository(db);

    expect((await repo.statistics('room-1')).totalContributed).toBe(0n);
  });
});
