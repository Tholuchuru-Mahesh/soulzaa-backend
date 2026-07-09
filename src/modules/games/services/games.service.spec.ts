import {
  GameCategory,
  GameCode,
  GameCurrency,
  GameLobbyStatus,
  GameParticipantStatus,
  GameSessionStatus,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { QueueService } from 'src/infra/queue/queue.service';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesRepository } from '../repositories/games.repository';
import { GamesService } from './games.service';

const HOST = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';
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
    };
    locks = {
      withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()),
      acquire: jest.fn().mockResolvedValue(async () => undefined),
    };
    cache = { addScore: jest.fn().mockResolvedValue(1), top: jest.fn().mockResolvedValue([]) };
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
    service = new GamesService(
      repo as unknown as GamesRepository,
      locks as unknown as LockService,
      cache as unknown as CacheService,
      queue as unknown as QueueService,
      bus,
      wallet as unknown as IWalletService,
      users as unknown as IUsersService,
    );
  });

  describe('createLobby', () => {
    it('creates a lobby, adds the host, and broadcasts', async () => {
      await service.createLobby(ACTOR, { gameCode: GameCode.GREEDY, stake: 500 });
      expect(repo.createLobby).toHaveBeenCalled();
      expect(repo.addMember).toHaveBeenCalledWith('lobby-1', HOST);
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
      expect(repo.addMember).toHaveBeenCalledWith('lobby-1', P2);
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

    it('refunds and aborts if a stake debit fails', async () => {
      wallet.debit
        .mockResolvedValueOnce({ transactionId: 'wtx', balanceAfter: 0, duplicate: false })
        .mockRejectedValueOnce(new BusinessException(ERROR_CODES.INSUFFICIENT_BALANCE, 'no funds'));
      await expect(service.startLobby(ACTOR, 'ABCDEF')).rejects.toBeInstanceOf(BusinessException);
      expect(wallet.credit).toHaveBeenCalledTimes(1); // refund the one already escrowed
      expect(repo.closeSession).toHaveBeenCalledWith('sess-1', GameSessionStatus.ABORTED, HOST);
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
      );
      expect(repo.createMatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ payoutTotal: 150n, rakeAmount: 50n, winners: [HOST] }),
      );
      expect(repo.completeSession).toHaveBeenCalledWith('sess-1', ADMIN.id);
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
});
