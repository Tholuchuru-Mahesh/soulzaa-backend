import { HttpStatus } from '@nestjs/common';
import {
  GiftContextType,
  VideoRoomMemberRole,
  VideoRoomPkMode,
  WalletTxnReason,
} from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { ConnectionStatus } from './enums';
import { VideoRoomGiftContextHandler } from './services/video-room-gift-context.handler';
import { VideoRoomPkInvitationService } from './services/video-room-pk-invitation.service';
import { VideoRoomPkJobsService } from './services/video-room-pk-jobs.service';
import { VideoRoomPkRecoveryService } from './services/video-room-pk-recovery.service';
import { VideoRoomPkScoreEngine } from './services/video-room-pk-score.engine';
import { VideoRoomPkScoringService } from './services/video-room-pk-scoring.service';
import { VideoRoomPkSettlementService } from './services/video-room-pk-settlement.service';
import { VideoRoomPkStateService } from './services/video-room-pk-state.service';
import { VideoRoomPkTimerService } from './services/video-room-pk-timer.service';
import { VideoRoomPkValidationService } from './services/video-room-pk-validation.service';
import { VideoRoomPkService } from './services/video-room-pk.service';

/**
 * VR-12 Task 24 end-to-end: the REAL PK service graph (lifecycle, invitations,
 * state machine, score engine, scoring, settlement, jobs, recovery) wired
 * together, plus the REAL `VideoRoomGiftContextHandler.onSend` seam — with
 * only the outermost edges (Postgres, Redis, wallet, cosmetics, queue, locks,
 * event bus, permissions/presence/media) faked with in-memory doubles.
 *
 * Mirrors `video-rooms-gift.integration.spec.ts`'s convention: construct real
 * collaborators directly (no Nest DI container), cast fakes `as never` at the
 * constructor boundary. The unit specs each prove one collaborator in
 * isolation; this proves the WHOLE lifecycle → gift → settlement path agrees
 * end to end, the way TDD alone cannot (a passing unit suite proves each part
 * does what it says, not that anything actually calls it in sequence).
 */

const ROOM = 'room-1';
const OWNER_ID = 'owner-1';
const OPPONENT_ID = 'opp-1';
const OWNER = { id: OWNER_ID, roles: [] } as never;
const OPPONENT = { id: OPPONENT_ID, roles: [] } as never;
const NOW = 1_700_000_000_000;

const GIFT = {
  id: 'gift-1',
  name: 'Rocket',
  category: 'LUXURY',
  type: 'ANIMATED',
  coinValue: 100,
  animationUrl: 'a.svga',
  soundUrl: 's.mp3',
  minVipLevel: 0,
  comboEnabled: false,
  comboWindowSeconds: 10,
  luckyMultipliers: [],
  luckyWinChanceBp: 0,
  enabled: true,
};

const DEFAULT_PK_CFG = {
  enabled: true,
  countdownSeconds: 1,
  minDurationSeconds: 1,
  maxDurationSeconds: 1800,
  defaultDurationSeconds: 300,
  invitationTtlSeconds: 60,
  poolBps: 1000,
  winnerBps: 6000,
  participationBps: 3000,
  bonusBps: 1000,
  multiplierCapBps: 30_000,
  vipBonusBpsPerTier: 500,
  eventBonusBps: 0,
  eventMultiplierEnabled: false,
  scoreEmitPerSecond: 10,
  recoveryEnabled: false,
  monitorIntervalSeconds: 15,
  orphanTimeoutSeconds: 120,
  recoveryGraceSeconds: 45,
  maxPerSweep: 50,
};

const GIFT_CFG = { maxReceivers: 9 };

/** In-memory double for `VideoRoomPkRepository`. `db`/`tx` params are accepted but ignored. */
function createPkRepo() {
  const battles = new Map<string, Record<string, unknown>>();
  const teams = new Map<string, Record<string, unknown>>();
  const participants = new Map<string, Record<string, unknown>>();
  const contributions: Record<string, unknown>[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  return {
    runInTransaction: async (fn: (tx: unknown) => unknown) => fn({}),

    findLive: async (roomId: string) =>
      [...battles.values()].find((b) => b.roomId === roomId && b.status === 'LIVE') ?? null,
    findCurrent: async (roomId: string) =>
      [...battles.values()].find(
        (b) =>
          b.roomId === roomId && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(b.status as string),
      ) ?? null,
    getBattle: async (id: string) => battles.get(id) ?? null,
    createBattle: async (data: Record<string, unknown>) => {
      const row = {
        resumeSeq: 0,
        totalPausedMs: 0,
        isDraw: false,
        winningTeamId: null,
        startedAt: null,
        endsAt: null,
        pausedAt: null,
        completedAt: null,
        cancelledAt: null,
        failureReason: null,
        createdAt: new Date(),
        ...data,
        id: nextId('battle'),
        status: 'CREATED',
      };
      battles.set(row.id as string, row);
      return row;
    },
    transition: async (
      id: string,
      from: string,
      to: string,
      patch: Record<string, unknown> = {},
    ) => {
      const row = battles.get(id);
      if (!row || row.status !== from) return null;
      Object.assign(row, patch, { status: to });
      return row;
    },

    createTeams: async (rows: Record<string, unknown>[]) => {
      for (const r of rows) teams.set(r.id as string, { score: 0n, giftCount: 0, ...r });
      return { count: rows.length };
    },
    listTeams: async (battleId: string) =>
      [...teams.values()].filter((t) => t.battleId === battleId),
    getTeam: async (id: string) => teams.get(id) ?? null,
    addTeamScore: async (teamId: string, seenScore: bigint, delta: bigint) => {
      const row = teams.get(teamId);
      if (!row || row.score !== seenScore) return null;
      row.score = seenScore + delta;
      row.giftCount = (row.giftCount as number) + 1;
      return row;
    },

    createParticipants: async (rows: Record<string, unknown>[]) => {
      for (const r of rows) participants.set(r.id as string, { score: 0n, giftCount: 0, ...r });
      return { count: rows.length };
    },
    listParticipants: async (battleId: string) =>
      [...participants.values()].filter((p) => p.battleId === battleId),
    findParticipantsByUserIds: async (battleId: string, userIds: string[]) =>
      [...participants.values()].filter(
        (p) => p.battleId === battleId && userIds.includes(p.userId as string),
      ),
    getParticipant: async (id: string) => participants.get(id) ?? null,
    addParticipantScore: async (id: string, seenScore: bigint, delta: bigint) => {
      const row = participants.get(id);
      if (!row || row.score !== seenScore) return null;
      row.score = seenScore + delta;
      row.giftCount = (row.giftCount as number) + 1;
      return row;
    },

    addContribution: async (data: Record<string, unknown>) => {
      const row = { id: nextId('contrib'), ...data };
      contributions.push(row);
      return row;
    },
    sumBaseAmount: async (battleId: string) =>
      contributions
        .filter((c) => c.battleId === battleId)
        .reduce((sum: bigint, c) => sum + (c.baseAmount as bigint), 0n),
    countGifts: async (battleId: string) =>
      contributions.filter((c) => c.battleId === battleId).length,
    findContributions: async (battleId: string, giftTxnId: string) =>
      contributions.filter((c) => c.battleId === battleId && c.giftTxnId === giftTxnId),
    topContributor: async (battleId: string) => {
      const totals = new Map<string, bigint>();
      for (const c of contributions) {
        if (c.battleId !== battleId) continue;
        const senderId = c.senderId as string;
        totals.set(senderId, (totals.get(senderId) ?? 0n) + (c.baseAmount as bigint));
      }
      let top: { userId: string; total: bigint } | null = null;
      for (const [userId, total] of totals) {
        if (!top || total > top.total) top = { userId, total };
      }
      return top;
    },

    getWealthLevel: async () => 0,

    listBattles: async (roomId: string, skip: number, take: number) => {
      const rows = [...battles.values()].filter(
        (b) =>
          b.roomId === roomId && ['COMPLETED', 'CANCELLED', 'FAILED'].includes(b.status as string),
      );
      return [rows.slice(skip, skip + take), rows.length] as const;
    },
    statistics: async () => ({
      totalBattles: 0,
      totalWins: 0,
      totalDraws: 0,
      totalContributed: 0n,
      totalGiftCount: 0,
    }),
    findStale: async (now: Date, statuses: string[], take: number) =>
      [...battles.values()]
        .filter(
          (b) =>
            statuses.includes(b.status as string) &&
            b.endsAt &&
            (b.endsAt as Date).getTime() <= now.getTime(),
        )
        .slice(0, take),
    findByStatus: async (status: string, take: number) =>
      [...battles.values()].filter((b) => b.status === status).slice(0, take),
  };
}

/** In-memory double for `VideoRoomPkInvitationRepository`. */
function createInvitationRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;

  return {
    create: async (data: Record<string, unknown>) => {
      const row = {
        status: 'SENT',
        deliveredAt: null,
        respondedAt: null,
        ...data,
        id: `inv-${++seq}`,
      };
      rows.set(row.id, row);
      return row;
    },
    listForBattle: async (battleId: string) =>
      [...rows.values()].filter((r) => r.battleId === battleId),
    findActionable: async (battleId: string, inviteeUserId: string) => {
      const actionable = [...rows.values()]
        .filter(
          (r) =>
            r.battleId === battleId &&
            r.inviteeUserId === inviteeUserId &&
            ['SENT', 'DELIVERED'].includes(r.status as string),
        )
        .sort((a, b) => (b.attempt as number) - (a.attempt as number));
      return actionable[0] ?? null;
    },
    updateStatus: async (
      id: string,
      from: string,
      to: string,
      patch: Record<string, unknown> = {},
    ) => {
      const row = rows.get(id);
      if (!row || row.status !== from) return null;
      Object.assign(row, patch, { status: to });
      return row;
    },
    latestAttempt: async (battleId: string, inviteeUserId: string) => {
      const matches = [...rows.values()].filter(
        (r) => r.battleId === battleId && r.inviteeUserId === inviteeUserId,
      );
      return matches.length ? Math.max(...matches.map((r) => r.attempt as number)) : 0;
    },
    findExpired: async (now: Date, take: number) =>
      [...rows.values()]
        .filter(
          (r) =>
            ['SENT', 'DELIVERED'].includes(r.status as string) &&
            (r.expiresAt as Date).getTime() <= now.getTime(),
        )
        .slice(0, take),
  };
}

/** In-memory double for `VideoRoomPkRewardRepository`. */
function createRewardRepo() {
  const pools = new Map<string, Record<string, unknown>>();
  const rewards = new Map<string, Record<string, unknown>>();
  let seq = 0;

  return {
    createPool: async (data: Record<string, unknown>) => {
      const existing = pools.get(data.battleId as string);
      if (existing) return { pool: existing, created: false };
      const pool = { allocatedAmount: 0n, ...data, id: `pool-${++seq}` };
      pools.set(data.battleId as string, pool);
      return { pool, created: true };
    },
    getPool: async (battleId: string) => pools.get(battleId) ?? null,
    addAllocated: async (poolId: string, amount: bigint) => {
      const pool = [...pools.values()].find((p) => p.id === poolId);
      if (pool) pool.allocatedAmount = (pool.allocatedAmount as bigint) + amount;
      return pool;
    },
    setWalletTxnId: async (rewardId: string, walletTxnId: string) => {
      const reward = rewards.get(rewardId);
      if (reward) reward.walletTxnId = walletTxnId;
      return reward;
    },
    createReward: async (data: Record<string, unknown>) => {
      const dupe = [...rewards.values()].find(
        (r) => r.battleId === data.battleId && r.userId === data.userId && r.kind === data.kind,
      );
      if (dupe) return null;
      const reward = { walletTxnId: null, ...data, id: `reward-${++seq}` };
      rewards.set(reward.id, reward);
      return reward;
    },
    listRewards: async (battleId: string) =>
      [...rewards.values()].filter((r) => r.battleId === battleId),
  };
}

describe('VR-12 PK integration', () => {
  function build() {
    const pkCfg = { ...DEFAULT_PK_CFG };
    const config = {
      get: jest.fn((ns: string) => (ns === 'videoRoomPk' ? pkCfg : ns === 'gift' ? GIFT_CFG : {})),
    };

    const pkRepo = createPkRepo();
    const invitationRepo = createInvitationRepo();
    const rewardRepo = createRewardRepo();

    const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const locks = {
      withLock: jest.fn().mockImplementation((_k: string, fn: () => unknown) => fn()),
      acquire: jest.fn().mockResolvedValue(async () => undefined),
    };
    const queueService = {
      enqueueDelayed: jest.fn().mockResolvedValue(undefined),
      getQueue: jest.fn().mockReturnValue({ remove: jest.fn().mockResolvedValue(undefined) }),
    };
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const redis = {
      hset: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({}),
    };
    const wallet = {
      credit: jest.fn().mockImplementation(async (input: Record<string, unknown>) => ({
        transactionId: `wtxn-${Math.random()}`,
        currency: input.currency,
        balanceAfter: 0,
        duplicate: false,
      })),
      debit: jest.fn(),
      ensureWallet: jest.fn(),
      getBalance: jest.fn(),
    };
    const cosmetics = {
      ensureCosmetic: jest.fn().mockResolvedValue('badge-1'),
      grantToUser: jest
        .fn()
        .mockResolvedValue({ cosmeticId: 'badge-1', backpackItemId: 'bp-1', duplicate: false }),
      getCosmetic: jest.fn(),
      listActive: jest.fn(),
    };
    const metrics = { setPkActive: jest.fn(), setPkRecoveryQueueDepth: jest.fn() };

    const rooms: Record<string, jest.Mock> = {
      findById: jest.fn().mockResolvedValue({ id: ROOM, ownerId: OWNER_ID, status: 'LIVE' }),
      getSettings: jest.fn().mockResolvedValue({ allowPk: true, allowGifts: true, metadata: null }),
      getMember: jest
        .fn()
        .mockResolvedValue({ isActive: true, role: VideoRoomMemberRole.PARTICIPANT }),
    };
    // Mirrors `getSettings` by default (delegates to it) so any override of
    // `getSettings` keeps working now that the validation service reads
    // `requireSettings` instead.
    rooms.requireSettings = jest.fn(async () => {
      const row = await rooms.getSettings();
      if (!row) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return row;
    });
    const permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    const presence = {
      isInRoom: jest.fn().mockResolvedValue(true),
    };
    const mediaState = {
      getSnapshot: jest.fn().mockResolvedValue({
        participants: [
          { userId: OWNER_ID, connection: ConnectionStatus.CONNECTED },
          { userId: OPPONENT_ID, connection: ConnectionStatus.CONNECTED },
        ],
      }),
    };

    // ---- REAL PK service graph ----
    const state = new VideoRoomPkStateService(pkRepo as never);
    const scoreEngine = new VideoRoomPkScoreEngine();
    const validation = new VideoRoomPkValidationService(
      rooms as never,
      permissions as never,
      presence as never,
      mediaState as never,
      pkRepo as never,
      config as never,
    );
    const scoring = new VideoRoomPkScoringService(
      pkRepo as never,
      scoreEngine,
      cache as never,
      config as never,
      redis as never,
    );
    const timer = new VideoRoomPkTimerService(queueService as never);
    const invitations = new VideoRoomPkInvitationService(
      invitationRepo as never,
      state,
      bus as never,
      config as never,
    );
    const settlement = new VideoRoomPkSettlementService(
      pkRepo as never,
      rewardRepo as never,
      state,
      wallet as never,
      cosmetics as never,
      bus as never,
    );
    const pk = new VideoRoomPkService(
      pkRepo as never,
      validation,
      state,
      timer,
      invitations,
      scoreEngine,
      locks as never,
      bus as never,
      config as never,
      settlement,
    );
    const jobs = new VideoRoomPkJobsService(
      { register: jest.fn() } as never,
      pkRepo as never,
      state,
      timer,
      settlement,
    );
    const recovery = new VideoRoomPkRecoveryService(
      pkRepo as never,
      invitationRepo as never,
      invitations,
      state,
      timer,
      settlement,
      rooms as never,
      locks as never,
      bus as never,
      config as never,
      metrics as never,
      () => Date.now(),
    );

    // ---- The REAL gift-context handler seam (VR-10, extended VR-12). ----
    const treasureProgress = {
      apply: jest.fn().mockResolvedValue({
        sessionId: null,
        applied: 0,
        events: [],
        claimedBoxId: null,
        claimedLevel: null,
        correlationId: 'c1',
        mirror: null,
      }),
      shouldEmit: jest.fn().mockResolvedValue(true),
      mirror: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
    };
    const giftHandler = new VideoRoomGiftContextHandler(
      rooms as never,
      { findActiveBlock: jest.fn().mockResolvedValue(null) } as never,
      config as never,
      { register: jest.fn() } as never,
      treasureProgress as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      scoring,
      // No room in this fixture has gift-lock enabled, so this collaborator
      // is never actually invoked — a no-op stand-in keeps the constructor
      // call shape in sync with the real handler.
      { grantAccess: jest.fn().mockResolvedValue(undefined) } as never,
      bus as never,
    );

    let txnSeq = 0;
    const giftCtx = (overrides: { receiverIds: string[]; totalCoinValue?: number }) => ({
      contextType: GiftContextType.VIDEO_ROOM,
      contextId: ROOM,
      senderId: OWNER_ID,
      receiverIds: overrides.receiverIds,
      gift: GIFT,
      quantity: 1,
      transactionId: `gift-txn-${++txnSeq}`,
      batchId: `batch-${txnSeq}`,
      idempotencyKey: `idem-${txnSeq}`,
      totalCoinValue: overrides.totalCoinValue ?? 100,
    });

    const inviteDto = (durationSeconds = 300) => ({
      mode: VideoRoomPkMode.ONE_VS_ONE,
      durationSeconds,
      red: [OWNER_ID],
      blue: [OPPONENT_ID],
    });

    return {
      pk,
      jobs,
      recovery,
      scoring,
      settlement,
      giftHandler,
      giftCtx,
      inviteDto,
      pkRepo,
      invitationRepo,
      rewardRepo,
      wallet,
      cosmetics,
      pkCfg,
      bus,
    };
  }

  /**
   * invite → accept (both sides — `red` names the OWNER as a participant, so
   * they too hold an invitation to accept) → start, leaving the battle in
   * COUNTDOWN.
   */
  async function toCountdown(h: ReturnType<typeof build>, durationSeconds = 300) {
    const battle = await h.pk.invite(OWNER, ROOM, h.inviteDto(durationSeconds) as never);
    // `invite()` excludes the host from its own invitee list (VR-12: the host
    // consents by creating the battle, not by accepting it), so OWNER never
    // has a pending invitation here — only OPPONENT does. OPPONENT's accept
    // is also the LAST outstanding one for a 1v1, so it drives
    // ACCEPTED → COUNTDOWN itself (`VideoRoomPkService.accept`); there is no
    // separate `start()` call left in this flow.
    const started = await h.pk.accept(OPPONENT, ROOM, {} as never);
    return { ...started, id: battle.id! };
  }

  /** invite → accept → start → countdown-job, leaving the battle LIVE. */
  async function toLive(h: ReturnType<typeof build>, durationSeconds = 300) {
    const started = await toCountdown(h, durationSeconds);
    await h.jobs.handleStart({ roomId: ROOM, battleId: started.id!, resumeSeq: 0 });
    return started;
  }

  const tx = {} as never;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs invite → accept → start → countdown → gift → end → reward', async () => {
    const h = build();
    const battle = await h.pk.invite(OWNER, ROOM, h.inviteDto() as never);
    expect(battle.active).toBe(true);
    // Only OPPONENT was invited — OWNER consents by creating the battle, not
    // by accepting it — and that single accept already drives ACCEPTED →
    // COUNTDOWN (`VideoRoomPkService.accept`), so no separate `start()` call.
    await h.pk.accept(OPPONENT, ROOM, {} as never);
    await h.jobs.handleStart({ roomId: ROOM, battleId: battle.id!, resumeSeq: 0 });

    const live = await h.pkRepo.getBattle(battle.id!);
    expect((live as { status: string }).status).toBe('LIVE');

    // Gift flows through the REAL gift-context handler seam.
    const effects = await h.giftHandler.onSend(
      tx,
      h.giftCtx({ receiverIds: [OPPONENT_ID] }) as never,
    );
    await effects.postCommit?.();

    await h.jobs.handleEnd({ roomId: ROOM, battleId: battle.id!, resumeSeq: 0 });

    const completed = await h.pkRepo.getBattle(battle.id!);
    expect((completed as { status: string }).status).toBe('COMPLETED');

    const rewards = await h.rewardRepo.listRewards(battle.id!);
    expect(rewards.length).toBeGreaterThan(0);
    expect(h.wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: WalletTxnReason.PK_REWARD }),
      expect.anything(),
    );
  });

  it('survives a pause/resume without losing time or settling early', async () => {
    const h = build();
    const started = await toLive(h, 300);
    const originalEndsAt = new Date(started.endsAt!).getTime();

    jest.setSystemTime(NOW + 5_000);
    await h.pk.pause(OWNER, ROOM, {} as never);
    const pausedBattle = await h.pkRepo.getBattle(started.id!);
    expect((pausedBattle as { status: string }).status).toBe('PAUSED');
    expect((pausedBattle as { resumeSeq: number }).resumeSeq).toBe(0);

    jest.setSystemTime(NOW + 5_000 + 3_000);
    const resumed = await h.pk.resume(OWNER, ROOM, {} as never);
    expect(resumed.status).toBe('LIVE');
    // Loses no time: endsAt shifts forward by EXACTLY the paused duration.
    expect(new Date(resumed.endsAt!).getTime()).toBe(originalEndsAt + 3_000);

    const resumedBattle = await h.pkRepo.getBattle(started.id!);
    expect((resumedBattle as { resumeSeq: number }).resumeSeq).toBe(1);

    // The end job scheduled BEFORE the pause (stale resumeSeq) must not settle
    // the battle early.
    await h.jobs.handleEnd({ roomId: ROOM, battleId: started.id!, resumeSeq: 0 });
    const stillLive = await h.pkRepo.getBattle(started.id!);
    expect((stillLive as { status: string }).status).toBe('LIVE');
    expect(h.wallet.credit).not.toHaveBeenCalled();
  });

  it('recovers a battle whose end job never ran', async () => {
    const h = build();
    const started = await toLive(h, 5); // countdown 1s + duration 5s ⇒ endsAt = NOW + 6s

    // A gift lands while the battle is LIVE, same as the happy path, so the
    // sweep's settlement has something to pay out.
    const effects = await h.giftHandler.onSend(
      tx,
      h.giftCtx({ receiverIds: [OPPONENT_ID] }) as never,
    );
    await effects.postCommit?.();

    // Advance well past endsAt without ever delivering the end job.
    jest.setSystemTime(NOW + 10_000);
    h.pkCfg.recoveryEnabled = true;

    await h.recovery.tick();

    const recovered = await h.pkRepo.getBattle(started.id!);
    expect((recovered as { status: string }).status).toBe('COMPLETED');
    const rewards = await h.rewardRepo.listRewards(started.id!);
    expect(rewards.length).toBeGreaterThan(0);
    expect(h.wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: WalletTxnReason.PK_REWARD }),
      expect.anything(),
    );
  });

  it('scores nothing for a gift sent during COUNTDOWN', async () => {
    const h = build();
    const started = await toCountdown(h);
    const battle = await h.pkRepo.getBattle(started.id!);
    expect((battle as { status: string }).status).toBe('COUNTDOWN');

    const effects = await h.giftHandler.onSend(
      tx,
      h.giftCtx({ receiverIds: [OPPONENT_ID] }) as never,
    );

    // The gift itself still "succeeds" (never blocks a paid gift)...
    expect(effects.acceptedAmount).toBe(100);
    expect(effects.refundAmount).toBe(0);
    // ...but nothing was scored: no contribution, no team movement.
    expect(await h.pkRepo.countGifts(started.id!)).toBe(0);
    const teams = await h.pkRepo.listTeams(started.id!);
    for (const team of teams as { score: bigint }[]) {
      expect(team.score).toBe(0n);
    }
  });
});
