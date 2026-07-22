import { CasinoGame } from '@prisma/client';
import { CasinoLoopService, CASINO_GAMES } from './casino-loop.service';

/** One emitted broadcast, captured for assertion. */
interface Emitted {
  room: string;
  event: string;
  payload: any;
}

let roundCounter = 0;

/** Fresh set of test doubles wired the same way for every test. */
function makeLoop(
  opts: { leader?: boolean; winners?: Array<{ userId: string; amount: number }> } = {},
) {
  const { leader = true, winners = [] } = opts;
  roundCounter = 0;

  const repo = {
    createRound: jest.fn(async (game: CasinoGame) => ({
      id: `round-${++roundCounter}`,
      game,
      status: 'BETTING',
      winningOutcome: null,
      createdAt: new Date(),
      settledAt: null,
    })),
    listPlacedBets: jest.fn().mockResolvedValue([]),
  };

  const casino = {
    settleRound: jest.fn(async (_game: CasinoGame, _roundId: string, winningOutcome: string) => ({
      winningOutcome,
      payouts: {} as Record<string, number>,
      winners,
    })),
  };

  const release = jest.fn().mockResolvedValue(undefined);
  const locks = {
    acquire: jest.fn().mockResolvedValue(leader ? release : null),
    acquireLockObject: jest
      .fn()
      .mockResolvedValue(leader ? { token: 'mock-token', release } : null),
    extend: jest.fn().mockResolvedValue(leader),
  };

  const emitted: Emitted[] = [];
  const broadcaster = {
    emitToRoom: jest.fn((room: string, event: string, payload: unknown) => {
      emitted.push({ room, event, payload });
    }),
    onlineCount: jest.fn().mockReturnValue(3),
  };

  const profiles = {
    resolvePublicIdentities: jest
      .fn()
      .mockResolvedValue(new Map([['u1', { displayName: 'Alice', avatarUrl: null }]])),
  };

  const loop = new CasinoLoopService(
    repo as any,
    casino as any,
    locks as any,
    broadcaster as any,
    profiles as any,
  );
  return { loop, repo, casino, locks, broadcaster, emitted, profiles };
}

/** Runs `n` `tickGame` calls sequentially, awaiting each (the loop is not re-entrant-safe by design). */
async function tick(loop: CasinoLoopService, game: CasinoGame, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await loop.tickGame(game);
}

describe('CasinoLoopService — leader lock', () => {
  it('does nothing when not the leader: no round created, nothing broadcast', async () => {
    const { loop, repo, broadcaster } = makeLoop({ leader: false });
    await loop.tickGame(CasinoGame.GREEDY_FOOD);
    expect(repo.createRound).not.toHaveBeenCalled();
    expect(broadcaster.emitToRoom).not.toHaveBeenCalled();
  });

  it('bootGame is also a no-op when not the leader', async () => {
    const { loop, repo } = makeLoop({ leader: false });
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    expect(repo.createRound).not.toHaveBeenCalled();
    expect(loop.getState(CasinoGame.GREEDY_FOOD)).toBeUndefined();
  });

  it('advances and broadcasts once this instance IS the leader', async () => {
    const { loop, repo, broadcaster } = makeLoop({ leader: true });
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    expect(repo.createRound).toHaveBeenCalledTimes(1);
    await loop.tickGame(CasinoGame.GREEDY_FOOD);
    expect(broadcaster.emitToRoom).toHaveBeenCalledWith(
      'greedy_food_global',
      'greedy_food_tick',
      expect.objectContaining({ secondsRemaining: 29 }),
    );
  });
});

describe('CasinoLoopService — phase machine (Greedy Food)', () => {
  it('transitions betting(30) -> spinning(10) -> results(5) -> new round, settling exactly once', async () => {
    const { loop, repo, casino, emitted } = makeLoop();
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    expect(loop.getState(CasinoGame.GREEDY_FOOD)).toMatchObject({
      phase: 'betting',
      secondsRemaining: 30,
      roundId: 'round-1',
    });

    // 30 ticks: betting -> spinning
    await tick(loop, CasinoGame.GREEDY_FOOD, 30);
    expect(emitted.some((e) => e.event === 'greedy_food_spin')).toBe(true);
    const spinState = loop.getState(CasinoGame.GREEDY_FOOD)!;
    expect(spinState.phase).toBe('spinning');
    expect(spinState.secondsRemaining).toBe(10);
    expect(typeof spinState.winningOutcome).toBe('string');
    expect(casino.settleRound).not.toHaveBeenCalled();

    // 10 ticks: spinning -> results — settleRound fires exactly once
    await tick(loop, CasinoGame.GREEDY_FOOD, 10);
    expect(casino.settleRound).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === 'greedy_food_results')).toBe(true);
    const resultsState = loop.getState(CasinoGame.GREEDY_FOOD)!;
    expect(resultsState.phase).toBe('results');
    expect(resultsState.secondsRemaining).toBe(5);
    expect(resultsState.history).toHaveLength(1);

    // 5 ticks: results -> a fresh betting round; settleRound still only called once
    await tick(loop, CasinoGame.GREEDY_FOOD, 5);
    expect(casino.settleRound).toHaveBeenCalledTimes(1);
    expect(repo.createRound).toHaveBeenCalledTimes(2);
    expect(emitted.some((e) => e.event === 'greedy_food_new_round')).toBe(true);
    const nextState = loop.getState(CasinoGame.GREEDY_FOOD)!;
    expect(nextState.phase).toBe('betting');
    expect(nextState.secondsRemaining).toBe(30);
    expect(nextState.roundId).toBe('round-2');
    // history is carried forward round-to-round, not reset
    expect(nextState.history).toHaveLength(1);
  });

  it('emits greedy_food_spin/greedy_food_results WITHOUT a roundId field (old-app fidelity)', async () => {
    const { loop, emitted } = makeLoop();
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    await tick(loop, CasinoGame.GREEDY_FOOD, 30);
    const spin = emitted.find((e) => e.event === 'greedy_food_spin')!;
    expect(spin.payload).not.toHaveProperty('roundId');
    expect(spin.payload).toEqual({ winningOutcome: expect.any(String), secondsRemaining: 10 });

    await tick(loop, CasinoGame.GREEDY_FOOD, 10);
    const results = emitted.find((e) => e.event === 'greedy_food_results')!;
    expect(results.payload).not.toHaveProperty('roundId');
    expect(results.payload).toMatchObject({ secondsRemaining: 5 });
  });

  it('resolves winners to {username, amount} via PROFILE_SERVICE, falling back to Player_<id>', async () => {
    const { loop, emitted } = makeLoop({
      winners: [
        { userId: 'u1', amount: 500 }, // resolvable -> 'Alice'
        { userId: 'u-unknown', amount: 100 }, // not in the identity map -> fallback
      ],
    });
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    await tick(loop, CasinoGame.GREEDY_FOOD, 40);
    const results = emitted.find((e) => e.event === 'greedy_food_results')!;
    expect(results.payload.winners).toEqual([
      { username: 'Alice', amount: 500, avatarUrl: null },
      { username: 'Player_u-unknown', amount: 100, avatarUrl: null },
    ]);
  });

  it('resultsHistory caps at 8, newest first', async () => {
    const { loop } = makeLoop();
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    // Run 9 full 45-tick cycles (30 + 10 + 5) — more than the 8-entry cap.
    for (let cycle = 0; cycle < 9; cycle++) {
      await tick(loop, CasinoGame.GREEDY_FOOD, 45);
    }
    const state = loop.getState(CasinoGame.GREEDY_FOOD)!;
    expect(state.history).toHaveLength(8);
  });

  it('poolBets is refreshed from repo.listPlacedBets and included on the tick payload', async () => {
    const { loop, repo, emitted } = makeLoop();
    repo.listPlacedBets.mockResolvedValue([
      { betItem: 'crab', betAmount: 500n },
      { betItem: 'crab', betAmount: 100n },
      { betItem: 'carrot', betAmount: 100n },
    ]);
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    await loop.tickGame(CasinoGame.GREEDY_FOOD);
    const tickEvt = emitted.find((e) => e.event === 'greedy_food_tick')!;
    expect(tickEvt.payload.poolBets).toEqual({ crab: 600, carrot: 100 });
    expect(tickEvt.payload.onlineCount).toBe(3);
  });
});

describe('CasinoLoopService — Lucky Fruit divergent event names/payloads', () => {
  it('uses lucky_fruit_tick / lucky_fruit_result / lucky_fruit_settlement / lucky_fruit_sync', async () => {
    const { loop, emitted } = makeLoop();
    await loop.bootGame(CasinoGame.LUCKY_FRUIT);
    await tick(loop, CasinoGame.LUCKY_FRUIT, 30);
    const spin = emitted.find((e) => e.event === 'lucky_fruit_result');
    expect(spin).toBeDefined();
    // Unlike Greedy's spin payload, Lucky's DOES carry roundId.
    expect(spin!.payload).toHaveProperty('roundId');
    expect(emitted.some((e) => e.event === 'lucky_fruit_tick')).toBe(true);
    expect(emitted.some((e) => e.event === 'greedy_food_spin')).toBe(false);

    await tick(loop, CasinoGame.LUCKY_FRUIT, 10);
    const settlement = emitted.find((e) => e.event === 'lucky_fruit_settlement')!;
    expect(settlement.payload).toHaveProperty('roundId');

    await tick(loop, CasinoGame.LUCKY_FRUIT, 5);
    expect(emitted.some((e) => e.event === 'lucky_fruit_sync')).toBe(true);
    // Lucky Fruit never emits Greedy's new-round event.
    expect(emitted.some((e) => e.event === 'greedy_food_new_round')).toBe(false);
  });

  it('does NOT broadcast anything at cold boot (old `_createNewRound` is silent)', async () => {
    const { loop, emitted } = makeLoop();
    await loop.bootGame(CasinoGame.LUCKY_FRUIT);
    expect(emitted).toHaveLength(0);
  });

  it('tick payload uses `pool` (not `poolBets`) as the key name', async () => {
    const { loop, emitted } = makeLoop();
    await loop.bootGame(CasinoGame.LUCKY_FRUIT);
    await loop.tickGame(CasinoGame.LUCKY_FRUIT);
    const tickEvt = emitted.find((e) => e.event === 'lucky_fruit_tick')!;
    expect(tickEvt.payload).toHaveProperty('pool');
    expect(tickEvt.payload).not.toHaveProperty('poolBets');
  });
});

describe('CasinoLoopService — getState', () => {
  it('is undefined before the game has ever booted', () => {
    const { loop } = makeLoop();
    expect(loop.getState(CasinoGame.GREEDY_FOOD)).toBeUndefined();
  });

  it('returns a safe copy — mutating the returned snapshot does not affect internal state', async () => {
    const { loop } = makeLoop();
    await loop.bootGame(CasinoGame.GREEDY_FOOD);
    const snapshot = loop.getState(CasinoGame.GREEDY_FOOD)!;
    snapshot.history.push('tampered');
    snapshot.poolBets.tampered = 999;
    expect(loop.getState(CasinoGame.GREEDY_FOOD)!.history).toEqual([]);
    expect(loop.getState(CasinoGame.GREEDY_FOOD)!.poolBets).toEqual({});
  });
});

describe('CASINO_GAMES', () => {
  it('lists exactly the two house-banked games', () => {
    expect(CASINO_GAMES).toEqual([CasinoGame.GREEDY_FOOD, CasinoGame.LUCKY_FRUIT]);
  });
});
