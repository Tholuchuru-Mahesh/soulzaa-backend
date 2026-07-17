import { Prisma } from '@prisma/client';
import { CasinoRepository } from './casino.repository';

const prisma = {
  casinoRound: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  casinoBet: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((fn: any) => fn(prisma)),
} as any;

/** Matches the shape Prisma throws on a unique-constraint violation (P2002). */
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('CasinoRepository', () => {
  const repo = new CasinoRepository(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn: any) => fn(prisma));
  });

  it('creates a round in BETTING', async () => {
    prisma.casinoRound.count.mockResolvedValue(10);
    prisma.casinoRound.create.mockResolvedValue({ id: 'r1' });
    await repo.createRound('GREEDY_FOOD' as any);
    expect(prisma.casinoRound.count).toHaveBeenCalledWith({ where: { game: 'GREEDY_FOOD' } });
    expect(prisma.casinoRound.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ game: 'GREEDY_FOOD', status: 'BETTING', roundNumber: 11 }),
      }),
    );
  });

  it('fetches a round by id', async () => {
    prisma.casinoRound.findUnique.mockResolvedValue({ id: 'r1' });
    const round = await repo.getRound('r1');
    expect(prisma.casinoRound.findUnique).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(round).toEqual({ id: 'r1' });
  });

  it('closes a round as SETTLED with a winning outcome', async () => {
    prisma.casinoRound.update.mockResolvedValue({ id: 'r1' });
    await repo.closeRound('r1', 'SETTLED' as any, 'CHICKEN');
    expect(prisma.casinoRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'SETTLED', winningOutcome: 'CHICKEN' }),
      }),
    );
  });

  it('closes a round as ABORTED with a null outcome', async () => {
    prisma.casinoRound.update.mockResolvedValue({ id: 'r1' });
    await repo.closeRound('r1', 'ABORTED' as any, null);
    expect(prisma.casinoRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ABORTED', winningOutcome: null }),
      }),
    );
  });

  it('creates a PLACED bet, converting the amount to BigInt', async () => {
    prisma.casinoBet.create.mockResolvedValue({ id: 'b1' });
    await repo.createBet({
      roundId: 'r1',
      userId: 'u1',
      game: 'LUCKY_FRUIT' as any,
      betItem: 'MANGO',
      betAmount: 100,
      clientBetId: 'tap-1',
      betTxnId: 'txn-1',
    });
    expect(prisma.casinoBet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          roundId: 'r1',
          userId: 'u1',
          betItem: 'MANGO',
          betAmount: BigInt(100),
          clientBetId: 'tap-1',
          betTxnId: 'txn-1',
        }),
      }),
    );
  });

  it('runs createBet inside a transaction client when one is supplied', async () => {
    const tx = { casinoBet: { create: jest.fn().mockResolvedValue({ id: 'b1' }) } } as any;
    await repo.createBet(
      {
        roundId: 'r1',
        userId: 'u1',
        game: 'LUCKY_FRUIT' as any,
        betItem: 'MANGO',
        betAmount: 10,
        clientBetId: 'tap-1',
      },
      tx,
    );
    expect(tx.casinoBet.create).toHaveBeenCalled();
    expect(prisma.casinoBet.create).not.toHaveBeenCalled();
  });

  it('is idempotent on (roundId, userId, clientBetId): a replay returns the EXISTING row instead of duplicating', async () => {
    prisma.casinoBet.create.mockRejectedValueOnce(p2002());
    prisma.casinoBet.findUnique.mockResolvedValue({ id: 'existing-bet', clientBetId: 'tap-1' });

    const bet = await repo.createBet({
      roundId: 'r1',
      userId: 'u1',
      game: 'LUCKY_FRUIT' as any,
      betItem: 'MANGO',
      betAmount: 100,
      clientBetId: 'tap-1',
      betTxnId: 'txn-1',
    });

    expect(prisma.casinoBet.findUnique).toHaveBeenCalledWith({
      where: {
        roundId_userId_clientBetId: { roundId: 'r1', userId: 'u1', clientBetId: 'tap-1' },
      },
    });
    expect(bet).toEqual({ id: 'existing-bet', clientBetId: 'tap-1' });
  });

  it('a DIFFERENT clientBetId on the same item creates a NEW row (faithful stacking)', async () => {
    prisma.casinoBet.create
      .mockResolvedValueOnce({ id: 'bet-1', clientBetId: 'tap-1' })
      .mockResolvedValueOnce({ id: 'bet-2', clientBetId: 'tap-2' });

    const input = {
      roundId: 'r1',
      userId: 'u1',
      game: 'LUCKY_FRUIT' as any,
      betItem: 'MANGO',
      betAmount: 100,
    };
    const first = await repo.createBet({ ...input, clientBetId: 'tap-1' });
    const second = await repo.createBet({ ...input, clientBetId: 'tap-2' });

    expect(prisma.casinoBet.create).toHaveBeenCalledTimes(2);
    expect(prisma.casinoBet.findUnique).not.toHaveBeenCalled();
    expect(first.id).toBe('bet-1');
    expect(second.id).toBe('bet-2');
    expect(first.id).not.toBe(second.id);
  });

  it('rethrows a P2002 when no existing row is found (defensive — should not happen in practice)', async () => {
    prisma.casinoBet.create.mockRejectedValueOnce(p2002());
    prisma.casinoBet.findUnique.mockResolvedValueOnce(null);

    await expect(
      repo.createBet({
        roundId: 'r1',
        userId: 'u1',
        game: 'LUCKY_FRUIT' as any,
        betItem: 'MANGO',
        betAmount: 100,
        clientBetId: 'tap-1',
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('rethrows non-P2002 errors from createBet unchanged', async () => {
    const boom = new Error('db connection lost');
    prisma.casinoBet.create.mockRejectedValueOnce(boom);

    await expect(
      repo.createBet({
        roundId: 'r1',
        userId: 'u1',
        game: 'LUCKY_FRUIT' as any,
        betItem: 'MANGO',
        betAmount: 100,
        clientBetId: 'tap-1',
      }),
    ).rejects.toBe(boom);
  });

  it('lists placed bets for a round', async () => {
    prisma.casinoBet.findMany.mockResolvedValue([{ id: 'b1' }]);
    const bets = await repo.listPlacedBets('r1');
    expect(prisma.casinoBet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roundId: 'r1', status: 'PLACED' } }),
    );
    expect(bets).toHaveLength(1);
  });

  it("lists ONE user's placed bets in a round", async () => {
    prisma.casinoBet.findMany.mockResolvedValue([
      { id: 'b1', userId: 'u1', betItem: 'crab' },
      { id: 'b2', userId: 'u1', betItem: 'crab' },
    ]);
    const bets = await repo.listUserBets('r1', 'u1');
    expect(prisma.casinoBet.findMany).toHaveBeenCalledWith({
      where: { roundId: 'r1', userId: 'u1', status: 'PLACED' },
    });
    expect(bets).toHaveLength(2);
  });

  it('returns the last N winning bets across all players for a game, newest first', async () => {
    prisma.casinoBet.findMany.mockResolvedValue([
      { userId: 'u1', betItem: 'crab', payoutAmount: BigInt(4500) },
      { userId: 'u2', betItem: 'muskmelon', payoutAmount: BigInt(2250) },
    ]);
    const rows = await repo.recentWinningBets('GREEDY_FOOD' as any, 10);
    expect(prisma.casinoBet.findMany).toHaveBeenCalledWith({
      where: { game: 'GREEDY_FOOD', status: 'WON', payoutAmount: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { userId: true, betItem: true, payoutAmount: true },
    });
    expect(rows).toEqual([
      { userId: 'u1', betItem: 'crab', payoutAmount: 4500 },
      { userId: 'u2', betItem: 'muskmelon', payoutAmount: 2250 },
    ]);
  });

  it('counts distinct symbols a user has bet on in a round', async () => {
    prisma.casinoBet.findMany.mockResolvedValue([{ betItem: 'MANGO' }, { betItem: 'GRAPE' }]);
    const count = await repo.countDistinctSymbols('r1', 'u1');
    expect(prisma.casinoBet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roundId: 'r1', userId: 'u1' },
        distinct: ['betItem'],
        select: { betItem: true },
      }),
    );
    expect(count).toBe(2);
  });

  it('reports hasSymbol true when the user already has a bet on that item', async () => {
    prisma.casinoBet.findFirst.mockResolvedValue({ id: 'b1' });
    const has = await repo.hasSymbol('r1', 'u1', 'MANGO');
    expect(prisma.casinoBet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roundId: 'r1', userId: 'u1', betItem: 'MANGO' },
        select: { id: true },
      }),
    );
    expect(has).toBe(true);
  });

  it('reports hasSymbol false when the user has no bet on that item', async () => {
    prisma.casinoBet.findFirst.mockResolvedValue(null);
    const has = await repo.hasSymbol('r1', 'u1', 'MANGO');
    expect(has).toBe(false);
  });

  it('updates a bet to WON with a payout and winTxnId', async () => {
    await repo.updateBet('b1', {
      status: 'WON' as any,
      payoutAmount: 500,
      winTxnId: 'win-1',
      settledAt: new Date('2026-07-16T00:00:00Z'),
    });
    expect(prisma.casinoBet.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: {
        status: 'WON',
        payoutAmount: BigInt(500),
        winTxnId: 'win-1',
        settledAt: new Date('2026-07-16T00:00:00Z'),
      },
    });
  });

  it('updates a bet to LOST with a zero payout (0 must not be dropped)', async () => {
    await repo.updateBet('b1', { status: 'LOST' as any, payoutAmount: 0 });
    expect(prisma.casinoBet.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'LOST', payoutAmount: BigInt(0) },
    });
  });

  it('updates a bet inside a transaction client when one is supplied', async () => {
    const tx = { casinoBet: { update: jest.fn() } } as any;
    await repo.updateBet('b1', { status: 'REFUNDED' as any }, tx);
    expect(tx.casinoBet.update).toHaveBeenCalled();
    expect(prisma.casinoBet.update).not.toHaveBeenCalled();
  });

  it('returns win history derived from WON bets, ordered by createdAt desc', async () => {
    const createdAt = new Date('2026-07-16T00:00:00Z');
    prisma.casinoBet.findMany.mockResolvedValue([
      {
        roundId: 'r1',
        betItem: 'MANGO',
        betAmount: BigInt(100),
        payoutAmount: BigInt(500),
        createdAt,
      },
    ]);
    const history = await repo.winHistory('u1', 'LUCKY_FRUIT' as any, 20);
    expect(prisma.casinoBet.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', game: 'LUCKY_FRUIT', status: 'WON' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(history).toEqual([
      { roundId: 'r1', item: 'MANGO', betAmount: 100, payout: 500, multiplier: 5, createdAt },
    ]);
  });

  it('runInTransaction delegates to prisma.$transaction', async () => {
    const result = await repo.runInTransaction(async (tx) => {
      expect(tx).toBe(prisma);
      return 'done';
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result).toBe('done');
  });
});
