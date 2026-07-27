import { Injectable } from '@nestjs/common';
import {
  GameCategory,
  GameCode,
  GameCurrency,
  GameDefinition,
  GameLobby,
  GameLobbyStatus,
  GameParticipant,
  GameParticipantStatus,
  GameSession,
  GameSessionStatus,
  GameTeam,
  GameTxnType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class GamesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run a set of writes atomically in one DB transaction — used by settlement
   * so credits + ledger rows + participant payouts + the COMPLETED status flip
   * either all land or none do (no half-settled session a retry can get stuck on).
   */
  runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(tx));
  }

  // ======================= Definitions (catalog) =======================

  listDefinitions(enabledOnly: boolean): Promise<GameDefinition[]> {
    return this.prisma.gameDefinition.findMany({
      where: enabledOnly ? { enabled: true } : undefined,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  getDefinitionByCode(code: GameCode): Promise<GameDefinition | null> {
    return this.prisma.gameDefinition.findUnique({ where: { code } });
  }

  upsertDefinition(data: {
    code: GameCode;
    name: string;
    category: GameCategory;
    currency: GameCurrency;
    minPlayers: number;
    maxPlayers: number;
    minStake: bigint;
    maxStake: bigint;
  }): Promise<GameDefinition> {
    return this.prisma.gameDefinition.upsert({
      where: { code: data.code },
      // Catalog config is admin-owned after seeding — only backfill on create.
      update: {},
      create: data,
    });
  }

  updateDefinition(
    code: GameCode,
    data: Prisma.GameDefinitionUpdateInput,
  ): Promise<GameDefinition> {
    return this.prisma.gameDefinition.update({ where: { code }, data });
  }

  // ======================= Lobbies =======================

  createLobby(data: Prisma.GameLobbyUncheckedCreateInput): Promise<GameLobby> {
    return this.prisma.gameLobby.create({ data });
  }

  getLobbyByCode(code: string): Promise<GameLobby | null> {
    return this.prisma.gameLobby.findUnique({ where: { code } });
  }

  getLobbyById(id: string): Promise<GameLobby | null> {
    return this.prisma.gameLobby.findUnique({ where: { id } });
  }

  listOpenLobbies(skip: number, take: number): Promise<[GameLobby[], number]> {
    // Matchmade lobbies are transient + auto-started; private lobbies are join-by-code —
    // neither is surfaced in the public browse.
    const where: Prisma.GameLobbyWhereInput = {
      status: GameLobbyStatus.OPEN,
      isMatchmade: false,
      isPrivate: false,
    };
    return this.prisma.$transaction([
      this.prisma.gameLobby.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.gameLobby.count({ where }),
    ]);
  }

  addMember(lobbyId: string, userId: string, team?: GameTeam): Promise<{ id: string }> {
    return this.prisma.gameLobbyMember.create({
      data: { lobbyId, userId, team },
      select: { id: true },
    });
  }

  removeMember(lobbyId: string, userId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.gameLobbyMember.deleteMany({ where: { lobbyId, userId } });
  }

  getMember(lobbyId: string, userId: string): Promise<{ id: string } | null> {
    return this.prisma.gameLobbyMember.findUnique({
      where: { lobbyId_userId: { lobbyId, userId } },
      select: { id: true },
    });
  }

  async listMemberIds(lobbyId: string): Promise<string[]> {
    const rows = await this.prisma.gameLobbyMember.findMany({
      where: { lobbyId },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Members with team + bot info (join order) — drives seating, escrow-skip, UI. */
  listMembersWithTeams(lobbyId: string): Promise<
    {
      userId: string;
      team: GameTeam | null;
      isBot: boolean;
      botName: string | null;
      isReady: boolean;
      joinedAt: Date;
    }[]
  > {
    return this.prisma.gameLobbyMember.findMany({
      where: { lobbyId },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true, team: true, isBot: true, botName: true, isReady: true, joinedAt: true },
    });
  }

  updateLobbyHost(lobbyId: string, hostId: string): Promise<GameLobby> {
    return this.prisma.gameLobby.update({
      where: { id: lobbyId },
      data: { hostId, updatedBy: hostId },
    });
  }

  setMemberTeam(lobbyId: string, userId: string, team: GameTeam): Promise<{ id: string }> {
    return this.prisma.gameLobbyMember.update({
      where: { lobbyId_userId: { lobbyId, userId } },
      data: { team },
      select: { id: true },
    });
  }

  setMemberReady(lobbyId: string, userId: string, isReady: boolean): Promise<{ id: string }> {
    return this.prisma.gameLobbyMember.update({
      where: { lobbyId_userId: { lobbyId, userId } },
      data: { isReady },
      select: { id: true },
    });
  }

  addBotMember(
    lobbyId: string,
    botUserId: string,
    botName: string,
    team?: GameTeam,
  ): Promise<{ id: string }> {
    return this.prisma.gameLobbyMember.create({
      data: { lobbyId, userId: botUserId, isBot: true, botName, team },
      select: { id: true },
    });
  }

  countMembers(lobbyId: string): Promise<number> {
    return this.prisma.gameLobbyMember.count({ where: { lobbyId } });
  }

  updateLobby(id: string, data: Prisma.GameLobbyUncheckedUpdateInput): Promise<GameLobby> {
    return this.prisma.gameLobby.update({ where: { id }, data });
  }

  markLobbyStarted(id: string, sessionId: string, actorId: string): Promise<GameLobby> {
    return this.prisma.gameLobby.update({
      where: { id },
      data: {
        status: GameLobbyStatus.STARTED,
        sessionId,
        startedAt: new Date(),
        updatedBy: actorId,
      },
    });
  }

  markLobbyClosed(id: string, status: GameLobbyStatus, actorId: string | null): Promise<GameLobby> {
    return this.prisma.gameLobby.update({
      where: { id },
      data: { status, cancelledAt: new Date(), updatedBy: actorId },
    });
  }

  findExpiredLobbies(now: Date): Promise<GameLobby[]> {
    return this.prisma.gameLobby.findMany({
      where: { status: GameLobbyStatus.OPEN, expiresAt: { lte: now } },
      take: 100,
    });
  }

  // ======================= Sessions & participants =======================

  createSession(data: Prisma.GameSessionUncheckedCreateInput): Promise<GameSession> {
    return this.prisma.gameSession.create({ data });
  }

  createParticipants(
    rows: Prisma.GameParticipantUncheckedCreateInput[],
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.gameParticipant.createMany({ data: rows });
  }

  getSession(id: string): Promise<GameSession | null> {
    return this.prisma.gameSession.findUnique({ where: { id } });
  }

  listParticipants(sessionId: string): Promise<GameParticipant[]> {
    // Seat order is authoritative (deterministic turn order; TEAM_2V2 positions).
    return this.prisma.gameParticipant.findMany({
      where: { sessionId },
      orderBy: { seat: 'asc' },
    });
  }

  getParticipant(sessionId: string, userId: string): Promise<GameParticipant | null> {
    return this.prisma.gameParticipant.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
  }

  updateParticipant(
    id: string,
    data: Prisma.GameParticipantUncheckedUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<GameParticipant> {
    return (tx ?? this.prisma).gameParticipant.update({ where: { id }, data });
  }

  setSessionPot(id: string, potAmount: bigint): Promise<GameSession> {
    return this.prisma.gameSession.update({ where: { id }, data: { potAmount } });
  }

  completeSession(
    id: string,
    actorId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<GameSession> {
    return (tx ?? this.prisma).gameSession.update({
      where: { id },
      data: {
        status: GameSessionStatus.COMPLETED,
        completedAt: new Date(),
        settledAt: new Date(),
        updatedBy: actorId,
      },
    });
  }

  closeSession(
    id: string,
    status: GameSessionStatus,
    actorId: string | null,
  ): Promise<GameSession> {
    return this.prisma.gameSession.update({
      where: { id },
      data: { status, cancelledAt: new Date(), updatedBy: actorId },
    });
  }

  listSessions(
    where: Prisma.GameSessionWhereInput,
    skip: number,
    take: number,
  ): Promise<[GameSession[], number]> {
    return this.prisma.$transaction([
      this.prisma.gameSession.findMany({ where, orderBy: { startedAt: 'desc' }, skip, take }),
      this.prisma.gameSession.count({ where }),
    ]);
  }

  /** List all currently ACTIVE sessions for monitoring/sweeping. */
  async listActiveSessions(): Promise<GameSession[]> {
    return this.prisma.gameSession.findMany({
      where: { status: GameSessionStatus.ACTIVE },
    });
  }

  /** List active sessions started before cutoff timestamp for stale cleanup. */
  async findStaleActiveSessions(cutoff: Date): Promise<GameSession[]> {
    return this.prisma.gameSession.findMany({
      where: {
        status: GameSessionStatus.ACTIVE,
        startedAt: { lt: cutoff },
      },
    });
  }

  /** Abort a stale active session and mark playing participants refunded. */
  async abortStaleSession(sessionId: string, now: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.gameSession.update({
        where: { id: sessionId },
        data: { status: GameSessionStatus.ABORTED, cancelledAt: now },
      }),
      this.prisma.gameParticipant.updateMany({
        where: { sessionId, status: GameParticipantStatus.PLAYING },
        data: { status: GameParticipantStatus.REFUNDED, settledAt: now },
      }),
    ]);
  }

  /** The active session a user is currently a PLAYING participant of, if any. */
  async findActiveSessionForParticipant(userId: string): Promise<string | null> {
    const parts = await this.prisma.gameParticipant.findMany({
      where: { userId, status: GameParticipantStatus.PLAYING },
      select: { sessionId: true },
    });
    if (parts.length === 0) return null;
    const session = await this.prisma.gameSession.findFirst({
      where: { id: { in: parts.map((p) => p.sessionId) }, status: GameSessionStatus.ACTIVE },
      select: { id: true },
    });
    return session?.id ?? null;
  }

  /**
   * The still-open (OPEN/STARTED) lobby a user is currently a member of, if
   * any — the pre-match counterpart of [findActiveSessionForParticipant], for
   * resume-on-launch: a player who backgrounded the app while still in the
   * waiting room (never actually started) has no session to find, only a
   * lobby. STARTED is included because there's a brief window between the
   * host starting the match and the session row existing where the lobby is
   * already STARTED but `sessionId` may not be set yet.
   */
  async findActiveLobbyForParticipant(userId: string): Promise<string | null> {
    const memberships = await this.prisma.gameLobbyMember.findMany({
      where: { userId, isBot: false },
      orderBy: { joinedAt: 'desc' },
      select: { lobbyId: true },
      take: 10,
    });
    if (!memberships.length) return null;
    const lobbyIds = memberships.map((m) => m.lobbyId);
    const lobby = await this.prisma.gameLobby.findFirst({
      where: {
        id: { in: lobbyIds },
        status: GameLobbyStatus.OPEN,
      },
      select: { code: true },
    });
    return lobby?.code ?? null;
  }

  /**
   * The most recently settled session this user played that they have NOT
   * yet acknowledged (`resultSeenAt IS NULL`) — resume-on-launch's "you
   * missed the result" case. Only COMPLETED sessions carry a result worth
   * showing; CANCELLED/ABORTED ones resolve via a refund, not a result
   * screen, so they're excluded here (the client's CANCELLED branch just
   * routes Home, per spec — nothing to fetch).
   *
   * `GameParticipant`/`GameSession` are linked by a plain `sessionId` column
   * (no Prisma relation declared between the two models), so this is a
   * two-step lookup rather than a single nested-relation query.
   */
  async findUnseenCompletedSessionForParticipant(userId: string): Promise<string | null> {
    const unseen = await this.prisma.gameParticipant.findMany({
      where: { userId, resultSeenAt: null },
      orderBy: { settledAt: 'desc' },
      select: { sessionId: true, settledAt: true },
    });
    if (unseen.length === 0) return null;
    const session = await this.prisma.gameSession.findFirst({
      where: {
        id: { in: unseen.map((p) => p.sessionId) },
        status: GameSessionStatus.COMPLETED,
      },
      orderBy: { settledAt: 'desc' },
      select: { id: true },
    });
    return session?.id ?? null;
  }

  /** Marks [userId]'s result for [sessionId] as acknowledged (idempotent). */
  async markResultSeen(sessionId: string, userId: string): Promise<void> {
    await this.prisma.gameParticipant.updateMany({
      where: { sessionId, userId },
      data: { resultSeenAt: new Date() },
    });
  }

  /** Session ids a user has taken part in (optionally filtered to one game). */
  async listUserSessionIds(userId: string, definitionId?: string): Promise<string[]> {
    const rows = await this.prisma.gameParticipant.findMany({
      where: { userId, ...(definitionId ? { definitionId } : {}) },
      select: { sessionId: true },
    });
    return [...new Set(rows.map((r) => r.sessionId))];
  }

  // ======================= Ledger / results / audit =======================

  createTransaction(
    data: {
      sessionId: string;
      participantId?: string | null;
      userId: string;
      type: GameTxnType;
      currency: GameCurrency;
      amount: bigint;
      walletTxnId?: string | null;
      idempotencyKey: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    return (tx ?? this.prisma).gameTransaction.create({ data, select: { id: true } });
  }

  createMatchResult(
    data: {
      sessionId: string;
      definitionId: string;
      code: GameCode;
      potAmount: bigint;
      payoutTotal: bigint;
      rakeAmount: bigint;
      winners: string[];
      resultData: Record<string, unknown>;
      settledBy?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    return (tx ?? this.prisma).gameMatchResult.create({
      data: { ...data, resultData: data.resultData as Prisma.InputJsonValue },
      select: { id: true },
    });
  }

  getMatchResult(sessionId: string): Promise<{ id: string } | null> {
    return this.prisma.gameMatchResult.findUnique({
      where: { sessionId },
      select: { id: true },
    });
  }

  logEvent(data: {
    sessionId?: string | null;
    lobbyId?: string | null;
    userId?: string | null;
    action: string;
    detail?: Prisma.InputJsonValue;
  }): Promise<{ id: string }> {
    return this.prisma.gameEventLog.create({ data, select: { id: true } });
  }

  // Re-export enums used by the service for status transitions.
  static readonly ParticipantStatus = GameParticipantStatus;
}
