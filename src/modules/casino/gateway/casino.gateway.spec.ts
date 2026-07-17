import { CasinoError } from '../services/casino.service';
import { CasinoGateway } from './casino.gateway';

/** Default `CasinoLoopService.getState` snapshot shared by most tests. */
function defaultState() {
  return {
    roundId: 'r1',
    phase: 'betting' as const,
    secondsRemaining: 20,
    history: ['crab'],
    lastWinners: [{ username: 'Alice', amount: 500 }],
    winningOutcome: null,
    poolBets: {},
  };
}

interface Overrides {
  casino?: Record<string, jest.Mock>;
  loop?: Record<string, jest.Mock>;
  repo?: Record<string, jest.Mock>;
  wallet?: Record<string, jest.Mock>;
  profiles?: Record<string, jest.Mock>;
  rooms?: Map<string, Set<string>>;
}

/** Fresh gateway + every dependency double, wired the same way for every test. */
function makeGateway(overrides: Overrides = {}) {
  const manager = {
    joinRoom: jest.fn().mockResolvedValue(undefined),
    leaveRoom: jest.fn().mockResolvedValue(undefined),
  };
  const casino = {
    placeBet: jest.fn(),
    getWinHistory: jest.fn().mockResolvedValue([]),
    ...overrides.casino,
  };
  const loop = {
    getState: jest.fn().mockReturnValue(defaultState()),
    ...overrides.loop,
  };
  const repo = {
    listUserBets: jest.fn().mockResolvedValue([]),
    listPlacedBets: jest.fn().mockResolvedValue([]),
    recentWinningBets: jest.fn().mockResolvedValue([]),
    ...overrides.repo,
  };
  const wallet = {
    getBalance: jest.fn().mockResolvedValue({ gold: 900, free: 0, earnings: 0 }),
    ...overrides.wallet,
  };
  const profiles = {
    resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()),
    ...overrides.profiles,
  };

  const gateway = new CasinoGateway(
    manager as any,
    casino as any,
    loop as any,
    repo as any,
    wallet as any,
    profiles as any,
  );

  const rooms = overrides.rooms ?? new Map<string, Set<string>>();
  const server = {
    sockets: { adapter: { rooms } },
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  };
  // Bypass Nest's @WebSocketServer() DI (not running in this unit test).
  (gateway as any).server = server;

  return { gateway, manager, casino, loop, repo, wallet, profiles, server };
}

function makeClient(userId = 'u1') {
  return { data: { user: { id: userId, roles: [] } }, emit: jest.fn() } as any;
}

describe('CasinoGateway — place bet', () => {
  it('places a Greedy Food bet, threading clientBetId through, acks bet_placed_success, and broadcasts the pool', async () => {
    const emitSpy = jest.fn();
    const { gateway, casino, server } = makeGateway({
      casino: { placeBet: jest.fn().mockResolvedValue({ balanceAfter: 800, betId: 'bet1' }) },
      repo: {
        listPlacedBets: jest.fn().mockResolvedValue([
          { betItem: 'crab', betAmount: 100n },
          { betItem: 'crab', betAmount: 100n },
        ]),
      },
    });
    server.to.mockReturnValue({ emit: emitSpy });
    const client = makeClient();

    await gateway.onGreedyBet(client, {
      roundId: 'r1',
      item: 'crab',
      amount: 100,
      clientBetId: 'tap-1',
    } as any);

    expect(casino.placeBet).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        game: 'GREEDY_FOOD',
        roundId: 'r1',
        item: 'crab',
        amount: 100,
        activeRoundId: 'r1',
        phase: 'betting',
        clientBetId: 'tap-1',
      }),
    );
    expect(client.emit).toHaveBeenCalledWith('bet_placed_success', {
      item: 'crab',
      amount: 100,
      balance: 800,
    });
    expect(server.to).toHaveBeenCalledWith('greedy_food_global');
    expect(emitSpy).toHaveBeenCalledWith(
      'greedy_food_pool_update',
      expect.objectContaining({ poolBets: expect.objectContaining({ crab: 200 }) }),
    );
  });

  it('places a Lucky Fruit bet, acks lucky_fruit_bet_placed with roundId, and broadcasts the pool map directly (no wrapper)', async () => {
    const emitSpy = jest.fn();
    const { gateway, casino, server } = makeGateway({
      casino: { placeBet: jest.fn().mockResolvedValue({ balanceAfter: 700, betId: 'bet2' }) },
      repo: {
        listPlacedBets: jest.fn().mockResolvedValue([{ betItem: 'muskmelon', betAmount: 500n }]),
      },
    });
    server.to.mockReturnValue({ emit: emitSpy });
    const client = makeClient();

    await gateway.onLuckyBet(client, {
      roundId: 'r1',
      symbol: 'muskmelon',
      amount: 500,
      clientBetId: 'tap-9',
    } as any);

    expect(casino.placeBet).toHaveBeenCalledWith(
      expect.objectContaining({ game: 'LUCKY_FRUIT', item: 'muskmelon', clientBetId: 'tap-9' }),
    );
    expect(client.emit).toHaveBeenCalledWith('lucky_fruit_bet_placed', {
      symbol: 'muskmelon',
      amount: 500,
      balance: 700,
      roundId: 'r1',
    });
    expect(server.to).toHaveBeenCalledWith('lucky_fruit_global');
    expect(emitSpy).toHaveBeenCalledWith(
      'lucky_fruit_pool_update',
      expect.objectContaining({ muskmelon: 500 }),
    );
    const payload = emitSpy.mock.calls[0][1];
    expect(payload.poolBets).toBeUndefined(); // no wrapper — payload IS the pool map
  });

  it('emits casino_error to the requesting socket only when placeBet throws CasinoError', async () => {
    const { gateway } = makeGateway({
      casino: {
        placeBet: jest.fn().mockRejectedValue(new CasinoError('Insufficient wallet balance')),
      },
    });
    const client = makeClient();

    await gateway.onGreedyBet(client, {
      roundId: 'r1',
      item: 'crab',
      amount: 100,
      clientBetId: 'tap-1',
    } as any);

    expect(client.emit).toHaveBeenCalledWith('casino_error', {
      message: 'Insufficient wallet balance',
    });
    expect(client.emit).not.toHaveBeenCalledWith('bet_placed_success', expect.anything());
  });

  it('emits a generic casino_error message for a non-CasinoError failure (defensive)', async () => {
    const { gateway } = makeGateway({
      casino: { placeBet: jest.fn().mockRejectedValue(new Error('db exploded')) },
    });
    const client = makeClient();

    await gateway.onGreedyBet(client, {
      roundId: 'r1',
      item: 'crab',
      amount: 100,
      clientBetId: 'tap-1',
    } as any);

    expect(client.emit).toHaveBeenCalledWith('casino_error', {
      message: 'Internal transaction failed',
    });
  });

  it.each([
    ['missing roundId', { item: 'crab', amount: 100, clientBetId: 'tap-1' }],
    ['missing item/symbol', { roundId: 'r1', amount: 100, clientBetId: 'tap-1' }],
    ['missing amount', { roundId: 'r1', item: 'crab', clientBetId: 'tap-1' }],
    ['zero amount', { roundId: 'r1', item: 'crab', amount: 0, clientBetId: 'tap-1' }],
    ['missing clientBetId', { roundId: 'r1', item: 'crab', amount: 100 }],
  ])('rejects a bet payload with %s without ever calling placeBet', async (_label, body) => {
    const { gateway, casino } = makeGateway();
    const client = makeClient();

    await gateway.onGreedyBet(client, body as any);

    expect(casino.placeBet).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(
      'casino_error',
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it("normalizes Lucky Fruit's `symbol` field into `item` for CasinoService.placeBet", async () => {
    const { gateway, casino } = makeGateway({
      casino: { placeBet: jest.fn().mockResolvedValue({ balanceAfter: 100, betId: 'b1' }) },
    });
    const client = makeClient();
    await gateway.onLuckyBet(client, {
      roundId: 'r1',
      symbol: 'pear',
      amount: 100,
      clientBetId: 'tap-1',
    } as any);
    expect(casino.placeBet).toHaveBeenCalledWith(expect.objectContaining({ item: 'pear' }));
  });
});

describe('CasinoGateway — join / sync', () => {
  it('joins the Greedy Food room and replies with a sync payload built from getState + myBets + balance + onlineCount', async () => {
    const rooms = new Map<string, Set<string>>([
      ['greedy_food_global', new Set(['s1', 's2', 's3'])],
    ]);
    const { gateway, manager } = makeGateway({
      rooms,
      repo: {
        listUserBets: jest.fn().mockResolvedValue([
          { betItem: 'crab', betAmount: 100n },
          { betItem: 'crab', betAmount: 200n },
        ]),
        listPlacedBets: jest.fn().mockResolvedValue([{ betItem: 'crab', betAmount: 300n }]),
      },
      wallet: { getBalance: jest.fn().mockResolvedValue({ gold: 950, free: 0, earnings: 0 }) },
    });
    const client = makeClient();

    await gateway.onGreedyJoin(client);

    expect(manager.joinRoom).toHaveBeenCalledWith(client, 'greedy_food_global');
    const payload = client.emit.mock.calls.find((c: any) => c[0] === 'greedy_food_sync')![1];
    expect(payload).toEqual(
      expect.objectContaining({
        roundId: 'r1',
        phase: 'betting',
        secondsRemaining: 20,
        myBets: [
          { item: 'crab', amount: 100 },
          { item: 'crab', amount: 200 },
        ],
        activeBets: { crab: 300 },
        balance: 950,
        myProfile: { balance: 950 },
        onlineCount: 3,
        history: ['crab'],
        winners: [{ username: 'Alice', amount: 500 }],
      }),
    );
    expect(payload.poolBets.crab).toBe(300);
  });

  it('joins the Lucky Fruit room and replies with a sync payload (pool key, symbol-shaped myBets, no activeBets/myProfile)', async () => {
    const rooms = new Map<string, Set<string>>([['lucky_fruit_global', new Set(['s1'])]]);
    const { gateway, manager } = makeGateway({
      rooms,
      repo: {
        listUserBets: jest.fn().mockResolvedValue([{ betItem: 'muskmelon', betAmount: 500n }]),
        listPlacedBets: jest.fn().mockResolvedValue([]),
      },
      wallet: { getBalance: jest.fn().mockResolvedValue({ gold: 400, free: 0, earnings: 0 }) },
    });
    const client = makeClient();

    await gateway.onLuckyJoin(client);

    expect(manager.joinRoom).toHaveBeenCalledWith(client, 'lucky_fruit_global');
    const payload = client.emit.mock.calls.find((c: any) => c[0] === 'lucky_fruit_sync')![1];
    expect(payload.myBets).toEqual([{ symbol: 'muskmelon', amount: 500 }]);
    expect(payload.balance).toBe(400);
    expect(payload.onlineCount).toBe(1);
    expect(payload.activeBets).toBeUndefined();
    expect(payload.myProfile).toBeUndefined();
    expect(payload.pool).toBeDefined();
  });

  it('includes recentWinners in the Greedy sync, formatted with the ₹ glyph and username fallback', async () => {
    const { gateway } = makeGateway({
      repo: {
        recentWinningBets: jest.fn().mockResolvedValue([
          { userId: 'u1', betItem: 'crab', payoutAmount: 4500 },
          { userId: 'u2', betItem: 'mutton', payoutAmount: 2500 },
        ]),
      },
      profiles: {
        resolvePublicIdentities: jest
          .fn()
          .mockResolvedValue(new Map([['u1', { displayName: 'Alice', avatarUrl: null }]])),
      },
    });
    const client = makeClient();

    await gateway.onGreedyJoin(client);

    const payload = client.emit.mock.calls.find((c: any) => c[0] === 'greedy_food_sync')![1];
    expect(payload.recentWinners).toEqual(['Alice won ₹ 4500', 'Player_u2 won ₹ 2500']);
  });

  it('uses the 🪙 glyph for Lucky Fruit recentWinners', async () => {
    const { gateway } = makeGateway({
      repo: {
        recentWinningBets: jest
          .fn()
          .mockResolvedValue([{ userId: 'u3', betItem: 'muskmelon', payoutAmount: 1000 }]),
      },
    });
    const client = makeClient();

    await gateway.onLuckyJoin(client);

    const payload = client.emit.mock.calls.find((c: any) => c[0] === 'lucky_fruit_sync')![1];
    expect(payload.recentWinners).toEqual(['Player_u3 won 🪙 1000']);
  });
});

describe('CasinoGateway — win history', () => {
  it('replies to get_greedy_food_win_history with the service history', async () => {
    const history = [
      {
        roundId: 'r1',
        item: 'crab',
        betAmount: 100,
        payout: 4500,
        multiplier: 45,
        createdAt: new Date(),
      },
    ];
    const { gateway, casino } = makeGateway({
      casino: { getWinHistory: jest.fn().mockResolvedValue(history) },
    });
    const client = makeClient();

    await gateway.onGreedyHistory(client);

    expect(casino.getWinHistory).toHaveBeenCalledWith('u1', 'GREEDY_FOOD');
    expect(client.emit).toHaveBeenCalledWith('greedy_food_win_history', { history });
  });

  it('replies to get_lucky_fruit_win_history with the service history', async () => {
    const { gateway, casino } = makeGateway();
    const client = makeClient();

    await gateway.onLuckyHistory(client);

    expect(casino.getWinHistory).toHaveBeenCalledWith('u1', 'LUCKY_FRUIT');
    expect(client.emit).toHaveBeenCalledWith('lucky_fruit_win_history', { history: [] });
  });
});

describe('CasinoGateway — leave', () => {
  it('leaves the Greedy Food room on leave_greedy_food', async () => {
    const { gateway, manager } = makeGateway();
    const client = makeClient();
    await gateway.onGreedyLeave(client);
    expect(manager.leaveRoom).toHaveBeenCalledWith(client, 'greedy_food_global');
  });

  it('leaves the Lucky Fruit room on leave_lucky_fruit', async () => {
    const { gateway, manager } = makeGateway();
    const client = makeClient();
    await gateway.onLuckyLeave(client);
    expect(manager.leaveRoom).toHaveBeenCalledWith(client, 'lucky_fruit_global');
  });
});

describe('CasinoGateway — CasinoBroadcaster implementation', () => {
  it('emitToRoom delegates to server.to(room).emit(event, payload)', () => {
    const emitSpy = jest.fn();
    const { gateway, server } = makeGateway();
    server.to.mockReturnValue({ emit: emitSpy });

    gateway.emitToRoom('greedy_food_global', 'greedy_food_tick', { a: 1 });

    expect(server.to).toHaveBeenCalledWith('greedy_food_global');
    expect(emitSpy).toHaveBeenCalledWith('greedy_food_tick', { a: 1 });
  });

  it('onlineCount reads the room size from the socket.io adapter', () => {
    const rooms = new Map<string, Set<string>>([['greedy_food_global', new Set(['a', 'b'])]]);
    const { gateway } = makeGateway({ rooms });
    expect(gateway.onlineCount('greedy_food_global')).toBe(2);
  });

  it('onlineCount returns 0 for an empty/unknown room', () => {
    const { gateway } = makeGateway();
    expect(gateway.onlineCount('greedy_food_global')).toBe(0);
  });
});
