import {
  VideoRoomPkBattle,
  VideoRoomPkMode,
  VideoRoomPkParticipant,
  VideoRoomPkRewardPool,
  VideoRoomPkSide,
  VideoRoomPkStatus,
  VideoRoomPkTeam,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { PKRewardException, PKWinnerException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkRewardRepository } from '../repositories/video-room-pk-reward.repository';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomPkSettlementService } from './video-room-pk-settlement.service';
import { VideoRoomPkStateService } from './video-room-pk-state.service';

const REWARD_SNAPSHOT = { poolBps: 1000, winnerBps: 6000, participationBps: 3000, bonusBps: 1000 };

const makeBattle = (overrides: Partial<VideoRoomPkBattle> = {}): VideoRoomPkBattle =>
  ({
    id: 'b1',
    roomId: 'r1',
    mode: VideoRoomPkMode.TEAM,
    status: VideoRoomPkStatus.LIVE,
    createdBy: 'owner',
    countdownSeconds: 10,
    durationSeconds: 300,
    startedAt: new Date(),
    endsAt: new Date(),
    pausedAt: null,
    totalPausedMs: 0,
    resumeSeq: 0,
    scoringSnapshot: {},
    rewardSnapshot: REWARD_SNAPSHOT,
    winningTeamId: null,
    isDraw: false,
    completedAt: null,
    cancelledAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as VideoRoomPkBattle;

const makeTeam = (overrides: Partial<VideoRoomPkTeam> = {}): VideoRoomPkTeam =>
  ({
    id: 't-red',
    battleId: 'b1',
    roomId: 'r1',
    side: VideoRoomPkSide.RED,
    score: 0n,
    giftCount: 0,
    createdAt: new Date(),
    ...overrides,
  }) as VideoRoomPkTeam;

const makeParticipant = (overrides: Partial<VideoRoomPkParticipant> = {}): VideoRoomPkParticipant =>
  ({
    id: 'p1',
    battleId: 'b1',
    teamId: 't-red',
    roomId: 'r1',
    userId: 'u1',
    side: VideoRoomPkSide.RED,
    score: 0n,
    giftCount: 0,
    joinedAt: new Date(),
    ...overrides,
  }) as VideoRoomPkParticipant;

const makePool = (overrides: Partial<VideoRoomPkRewardPool> = {}): VideoRoomPkRewardPool =>
  ({
    id: 'pool-1',
    battleId: 'b1',
    roomId: 'r1',
    strategy: 'PERCENTAGE',
    sourceAmount: 1000n,
    poolAmount: 100n,
    winnerBps: 6000,
    participationBps: 3000,
    bonusBps: 1000,
    allocatedAmount: 0n,
    computedAt: new Date(),
    ...overrides,
  }) as VideoRoomPkRewardPool;

describe('VideoRoomPkSettlementService.settle', () => {
  let repo: jest.Mocked<VideoRoomPkRepository>;
  let rewards: jest.Mocked<VideoRoomPkRewardRepository>;
  let state: jest.Mocked<VideoRoomPkStateService>;
  let wallet: jest.Mocked<IWalletService>;
  let cosmetics: jest.Mocked<ICosmeticsService>;
  let bus: jest.Mocked<IEventBus>;

  beforeEach(() => {
    repo = {
      getBattle: jest.fn().mockResolvedValue(makeBattle()),
      listTeams: jest
        .fn()
        .mockResolvedValue([
          makeTeam({ id: 't-red', side: VideoRoomPkSide.RED, score: 10n }),
          makeTeam({ id: 't-blue', side: VideoRoomPkSide.BLUE, score: 0n }),
        ]),
      listParticipants: jest
        .fn()
        .mockResolvedValue([
          makeParticipant({ id: 'p1', teamId: 't-red', userId: 'u1', side: VideoRoomPkSide.RED }),
          makeParticipant({ id: 'p2', teamId: 't-blue', userId: 'u2', side: VideoRoomPkSide.BLUE }),
        ]),
      sumBaseAmount: jest.fn().mockResolvedValue(1000n),
      countGifts: jest.fn().mockResolvedValue(2),
      topContributor: jest.fn().mockResolvedValue({ userId: 'u1', total: 1000n }),
      transition: jest.fn().mockResolvedValue(makeBattle({ status: VideoRoomPkStatus.COMPLETED })),
      runInTransaction: jest.fn().mockImplementation((fn) => fn({})),
    } as unknown as jest.Mocked<VideoRoomPkRepository>;

    rewards = {
      createPool: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          pool: makePool({
            battleId: data.battleId,
            roomId: data.roomId,
            sourceAmount: data.sourceAmount,
            poolAmount: data.poolAmount,
            winnerBps: data.winnerBps,
            participationBps: data.participationBps,
            bonusBps: data.bonusBps,
          }),
          created: true,
        }),
      ),
      createReward: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          id: `${data.userId}-${data.kind}`,
          battleId: data.battleId,
          roomId: data.roomId,
          userId: data.userId,
          teamId: data.teamId ?? null,
          side: data.side ?? null,
          kind: data.kind,
          amount: data.amount,
          currency: data.currency,
          walletTxnId: null,
          idempotencyKey: data.idempotencyKey,
          createdAt: new Date(),
        }),
      ),
      getPool: jest.fn(),
      addAllocated: jest.fn().mockResolvedValue(makePool()),
      setWalletTxnId: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoRoomPkRewardRepository>;

    state = {
      tryTransition: jest
        .fn()
        .mockResolvedValue(
          makeBattle({ status: VideoRoomPkStatus.COMPLETED, completedAt: new Date() }),
        ),
      transition: jest.fn(),
      assertTransition: jest.fn(),
    } as unknown as jest.Mocked<VideoRoomPkStateService>;

    wallet = {
      ensureWallet: jest.fn(),
      getBalance: jest.fn(),
      debit: jest.fn(),
      credit: jest.fn().mockResolvedValue({
        transactionId: 'tx-1',
        currency: WalletCurrency.GOLD,
        balanceAfter: 100,
        duplicate: false,
      }),
    } as unknown as jest.Mocked<IWalletService>;

    cosmetics = {
      getCosmetic: jest.fn(),
      listActive: jest.fn(),
      ensureCosmetic: jest.fn().mockResolvedValue('badge-1'),
      grantToUser: jest
        .fn()
        .mockResolvedValue({ cosmeticId: 'badge-1', backpackItemId: 'bp-1', duplicate: false }),
    } as unknown as jest.Mocked<ICosmeticsService>;

    bus = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    } as unknown as jest.Mocked<IEventBus>;
  });

  function build(
    opts: {
      state?: Pick<jest.Mocked<VideoRoomPkStateService>, 'tryTransition'>;
      draw?: boolean;
      winners?: number;
      winnerShare?: number;
    } = {},
  ): VideoRoomPkSettlementService {
    if (opts.draw) {
      repo.listTeams.mockResolvedValue([
        makeTeam({ id: 't-red', side: VideoRoomPkSide.RED, score: 5n }),
        makeTeam({ id: 't-blue', side: VideoRoomPkSide.BLUE, score: 5n }),
      ]);
    }

    if (opts.winners !== undefined && opts.winnerShare !== undefined) {
      // 100% pool, 100% winner slice, 0% participation/bonus — isolates the
      // winner-slice integer division so the dust is exactly poolAmount -
      // floor(winnerShare / winners) * winners.
      const snapshot = { poolBps: 10_000, winnerBps: 10_000, participationBps: 0, bonusBps: 0 };
      state.tryTransition.mockResolvedValue(
        makeBattle({
          status: VideoRoomPkStatus.COMPLETED,
          completedAt: new Date(),
          rewardSnapshot: snapshot,
        }),
      );
      repo.sumBaseAmount.mockResolvedValue(BigInt(opts.winnerShare));
      repo.listTeams.mockResolvedValue([
        makeTeam({ id: 't-red', side: VideoRoomPkSide.RED, score: 10n }),
        makeTeam({ id: 't-blue', side: VideoRoomPkSide.BLUE, score: 0n }),
      ]);
      repo.listParticipants.mockResolvedValue(
        Array.from({ length: opts.winners }, (_, i) =>
          makeParticipant({
            id: `pw${i}`,
            teamId: 't-red',
            userId: `uw${i}`,
            side: VideoRoomPkSide.RED,
          }),
        ),
      );
      repo.topContributor.mockResolvedValue(null);
    }

    const svcState = (opts.state as jest.Mocked<VideoRoomPkStateService>) ?? state;
    return new VideoRoomPkSettlementService(repo, rewards, svcState, wallet, cosmetics, bus);
  }

  it('exits quietly when the battle is already COMPLETED', async () => {
    const localState = { tryTransition: jest.fn().mockResolvedValue(null) };
    const out = await build({
      state: localState as unknown as jest.Mocked<VideoRoomPkStateService>,
    }).settle('b1', 'timer');
    expect(out.settled).toBe(false);
    expect(rewards.createPool).not.toHaveBeenCalled();
  });

  it('declares the higher-scoring team the winner', async () => {
    const out = await build().settle('b1', 'timer');
    expect(out.winningTeamId).toBe('t-red');
    expect(out.isDraw).toBe(false);
  });

  it('declares a draw on equal scores', async () => {
    const out = await build({ draw: true }).settle('b1', 'timer');
    expect(out.isDraw).toBe(true);
    expect(out.winningTeamId).toBeNull();
  });

  // Sizing on scoredAmount would let a 3x multiplier triple the platform's
  // liability for coins nobody spent.
  it('sizes the pool on BASE contribution, not scored', async () => {
    repo.sumBaseAmount.mockResolvedValue(1000n);
    repo.listTeams.mockResolvedValue([
      { id: 't-red', side: VideoRoomPkSide.RED, score: 3000n } as VideoRoomPkTeam,
      { id: 't-blue', side: VideoRoomPkSide.BLUE, score: 0n } as VideoRoomPkTeam,
    ]);
    await build().settle('b1', 'timer');
    expect(rewards.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAmount: 1000n, poolAmount: 100n }),
      expect.anything(),
    );
  });

  it('mints no winner slice on a draw', async () => {
    // pool 100, winnerBps 6000 -> the 60 is NOT minted and NOT redistributed
    const out = await build({ draw: true }).settle('b1', 'timer');
    expect(out.allocatedAmount).toBe(40);
  });

  it('leaves integer-division dust unminted', async () => {
    // winner share 10 across 3 winners -> 3 each, 1 left unminted
    const out = await build({ winners: 3, winnerShare: 10 }).settle('b1', 'timer');
    expect(out.poolAmount - out.allocatedAmount).toBeGreaterThan(0);
  });

  it('credits each recipient with a per-kind idempotency key', async () => {
    await build().settle('b1', 'timer');
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: WalletTxnReason.PK_REWARD,
        idempotencyKey: 'pk:b1:u1:WINNER',
      }),
      expect.anything(),
    );
  });

  // Two guards, independently: our table AND the wallet.
  it('skips the wallet credit when the reward row already exists', async () => {
    rewards.createReward.mockResolvedValue(null);
    await build().settle('b1', 'timer');
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('is idempotent end to end — settling twice pays once', async () => {
    const svc = build();
    await svc.settle('b1', 'timer');
    rewards.createPool.mockResolvedValue({
      pool: makePool({ allocatedAmount: 100n }),
      created: false,
    });
    rewards.createReward.mockResolvedValue(null);
    await svc.settle('b1', 'timer');
    // 4 recipients paid on pass 1 (WINNER u1, PARTICIPATION u1, PARTICIPATION
    // u2, BONUS u1); pass 2 finds every (battle,user,kind) row already
    // present and skips every credit.
    expect(wallet.credit).toHaveBeenCalledTimes(4);
  });

  it('prefixes the badge grantKey with video-pk to avoid the audio namespace', async () => {
    await build().settle('b1', 'timer');
    expect(cosmetics.grantToUser).toHaveBeenCalledWith(
      expect.objectContaining({ grantKey: 'video-pk:b1:u1' }),
    );
  });

  it('emits PkEndedEvent, PkWinnerDeclaredEvent then PkRewardDistributedEvent', async () => {
    await build().settle('b1', 'timer');
    expect(bus.publish.mock.calls.map((c) => c[0].name)).toEqual([
      VIDEO_ROOM_PK_EVENTS.ENDED,
      VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED,
      VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED,
    ]);
  });

  // ---- Extra coverage beyond the 11 required tests ----

  it('settles a battle with zero contributions without crashing', async () => {
    repo.sumBaseAmount.mockResolvedValue(0n);
    const out = await build().settle('b1', 'timer');
    expect(out.poolAmount).toBe(0);
    expect(out.allocatedAmount).toBe(0);
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
    // Settlement still completes and still announces the (empty) outcome.
    expect(bus.publish).toHaveBeenCalledTimes(3);
  });

  it('rolls back and skips badge grants and events when a wallet credit rejects mid-distribution', async () => {
    wallet.credit.mockRejectedValueOnce(new Error('wallet down'));
    await expect(build().settle('b1', 'timer')).rejects.toThrow('wallet down');
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  // ---- Regression guard: the CAS must commit atomically WITH the payout ----

  // The critical fix under review: `state.tryTransition` (the CAS that flips
  // LIVE|PAUSED -> COMPLETED) used to run as a standalone statement BEFORE
  // `repo.runInTransaction` opened the payout transaction. A crash (or DB
  // error) between that standalone commit and the payout transaction
  // completing left the battle permanently COMPLETED with no pool and no
  // reward rows — unrecoverable, because every retry's `isPkTerminal`
  // fast-check at the top of `settle()` would then exit quietly forever.
  //
  // This test simulates that crash: `runInTransaction`'s callback (CAS +
  // full payout) runs to completion against a transaction client, but the
  // transaction itself then rejects instead of committing (a dropped
  // connection at COMMIT time, say). The regression signal is which `db`
  // handle the CAS ran on: if it ran on the SAME (now-doomed) transaction
  // client passed to the callback, it rolls back with everything else and
  // the battle is never left COMPLETED. If it ran as a bare pre-transaction
  // call (the old, buggy ordering), it would already have committed by the
  // time this rejection happens, regardless of this assertion. Restoring the
  // old ordering makes this specific assertion fail, because the old code
  // calls `tryTransition` WITHOUT a trailing `tx` argument.
  it('CRITICAL: does not commit the CAS separately from a payout transaction that fails to commit', async () => {
    const FAKE_TX = { __marker: 'settlement-tx' } as never;
    repo.runInTransaction.mockImplementation(async (fn: (tx: never) => Promise<unknown>) => {
      await fn(FAKE_TX); // CAS + full payout run against this client...
      throw new Error('crash mid-payout'); // ...but the transaction never commits.
    });

    const svc = build();
    await expect(svc.settle('b1', 'timer')).rejects.toThrow('crash mid-payout');

    // The CAS must run ON THE SAME doomed transaction client passed into the
    // callback — proof it is inside the transaction, not a standalone
    // pre-transaction commit that already landed before this rejection.
    expect(state.tryTransition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.COMPLETED,
      expect.objectContaining({ completedAt: expect.any(Date) }),
      FAKE_TX,
    );

    // Nothing post-commit ran: a rolled-back transaction must not leave a
    // granted badge or a broadcast winner behind — and, since the CAS is now
    // part of that same rollback, must not leave the battle COMPLETED either.
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('writes the wallet transaction id onto the reward row after a successful credit', async () => {
    wallet.credit.mockResolvedValue({
      transactionId: 'tx-99',
      currency: WalletCurrency.GOLD,
      balanceAfter: 500,
      duplicate: false,
    });

    await build().settle('b1', 'timer');

    // u1-WINNER is the reward id `createReward`'s mock derives for the
    // winning participant (userId u1, kind WINNER) — see `rewards.createReward`.
    expect(rewards.setWalletTxnId).toHaveBeenCalledWith('u1-WINNER', 'tx-99', expect.anything());
  });

  it('clamps an out-of-range poolBps to 10000 so the pool cannot exceed the base contribution', async () => {
    state.tryTransition.mockResolvedValue(
      makeBattle({
        status: VideoRoomPkStatus.COMPLETED,
        completedAt: new Date(),
        rewardSnapshot: { poolBps: 20_000, winnerBps: 10_000, participationBps: 0, bonusBps: 0 },
      }),
    );
    repo.sumBaseAmount.mockResolvedValue(1000n);

    const out = await build().settle('b1', 'timer');

    // 20000 bps clamps to 10000 (100%): the pool cannot exceed base contribution.
    expect(out.poolAmount).toBe(1000);
    expect(rewards.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ poolAmount: 1000n }),
      expect.anything(),
    );
  });

  // ---- Wiring-gate closure: PKWinnerException/PKRewardException were bound
  // to real error codes but never thrown anywhere. ----

  it('throws PKWinnerException when the battle has no teams to rank', async () => {
    repo.listTeams.mockResolvedValue([]);

    await expect(build().settle('b1', 'timer')).rejects.toBeInstanceOf(PKWinnerException);
    // The rolled-back transaction must not have minted a pool or paid anyone.
    expect(rewards.createPool).not.toHaveBeenCalled();
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('throws PKRewardException when the winning team has money earmarked but no participants', async () => {
    repo.listTeams.mockResolvedValue([
      makeTeam({ id: 't-red', side: VideoRoomPkSide.RED, score: 10n }),
      makeTeam({ id: 't-blue', side: VideoRoomPkSide.BLUE, score: 0n }),
    ]);
    // No participant belongs to the winning team (t-red) at all.
    repo.listParticipants.mockResolvedValue([
      makeParticipant({ id: 'p2', teamId: 't-blue', userId: 'u2', side: VideoRoomPkSide.BLUE }),
    ]);

    await expect(build().settle('b1', 'timer')).rejects.toBeInstanceOf(PKRewardException);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('scales winner/participation/bonus down proportionally when their sum exceeds 10000, keeping allocated <= pool', async () => {
    // 6000 + 6000 + 3000 = 15000 > 10000.
    state.tryTransition.mockResolvedValue(
      makeBattle({
        status: VideoRoomPkStatus.COMPLETED,
        completedAt: new Date(),
        rewardSnapshot: {
          poolBps: 10_000,
          winnerBps: 6000,
          participationBps: 6000,
          bonusBps: 3000,
        },
      }),
    );
    repo.sumBaseAmount.mockResolvedValue(1000n);

    const out = await build().settle('b1', 'timer');

    expect(out.allocatedAmount).toBeLessThanOrEqual(out.poolAmount);
    // Scaled proportionally so the sum is exactly 10000: 4000 + 4000 + 2000.
    expect(rewards.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ winnerBps: 4000, participationBps: 4000, bonusBps: 2000 }),
      expect.anything(),
    );
  });
});
