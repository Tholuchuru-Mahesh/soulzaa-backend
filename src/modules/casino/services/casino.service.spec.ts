import { HttpStatus } from '@nestjs/common';
import { CasinoGame } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { WIN_HISTORY_LIMIT } from '../constants/casino.constants';
import { CasinoError, CasinoService, type PlaceBetInput } from './casino.service';

/** A bare-bones `CasinoBet` row as returned by `repo.listPlacedBets` (`betAmount` is BigInt). */
function makeBet(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'b1',
    roundId: 'r1',
    userId: 'u1',
    game: CasinoGame.GREEDY_FOOD,
    betItem: 'crab',
    betAmount: 100n,
    clientBetId: 'tap-1',
    status: 'PLACED',
    payoutAmount: 0n,
    betTxnId: 'btx1',
    winTxnId: null,
    createdAt: new Date(),
    settledAt: null,
    ...overrides,
  };
}

/** Settlement-flavored service double: repo settlement methods + wallet.credit. */
function makeSettlementService(
  bets: ReturnType<typeof makeBet>[],
  overrides: { repo?: Record<string, jest.Mock>; wallet?: Record<string, jest.Mock> } = {},
) {
  const repo = {
    listPlacedBets: jest.fn().mockResolvedValue(bets),
    updateBet: jest.fn().mockResolvedValue(undefined),
    closeRound: jest.fn().mockResolvedValue(undefined),
    runInTransaction: jest.fn((fn: (tx: unknown) => unknown) => fn('TX')),
    ...overrides.repo,
  };
  const wallet = {
    credit: jest.fn().mockResolvedValue({
      transactionId: 'wtx',
      currency: 'GOLD',
      balanceAfter: 1,
      duplicate: false,
    }),
    ...overrides.wallet,
  };
  const locks = { withLock: (_key: string, fn: () => unknown) => fn() };
  const svc = new CasinoService(repo as any, wallet as any, locks as any);
  return { svc, repo, wallet };
}

function makeService(
  overrides: { repo?: Record<string, jest.Mock>; wallet?: Record<string, jest.Mock> } = {},
) {
  const repo = {
    createBet: jest.fn().mockResolvedValue({ id: 'bet1' }),
    countDistinctSymbols: jest.fn().mockResolvedValue(0),
    hasSymbol: jest.fn().mockResolvedValue(false),
    ...overrides.repo,
  };
  const wallet = {
    debit: jest
      .fn()
      .mockResolvedValue({ transactionId: 'tx1', balanceAfter: 900, duplicate: false }),
    ...overrides.wallet,
  };
  const locks = { withLock: (_key: string, fn: () => unknown) => fn() };
  const svc = new CasinoService(repo as any, wallet as any, locks as any);
  return { svc, repo, wallet };
}

describe('CasinoService.placeBet', () => {
  const base: PlaceBetInput = {
    userId: 'u1',
    game: CasinoGame.GREEDY_FOOD,
    roundId: 'r1',
    activeRoundId: 'r1',
    phase: 'betting',
    item: 'crab',
    amount: 100,
    clientBetId: 'tap-1',
  };

  it('debits GOLD, persists the bet, and returns the balance + bet id', async () => {
    const { svc, wallet, repo } = makeService();
    const res = await svc.placeBet(base);

    expect(wallet.debit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        currency: 'GOLD',
        amount: 100,
        reason: 'CASINO_BET',
        idempotencyKey: 'casino-bet:r1:u1:tap-1',
        referenceType: 'casino_round',
        referenceId: 'r1',
        metadata: { gameCode: CasinoGame.GREEDY_FOOD, item: 'crab' },
      }),
    );
    expect(repo.createBet).toHaveBeenCalledWith(
      expect.objectContaining({
        roundId: 'r1',
        userId: 'u1',
        game: CasinoGame.GREEDY_FOOD,
        betItem: 'crab',
        betAmount: 100,
        clientBetId: 'tap-1',
        betTxnId: 'tx1',
      }),
    );
    expect(res).toEqual({ balanceAfter: 900, betId: 'bet1' });
  });

  it('rejects when betting is closed (wrong phase)', async () => {
    const { svc, wallet, repo } = makeService();
    await expect(svc.placeBet({ ...base, phase: 'spinning' })).rejects.toThrow(CasinoError);
    await expect(svc.placeBet({ ...base, phase: 'spinning' })).rejects.toThrow(/round/i);
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(repo.createBet).not.toHaveBeenCalled();
  });

  it('rejects a roundId mismatch against the active round', async () => {
    const { svc, wallet } = makeService();
    await expect(svc.placeBet({ ...base, roundId: 'stale' })).rejects.toThrow(/round/i);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('rejects when there is no active round at all', async () => {
    const { svc } = makeService();
    await expect(svc.placeBet({ ...base, activeRoundId: null })).rejects.toThrow(/round/i);
  });

  it('rejects an off-whitelist chip amount', async () => {
    const { svc, wallet } = makeService();
    await expect(svc.placeBet({ ...base, amount: 250 })).rejects.toThrow(/chip/i);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('rejects a non-bettable Greedy Food item', async () => {
    const { svc, wallet } = makeService();
    await expect(svc.placeBet({ ...base, item: 'nope' })).rejects.toThrow(/item|symbol/i);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('rejects a non-bettable Lucky Fruit symbol (including the bonus-only segments)', async () => {
    const { svc, wallet } = makeService();
    await expect(
      svc.placeBet({ ...base, game: CasinoGame.LUCKY_FRUIT, item: 'smallLucky' }),
    ).rejects.toThrow(/symbol/i);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('enforces the Lucky Fruit 6-distinct-symbol cap for a brand-new symbol', async () => {
    const { svc, repo, wallet } = makeService({
      repo: {
        countDistinctSymbols: jest.fn().mockResolvedValue(6),
        hasSymbol: jest.fn().mockResolvedValue(false),
      },
    });
    await expect(
      svc.placeBet({ ...base, game: CasinoGame.LUCKY_FRUIT, item: 'pear' }),
    ).rejects.toThrow(/6 symbols/i);
    expect(repo.hasSymbol).toHaveBeenCalledWith('r1', 'u1', 'pear');
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('allows adding to an already-bet symbol even once the 6-distinct cap is reached', async () => {
    const { svc, wallet } = makeService({
      repo: {
        countDistinctSymbols: jest.fn().mockResolvedValue(6),
        hasSymbol: jest.fn().mockResolvedValue(true),
      },
    });
    const res = await svc.placeBet({ ...base, game: CasinoGame.LUCKY_FRUIT, item: 'pear' });
    expect(wallet.debit).toHaveBeenCalled();
    expect(res).toEqual({ balanceAfter: 900, betId: 'bet1' });
  });

  it('does not consult hasSymbol when the user is still under the 6-distinct cap', async () => {
    const { svc, repo } = makeService({
      repo: { countDistinctSymbols: jest.fn().mockResolvedValue(3) },
    });
    await svc.placeBet({ ...base, game: CasinoGame.LUCKY_FRUIT, item: 'pear' });
    expect(repo.hasSymbol).not.toHaveBeenCalled();
  });

  it('surfaces the old insufficient-balance error for Greedy Food on a failed debit', async () => {
    const { svc, repo } = makeService({
      wallet: {
        debit: jest
          .fn()
          .mockRejectedValue(
            new BusinessException(
              ERROR_CODES.INSUFFICIENT_BALANCE,
              'Insufficient balance for this transaction.',
              HttpStatus.CONFLICT,
            ),
          ),
      },
    });
    await expect(svc.placeBet(base)).rejects.toThrow(CasinoError);
    await expect(svc.placeBet(base)).rejects.toThrow(/insufficient wallet balance/i);
    expect(repo.createBet).not.toHaveBeenCalled();
  });

  it('surfaces the old insufficient-balance error for Lucky Fruit on a failed debit', async () => {
    const { svc } = makeService({
      wallet: {
        debit: jest
          .fn()
          .mockRejectedValue(
            new BusinessException(
              ERROR_CODES.INSUFFICIENT_BALANCE,
              'Insufficient balance for this transaction.',
              HttpStatus.CONFLICT,
            ),
          ),
      },
    });
    await expect(
      svc.placeBet({ ...base, game: CasinoGame.LUCKY_FRUIT, item: 'pear' }),
    ).rejects.toThrow(/insufficient coins/i);
  });

  it('propagates unrelated wallet errors unchanged (not swallowed as a generic casino error)', async () => {
    const boom = new Error('db connection lost');
    const { svc } = makeService({ wallet: { debit: jest.fn().mockRejectedValue(boom) } });
    await expect(svc.placeBet(base)).rejects.toBe(boom);
  });

  it('STACKING: two placeBet calls on the SAME item with DIFFERENT clientBetIds both debit and both persist', async () => {
    const debit = jest
      .fn()
      .mockResolvedValueOnce({ transactionId: 'tx1', balanceAfter: 900, duplicate: false })
      .mockResolvedValueOnce({ transactionId: 'tx2', balanceAfter: 800, duplicate: false });
    const createBet = jest
      .fn()
      .mockResolvedValueOnce({ id: 'bet1' })
      .mockResolvedValueOnce({ id: 'bet2' });
    const { svc } = makeService({ wallet: { debit }, repo: { createBet } });

    const first = await svc.placeBet({ ...base, clientBetId: 'tap-1' });
    const second = await svc.placeBet({ ...base, clientBetId: 'tap-2' });

    expect(debit).toHaveBeenCalledTimes(2);
    expect(debit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'casino-bet:r1:u1:tap-1' }),
    );
    expect(debit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'casino-bet:r1:u1:tap-2' }),
    );
    expect(createBet).toHaveBeenCalledTimes(2);
    expect(createBet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ betItem: 'crab', clientBetId: 'tap-1' }),
    );
    expect(createBet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ betItem: 'crab', clientBetId: 'tap-2' }),
    );
    expect(first).toEqual({ balanceAfter: 900, betId: 'bet1' });
    expect(second).toEqual({ balanceAfter: 800, betId: 'bet2' });
    expect(second.betId).not.toBe(first.betId);
  });

  it('IDEMPOTENT-REPLAY: two placeBet calls with the SAME clientBetId converge on exactly ONE debit and ONE row', async () => {
    // Simulate the wallet's own idempotent behaviour: the 2nd call with the
    // same key returns `duplicate: true` and the SAME transactionId/balanceAfter
    // — no second charge is ever recorded. Simulate the repository's own
    // idempotent-on-(roundId,userId,clientBetId) behaviour (proven directly in
    // casino.repository.spec.ts) by having `createBet` resolve to the SAME
    // row both times — no duplicate bet is ever persisted.
    const debit = jest
      .fn()
      .mockResolvedValueOnce({ transactionId: 'tx1', balanceAfter: 900, duplicate: false })
      .mockResolvedValueOnce({ transactionId: 'tx1', balanceAfter: 900, duplicate: true });
    const createBet = jest.fn().mockResolvedValue({ id: 'bet1' });
    const { svc } = makeService({ wallet: { debit }, repo: { createBet } });

    const first = await svc.placeBet({ ...base, clientBetId: 'tap-1' });
    const second = await svc.placeBet({ ...base, clientBetId: 'tap-1' });

    expect(debit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'casino-bet:r1:u1:tap-1' }),
    );
    expect(debit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'casino-bet:r1:u1:tap-1' }),
    );
    expect(createBet).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientBetId: 'tap-1' }));
    expect(createBet).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientBetId: 'tap-1' }));
    // ONE debit: both calls converge on the same underlying transaction/balance.
    expect(second.balanceAfter).toBe(first.balanceAfter);
    // ONE row: the replay returns the EXISTING betId, not a new one.
    expect(second.betId).toBe(first.betId);
    expect(second).toEqual(first);
  });
});

describe('CasinoService.settleRound', () => {
  it('credits the winner exactly stake×multiplier, marks losers LOST with 0 payout, sums nothing for a single bet, and closes the round SETTLED', async () => {
    const bets = [
      makeBet({ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n }), // wins: crab=45x -> 4500
      makeBet({ id: 'b2', userId: 'u2', betItem: 'carrot', betAmount: 100n }), // loses under outcome=crab
    ];
    const { svc, repo, wallet } = makeSettlementService(bets);

    const res = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');

    expect(wallet.credit).toHaveBeenCalledTimes(1);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        currency: 'GOLD',
        amount: 4500,
        reason: 'CASINO_WIN',
        idempotencyKey: 'casino-win:r1:b1',
        referenceType: 'casino_round',
        referenceId: 'r1',
      }),
      'TX',
    );
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ status: 'WON', payoutAmount: 4500, winTxnId: 'wtx' }),
      'TX',
    );
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b2',
      expect.objectContaining({ status: 'LOST' }),
      'TX',
    );
    expect(repo.updateBet).not.toHaveBeenCalledWith(
      'b2',
      expect.objectContaining({ payoutAmount: expect.anything() }),
      'TX',
    );
    expect(repo.closeRound).toHaveBeenCalledWith('r1', 'SETTLED', 'crab', 'TX');
    expect(res).toEqual({
      winningOutcome: 'crab',
      payouts: { u1: 4500 },
      winners: [{ userId: 'u1', amount: 4500 }],
    });
  });

  it('dispatches to the Lucky Fruit engine (bigLucky bonus pays the bet symbol its own multiplier)', async () => {
    const bets = [
      makeBet({
        id: 'b1',
        userId: 'u1',
        game: CasinoGame.LUCKY_FRUIT,
        betItem: 'dragonFruit', // BIG symbol, 25x
        betAmount: 100n,
      }),
    ];
    const { svc, wallet } = makeSettlementService(bets);

    const res = await svc.settleRound(CasinoGame.LUCKY_FRUIT, 'r1', 'bigLucky');

    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2500, idempotencyKey: 'casino-win:r1:b1' }),
      'TX',
    );
    expect(res.payouts).toEqual({ u1: 2500 });
  });

  it('SUMMATION: a user with TWO winning bets gets a payouts/winners entry that is the SUM, credited per-bet (fixes the old winnersMap.set overwrite bug)', async () => {
    const bets = [
      makeBet({ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n, clientBetId: 'tap-1' }),
      makeBet({ id: 'b2', userId: 'u1', betItem: 'crab', betAmount: 100n, clientBetId: 'tap-2' }),
    ];
    const { svc, repo, wallet } = makeSettlementService(bets);

    const res = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');

    // TWO separate credits — each winning bet is its own ledger row.
    expect(wallet.credit).toHaveBeenCalledTimes(2);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'casino-win:r1:b1', amount: 4500 }),
      'TX',
    );
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'casino-win:r1:b2', amount: 4500 }),
      'TX',
    );
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ payoutAmount: 4500 }),
      'TX',
    );
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b2',
      expect.objectContaining({ payoutAmount: 4500 }),
      'TX',
    );
    // ONE payouts/winners entry for u1 — the SUM (9000), not an overwrite (4500).
    expect(res.payouts).toEqual({ u1: 9000 });
    expect(res.winners).toEqual([{ userId: 'u1', amount: 9000 }]);
  });

  it('caps winners at the top 3 by summed amount, descending', async () => {
    const bets = [
      makeBet({ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n }), // 4500
      makeBet({ id: 'b2', userId: 'u2', betItem: 'crab', betAmount: 1000n }), // 45000
      makeBet({ id: 'b3', userId: 'u3', betItem: 'crab', betAmount: 500n }), // 22500
      makeBet({ id: 'b4', userId: 'u4', betItem: 'crab', betAmount: 10000n }), // 450000
    ];
    const { svc } = makeSettlementService(bets);

    const res = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');

    expect(res.winners).toEqual([
      { userId: 'u4', amount: 450000 },
      { userId: 'u2', amount: 45000 },
      { userId: 'u3', amount: 22500 },
    ]);
  });

  it('IDEMPOTENCY: settling the same round twice does not re-credit already-settled bets (listPlacedBets only ever returns PLACED rows)', async () => {
    let placed = [makeBet({ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n })];
    const repo = {
      listPlacedBets: jest.fn(async () => placed),
      updateBet: jest.fn(async (id: string, data: Record<string, unknown>) => {
        if (data.status && data.status !== 'PLACED') {
          placed = placed.filter((b) => b.id !== id);
        }
      }),
      closeRound: jest.fn().mockResolvedValue(undefined),
      runInTransaction: jest.fn((fn: (tx: unknown) => unknown) => fn('TX')),
    };
    const wallet = {
      credit: jest.fn().mockResolvedValue({
        transactionId: 'wtx',
        currency: 'GOLD',
        balanceAfter: 1,
        duplicate: false,
      }),
    };
    const locks = { withLock: (_key: string, fn: () => unknown) => fn() };
    const svc = new CasinoService(repo as any, wallet as any, locks as any);

    const first = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');
    const second = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');

    expect(wallet.credit).toHaveBeenCalledTimes(1); // second settle found nothing left PLACED
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'casino-win:r1:b1' }),
      'TX',
    );
    expect(first.payouts).toEqual({ u1: 4500 });
    expect(second.payouts).toEqual({});
    expect(second.winners).toEqual([]);
    expect(repo.closeRound).toHaveBeenCalledTimes(2); // still safe/idempotent to re-close
  });

  it('REFUND: settlement transaction failure refunds every bet its own stake, marks them REFUNDED, closes the round ABORTED, and returns aborted:true', async () => {
    const bets = [
      makeBet({ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n }),
      makeBet({ id: 'b2', userId: 'u2', betItem: 'carrot', betAmount: 500n }),
    ];
    const repo = {
      listPlacedBets: jest.fn().mockResolvedValue(bets),
      updateBet: jest.fn().mockResolvedValue(undefined),
      closeRound: jest.fn().mockResolvedValue(undefined),
      runInTransaction: jest.fn(() => {
        throw new Error('db down');
      }),
    };
    const wallet = {
      credit: jest.fn().mockResolvedValue({
        transactionId: 'rtx',
        currency: 'GOLD',
        balanceAfter: 1,
        duplicate: false,
      }),
    };
    const locks = { withLock: (_key: string, fn: () => unknown) => fn() };
    const svc = new CasinoService(repo as any, wallet as any, locks as any);

    const res = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');

    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amount: 100,
        reason: 'CASINO_REFUND',
        idempotencyKey: 'casino-refund:r1:b1',
      }),
    );
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u2',
        amount: 500,
        reason: 'CASINO_REFUND',
        idempotencyKey: 'casino-refund:r1:b2',
      }),
    );
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ status: 'REFUNDED' }),
    );
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b2',
      expect.objectContaining({ status: 'REFUNDED' }),
    );
    expect(repo.closeRound).toHaveBeenCalledWith('r1', 'ABORTED', null);
    expect(res).toEqual({ winningOutcome: 'crab', payouts: {}, winners: [], aborted: true });

    // REFUND IS IDEMPOTENT: re-running the (still-failing) settlement reuses
    // the SAME per-bet refund keys — the wallet's own idempotency guarantee
    // (proven in wallet.service.spec.ts) means this never double-refunds.
    wallet.credit.mockClear();
    repo.updateBet.mockClear();
    repo.closeRound.mockClear();
    const res2 = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'casino-refund:r1:b1' }),
    );
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'casino-refund:r1:b2' }),
    );
    expect(repo.closeRound).toHaveBeenCalledWith('r1', 'ABORTED', null);
    expect(res2.aborted).toBe(true);
  });

  it('REFUND resilience: one bad refund does not block refunding the rest, and the round is still closed ABORTED', async () => {
    const bets = [
      makeBet({ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n }),
      makeBet({ id: 'b2', userId: 'u2', betItem: 'carrot', betAmount: 500n }),
    ];
    const repo = {
      listPlacedBets: jest.fn().mockResolvedValue(bets),
      updateBet: jest.fn().mockResolvedValue(undefined),
      closeRound: jest.fn().mockResolvedValue(undefined),
      runInTransaction: jest.fn(() => {
        throw new Error('db down');
      }),
    };
    const wallet = {
      credit: jest
        .fn()
        .mockRejectedValueOnce(new Error('wallet down for u1'))
        .mockResolvedValueOnce({
          transactionId: 'rtx2',
          currency: 'GOLD',
          balanceAfter: 1,
          duplicate: false,
        }),
    };
    const locks = { withLock: (_key: string, fn: () => unknown) => fn() };
    const svc = new CasinoService(repo as any, wallet as any, locks as any);

    const res = await svc.settleRound(CasinoGame.GREEDY_FOOD, 'r1', 'crab');

    expect(wallet.credit).toHaveBeenCalledTimes(2); // both attempted despite b1's failure
    expect(repo.updateBet).toHaveBeenCalledWith(
      'b2',
      expect.objectContaining({ status: 'REFUNDED' }),
    );
    expect(repo.updateBet).not.toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ status: 'REFUNDED' }),
    );
    expect(repo.closeRound).toHaveBeenCalledWith('r1', 'ABORTED', null); // still closed despite b1's failure
    expect(res.aborted).toBe(true);
  });
});

describe('CasinoService.getWinHistory', () => {
  /** Bare service double exposing only `repo.winHistory` — a thin-passthrough method needs nothing else. */
  function makeWinHistoryService(winHistory: jest.Mock) {
    const repo = { winHistory };
    const wallet = {};
    const locks = { withLock: (_key: string, fn: () => unknown) => fn() };
    const svc = new CasinoService(repo as any, wallet as any, locks as any);
    return { svc, repo };
  }

  it('delegates to the repo with the given user/game and the win-history limit, returning its rows verbatim', async () => {
    const rows = [
      {
        roundId: 'r1',
        item: 'crab',
        betAmount: 100,
        payout: 4500,
        multiplier: 45,
        createdAt: new Date(),
      },
    ];
    const { svc, repo } = makeWinHistoryService(jest.fn().mockResolvedValue(rows));

    const history = await svc.getWinHistory('u1', CasinoGame.GREEDY_FOOD);

    expect(repo.winHistory).toHaveBeenCalledWith('u1', CasinoGame.GREEDY_FOOD, WIN_HISTORY_LIMIT);
    expect(history).toBe(rows);
  });

  it('passes the game through unchanged for Lucky Fruit (not hardcoded to Greedy Food)', async () => {
    const { svc, repo } = makeWinHistoryService(jest.fn().mockResolvedValue([]));

    await svc.getWinHistory('u2', CasinoGame.LUCKY_FRUIT);

    expect(repo.winHistory).toHaveBeenCalledWith('u2', CasinoGame.LUCKY_FRUIT, WIN_HISTORY_LIMIT);
  });
});
