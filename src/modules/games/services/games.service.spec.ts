import {
  GameCategory,
  GameCode,
  GameCurrency,
  GameLobbyStatus,
  GameMode,
  GameParticipantStatus,
  GameSessionStatus,
  GameTeam,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { sha256 } from 'src/modules/auth/services/hash.util';
import {
  GAME_MATCH_READY_INDEX_KEY,
  GAME_MAX_CONSECUTIVE_TURN_TIMEOUTS,
  GAME_TURN_RESYNC_GRACE_MS,
  GAME_TURN_SECONDS,
  GAME_TURN_STALL_GRACE_MS,
  GAME_LIVE_STATE_TTL_SECONDS,
  gameDisconnectKey,
  gameLiveStateKey,
  gameMatchQueueKey,
  gameMatchReadyKey,
  gameMatchReadyUserKey,
  gameMatchUserKey,
  gameTurnResyncPendingKey,
} from '../constants/games.constants';
import type { GameLiveState } from './game-live-state';
import { IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';

import { LockService } from 'src/infra/redis/lock.service';
import { QueueService } from 'src/infra/queue/queue.service';
import type { IProfileService } from 'src/modules/users/interfaces/profile.interface';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesRepository } from '../repositories/games.repository';
import type { AudioRoomGameAuthzService } from './audio-room-game-authz.service';
import { GamesService } from './games.service';

// Sentinel "transaction client" the mocked repo.runInTransaction hands to the
// callback — must be non-null so `expect.anything()` matches it in assertions.
const FAKE_TX = { __fakeTx: true };

const HOST = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';
const P3 = '44444444-4444-4444-4444-444444444444';
const ACTOR: GameActor = { id: HOST, roles: ['USER'] };
const ADMIN: GameActor = { id: 'admin-1', roles: ['ADMIN'] };

function def(overrides: Record<string, unknown> = {}) {
  return {
    id: 'def-1',
    code: GameCode.GREEDY,
    name: 'Greedy',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 2,
    maxPlayers: 8,
    minStake: 100n,
    maxStake: 1_000_000n,
    houseRakeBps: 0,
    enabled: true,
    config: null,
    ...overrides,
  };
}

function lobby(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lobby-1',
    definitionId: 'def-1',
    code: 'ABCDEF',
    hostId: HOST,
    roomId: null,
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    stake: 100n,
    maxPlayers: 8,
    status: GameLobbyStatus.OPEN,
    sessionId: null,
    expiresAt: new Date(Date.now() + 60000),
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    definitionId: 'def-1',
    code: GameCode.GREEDY,
    lobbyId: 'lobby-1',
    joinCode: 'ABCDEF',
    hostId: HOST,
    roomId: null,
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    stake: 100n,
    playerCount: 2,
    potAmount: 200n,
    status: GameSessionStatus.ACTIVE,
    startedAt: new Date(),
    settledAt: null,
    ...overrides,
  };
}

function participant(id: string, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 'sess-1',
    definitionId: 'def-1',
    userId,
    stake: 100n,
    stakeTxnId: null,
    status: GameParticipantStatus.PLAYING,
    payoutAmount: 0n,
    payoutTxnId: null,
    refundTxnId: null,
    isWinner: false,
    joinedAt: new Date(),
    settledAt: null,
    ...overrides,
  };
}

describe('GamesService', () => {
  let repo: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock; acquire: jest.Mock };
  let cache: Record<string, jest.Mock>;
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let wallet: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let profiles: Record<string, jest.Mock>;
  let authz: Record<string, jest.Mock>;
  let service: GamesService;

  beforeEach(() => {
    repo = {
      listDefinitions: jest.fn().mockResolvedValue([def()]),
      getDefinitionByCode: jest.fn().mockResolvedValue(def()),
      updateDefinition: jest.fn().mockResolvedValue(def()),
      createLobby: jest.fn().mockResolvedValue(lobby()),
      getLobbyByCode: jest.fn().mockResolvedValue(null),
      getLobbyById: jest.fn().mockResolvedValue(lobby()),
      addMember: jest.fn().mockResolvedValue({ id: 'm1' }),
      removeMember: jest.fn().mockResolvedValue({ count: 1 }),
      getMember: jest.fn().mockResolvedValue(null),
      countMembers: jest.fn().mockResolvedValue(1),
      listMemberIds: jest.fn().mockResolvedValue([HOST, P2]),
      markLobbyStarted: jest.fn().mockResolvedValue(lobby({ status: GameLobbyStatus.STARTED })),
      markLobbyClosed: jest.fn().mockResolvedValue(lobby()),
      findExpiredLobbies: jest.fn().mockResolvedValue([]),
      createSession: jest.fn().mockResolvedValue(session({ potAmount: 0n })),
      createParticipants: jest.fn().mockResolvedValue({ count: 2 }),
      getSession: jest.fn().mockResolvedValue(session()),
      listParticipants: jest
        .fn()
        .mockResolvedValue([participant('p1', HOST), participant('p2', P2)]),
      getParticipant: jest.fn().mockResolvedValue(participant('p1', HOST)),
      updateParticipant: jest.fn().mockResolvedValue(participant('p1', HOST)),
      setSessionPot: jest.fn().mockResolvedValue(session()),
      completeSession: jest.fn().mockResolvedValue(session()),
      closeSession: jest.fn().mockResolvedValue(session()),
      listSessions: jest.fn().mockResolvedValue([[], 0]),
      listUserSessionIds: jest.fn().mockResolvedValue([]),
      getMatchResult: jest.fn().mockResolvedValue(null),
      createMatchResult: jest.fn().mockResolvedValue({ id: 'r1' }),
      createTransaction: jest.fn().mockResolvedValue({ id: 't1' }),
      logEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      listMembersWithTeams: jest.fn().mockResolvedValue([]),
      setMemberTeam: jest.fn().mockResolvedValue({ id: 'm1' }),
      findActiveSessionForParticipant: jest.fn().mockResolvedValue(null),
      listActiveSessions: jest.fn().mockResolvedValue([]),
      findActiveLobbyForParticipant: jest.fn().mockResolvedValue(null),
      findUnseenCompletedSessionForParticipant: jest.fn().mockResolvedValue(null),
      markResultSeen: jest.fn().mockResolvedValue(undefined),
      updateLobby: jest.fn().mockResolvedValue(lobby()),
      addBotMember: jest.fn().mockResolvedValue({ id: 'bm1' }),
      // Audio-room integration: no room-bound lobby/session by default — the
      // overwhelming majority of tests never set dto.roomId, so these mocks
      // simply never gate anything unless a test explicitly overrides them.
      findActiveSessionForRoom: jest.fn().mockResolvedValue(null),
      findOpenLobbyForRoom: jest.fn().mockResolvedValue(null),
      updateSessionHost: jest.fn().mockResolvedValue(session()),
      updateLobbyHost: jest.fn().mockResolvedValue(lobby()),
      // Settlement runs its writes inside one DB transaction — the mock just
      // invokes the callback with a non-null sentinel "tx" (real atomicity/
      // rollback is a Prisma guarantee, not something a unit test can observe).
      runInTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(FAKE_TX)),
    };
    locks = {
      withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()),
      acquire: jest.fn().mockResolvedValue(async () => undefined),
    };
    // Map-backed JSON store so get/set/del behave like real Redis (dedup-then-read
    // in the matchmaking flow depends on it); sorted-set + set ops stay assertable.
    const store = new Map<string, unknown>();
    cache = {
      addScore: jest.fn().mockResolvedValue(1),
      top: jest.fn().mockResolvedValue([]),
      get: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k) : null)),
      set: jest.fn((k: string, v: unknown) => {
        store.set(k, v);
        return Promise.resolve(undefined);
      }),
      del: jest.fn((...keys: string[]) => {
        keys.forEach((k) => store.delete(k));
        return Promise.resolve(keys.length);
      }),
      exists: jest.fn((k: string) => Promise.resolve(store.has(k))),
      increment: jest.fn().mockResolvedValue(1), // rate-limit counter (under the limit)
      setScore: jest.fn().mockResolvedValue(undefined),
      sortedCount: jest.fn().mockResolvedValue(0),
      sortedRank: jest.fn().mockResolvedValue(null),
      sortedLowest: jest.fn().mockResolvedValue([]),
      sortedRemove: jest.fn().mockResolvedValue(1),
      sortedRangeByScore: jest.fn().mockResolvedValue([]),
      sortedRemoveByScore: jest.fn().mockResolvedValue(0),
      setAdd: jest.fn().mockResolvedValue(1),
      setMembers: jest.fn().mockResolvedValue([]),
      setRemove: jest.fn().mockResolvedValue(1),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    wallet = {
      getBalance: jest.fn().mockResolvedValue({ gold: 1_000_000, free: 1_000_000, earnings: 0 }),
      debit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'wtx', balanceAfter: 0, duplicate: false }),
      credit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'wtx-c', balanceAfter: 0, duplicate: false }),
    };
    users = { findById: jest.fn().mockResolvedValue({ id: HOST, username: 'host' }) };
    // Default: no identities resolved (empty map) — views degrade to null
    // displayName/avatar for tests that don't care about player identity.
    profiles = { resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()) };
    // Default: authorized + a member — tests exercising the room-gated
    // branches (dto.roomId set) override these per-case.
    authz = {
      assertCanStartBoardGame: jest.fn().mockResolvedValue(undefined),
      assertCanStartCasinoWindow: jest.fn().mockResolvedValue(undefined),
      assertCanWatch: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(true),
    };
    const prismaMock = {
      gameParticipant: { findMany: jest.fn().mockResolvedValue([]) },
      casinoBet: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    service = new GamesService(
      repo as unknown as GamesRepository,
      prismaMock as unknown as PrismaService,
      locks as unknown as LockService,
      cache as unknown as CacheService,
      queue as unknown as QueueService,
      bus,
      wallet as unknown as IWalletService,
      users as unknown as IUsersService,
      profiles as unknown as IProfileService,
      authz as unknown as AudioRoomGameAuthzService,
    );
  });

  describe('createLobby', () => {
    it('creates a lobby, adds the host, and broadcasts', async () => {
      await service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500 });
      expect(repo.createLobby).toHaveBeenCalled();
      expect(repo.addMember).toHaveBeenCalledWith('lobby-1', HOST, undefined);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_created' }),
      );
    });

    it('rejects a disabled game', async () => {
      repo.getDefinitionByCode.mockResolvedValue(def({ enabled: false }));
      await expect(
        service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500 }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_DISABLED });
    });

    it('rejects a stake outside the configured range', async () => {
      await expect(
        service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 5 }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_INVALID_STAKE });
    });

    it('rejects an unknown game', async () => {
      repo.getDefinitionByCode.mockResolvedValue(null);
      await expect(
        service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500 }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_FOUND });
    });
  });

  describe('joinLobby', () => {
    beforeEach(() => repo.getLobbyByCode.mockResolvedValue(lobby()));

    it('adds a member and broadcasts', async () => {
      const other: GameActor = { id: P2, roles: ['USER'] };
      await service.joinLobby(other, 'ABCDEF');
      expect(repo.addMember).toHaveBeenCalledWith('lobby-1', P2, undefined);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_joined' }),
      );
    });

    it('rejects a user already in the lobby', async () => {
      repo.getMember.mockResolvedValue({ id: 'm1' });
      await expect(service.joinLobby(ACTOR, 'ABCDEF')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_ALREADY_IN_LOBBY,
      });
    });

    it('rejects when the lobby is full', async () => {
      repo.getLobbyById.mockResolvedValue(lobby({ maxPlayers: 1 }));
      repo.countMembers.mockResolvedValue(1);
      await expect(service.joinLobby({ id: P2, roles: ['USER'] }, 'ABCDEF')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_LOBBY_FULL,
      });
    });

    it('rejects when the player cannot afford the stake', async () => {
      wallet.getBalance.mockResolvedValue({ gold: 10, free: 10, earnings: 0 });
      await expect(service.joinLobby({ id: P2, roles: ['USER'] }, 'ABCDEF')).rejects.toMatchObject({
        errorCode: ERROR_CODES.INSUFFICIENT_BALANCE,
      });
    });
  });

  describe('startLobby', () => {
    beforeEach(() => repo.getLobbyByCode.mockResolvedValue(lobby()));

    it('escrows each stake, fixes the pot, and broadcasts', async () => {
      await service.startLobby(ACTOR, 'ABCDEF');
      expect(wallet.debit).toHaveBeenCalledTimes(2);
      expect(repo.setSessionPot).toHaveBeenCalledWith('sess-1', 200n);
      expect(repo.markLobbyStarted).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.started' }));
    });

    it('rejects a non-host starter', async () => {
      await expect(service.startLobby({ id: P2, roles: ['USER'] }, 'ABCDEF')).rejects.toMatchObject(
        {
          errorCode: ERROR_CODES.GAME_NOT_HOST,
        },
      );
    });

    it('rejects when below the minimum player count', async () => {
      repo.listMemberIds.mockResolvedValue([HOST]);
      await expect(service.startLobby(ACTOR, 'ABCDEF')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_INSUFFICIENT_PLAYERS,
      });
    });

    it('refunds and aborts if a stake debit fails (insufficient funds)', async () => {
      wallet.debit
        .mockResolvedValueOnce({ transactionId: 'wtx', balanceAfter: 0, duplicate: false })
        .mockRejectedValueOnce(new BusinessException(ERROR_CODES.INSUFFICIENT_BALANCE, 'no funds'));
      await expect(service.startLobby(ACTOR, 'ABCDEF')).rejects.toBeInstanceOf(BusinessException);
      expect(wallet.credit).toHaveBeenCalledTimes(1); // refund the one already escrowed
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 100, reason: 'GAME_REFUND' }),
      );
      expect(repo.closeSession).toHaveBeenCalledWith('sess-1', GameSessionStatus.ABORTED, HOST);
    });
  });

  describe('audio-room integration', () => {
    describe('createLobby with roomId', () => {
      it('checks host authority for the room before creating', async () => {
        await service.createLobby(ACTOR, {
          gameCode: GameCode.GREEDY,
          stake: 500,
          roomId: 'room-1',
        });
        expect(authz.assertCanStartBoardGame).toHaveBeenCalledWith('room-1', HOST);
        expect(repo.createLobby).toHaveBeenCalled();
      });

      it('propagates a host-authority rejection without creating a lobby', async () => {
        authz.assertCanStartBoardGame.mockRejectedValue(
          new BusinessException(ERROR_CODES.GAME_NOT_AUTHORIZED, 'no'),
        );
        await expect(
          service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500, roomId: 'room-1' }),
        ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED });
        expect(repo.createLobby).not.toHaveBeenCalled();
      });

      it('rejects when the room already has an active game', async () => {
        repo.findActiveSessionForRoom.mockResolvedValue(session({ roomId: 'room-1' }));
        await expect(
          service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500, roomId: 'room-1' }),
        ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_ROOM_ALREADY_ACTIVE });
        expect(repo.createLobby).not.toHaveBeenCalled();
      });

      it('skips every room check when roomId is absent (unchanged default path)', async () => {
        await service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500 });
        expect(authz.assertCanStartBoardGame).not.toHaveBeenCalled();
        expect(repo.findActiveSessionForRoom).not.toHaveBeenCalled();
      });
    });

    describe('joining a room-bound lobby', () => {
      beforeEach(() => {
        repo.getLobbyByCode.mockResolvedValue(lobby({ roomId: 'room-1' }));
        repo.getLobbyById.mockResolvedValue(lobby({ roomId: 'room-1' }));
      });

      const OTHER_ROOM_MEMBER: GameActor = { id: STRANGER, roles: ['USER'] };

      it('lets a current room member join a room-bound lobby by code', async () => {
        authz.isMember.mockResolvedValue(true);
        repo.getMember.mockResolvedValue(null);
        repo.countMembers.mockResolvedValue(0);
        await expect(service.joinLobby(OTHER_ROOM_MEMBER, 'ABCDEF')).resolves.toBeDefined();
        expect(authz.isMember).toHaveBeenCalledWith('room-1', STRANGER);
        expect(repo.addMember).toHaveBeenCalled();
      });

      it('rejects a non-member who obtains the join code', async () => {
        authz.isMember.mockResolvedValue(false);
        await expect(service.joinLobby(OTHER_ROOM_MEMBER, 'ABCDEF')).rejects.toMatchObject({
          errorCode: ERROR_CODES.NOT_ROOM_MEMBER,
        });
        expect(repo.addMember).not.toHaveBeenCalled();
      });

      it('rejects a non-member even with the correct password', async () => {
        repo.getLobbyById.mockResolvedValue(
          lobby({ roomId: 'room-1', passwordHash: sha256('hunter2') }),
        );
        authz.isMember.mockResolvedValue(false);
        await expect(
          service.joinLobby(OTHER_ROOM_MEMBER, 'ABCDEF', 'hunter2'),
        ).rejects.toMatchObject({
          errorCode: ERROR_CODES.NOT_ROOM_MEMBER,
        });
        expect(repo.addMember).not.toHaveBeenCalled();
      });

      it('does not consult room membership for a lobby with no roomId (unchanged default path)', async () => {
        repo.getLobbyByCode.mockResolvedValue(lobby());
        repo.getLobbyById.mockResolvedValue(lobby());
        repo.getMember.mockResolvedValue(null);
        repo.countMembers.mockResolvedValue(0);
        await expect(service.joinLobby(OTHER_ROOM_MEMBER, 'ABCDEF')).resolves.toBeDefined();
        expect(authz.isMember).not.toHaveBeenCalled();
      });
    });

    describe('starting a room-bound lobby', () => {
      beforeEach(() => {
        repo.getLobbyByCode.mockResolvedValue(lobby({ roomId: 'room-1' }));
        repo.getLobbyById.mockResolvedValue(lobby({ roomId: 'room-1' }));
      });

      it('re-checks host authority and the active-session guard under the room lock, then starts', async () => {
        await service.startLobby(ACTOR, 'ABCDEF');
        expect(authz.assertCanStartBoardGame).toHaveBeenCalledWith('room-1', HOST);
        expect(repo.findActiveSessionForRoom).toHaveBeenCalledWith('room-1');
        expect(repo.createSession).toHaveBeenCalled();
      });

      it('rejects if another active game already claimed the room between create and start', async () => {
        repo.findActiveSessionForRoom.mockResolvedValue(session({ roomId: 'room-1' }));
        await expect(service.startLobby(ACTOR, 'ABCDEF')).rejects.toMatchObject({
          errorCode: ERROR_CODES.GAME_ROOM_ALREADY_ACTIVE,
        });
        expect(repo.createSession).not.toHaveBeenCalled();
      });

      it('does not touch the room lock for a lobby with no roomId', async () => {
        repo.getLobbyByCode.mockResolvedValue(lobby());
        repo.getLobbyById.mockResolvedValue(lobby());
        await service.startLobby(ACTOR, 'ABCDEF');
        expect(authz.assertCanStartBoardGame).not.toHaveBeenCalled();
        expect(repo.findActiveSessionForRoom).not.toHaveBeenCalled();
      });
    });

    describe('getSession spectator access', () => {
      it('lets a current room member view a room-bound session they did not join', async () => {
        repo.getSession.mockResolvedValue(session({ roomId: 'room-1' }));
        repo.getParticipant.mockResolvedValue(null);
        authz.isMember.mockResolvedValue(true);
        const spectator: GameActor = { id: STRANGER, roles: ['USER'] };
        await expect(service.getSession(spectator, 'sess-1')).resolves.toBeDefined();
        expect(authz.isMember).toHaveBeenCalledWith('room-1', STRANGER);
      });

      it('rejects a non-member, non-participant for a room-bound session', async () => {
        repo.getSession.mockResolvedValue(session({ roomId: 'room-1' }));
        repo.getParticipant.mockResolvedValue(null);
        authz.isMember.mockResolvedValue(false);
        const stranger: GameActor = { id: STRANGER, roles: ['USER'] };
        await expect(service.getSession(stranger, 'sess-1')).rejects.toMatchObject({
          errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
        });
      });

      it('rejects a non-participant for a session with no roomId (unchanged default behavior)', async () => {
        repo.getSession.mockResolvedValue(session());
        repo.getParticipant.mockResolvedValue(null);
        const stranger: GameActor = { id: STRANGER, roles: ['USER'] };
        await expect(service.getSession(stranger, 'sess-1')).rejects.toMatchObject({
          errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
        });
        expect(authz.isMember).not.toHaveBeenCalled();
      });
    });
  });

  describe('cancelSession', () => {
    it('refunds staked participants and broadcasts', async () => {
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { stakeTxnId: 'wtx' }),
        participant('p2', P2, { stakeTxnId: 'wtx' }),
      ]);
      const res = await service.cancelSession(ACTOR, 'sess-1');
      expect(res.refunded).toEqual([HOST, P2]);
      expect(wallet.credit).toHaveBeenCalledTimes(2);
      expect(repo.closeSession).toHaveBeenCalledWith('sess-1', GameSessionStatus.CANCELLED, HOST);
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.cancelled' }));
    });

    it('rejects a caller who is neither host nor admin', async () => {
      await expect(
        service.cancelSession({ id: STRANGER, roles: ['USER'] }, 'sess-1'),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED });
    });
  });

  describe('settleResult', () => {
    it('validates, pays out winners, records the result and ranks winners', async () => {
      await service.settleResult({
        sessionId: 'sess-1',
        winners: [HOST],
        payouts: [{ userId: HOST, amount: 150 }],
        settledBy: ADMIN.id,
      });
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 150, reason: 'GAME_PAYOUT' }),
        FAKE_TX,
      );
      expect(repo.createMatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ payoutTotal: 150n, rakeAmount: 50n, winners: [HOST] }),
        FAKE_TX,
      );
      expect(repo.completeSession).toHaveBeenCalledWith('sess-1', ADMIN.id, FAKE_TX);
      expect(cache.addScore).toHaveBeenCalledWith('game:wins', HOST, 1);
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.settled' }));
    });

    it('rejects payouts that exceed the pot', async () => {
      await expect(
        service.settleResult({
          sessionId: 'sess-1',
          winners: [HOST],
          payouts: [{ userId: HOST, amount: 300 }],
        }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_PAYOUT_EXCEEDS_POT });
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('rejects a winner who is not a participant', async () => {
      await expect(
        service.settleResult({ sessionId: 'sess-1', winners: [STRANGER], payouts: [] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_INVALID_PARTICIPANT });
    });

    it('rejects settling an already-settled session', async () => {
      repo.getMatchResult.mockResolvedValue({ id: 'r1' });
      await expect(
        service.settleResult({ sessionId: 'sess-1', winners: [HOST], payouts: [] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_ALREADY_SETTLED });
    });

    it('rejects settling a non-active session', async () => {
      repo.getSession.mockResolvedValue(session({ status: GameSessionStatus.COMPLETED }));
      await expect(
        service.settleResult({ sessionId: 'sess-1', winners: [HOST], payouts: [] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_SESSION_NOT_ACTIVE });
    });

    it('a second settle attempt on an already-settled session pays out nothing extra (idempotent)', async () => {
      await service.settleResult({
        sessionId: 'sess-1',
        winners: [HOST],
        payouts: [{ userId: HOST, amount: 150 }],
        settledBy: ADMIN.id,
      });
      expect(wallet.credit).toHaveBeenCalledTimes(1);

      // The trusted seam (or a game engine retrying after a timeout) tries again —
      // the exactly-once guard must reject it without a second payout.
      repo.getMatchResult.mockResolvedValue({ id: 'r1' });
      await expect(
        service.settleResult({
          sessionId: 'sess-1',
          winners: [HOST],
          payouts: [{ userId: HOST, amount: 150 }],
          settledBy: ADMIN.id,
        }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_ALREADY_SETTLED });
      expect(wallet.credit).toHaveBeenCalledTimes(1); // unchanged — no double payout
      expect(repo.completeSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('economy hardening', () => {
    it('friendly (stake 0) match: create, play and settle with zero wallet movement and no winnings-leaderboard entry', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ stake: 0n }));
      repo.getLobbyById.mockResolvedValue(lobby({ stake: 0n }));
      repo.createSession.mockResolvedValue(session({ stake: 0n, potAmount: 0n }));
      repo.getSession.mockResolvedValue(session({ stake: 0n, potAmount: 0n }));
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { stake: 0n }),
        participant('p2', P2, { stake: 0n }),
      ]);

      await service.startLobby(ACTOR, 'ABCDEF');
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(repo.setSessionPot).toHaveBeenCalledWith('sess-1', 0n);

      await service.settleResult({
        sessionId: 'sess-1',
        winners: [HOST],
        payouts: [{ userId: HOST, amount: 0 }],
      });
      expect(wallet.credit).not.toHaveBeenCalled();
      // Win-count leaderboard still records the win; the winnings leaderboard
      // (amount > 0 only) must not get an entry for a zero-amount payout.
      expect(cache.addScore).toHaveBeenCalledWith('game:wins', HOST, 1);
      expect(cache.addScore).toHaveBeenCalledTimes(1);
    });

    it('classic: the sole winner takes the whole pot; every other participant is settled at zero', async () => {
      repo.getSession.mockResolvedValue(session({ potAmount: 400n, playerCount: 4 }));
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST),
        participant('p2', P2),
        participant('p3', STRANGER),
        participant('p4', P3),
      ]);

      await service.settleResult({
        sessionId: 'sess-1',
        winners: [HOST],
        payouts: [{ userId: HOST, amount: 400 }],
      });

      expect(wallet.credit).toHaveBeenCalledTimes(1);
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 400, reason: 'GAME_PAYOUT' }),
        FAKE_TX,
      );
      expect(repo.updateParticipant).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          status: GameParticipantStatus.WON,
          isWinner: true,
          payoutAmount: 400n,
        }),
        FAKE_TX,
      );
      for (const id of ['p2', 'p3', 'p4']) {
        expect(repo.updateParticipant).toHaveBeenCalledWith(
          id,
          expect.objectContaining({
            status: GameParticipantStatus.LOST,
            isWinner: false,
            payoutAmount: 0n,
          }),
          FAKE_TX,
        );
      }
    });
  });

  describe('relayMove', () => {
    it('relays a participant move, persists live state, and publishes game.move', async () => {
      const res = (await service.relayMove(ACTOR, 'sess-1', {
        action: 'roll_dice',
        value: 6,
        seat: 0,
      })) as Record<string, unknown>;
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.move' }));
      expect(cache.set).toHaveBeenCalled();
      expect(res).toMatchObject({ accepted: true });
    });

    it('rejects a mover who is not a participant of the session', async () => {
      repo.getParticipant.mockResolvedValue(null);
      await expect(
        service.relayMove({ id: STRANGER, roles: ['USER'] }, 'sess-1', { action: 'roll_dice' }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_PARTICIPANT });
    });

    it('rejects a move on a non-active session', async () => {
      repo.getSession.mockResolvedValue(session({ status: GameSessionStatus.COMPLETED }));
      await expect(
        service.relayMove(ACTOR, 'sess-1', { action: 'roll_dice' }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_SESSION_NOT_ACTIVE });
    });
  });

  describe('reportMatchResult', () => {
    const OTHER: GameActor = { id: P2, roles: ['USER'] };

    it('holds the result pending confirmation instead of settling immediately', async () => {
      const res = (await service.reportMatchResult(ACTOR, 'sess-1', {
        winners: [HOST],
      })) as Record<string, unknown>;
      expect(res).toMatchObject({ status: 'pending_confirmation', winners: [HOST] });
      expect(wallet.credit).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.result_reported' }),
      );
    });

    it('settles once a different participant confirms the reported result', async () => {
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] });
      await service.confirmMatchResult(OTHER, 'sess-1');
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 200, reason: 'GAME_PAYOUT' }),
        FAKE_TX,
      );
      expect(repo.createMatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ payoutTotal: 200n, rakeAmount: 0n, winners: [HOST] }),
        FAKE_TX,
      );
    });

    it('rejects the host confirming their own reported result', async () => {
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] });
      await expect(service.confirmMatchResult(ACTOR, 'sess-1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
      });
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('withholds settlement when a different participant disputes the result', async () => {
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] });
      const res = await service.disputeMatchResult(OTHER, 'sess-1');
      expect(res).toEqual({ disputed: true });
      expect(wallet.credit).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.result_disputed' }),
      );
    });

    it('rejects reporting again while a result is already pending', async () => {
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] });
      await expect(
        service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_RESULT_ALREADY_REPORTED });
    });

    it('settles immediately when no other active participant remains to confirm', async () => {
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST),
        participant('p2', P2, { status: GameParticipantStatus.LOST }),
      ]);
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] });
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 200, reason: 'GAME_PAYOUT' }),
        FAKE_TX,
      );
    });

    it('splits the pot evenly across multiple winners once confirmed', async () => {
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST, P2] });
      await service.confirmMatchResult(OTHER, 'sess-1');
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 100 }),
        FAKE_TX,
      );
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: P2, amount: 100 }),
        FAKE_TX,
      );
    });

    it('applies the house rake before paying the winner, once confirmed', async () => {
      repo.getDefinitionByCode.mockResolvedValue(def({ houseRakeBps: 500 })); // 5%
      await service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] });
      await service.confirmMatchResult(OTHER, 'sess-1');
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 190 }),
        FAKE_TX,
      );
      expect(repo.createMatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ payoutTotal: 190n, rakeAmount: 10n }),
        FAKE_TX,
      );
    });

    it('rejects a non-host reporter', async () => {
      await expect(
        service.reportMatchResult({ id: P2, roles: ['USER'] }, 'sess-1', { winners: [P2] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_HOST });
    });

    it('rejects a report with no winners', async () => {
      await expect(
        service.reportMatchResult(ACTOR, 'sess-1', { winners: [] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_INVALID_PAYOUT });
    });
  });

  describe('getLiveState', () => {
    it('returns the live state with the current turn and remaining seconds', async () => {
      const res = (await service.getLiveState(ACTOR, 'sess-1')) as Record<string, unknown>;
      expect(res).toMatchObject({ sessionId: 'sess-1', isOver: false, currentTurnUserId: HOST });
      expect(res).toHaveProperty('turnRemainingSeconds');
      expect(res).toHaveProperty('moves');
    });

    it('rejects an unknown session', async () => {
      repo.getSession.mockResolvedValue(null);
      await expect(service.getLiveState(ACTOR, 'nope')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_SESSION_NOT_FOUND,
      });
    });
  });

  describe('forfeit', () => {
    it('settles the pot to the sole survivor when a player forfeits (2-player)', async () => {
      const res = (await service.forfeit(ACTOR, 'sess-1')) as Record<string, unknown>;
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.forfeited' }));
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: P2, amount: 200, reason: 'GAME_PAYOUT' }),
        FAKE_TX,
      );
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.settled' }));
      expect(res).toBeTruthy();
    });

    it('continues the match and marks the leaver lost when 2+ players remain', async () => {
      repo.getSession.mockResolvedValue(session({ playerCount: 3, potAmount: 300n }));
      repo.getParticipant.mockResolvedValue(participant('p1', HOST));
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST),
        participant('p2', P2),
        participant('p3', P3),
      ]);
      await service.forfeit(ACTOR, 'sess-1');
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.forfeited' }));
      expect(repo.updateParticipant).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ status: GameParticipantStatus.LOST }),
      );
      // No settlement while the match continues.
      expect(repo.createMatchResult).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.settled' }),
      );
    });

    it(
      'REGRESSION (betting spec #12): when the LAST participant forfeits (everyone else ' +
        'already left), no refund — the actor takes the full pot instead of it being ' +
        'returned to nobody',
      async () => {
        repo.getSession.mockResolvedValue(session({ playerCount: 3, potAmount: 300n }));
        repo.getParticipant.mockResolvedValue(participant('p1', HOST));
        repo.listParticipants.mockResolvedValue([
          participant('p1', HOST, { status: GameParticipantStatus.PLAYING }),
          participant('p2', P2, { status: GameParticipantStatus.LOST }),
          participant('p3', P3, { status: GameParticipantStatus.LOST }),
        ]);
        await service.forfeit(ACTOR, 'sess-1');

        expect(wallet.credit).toHaveBeenCalledWith(
          expect.objectContaining({ userId: HOST, amount: 300, reason: 'GAME_PAYOUT' }),
          FAKE_TX,
        );
        expect(repo.createMatchResult).toHaveBeenCalledWith(
          expect.objectContaining({ winners: [HOST] }),
          FAKE_TX,
        );
        expect(bus.publish).not.toHaveBeenCalledWith(
          expect.objectContaining({ name: 'game.cancelled' }),
        );
      },
    );

    it('rejects a non-participant forfeiter', async () => {
      repo.getParticipant.mockResolvedValue(null);
      await expect(
        service.forfeit({ id: STRANGER, roles: ['USER'] }, 'sess-1'),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_PARTICIPANT });
    });

    it('rejects forfeit on a non-active session', async () => {
      repo.getSession.mockResolvedValue(session({ status: GameSessionStatus.COMPLETED }));
      await expect(service.forfeit(ACTOR, 'sess-1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_SESSION_NOT_ACTIVE,
      });
    });
  });

  describe('sweepStalledTurns (turn watchdog)', () => {
    const stallMs = GAME_TURN_SECONDS * 1000 + GAME_TURN_STALL_GRACE_MS;

    function liveState(overrides: Partial<GameLiveState> = {}): GameLiveState {
      return {
        currentTurnUserId: HOST,
        turnStartedAt: 0,
        turnSeconds: GAME_TURN_SECONDS,
        seatOrder: [HOST, P2],
        moves: [],
        isOver: false,
        timeoutCounts: {},
        ...overrides,
      };
    }

    beforeEach(() => {
      repo.listActiveSessions.mockResolvedValue([session()]);
    });

    it('does nothing while the turn is within its normal window', async () => {
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: 0 }));
      await service.sweepStalledTurns(new Date(5_000));
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('requests a resync the first time a turn goes stale, without rotating yet', async () => {
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: 0 }));
      await service.sweepStalledTurns(new Date(stallMs + 1));

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.turn_resync_requested' }),
      );
      const state = (await cache.get(gameLiveStateKey('sess-1'))) as GameLiveState;
      expect(state?.currentTurnUserId).toBe(HOST); // not rotated yet
      await expect(cache.get(gameTurnResyncPendingKey('sess-1'))).resolves.toMatchObject({
        turnStartedAt: 0,
      });
    });

    it('does not re-request a resync on a subsequent tick within the resync grace window', async () => {
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: 0 }));
      await service.sweepStalledTurns(new Date(stallMs + 1));
      bus.publish.mockClear();

      await service.sweepStalledTurns(new Date(stallMs + 1_000));
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('force-advances the turn once the resync grace also elapses with no move', async () => {
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: 0 }));
      await service.sweepStalledTurns(new Date(stallMs + 1)); // phase 1: resync requested
      bus.publish.mockClear();

      const forceAt = stallMs + GAME_TURN_RESYNC_GRACE_MS + 1;
      await service.sweepStalledTurns(new Date(forceAt)); // phase 2: force-advance

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'game.turn_force_advanced',
          payload: expect.objectContaining({ skippedUserId: HOST, currentTurnUserId: P2 }),
        }),
      );
      const state = (await cache.get(gameLiveStateKey('sess-1'))) as GameLiveState;
      expect(state?.currentTurnUserId).toBe(P2);
      expect(state?.turnStartedAt).toBe(forceAt);
      expect(state?.timeoutCounts[HOST]).toBe(1);
      await expect(cache.get(gameTurnResyncPendingKey('sess-1'))).resolves.toBeNull();
    });

    it('does not force-advance if a real move landed between the two phases', async () => {
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: 0 }));
      await service.sweepStalledTurns(new Date(stallMs + 1)); // phase 1: resync requested

      // A real move landed and moved the turn on — turnStartedAt changes.
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: stallMs + 500 }));
      bus.publish.mockClear();

      await service.sweepStalledTurns(new Date(stallMs + GAME_TURN_RESYNC_GRACE_MS + 1));
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.turn_force_advanced' }),
      );
    });

    it('folds a seat into forfeitOnDisconnect after enough consecutive force-advances', async () => {
      await cache.set(
        gameLiveStateKey('sess-1'),
        liveState({
          turnStartedAt: 0,
          timeoutCounts: { [HOST]: GAME_MAX_CONSECUTIVE_TURN_TIMEOUTS - 1 },
        }),
      );
      repo.findActiveSessionForParticipant.mockResolvedValue('sess-1');
      repo.getParticipant.mockResolvedValue(participant('p1', HOST));
      repo.listParticipants.mockResolvedValue([participant('p1', HOST), participant('p2', P2)]);

      await service.sweepStalledTurns(new Date(stallMs + 1));
      await service.sweepStalledTurns(new Date(stallMs + GAME_TURN_RESYNC_GRACE_MS + 1));
      await new Promise((resolve) => setImmediate(resolve)); // flush the fire-and-forget forfeit

      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.forfeited' }));
    });

    it('skips a session with no cached live state', async () => {
      await service.sweepStalledTurns(new Date(stallMs + 1));
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('skips a session already marked isOver', async () => {
      await cache.set(gameLiveStateKey('sess-1'), liveState({ turnStartedAt: 0, isOver: true }));
      await service.sweepStalledTurns(new Date(stallMs + 1));
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('admin + reads', () => {
    it('blocks a non-admin from editing a definition', async () => {
      await expect(
        service.updateDefinition(ACTOR, GameCode.GREEDY, { enabled: false }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED });
    });

    it('maps the wins leaderboard with usernames', async () => {
      cache.top.mockResolvedValue([{ member: HOST, score: 3 }]);
      const board = (await service.leaderboard(10)) as Array<Record<string, unknown>>;
      expect(board[0]).toMatchObject({ rank: 1, userId: HOST, username: 'host', wins: 3 });
    });
  });

  describe('getMyActiveMatch — resume-on-launch', () => {
    it('returns kind: none when nothing is active/unseen', async () => {
      const result = await service.getMyActiveMatch(ACTOR);
      expect(result).toEqual({ kind: 'none' });
    });

    it('prioritizes an ACTIVE session over everything else', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue('sess-1');
      repo.findActiveLobbyForParticipant.mockResolvedValue('LOBBY1');
      const result = (await service.getMyActiveMatch(ACTOR)) as Record<string, unknown>;
      expect(result.kind).toBe('session');
      const view = result.session as Record<string, unknown>;
      expect(view.id).toBe('sess-1');
      // The lobby lookup must not even matter once a session is found.
      expect(repo.findUnseenCompletedSessionForParticipant).not.toHaveBeenCalled();
    });

    it('does not reconnect to completed sessions on launch — returns none', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue(null);
      repo.findUnseenCompletedSessionForParticipant.mockResolvedValue('sess-2');
      repo.getSession.mockResolvedValue(
        session({ id: 'sess-2', status: GameSessionStatus.COMPLETED }),
      );
      const result = (await service.getMyActiveMatch(ACTOR)) as Record<string, unknown>;
      expect(result.kind).toBe('none');
    });

    it('returns active session if player disconnected within 60s reconnect window', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue('sess-1');
      repo.getSession.mockResolvedValue(
        session({ id: 'sess-1', status: GameSessionStatus.ACTIVE }),
      );
      repo.listParticipants.mockResolvedValue([]);
      cache.get.mockResolvedValue({ userId: ACTOR.id, disconnectedAt: Date.now() - 10000 });
      const result = (await service.getMyActiveMatch(ACTOR)) as Record<string, unknown>;
      expect(result.kind).toBe('session');
    });

    it('forfeits player and returns none if disconnect timeout expired (>60s)', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue('sess-1');
      cache.get.mockResolvedValue({ userId: ACTOR.id, disconnectedAt: Date.now() - 70000 });
      const result = (await service.getMyActiveMatch(ACTOR)) as Record<string, unknown>;
      expect(result.kind).toBe('none');
      expect(cache.del).toHaveBeenCalledWith(gameDisconnectKey(ACTOR.id));
    });

    it('falls back to an open lobby when no session (active or unseen) exists', async () => {
      repo.findActiveLobbyForParticipant.mockResolvedValue('LOBBY1');
      repo.getLobbyByCode.mockResolvedValue(lobby({ code: 'LOBBY1' }));
      const result = (await service.getMyActiveMatch(ACTOR)) as Record<string, unknown>;
      expect(result.kind).toBe('lobby');
      const view = result.lobby as Record<string, unknown>;
      expect(view.code).toBe('LOBBY1');
    });

    it('ackResult marks the session seen for the acting user', async () => {
      await service.ackResult(ACTOR, 'sess-1');
      expect(repo.markResultSeen).toHaveBeenCalledWith('sess-1', HOST);
    });
  });

  describe('matchmaking — joinQueue', () => {
    it('queues a lone player and reports QUEUED', async () => {
      cache.sortedCount.mockResolvedValue(1); // below the DUEL requirement (2)
      const res = (await service.joinQueue(ACTOR, {
        gameCode: GameCode.GREEDY,
        stake: 500,
        matchType: 'DUEL',
      })) as Record<string, unknown>;
      expect(res).toMatchObject({ status: 'QUEUED' });
      expect(cache.setScore).toHaveBeenCalledWith(
        gameMatchQueueKey(GameCode.GREEDY, 500, 'DUEL'),
        HOST,
        expect.any(Number),
      );
      expect(cache.setAdd).toHaveBeenCalled(); // registers the bucket for stale sweeps
    });

    it('forms a match and opens a ready-check when the bucket fills', async () => {
      cache.sortedCount.mockResolvedValue(2);
      cache.sortedLowest.mockResolvedValue([
        { member: HOST, score: 1 },
        { member: P2, score: 2 },
      ]);
      const res = (await service.joinQueue(ACTOR, {
        gameCode: GameCode.GREEDY,
        stake: 500,
        matchType: 'DUEL',
      })) as Record<string, unknown>;
      expect(res).toMatchObject({ status: 'MATCHED' });
      expect(res.matchId).toEqual(expect.any(String));
      expect(cache.sortedRemove).toHaveBeenCalledWith(
        gameMatchQueueKey(GameCode.GREEDY, 500, 'DUEL'),
        HOST,
        P2,
      );
      expect(cache.setScore).toHaveBeenCalledWith(
        GAME_MATCH_READY_INDEX_KEY,
        expect.any(String),
        expect.any(Number),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.match_found' }),
      );
    });

    it('rejects a player who is already queued', async () => {
      await cache.set(gameMatchUserKey(HOST), { bucketKey: 'b', retries: 0, firstQueuedAt: 1 });
      await expect(
        service.joinQueue(ACTOR, { gameCode: GameCode.GREEDY, stake: 500, matchType: 'DUEL' }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_ALREADY_QUEUED });
    });

    it('rejects TEAM_2V2 for a game whose engine does not support it', async () => {
      // GREEDY seats 8, but its engine has no 2v2 — capability gates, not seat count.
      await expect(
        service.joinQueue(ACTOR, { gameCode: GameCode.GREEDY, stake: 500, matchType: 'TEAM_2V2' }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_2V2_UNSUPPORTED });
    });

    it('allows TEAM_2V2 for the 2v2-capable games (Ludo, Carrom)', async () => {
      const cases: [GameCode, GameActor][] = [
        [GameCode.LUDO, { id: HOST, roles: ['USER'] }],
        [GameCode.CARROM, { id: P2, roles: ['USER'] }],
      ];
      for (const [code, actor] of cases) {
        repo.getDefinitionByCode.mockResolvedValue(def({ code }));
        const res = (await service.joinQueue(actor, {
          gameCode: code,
          stake: 500,
          matchType: 'TEAM_2V2',
        })) as Record<string, unknown>;
        expect(res).toMatchObject({ status: 'QUEUED' });
      }
    });

    it('rate-limits repeated queue requests', async () => {
      cache.increment.mockResolvedValue(11); // over the 10/min limit
      await expect(
        service.joinQueue(ACTOR, { gameCode: GameCode.GREEDY, stake: 500, matchType: 'DUEL' }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.RATE_LIMITED });
    });
  });

  describe('matchmaking — acceptMatch', () => {
    const MATCH = 'match-abc';
    function seedReadyCheck(overrides: Record<string, unknown> = {}) {
      return cache.set(gameMatchReadyKey(MATCH), {
        matchId: MATCH,
        v: 1,
        gameCode: GameCode.GREEDY,
        stake: 100,
        matchType: 'DUEL',
        currency: GameCurrency.GOLD,
        mode: GameMode.CLASSIC,
        bucketKey: gameMatchQueueKey(GameCode.GREEDY, 100, 'DUEL'),
        players: [HOST, P2],
        ready: [],
        hostId: HOST,
        retriesByUser: { [HOST]: 0, [P2]: 0 },
        expiresAt: Date.now() + 10000,
        createdAt: Date.now(),
        ...overrides,
      });
    }

    it('records readiness and waits for the other player', async () => {
      await seedReadyCheck();
      const res = (await service.acceptMatch(ACTOR, MATCH)) as Record<string, unknown>;
      expect(res).toMatchObject({ status: 'WAITING' });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.match_ready_progress' }),
      );
    });

    it('finalizes when all are ready: creates the matchmade lobby, escrows, starts', async () => {
      await seedReadyCheck({ ready: [P2] }); // P2 ready; HOST accepting makes it all-ready
      repo.createLobby.mockResolvedValue(
        lobby({ id: 'mm-lobby', mode: GameMode.CLASSIC, isMatchmade: true, hostId: HOST }),
      );
      repo.getLobbyById.mockResolvedValue(
        lobby({ id: 'mm-lobby', mode: GameMode.CLASSIC, isMatchmade: true, hostId: HOST }),
      );
      repo.listMemberIds.mockResolvedValue([HOST, P2]);
      const res = (await service.acceptMatch(ACTOR, MATCH)) as Record<string, unknown>;
      expect(res).toMatchObject({ status: 'STARTED' });
      expect(repo.createLobby).toHaveBeenCalledWith(
        expect.objectContaining({ isMatchmade: true, hostId: HOST }),
      );
      expect(repo.addMember).toHaveBeenCalledWith('mm-lobby', HOST);
      expect(repo.addMember).toHaveBeenCalledWith('mm-lobby', P2);
      expect(wallet.debit).toHaveBeenCalledTimes(2); // escrow via startSessionFromLobby
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.started' }));
      expect(cache.del).toHaveBeenCalledWith(gameMatchReadyKey(MATCH)); // ready-check cleared
    });

    it('rejects an unknown match', async () => {
      await expect(service.acceptMatch(ACTOR, 'nope')).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_MATCH_NOT_FOUND,
      });
    });

    it('rejects an expired match', async () => {
      await seedReadyCheck({ expiresAt: Date.now() - 1000 });
      await expect(service.acceptMatch(ACTOR, MATCH)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_MATCH_EXPIRED,
      });
    });
  });

  describe('matchmaking — leaveQueue / status', () => {
    it('removes the player from the bucket and clears the pointer', async () => {
      const bucketKey = gameMatchQueueKey(GameCode.GREEDY, 100, 'DUEL');
      await cache.set(gameMatchUserKey(HOST), { bucketKey, retries: 0, firstQueuedAt: Date.now() });
      const res = await service.leaveQueue(ACTOR);
      expect(res).toEqual({ left: true });
      expect(cache.sortedRemove).toHaveBeenCalledWith(bucketKey, HOST);
      expect(cache.del).toHaveBeenCalledWith(gameMatchUserKey(HOST));
    });

    it('is a no-op when the player is not queued', async () => {
      expect(await service.leaveQueue(ACTOR)).toEqual({ left: false });
    });

    it('reports IDLE when neither queued nor in a ready-check', async () => {
      expect(await service.getMatchmakingStatus(ACTOR)).toMatchObject({ state: 'IDLE' });
    });

    it('reports READY_CHECK when the player is in a ready-check', async () => {
      await cache.set(gameMatchReadyUserKey(HOST), 'm1');
      await cache.set(gameMatchReadyKey('m1'), {
        matchId: 'm1',
        players: [HOST, P2],
        ready: [P2],
        expiresAt: Date.now() + 5000,
      });
      expect(await service.getMatchmakingStatus(ACTOR)).toMatchObject({
        state: 'READY_CHECK',
        matchId: 'm1',
      });
    });
  });

  describe('matchmaking — dissolve', () => {
    it('re-queues the ready players and drops the rest on decline', async () => {
      const bucketKey = gameMatchQueueKey(GameCode.GREEDY, 100, 'TEAM_2V2');
      await cache.set(gameMatchReadyKey('m2'), {
        matchId: 'm2',
        v: 1,
        gameCode: GameCode.GREEDY,
        stake: 100,
        matchType: 'TEAM_2V2',
        currency: GameCurrency.GOLD,
        mode: GameMode.TEAM_2V2,
        bucketKey,
        players: [HOST, P2, STRANGER, P3],
        ready: [HOST, P2],
        hostId: HOST,
        retriesByUser: { [HOST]: 0, [P2]: 0, [STRANGER]: 0, [P3]: 0 },
        expiresAt: Date.now() + 5000,
        createdAt: Date.now(),
      });
      await service.declineMatch({ id: P3, roles: ['USER'] }, 'm2');
      expect(cache.setScore).toHaveBeenCalledWith(bucketKey, HOST, expect.any(Number));
      expect(cache.setScore).toHaveBeenCalledWith(bucketKey, P2, expect.any(Number));
      expect(cache.setScore).not.toHaveBeenCalledWith(bucketKey, STRANGER, expect.any(Number));
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.match_cancelled' }),
      );
      expect(cache.del).toHaveBeenCalledWith(gameMatchReadyKey('m2'));
    });
  });

  describe('matchmaking — sweepExpiredReadyChecks', () => {
    it('dissolves ready-checks past their deadline and re-queues the ready', async () => {
      const bucketKey = gameMatchQueueKey(GameCode.GREEDY, 100, 'DUEL');
      cache.sortedRangeByScore.mockResolvedValue(['m3']);
      await cache.set(gameMatchReadyKey('m3'), {
        matchId: 'm3',
        v: 1,
        gameCode: GameCode.GREEDY,
        stake: 100,
        matchType: 'DUEL',
        currency: GameCurrency.GOLD,
        mode: GameMode.CLASSIC,
        bucketKey,
        players: [HOST, P2],
        ready: [HOST],
        hostId: HOST,
        retriesByUser: { [HOST]: 0, [P2]: 0 },
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 20000,
      });
      await service.sweepExpiredReadyChecks(new Date());
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.match_cancelled' }),
      );
      expect(cache.setScore).toHaveBeenCalledWith(bucketKey, HOST, expect.any(Number));
    });
  });

  describe('2v2 — setPlayerTeam', () => {
    beforeEach(() => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ mode: GameMode.TEAM_2V2 }));
      repo.getLobbyById.mockResolvedValue(lobby({ mode: GameMode.TEAM_2V2 }));
      repo.getMember.mockResolvedValue({ id: 'm1' });
      repo.listMembersWithTeams.mockResolvedValue([
        { userId: HOST, team: null },
        { userId: P2, team: null },
      ]);
    });

    it('sets the callers own team and broadcasts', async () => {
      await service.setPlayerTeam(ACTOR, 'ABCDEF', GameTeam.A);
      expect(repo.setMemberTeam).toHaveBeenCalledWith('lobby-1', HOST, GameTeam.A);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_team_changed' }),
      );
    });

    it('rejects when the chosen team is already full', async () => {
      repo.listMembersWithTeams.mockResolvedValue([
        { userId: P2, team: GameTeam.A },
        { userId: STRANGER, team: GameTeam.A },
      ]);
      await expect(service.setPlayerTeam(ACTOR, 'ABCDEF', GameTeam.A)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_TEAM_FULL,
      });
    });

    it('rejects team selection in a non-team lobby', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ mode: GameMode.CLASSIC }));
      await expect(service.setPlayerTeam(ACTOR, 'ABCDEF', GameTeam.A)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_NOT_TEAM_MODE,
      });
    });
  });

  describe('2v2 — reportMatchResult (team expansion)', () => {
    it('expands the winning team and splits the pot between its members', async () => {
      repo.getSession.mockResolvedValue(
        session({ mode: GameMode.TEAM_2V2, potAmount: 400n, playerCount: 4 }),
      );
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { team: GameTeam.A, seat: 0 }),
        participant('p2', P2, { team: GameTeam.B, seat: 1 }),
        participant('p3', STRANGER, { team: GameTeam.A, seat: 2 }),
        participant('p4', P3, { team: GameTeam.B, seat: 3 }),
      ]);

      // The host's team report expands to both teammates and is held PENDING
      // corroboration — the host is not a trusted role, so no wallet movement
      // until a different active participant confirms.
      const res = (await service.reportMatchResult(ACTOR, 'sess-1', {
        winningTeam: GameTeam.A,
      })) as { status: string; winners: string[] };
      expect(res.status).toBe('pending_confirmation');
      expect(res.winners).toEqual(expect.arrayContaining([HOST, STRANGER]));
      expect(wallet.credit).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'game.result_reported',
          payload: expect.objectContaining({
            winners: expect.arrayContaining([HOST, STRANGER]),
          }),
        }),
      );

      // A different active participant corroborates → both teammates split the pot.
      await service.confirmMatchResult({ id: P2, roles: ['USER'] }, 'sess-1');
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 200 }),
        FAKE_TX,
      );
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: STRANGER, amount: 200 }),
        FAKE_TX,
      );
      expect(repo.createMatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ winners: expect.arrayContaining([HOST, STRANGER]) }),
        FAKE_TX,
      );
    });

    it('requires a winningTeam for a 2v2 session', async () => {
      repo.getSession.mockResolvedValue(session({ mode: GameMode.TEAM_2V2 }));
      await expect(
        service.reportMatchResult(ACTOR, 'sess-1', { winners: [HOST] }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_INVALID_PAYOUT });
    });

    it(
      'REGRESSION (betting spec #8): a teammate who already forfeited (status LOST) is ' +
        'excluded from the winning-team expansion, so the solo survivor takes the WHOLE ' +
        'pot instead of splitting it with a partner who left',
      async () => {
        repo.getSession.mockResolvedValue(
          session({ mode: GameMode.TEAM_2V2, potAmount: 400n, playerCount: 4 }),
        );
        repo.listParticipants.mockResolvedValue([
          participant('p1', HOST, {
            team: GameTeam.A,
            seat: 0,
            status: GameParticipantStatus.PLAYING,
          }),
          participant('p2', P2, {
            team: GameTeam.B,
            seat: 1,
            status: GameParticipantStatus.PLAYING,
          }),
          // STRANGER already forfeited earlier in the match — still tagged Team A,
          // but must NOT collect a share when Team A's survivor (HOST) wins.
          participant('p3', STRANGER, {
            team: GameTeam.A,
            seat: 2,
            status: GameParticipantStatus.LOST,
          }),
          participant('p4', P3, {
            team: GameTeam.B,
            seat: 3,
            status: GameParticipantStatus.PLAYING,
          }),
        ]);
        // The host's report is held pending — only the expanded winner set is
        // visible up front; the actual payout lands on corroboration.
        const res = (await service.reportMatchResult(ACTOR, 'sess-1', {
          winningTeam: GameTeam.A,
        })) as { status: string; winners: string[] };
        expect(res.status).toBe('pending_confirmation');
        expect(res.winners).toEqual([HOST]);
        expect(wallet.credit).not.toHaveBeenCalled();

        await service.confirmMatchResult({ id: P2, roles: ['USER'] }, 'sess-1');

        expect(wallet.credit).toHaveBeenCalledWith(
          expect.objectContaining({ userId: HOST, amount: 400 }),
          FAKE_TX,
        );
        expect(wallet.credit).not.toHaveBeenCalledWith(
          expect.objectContaining({ userId: STRANGER }),
          FAKE_TX,
        );
        expect(repo.createMatchResult).toHaveBeenCalledWith(
          expect.objectContaining({ winners: [HOST] }),
          FAKE_TX,
        );
      },
    );
  });

  describe('2v2 — forfeit', () => {
    it('awards the pot to the surviving team when a forfeit empties the other team', async () => {
      repo.getSession.mockResolvedValue(
        session({ mode: GameMode.TEAM_2V2, potAmount: 400n, playerCount: 4 }),
      );
      repo.getParticipant.mockResolvedValue(participant('p1', HOST, { team: GameTeam.A }));
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { team: GameTeam.A, status: GameParticipantStatus.PLAYING }),
        participant('p2', STRANGER, { team: GameTeam.A, status: GameParticipantStatus.LOST }),
        participant('p3', P2, { team: GameTeam.B, status: GameParticipantStatus.PLAYING }),
        participant('p4', P3, { team: GameTeam.B, status: GameParticipantStatus.PLAYING }),
      ]);
      await service.forfeit(ACTOR, 'sess-1');
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: P2, amount: 200 }),
        FAKE_TX,
      );
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: P3, amount: 200 }),
        FAKE_TX,
      );
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.settled' }));
    });

    it('continues a 2v2 match while both teams still have players', async () => {
      repo.getSession.mockResolvedValue(
        session({ mode: GameMode.TEAM_2V2, potAmount: 400n, playerCount: 4 }),
      );
      repo.getParticipant.mockResolvedValue(participant('p1', HOST, { team: GameTeam.A }));
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { team: GameTeam.A, status: GameParticipantStatus.PLAYING }),
        participant('p2', STRANGER, { team: GameTeam.A, status: GameParticipantStatus.PLAYING }),
        participant('p3', P2, { team: GameTeam.B, status: GameParticipantStatus.PLAYING }),
        participant('p4', P3, { team: GameTeam.B, status: GameParticipantStatus.PLAYING }),
      ]);
      await service.forfeit(ACTOR, 'sess-1');
      expect(repo.createMatchResult).not.toHaveBeenCalled();
      expect(repo.updateParticipant).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ status: GameParticipantStatus.LOST }),
      );
    });

    it(
      'REGRESSION (betting spec #12): the LAST 2v2 participant to forfeit (all three ' +
        'others already left) takes the full pot instead of a refund',
      async () => {
        repo.getSession.mockResolvedValue(
          session({ mode: GameMode.TEAM_2V2, potAmount: 400n, playerCount: 4 }),
        );
        repo.getParticipant.mockResolvedValue(participant('p1', HOST, { team: GameTeam.A }));
        repo.listParticipants.mockResolvedValue([
          participant('p1', HOST, { team: GameTeam.A, status: GameParticipantStatus.PLAYING }),
          participant('p2', STRANGER, { team: GameTeam.A, status: GameParticipantStatus.LOST }),
          participant('p3', P2, { team: GameTeam.B, status: GameParticipantStatus.LOST }),
          participant('p4', P3, { team: GameTeam.B, status: GameParticipantStatus.LOST }),
        ]);
        await service.forfeit(ACTOR, 'sess-1');

        expect(wallet.credit).toHaveBeenCalledWith(
          expect.objectContaining({ userId: HOST, amount: 400, reason: 'GAME_PAYOUT' }),
          FAKE_TX,
        );
        expect(bus.publish).not.toHaveBeenCalledWith(
          expect.objectContaining({ name: 'game.cancelled' }),
        );
      },
    );
  });

  describe('private / password lobbies + host controls', () => {
    it('creates a private password lobby, storing a hash (not the plaintext)', async () => {
      await service.createLobby(ACTOR, {
        gameCode: GameCode.GREEDY,
        stake: 500,
        isPrivate: true,
        password: 'secret',
      });
      expect(repo.createLobby).toHaveBeenCalledWith(
        expect.objectContaining({ isPrivate: true, passwordHash: expect.any(String) }),
      );
      const arg = repo.createLobby.mock.calls[0][0] as { passwordHash: string };
      expect(arg.passwordHash).not.toBe('secret');
    });

    it('rejects joining a password lobby with the wrong password', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ passwordHash: sha256('right') }));
      repo.getLobbyById.mockResolvedValue(lobby({ passwordHash: sha256('right') }));
      await expect(
        service.joinLobby({ id: P2, roles: ['USER'] }, 'ABCDEF', 'wrong'),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_LOBBY_BAD_PASSWORD });
    });

    it('allows joining a password lobby with the correct password', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ passwordHash: sha256('right') }));
      repo.getLobbyById.mockResolvedValue(lobby({ passwordHash: sha256('right') }));
      await service.joinLobby({ id: P2, roles: ['USER'] }, 'ABCDEF', 'right');
      expect(repo.addMember).toHaveBeenCalledWith('lobby-1', P2, undefined);
    });

    it('lets the host kick a member and broadcasts', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.getLobbyById.mockResolvedValue(lobby());
      repo.getMember.mockResolvedValue({ id: 'm2' });
      repo.listMemberIds.mockResolvedValue([HOST]);
      await service.kickMember(ACTOR, 'ABCDEF', P2);
      expect(repo.removeMember).toHaveBeenCalledWith('lobby-1', P2);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_member_kicked' }),
      );
    });

    it('rejects a non-host kicker', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      await expect(
        service.kickMember({ id: P2, roles: ['USER'] }, 'ABCDEF', HOST),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_HOST });
    });

    it('lets the host close (disband) the lobby', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.getLobbyById.mockResolvedValue(lobby());
      await service.closeLobby(ACTOR, 'ABCDEF');
      expect(repo.markLobbyClosed).toHaveBeenCalledWith('lobby-1', GameLobbyStatus.CANCELLED, HOST);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_cancelled' }),
      );
    });

    it('lets the host update stake while the lobby is open', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.getLobbyById.mockResolvedValue(lobby());
      await service.updateLobbySettings(ACTOR, 'ABCDEF', { stake: 800 });
      expect(repo.updateLobby).toHaveBeenCalledWith(
        'lobby-1',
        expect.objectContaining({ stake: 800n }),
      );
    });

    it('rejects a non-host editing settings', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      await expect(
        service.updateLobbySettings({ id: P2, roles: ['USER'] }, 'ABCDEF', { stake: 800 }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_HOST });
    });
  });

  describe('closeRoomBoundLobby', () => {
    it('closes the room-bound open lobby and broadcasts lobby_cancelled (room_ended)', async () => {
      repo.findOpenLobbyForRoom.mockResolvedValue(lobby());
      repo.getLobbyById.mockResolvedValue(lobby());
      await service.closeRoomBoundLobby('room-1');
      expect(repo.markLobbyClosed).toHaveBeenCalledWith('lobby-1', GameLobbyStatus.CANCELLED, null);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_cancelled' }),
      );
    });

    it('is a no-op when the room has no open lobby', async () => {
      repo.findOpenLobbyForRoom.mockResolvedValue(null);
      await service.closeRoomBoundLobby('room-1');
      expect(repo.markLobbyClosed).not.toHaveBeenCalled();
    });

    it('is a no-op when the lobby raced to a non-OPEN state', async () => {
      repo.findOpenLobbyForRoom.mockResolvedValue(lobby());
      repo.getLobbyById.mockResolvedValue(lobby({ status: GameLobbyStatus.STARTED }));
      await service.closeRoomBoundLobby('room-1');
      expect(repo.markLobbyClosed).not.toHaveBeenCalled();
    });
  });

  describe('repointRoomGameHost', () => {
    it('re-points the board session host and the open lobby host on ownership transfer', async () => {
      repo.findActiveSessionForRoom.mockResolvedValue(session({ roomId: 'room-1' }));
      repo.findOpenLobbyForRoom.mockResolvedValue(lobby({ roomId: 'room-1' }));
      await service.repointRoomGameHost('room-1', P2);
      expect(repo.updateSessionHost).toHaveBeenCalledWith('sess-1', P2);
      expect(repo.updateLobbyHost).toHaveBeenCalledWith('lobby-1', P2);
    });

    it('skips casino window sessions but still re-points an open lobby', async () => {
      repo.findActiveSessionForRoom.mockResolvedValue(
        session({ roomId: 'room-1', code: GameCode.GREEDY_FOOD }),
      );
      repo.findOpenLobbyForRoom.mockResolvedValue(lobby({ roomId: 'room-1' }));
      await service.repointRoomGameHost('room-1', P2);
      expect(repo.updateSessionHost).not.toHaveBeenCalled();
      expect(repo.updateLobbyHost).toHaveBeenCalledWith('lobby-1', P2);
    });

    it('is a no-op when the room has neither a session nor a lobby', async () => {
      repo.findActiveSessionForRoom.mockResolvedValue(null);
      repo.findOpenLobbyForRoom.mockResolvedValue(null);
      await service.repointRoomGameHost('room-1', P2);
      expect(repo.updateSessionHost).not.toHaveBeenCalled();
      expect(repo.updateLobbyHost).not.toHaveBeenCalled();
    });
  });

  describe('staked-seat bots', () => {
    const BOT = '99999999-9999-9999-9999-999999999999';

    it('lets the host add a bot to a friendly (no-stake) match and broadcasts it', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ stake: 0n }));
      repo.getLobbyById.mockResolvedValue(lobby({ stake: 0n }));
      repo.countMembers.mockResolvedValue(1);
      const res = (await service.addBot(ACTOR, 'ABCDEF', {})) as Record<string, unknown>;
      expect(repo.addBotMember).toHaveBeenCalled();
      expect(res).toHaveProperty('botId');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.lobby_joined' }),
      );
    });

    it('rejects adding a bot to a bet (staked) match — bots are friendly-only', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ stake: 100n }));
      repo.getLobbyById.mockResolvedValue(lobby({ stake: 100n }));
      repo.countMembers.mockResolvedValue(1);
      await expect(service.addBot(ACTOR, 'ABCDEF', {})).rejects.toMatchObject({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
      });
      expect(repo.addBotMember).not.toHaveBeenCalled();
    });

    it('rejects a non-host adding a bot', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      await expect(service.addBot({ id: P2, roles: ['USER'] }, 'ABCDEF', {})).rejects.toMatchObject(
        { errorCode: ERROR_CODES.GAME_NOT_HOST },
      );
    });

    it('skips escrow for bots and sets the pot from human stakes only', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.getLobbyById.mockResolvedValue(lobby());
      repo.listMemberIds.mockResolvedValue([HOST, BOT]);
      repo.listMembersWithTeams.mockResolvedValue([
        { userId: HOST, team: null, isBot: false },
        { userId: BOT, team: null, isBot: true },
      ]);
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { stake: 100n, isBot: false }),
        participant('pb', BOT, { stake: 0n, isBot: true }),
      ]);
      await service.startSessionFromLobby('lobby-1', HOST);
      expect(wallet.debit).toHaveBeenCalledTimes(1); // only the human staked
      expect(repo.setSessionPot).toHaveBeenCalledWith('sess-1', 100n); // 1 human × 100
    });

    it('redistributes a bot teammate’s share to the human on a winning 2v2 team', async () => {
      repo.getSession.mockResolvedValue(
        session({ mode: GameMode.TEAM_2V2, potAmount: 300n, playerCount: 4 }),
      );
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { team: GameTeam.A, isBot: false, stake: 100n }),
        participant('pb', BOT, { team: GameTeam.A, isBot: true, stake: 0n }),
        participant('p3', P2, { team: GameTeam.B, isBot: false, stake: 100n }),
        participant('p4', P3, { team: GameTeam.B, isBot: false, stake: 100n }),
      ]);
      // The team expands to the still-PLAYING bot, but settlement is pending
      // corroboration and only the human collects on payout.
      const res = (await service.reportMatchResult(ACTOR, 'sess-1', {
        winningTeam: GameTeam.A,
      })) as { status: string; winners: string[] };
      expect(res.status).toBe('pending_confirmation');
      expect(res.winners).toEqual(expect.arrayContaining([HOST, BOT]));
      expect(wallet.credit).not.toHaveBeenCalled();

      await service.confirmMatchResult({ id: P2, roles: ['USER'] }, 'sess-1');
      // Only the human on team A is paid — the whole distributable pot.
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: HOST, amount: 300 }),
        FAKE_TX,
      );
      expect(wallet.credit).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: BOT }),
        expect.anything(),
      );
      expect(repo.createMatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ winners: [HOST] }),
        FAKE_TX,
      );
    });

    it('refunds the humans when only a bot is left to win', async () => {
      repo.getSession.mockResolvedValue(session({ potAmount: 100n, playerCount: 2 }));
      repo.getParticipant.mockResolvedValue(participant('p1', HOST, { stakeTxnId: 'wtx' }));
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { isBot: false, stakeTxnId: 'wtx' }),
        participant('pb', BOT, { isBot: true, stake: 0n }),
      ]);
      await service.forfeit(ACTOR, 'sess-1'); // HOST forfeits, only the bot remains
      expect(repo.closeSession).toHaveBeenCalledWith('sess-1', GameSessionStatus.CANCELLED, HOST);
      expect(repo.createMatchResult).not.toHaveBeenCalled(); // no settlement to a bot
    });

    it('lets the host relay a move on a bot’s behalf', async () => {
      repo.getParticipant.mockResolvedValue(participant('pb', BOT, { isBot: true }));
      // Turn ownership is the relay gate — relayMove rejects with
      // GAME_NOT_YOUR_TURN unless the mover is the current-turn seat. Seed the
      // live state so the bot actually holds the turn.
      const botTurn: GameLiveState = {
        currentTurnUserId: BOT,
        turnStartedAt: Date.now(),
        turnSeconds: GAME_TURN_SECONDS,
        seatOrder: [HOST, BOT],
        moves: [],
        isOver: false,
        timeoutCounts: {},
      };
      await cache.set(gameLiveStateKey('sess-1'), botTurn, GAME_LIVE_STATE_TTL_SECONDS);

      const res = (await service.relayMove(
        ACTOR,
        'sess-1',
        { action: 'roll_dice' },
        BOT,
      )) as Record<string, unknown>;
      expect(res).toMatchObject({ accepted: true });
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.move' }));
    });

    it('rejects a non-host relaying for a bot', async () => {
      await expect(
        service.relayMove({ id: P2, roles: ['USER'] }, 'sess-1', { action: 'roll_dice' }, BOT),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GAME_NOT_HOST });
    });
  });

  describe('presence auto-forfeit — forfeitOnDisconnect', () => {
    it('auto-forfeits a disconnected player who is in an active session', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue('sess-1');
      await service.forfeitOnDisconnect(HOST);
      expect(repo.findActiveSessionForParticipant).toHaveBeenCalledWith(HOST);
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'game.forfeited' }));
    });

    it('is a no-op when the player is not in any active session', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue(null);
      await service.forfeitOnDisconnect(HOST);
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'game.forfeited' }),
      );
    });

    it('swallows a forfeit error (e.g. the player already left the session)', async () => {
      repo.findActiveSessionForParticipant.mockResolvedValue('sess-1');
      repo.getParticipant.mockResolvedValue(null); // forfeit() throws GAME_NOT_PARTICIPANT
      await expect(service.forfeitOnDisconnect(HOST)).resolves.toBeUndefined();
    });
  });

  describe('player identity in views', () => {
    const BOT = '99999999-9999-9999-9999-999999999999';

    it('sessionView carries displayName + avatar for a human and botName/null for a bot', async () => {
      repo.getSession.mockResolvedValue(session());
      repo.listParticipants.mockResolvedValue([
        participant('p1', HOST, { isBot: false }),
        participant('pb', BOT, { isBot: true }),
      ]);
      // Bot display name comes from the lobby seat (participants have no name of
      // their own) — never from the identity resolver.
      repo.listMembersWithTeams.mockResolvedValue([
        { userId: HOST, team: null, isBot: false, botName: null },
        { userId: BOT, team: null, isBot: true, botName: 'Bot Alpha' },
      ]);
      profiles.resolvePublicIdentities.mockResolvedValue(
        new Map([[HOST, { displayName: 'Host Name', avatarUrl: 'https://cdn/host.png' }]]),
      );

      const view = (await service.getSession(ACTOR, 'sess-1')) as {
        participants: Record<string, unknown>[];
      };

      expect(view.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: HOST,
            displayName: 'Host Name',
            avatar: 'https://cdn/host.png',
          }),
          expect.objectContaining({ userId: BOT, displayName: 'Bot Alpha', avatar: null }),
        ]),
      );
      // Resolved ONCE, batched, with only the human id — bots are never looked up.
      expect(profiles.resolvePublicIdentities).toHaveBeenCalledTimes(1);
      expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith([HOST]);
    });

    it('lobbyView carries displayName + avatar for a human and botName/null for a bot', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.listMembersWithTeams.mockResolvedValue([
        { userId: HOST, team: null, isBot: false, botName: null },
        { userId: BOT, team: null, isBot: true, botName: 'Bot Beta' },
      ]);
      profiles.resolvePublicIdentities.mockResolvedValue(
        new Map([[HOST, { displayName: 'Host Name', avatarUrl: 'https://cdn/host.png' }]]),
      );

      const view = (await service.getLobby('ABCDEF')) as {
        memberDetails: Record<string, unknown>[];
      };

      expect(view.memberDetails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: HOST,
            displayName: 'Host Name',
            avatar: 'https://cdn/host.png',
          }),
          expect.objectContaining({ userId: BOT, displayName: 'Bot Beta', avatar: null }),
        ]),
      );
      // Resolved ONCE, batched, with only the human id — bots are never looked up.
      expect(profiles.resolvePublicIdentities).toHaveBeenCalledTimes(1);
      expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith([HOST]);
    });
  });
});
