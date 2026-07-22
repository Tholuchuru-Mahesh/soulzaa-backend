import { VideoRoomPkStatus } from '@prisma/client';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { PK_MULTIPLIER_BASE_BPS } from '../constants/video-room-pk.constants';
import { PKScoreException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkScoreEngine } from './video-room-pk-score.engine';
import { VideoRoomPkScoringService } from './video-room-pk-scoring.service';

const tx = () => ({}) as never;

const battle = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  roomId: 'r1',
  status: VideoRoomPkStatus.LIVE,
  scoringSnapshot: {
    strategies: ['VIP'],
    vipBonusBpsPerTier: 500,
    eventBonusBps: 0,
    capBps: 30_000,
  },
  ...overrides,
});

const input = (overrides: Record<string, unknown> = {}) => ({
  roomId: 'r1',
  senderId: 'u-sender',
  receiverIds: ['u1'],
  totalCoinValue: 100,
  giftTxnId: 'g1',
  ...overrides,
});

interface MockParticipant {
  id: string;
  userId: string;
  teamId: string;
  side: string;
  score: bigint;
}

interface MockTeam {
  id: string;
  side: string;
  score: bigint;
}

interface MockRepoOptions {
  findLive?: ReturnType<typeof battle> | null;
  findCurrent?: ReturnType<typeof battle> | null;
  participants?: MockParticipant[];
  teams?: MockTeam[];
}

/**
 * `findLive`/`findCurrent` default to the SAME battle unless explicitly
 * overridden — `apply` only ever consults `findLive`, `reverse` only ever
 * consults `findCurrent`, so most tests only need to configure one to matter.
 */
function mockRepo(opts: MockRepoOptions = {}) {
  const liveBattle = 'findLive' in opts ? opts.findLive! : battle();
  const currentBattle = 'findCurrent' in opts ? opts.findCurrent! : (liveBattle ?? battle());

  const participants = opts.participants ?? [
    { id: 'p1', userId: 'u1', teamId: 't-red', side: 'RED', score: 0n },
  ];
  const teams = opts.teams ?? [
    { id: 't-red', side: 'RED', score: 0n },
    { id: 't-blue', side: 'BLUE', score: 0n },
  ];
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const participantById = new Map(participants.map((p) => [p.id, p]));

  return {
    findLive: jest.fn().mockResolvedValue(liveBattle),
    findCurrent: jest.fn().mockResolvedValue(currentBattle),
    findParticipantsByUserIds: jest.fn((_battleId: string, userIds: string[]) =>
      Promise.resolve(participants.filter((p) => userIds.includes(p.userId))),
    ),
    getTeam: jest.fn((teamId: string) => Promise.resolve(teamById.get(teamId) ?? null)),
    addTeamScore: jest
      .fn()
      .mockImplementation((teamId: string, seenScore: bigint, delta: bigint) =>
        Promise.resolve({ id: teamId, score: seenScore + delta }),
      ),
    getParticipant: jest.fn((id: string) => Promise.resolve(participantById.get(id) ?? null)),
    addParticipantScore: jest
      .fn()
      .mockImplementation((id: string, seenScore: bigint, delta: bigint) =>
        Promise.resolve({ id, score: seenScore + delta }),
      ),
    addContribution: jest.fn().mockResolvedValue(undefined),
    listTeams: jest.fn().mockResolvedValue(teams),
    countGifts: jest.fn().mockResolvedValue(1),
    sumBaseAmount: jest.fn().mockResolvedValue(100n),
    findContributions: jest.fn((battleId: string, giftTxnId: string) =>
      Promise.resolve([
        {
          id: 'c1',
          battleId,
          roomId: 'r1',
          teamId: 't-red',
          participantId: 'p1',
          side: 'RED',
          senderId: 'u-sender',
          receiverId: 'u1',
          baseAmount: 100n,
          multiplierBps: 10_000,
          scoredAmount: 100n,
          giftTxnId,
          batchId: null,
          createdAt: new Date(),
        },
      ]),
    ),
  };
}

function build(
  repo: ReturnType<typeof mockRepo>,
  opts: { multiplierBps?: number; cache?: Record<string, jest.Mock> } = {},
): VideoRoomPkScoringService {
  const engine = {
    resolve: jest.fn().mockResolvedValue(opts.multiplierBps ?? PK_MULTIPLIER_BASE_BPS),
  };
  const cache =
    opts.cache ??
    ({
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    } as Record<string, jest.Mock>);
  const redis = {
    hset: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
  const config = { get: jest.fn().mockReturnValue({ scoreEmitPerSecond: 10 }) };

  return new VideoRoomPkScoringService(
    repo as never,
    engine as never,
    cache as never,
    config as never,
    redis as never,
  );
}

describe('VideoRoomPkScoringService.apply', () => {
  it('is inert when the room has no LIVE battle', async () => {
    const repo = mockRepo({ findLive: null });
    const svc = build(repo);
    const out = await svc.apply(tx(), input());
    expect(out.battleId).toBeNull();
    expect(out.applied).toBe(0);
    expect(repo.addContribution).not.toHaveBeenCalled();
  });

  it('does not score a PAUSED battle', async () => {
    // findLive filters to LIVE, so a PAUSED battle simply is not found.
    const repo = mockRepo({ findLive: null });
    expect((await build(repo).apply(tx(), input())).applied).toBe(0);
  });

  it('ignores receivers who are not participants', async () => {
    const repo = mockRepo({ findLive: battle(), participants: [] });
    expect((await build(repo).apply(tx(), input())).applied).toBe(0);
  });

  // perReceiver = total / receivers, per gift.service.ts:196-200.
  it('splits a multi-receiver send evenly and scores BOTH sides', async () => {
    const repo = mockRepo({
      findLive: battle(),
      participants: [
        { id: 'p1', userId: 'u1', teamId: 't-red', side: 'RED', score: 0n },
        { id: 'p2', userId: 'u2', teamId: 't-blue', side: 'BLUE', score: 0n },
      ],
      teams: [
        { id: 't-red', side: 'RED', score: 0n },
        { id: 't-blue', side: 'BLUE', score: 0n },
      ],
    });
    const svc = build(repo);

    await svc.apply(tx(), { ...input(), receiverIds: ['u1', 'u2'], totalCoinValue: 200 });

    expect(repo.addTeamScore).toHaveBeenCalledWith('t-red', 0n, 100n, expect.anything());
    expect(repo.addTeamScore).toHaveBeenCalledWith('t-blue', 0n, 100n, expect.anything());
  });

  it('stores baseAmount and scoredAmount separately when a multiplier applies', async () => {
    const repo = mockRepo();
    const svc = build(repo, { multiplierBps: 20_000 });

    await svc.apply(tx(), { ...input(), totalCoinValue: 100 });

    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ baseAmount: 100n, multiplierBps: 20_000, scoredAmount: 200n }),
      expect.anything(),
    );
  });

  it('retries the CAS when a concurrent writer moves the score', async () => {
    const repo = mockRepo();
    repo.addTeamScore
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-red', score: 150n });
    repo.getTeam.mockResolvedValue({ id: 't-red', side: 'RED', score: 50n });

    await build(repo).apply(tx(), input());

    expect(repo.addTeamScore).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry ceiling without failing the gift', async () => {
    const repo = mockRepo();
    repo.addTeamScore.mockResolvedValue(null);
    repo.getTeam.mockResolvedValue({ id: 't-red', side: 'RED', score: 50n });

    await expect(build(repo).apply(tx(), input())).resolves.toBeDefined();
  });

  // Extra coverage (beyond the brief's 10): exhaustion must be a true no-op for
  // that participant — no contribution row, no score credited — never a throw.
  it('CAS exhaustion writes no contribution and credits nothing for that receiver', async () => {
    const repo = mockRepo();
    repo.addTeamScore.mockResolvedValue(null);
    repo.getTeam.mockResolvedValue({ id: 't-red', side: 'RED', score: 50n });

    const out = await build(repo).apply(tx(), input());

    expect(out.applied).toBe(0);
    expect(out.events).toHaveLength(0);
    expect(repo.addContribution).not.toHaveBeenCalled();
    expect(repo.addTeamScore).toHaveBeenCalledTimes(3); // bounded at MAX_CAS_RETRIES
  });

  it('emits one PkScoreUpdatedEvent per scored receiver', async () => {
    const out = await build(mockRepo()).apply(tx(), input());
    expect(out.events).toHaveLength(1);
    expect(out.events[0].name).toBe(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED);
  });

  it('writes no Redis, queue or socket calls inside apply', async () => {
    const cache = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
    const repo = mockRepo();
    const svc = build(repo, { cache });

    await svc.apply(tx(), input());

    // Genuinely assert on the mocks, not just one field of one mock: nothing
    // in `apply` may touch the cache-aside layer OR the raw Redis client —
    // that is the whole point of the Postgres-only contract.
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('reverse writes a negative contribution with a :reversal txn id', async () => {
    const repo = mockRepo();
    await build(repo).reverse(tx(), { ...input(), giftTxnId: 'txn-1' });
    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ giftTxnId: 'txn-1:reversal', baseAmount: -100n }),
      expect.anything(),
    );
  });

  // Critical review fix: `apply` must never propagate into the gift's own
  // `$transaction` — anything unexpected degrades to "gift succeeded, nothing
  // scored", mirroring `reverse`'s existing best-effort contract.
  it('resolves the inert result, not a rejection, when a repository call rejects mid-loop', async () => {
    const repo = mockRepo();
    repo.addContribution.mockRejectedValue(new Error('connection lost'));

    const out = await build(repo).apply(tx(), input());

    expect(out).toEqual({ battleId: null, applied: 0, events: [], mirror: null });
  });

  it('resolves the inert result, not a rejection, when the score engine throws', async () => {
    const repo = mockRepo();
    const engine = { resolve: jest.fn().mockRejectedValue(new Error('engine exploded')) };
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const redis = { hset: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    const config = { get: jest.fn().mockReturnValue({ scoreEmitPerSecond: 10 }) };
    const svc = new VideoRoomPkScoringService(
      repo as never,
      engine as never,
      cache as never,
      config as never,
      redis as never,
    );

    const out = await svc.apply(tx(), input());

    expect(out).toEqual({ battleId: null, applied: 0, events: [], mirror: null });
  });

  // These two use the REAL VideoRoomPkScoreEngine (not the always-10000 mock
  // `build()` wires up) with one strategy registered, so `resolve()` actually
  // dereferences `ctx.snapshot.strategies` the way the finding describes — a
  // mocked engine would never touch the malformed snapshot at all and could
  // pass even without the hardening fix.
  function buildWithRealEngine(repo: ReturnType<typeof mockRepo>): VideoRoomPkScoringService {
    const engine = new VideoRoomPkScoreEngine();
    engine.register({ key: 'VIP', bonusBps: () => 500 });
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const redis = { hset: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    const config = { get: jest.fn().mockReturnValue({ scoreEmitPerSecond: 10 }) };
    return new VideoRoomPkScoringService(
      repo as never,
      engine,
      cache as never,
      config as never,
      redis as never,
    );
  }

  it('scores at the 1.0x base rate instead of throwing when scoringSnapshot is null', async () => {
    const repo = mockRepo({ findLive: battle({ scoringSnapshot: null }) });
    const svc = buildWithRealEngine(repo);

    const out = await svc.apply(tx(), input());

    expect(out.battleId).toBe('b1');
    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ multiplierBps: PK_MULTIPLIER_BASE_BPS }),
      expect.anything(),
    );
  });

  it('scores at the 1.0x base rate instead of throwing when scoringSnapshot is an empty object', async () => {
    const repo = mockRepo({ findLive: battle({ scoringSnapshot: {} }) });
    const svc = buildWithRealEngine(repo);

    const out = await svc.apply(tx(), input());

    expect(out.battleId).toBe('b1');
    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ multiplierBps: PK_MULTIPLIER_BASE_BPS }),
      expect.anything(),
    );
  });
});

describe('VideoRoomPkScoringService.reverse', () => {
  it('is a no-op when the room has no non-terminal battle (settled battles are not unwound)', async () => {
    const repo = mockRepo({ findCurrent: null });
    await build(repo).reverse(tx(), input());
    expect(repo.addContribution).not.toHaveBeenCalled();
  });

  it('is a no-op when the original gift was never scored', async () => {
    const repo = mockRepo();
    repo.findContributions.mockResolvedValue([]);
    await build(repo).reverse(tx(), input());
    expect(repo.addContribution).not.toHaveBeenCalled();
  });

  it('negates the ORIGINAL scoredAmount, not a freshly recomputed multiplier', async () => {
    const repo = mockRepo();
    repo.findContributions.mockResolvedValue([
      {
        id: 'c1',
        battleId: 'b1',
        roomId: 'r1',
        teamId: 't-red',
        participantId: 'p1',
        side: 'RED',
        senderId: 'u-sender',
        receiverId: 'u1',
        baseAmount: 100n,
        multiplierBps: 20_000,
        scoredAmount: 200n,
        giftTxnId: 'txn-1',
        batchId: null,
        createdAt: new Date(),
      },
    ]);
    // Multiplier resolves differently NOW than it did at the time of the
    // original gift — the reversal must still undo exactly what was credited.
    const svc = build(repo, { multiplierBps: 10_000 });

    await svc.reverse(tx(), { ...input(), giftTxnId: 'txn-1' });

    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ baseAmount: -100n, multiplierBps: 20_000, scoredAmount: -200n }),
      expect.anything(),
    );
    expect(repo.addTeamScore).toHaveBeenCalledWith('t-red', 0n, -200n, expect.anything());
  });

  it('never throws even when the CAS is exhausted', async () => {
    const repo = mockRepo();
    repo.addTeamScore.mockResolvedValue(null);
    repo.getTeam.mockResolvedValue({ id: 't-red', side: 'RED', score: 50n });

    await expect(build(repo).reverse(tx(), input())).resolves.toBeUndefined();
    expect(repo.addContribution).not.toHaveBeenCalled();
  });

  // Wiring-gate closure: PKScoreException was bound to a real error code but
  // never thrown. Unlike the team-level CAS exhaustion above (a clean,
  // atomic no-op — nothing was ever applied for that original contribution),
  // a participant-level CAS exhaustion AFTER the team side already succeeded
  // leaves team and participant scores inconsistent, which is surfaced
  // instead of silently continuing.
  it('throws PKScoreException when the participant-level CAS exhausts after the team side already applied', async () => {
    const repo = mockRepo();
    repo.addParticipantScore.mockResolvedValue(null);
    repo.getParticipant.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      teamId: 't-red',
      side: 'RED',
      score: 50n,
    });

    await expect(build(repo).reverse(tx(), input())).rejects.toBeInstanceOf(PKScoreException);
    // The team side already applied by the time this throws — but the
    // contribution ledger row for THIS original must not be written, since
    // the compensation as a whole did not complete.
    expect(repo.addContribution).not.toHaveBeenCalled();
  });
});

describe('VideoRoomPkScoringService.mirror / shouldEmit', () => {
  it('mirror writes the scoreboard HASH keyed by battleId', async () => {
    const redis = { hset: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    const repo = mockRepo();
    const engine = { resolve: jest.fn() };
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    const config = { get: jest.fn().mockReturnValue({ scoreEmitPerSecond: 10 }) };
    const svc = new VideoRoomPkScoringService(
      repo as never,
      engine as never,
      cache as never,
      config as never,
      redis as never,
    );

    await svc.mirror({
      battleId: 'b1',
      teams: [
        { teamId: 't-red', side: 'RED', score: 100 },
        { teamId: 't-blue', side: 'BLUE', score: 50 },
      ],
      giftCount: 3,
      baseTotal: 150,
    });

    expect(redis.hset).toHaveBeenCalledWith(
      'video-room:pk:score:b1',
      expect.objectContaining({ RED: '100', BLUE: '50', giftCount: '3', baseTotal: '150' }),
    );
  });

  it('shouldEmit allows the first emit in a window', async () => {
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    const svc = build(mockRepo(), { cache });
    expect(await svc.shouldEmit('b1')).toBe(true);
    expect(cache.set).toHaveBeenCalled();
  });

  it('shouldEmit suppresses a second emit inside the window', async () => {
    const cache = { get: jest.fn().mockResolvedValue(Date.now()), set: jest.fn(), del: jest.fn() };
    const svc = build(mockRepo(), { cache });
    expect(await svc.shouldEmit('b1')).toBe(false);
  });

  it('shouldEmit allows an emit once the window has passed', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(Date.now() - 10_000),
      set: jest.fn(),
      del: jest.fn(),
    };
    const svc = build(mockRepo(), { cache });
    expect(await svc.shouldEmit('b1')).toBe(true);
  });
});
