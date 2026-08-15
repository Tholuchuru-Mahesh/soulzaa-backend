import { HttpStatus } from '@nestjs/common';
import { CasinoGame, GameCode, GameSession, GameSessionStatus } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import { GamesRepository } from 'src/modules/games/repositories/games.repository';
import { AudioRoomGameAuthzService } from 'src/modules/games/services/audio-room-game-authz.service';
import { WALLET_SERVICE, type IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CasinoRepository } from '../repositories/casino.repository';
import { CasinoLoopService } from './casino-loop.service';
import { CasinoError, CasinoService } from './casino.service';
import { RoomCasinoWindowService } from './room-casino-window.service';

const ROOM = 'room-1';
const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const NEW_OWNER = '33333333-3333-3333-3333-333333333333';

/** A minimal GameSession double with the fields the service reads. */
function windowSession(overrides: Partial<GameSession> = {}): GameSession {
  return {
    id: 'sess-1',
    definitionId: 'def-greedy',
    code: GameCode.GREEDY_FOOD,
    lobbyId: null,
    joinCode: 'ABCDEF',
    hostId: OWNER,
    roomId: ROOM,
    category: 'PREMIUM',
    currency: 'GOLD',
    stake: 0n,
    playerCount: 0,
    mode: 'CLASSIC',
    carromMode: 'classic',
    teamCoinAssignment: 'team_a_white',
    potAmount: 0n,
    status: GameSessionStatus.ACTIVE,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    cancelledAt: null,
    settledAt: null,
    createdBy: OWNER,
    updatedBy: null,
    ...overrides,
  } as unknown as GameSession;
}

function makeService() {
  const authz = {
    assertCanStartCasinoWindow: jest.fn().mockResolvedValue(undefined),
    assertCanWatch: jest.fn().mockResolvedValue(undefined),
    isMember: jest.fn().mockResolvedValue(true),
  };

  const rooms = {
    getOwnerId: jest.fn().mockResolvedValue(OWNER),
    isRoomLive: jest.fn().mockResolvedValue(true),
    isMember: jest.fn().mockResolvedValue(true),
    assertMember: jest.fn().mockResolvedValue(undefined),
    getEffectiveRole: jest.fn().mockResolvedValue(null),
  };

  const games = {
    getDefinitionByCode: jest
      .fn()
      .mockResolvedValue({ id: 'def-greedy', code: GameCode.GREEDY_FOOD }),
    findActiveSessionForRoom: jest.fn().mockResolvedValue(null),
    createSession: jest.fn((data: Record<string, unknown>) =>
      Promise.resolve(windowSession({ hostId: (data.hostId as string) ?? OWNER })),
    ),
    completeSession: jest.fn((_id: string) =>
      Promise.resolve(windowSession({ status: GameSessionStatus.COMPLETED })),
    ),
    listActiveRoomWindows: jest.fn().mockResolvedValue([]),
    updateSessionHost: jest.fn((_id: string, hostId: string) =>
      Promise.resolve(windowSession({ hostId })),
    ),
  };

  const repo = {
    listUserBets: jest.fn().mockResolvedValue([]),
    listPlacedBets: jest.fn().mockResolvedValue([]),
  };

  const casino = {
    placeBet: jest
      .fn()
      .mockResolvedValue({ balanceAfter: 9900, betId: 'bet-1' }),
  };

  const loop = {
    getState: jest.fn().mockReturnValue({
      roundId: 'round-1',
      roundNumber: 7,
      phase: 'betting',
      secondsRemaining: 30,
      winningOutcome: null,
      history: [],
      lastWinners: [],
      poolBets: {},
    }),
  };

  const locks = {
    withLock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  };

  const wallet = {
    getBalance: jest.fn().mockResolvedValue({ gold: 5000, free: 0, game: 0 }),
  };

  const svc = new RoomCasinoWindowService(
    authz as unknown as AudioRoomGameAuthzService,
    rooms as unknown as IAudioRoomsService,
    games as unknown as GamesRepository,
    repo as unknown as CasinoRepository,
    casino as unknown as CasinoService,
    loop as unknown as CasinoLoopService,
    locks as unknown as LockService,
    wallet as unknown as IWalletService,
  );

  return { svc, authz, rooms, games, repo, casino, loop, locks, wallet };
}

describe('RoomCasinoWindowService — startWindow', () => {
  it('creates a room-bound ACTIVE GameSession marker for the owner, no stake/participants', async () => {
    const { svc, games, locks } = makeService();
    const result = await svc.startWindow(ROOM, OWNER, CasinoGame.GREEDY_FOOD);

    expect(locks.withLock).toHaveBeenCalled();
    expect(games.findActiveSessionForRoom).toHaveBeenCalledWith(ROOM);
    expect(games.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        code: GameCode.GREEDY_FOOD,
        hostId: OWNER,
        roomId: ROOM,
        stake: 0n,
        playerCount: 0,
        status: GameSessionStatus.ACTIVE,
      }),
    );
    expect(result).toMatchObject({
      sessionId: 'sess-1',
      game: GameCode.GREEDY_FOOD,
      roomId: ROOM,
      hostId: OWNER,
      status: GameSessionStatus.ACTIVE,
    });
  });

  it('rejects a non-owner up front (authz throws)', async () => {
    const { svc, authz } = makeService();
    authz.assertCanStartCasinoWindow.mockRejectedValue(
      new BusinessException(ERROR_CODES.GAME_NOT_AUTHORIZED, 'no', HttpStatus.FORBIDDEN),
    );
    await expect(svc.startWindow(ROOM, OTHER, CasinoGame.LUCKY_FRUIT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
    });
    expect(authz.assertCanStartCasinoWindow).toHaveBeenCalledWith(ROOM, OTHER);
  });

  it('rejects with GAME_ROOM_ALREADY_ACTIVE when another game (or window) is already active in the room', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(
      windowSession({ code: GameCode.LUDO, hostId: OWNER }),
    );
    await expect(svc.startWindow(ROOM, OWNER, CasinoGame.GREEDY_FOOD)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_ROOM_ALREADY_ACTIVE,
      status: HttpStatus.CONFLICT,
    });
    expect(games.createSession).not.toHaveBeenCalled();
  });

  it('rejects when the game definition is not in the catalog', async () => {
    const { svc, games } = makeService();
    games.getDefinitionByCode.mockResolvedValue(null);
    await expect(svc.startWindow(ROOM, OWNER, CasinoGame.GREEDY_FOOD)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_NOT_FOUND,
    });
    expect(games.createSession).not.toHaveBeenCalled();
  });
});

describe('RoomCasinoWindowService — closeWindow', () => {
  it('completes the window when the room owner closes it', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession());
    await expect(svc.closeWindow(ROOM, OWNER)).resolves.toEqual({ ok: true });
    expect(games.completeSession).toHaveBeenCalledWith('sess-1', OWNER);
  });

  it('rejects a non-owner', async () => {
    const { svc, rooms } = makeService();
    rooms.getOwnerId.mockResolvedValue(OWNER);
    await expect(svc.closeWindow(ROOM, OTHER)).rejects.toMatchObject({
      errorCode: ERROR_CODES.NOT_ROOM_OWNER,
      status: HttpStatus.FORBIDDEN,
    });
  });

  it('skips the owner check for the room-ended path (actorId null)', async () => {
    const { svc, rooms, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession());
    await expect(svc.closeWindow(ROOM, null)).resolves.toEqual({ ok: true });
    expect(rooms.getOwnerId).not.toHaveBeenCalled();
    expect(games.completeSession).toHaveBeenCalledWith('sess-1', null);
  });

  it('is a no-op NOT_FOUND when no casino window is active', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession({ code: GameCode.LUDO }));
    await expect(svc.closeWindow(ROOM, OWNER)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_SESSION_NOT_FOUND,
    });
    expect(games.completeSession).not.toHaveBeenCalled();
  });
});

describe('RoomCasinoWindowService — placeHostBet', () => {
  const betDto = {
    game: CasinoGame.GREEDY_FOOD,
    roundId: 'round-1',
    item: 'crab',
    amount: 500,
    clientBetId: 'tap-1',
  };

  it('delegates to the existing CasinoService.placeBet (authoritative path) and returns the ack', async () => {
    const { svc, games, casino, loop } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession());
    const result = await svc.placeHostBet(ROOM, OWNER, betDto);

    expect(casino.placeBet).toHaveBeenCalledWith({
      userId: OWNER,
      game: CasinoGame.GREEDY_FOOD,
      roundId: 'round-1',
      item: 'crab',
      amount: 500,
      activeRoundId: 'round-1',
      phase: 'betting',
      clientBetId: 'tap-1',
    });
    expect(loop.getState).toHaveBeenCalledWith(CasinoGame.GREEDY_FOOD);
    expect(result).toEqual({ balanceAfter: 9900, betId: 'bet-1', roundId: 'round-1' });
  });

  it('rejects a room member who is not the window host', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession({ hostId: OTHER }));
    await expect(svc.placeHostBet(ROOM, OWNER, betDto)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
      status: HttpStatus.FORBIDDEN,
    });
  });

  it('rejects when the window is for a different game', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(
      windowSession({ code: GameCode.LUCKY_FRUIT, hostId: OWNER }),
    );
    await expect(svc.placeHostBet(ROOM, OWNER, betDto)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_SESSION_NOT_FOUND,
    });
  });

  it('maps CasinoError to a structured CASINO_BET_INVALID 400 (e.g. betting locked)', async () => {
    const { svc, games, casino } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession());
    casino.placeBet.mockRejectedValue(new CasinoError('Betting is locked for this round'));
    await expect(svc.placeHostBet(ROOM, OWNER, betDto)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CASINO_BET_INVALID,
      status: HttpStatus.BAD_REQUEST,
      message: 'Betting is locked for this round',
    });
  });
});

describe('RoomCasinoWindowService — getWindow', () => {
  it('rejects a non-member (assertCanWatch throws NOT_ROOM_MEMBER)', async () => {
    const { svc, authz } = makeService();
    authz.assertCanWatch.mockRejectedValue(
      new BusinessException(ERROR_CODES.NOT_ROOM_MEMBER, 'not a member', HttpStatus.FORBIDDEN),
    );
    await expect(svc.getWindow(ROOM, OTHER)).rejects.toMatchObject({
      errorCode: ERROR_CODES.NOT_ROOM_MEMBER,
    });
    expect(authz.assertCanWatch).toHaveBeenCalledWith(ROOM, OTHER);
  });

  it('returns the authoritative round snapshot, host bets, host balance and pool for a member', async () => {
    const { svc, games, repo, wallet } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession());
    repo.listUserBets.mockResolvedValue([{ betItem: 'crab', betAmount: 500n }]);
    repo.listPlacedBets.mockResolvedValue([
      { betItem: 'crab', betAmount: 500n },
      { betItem: 'carrot', betAmount: 100n },
    ]);
    wallet.getBalance.mockResolvedValue({ gold: 4500, free: 0, game: 0 });

    const result = await svc.getWindow(ROOM, OWNER);
    expect(result).toMatchObject({
      window: { sessionId: 'sess-1', game: GameCode.GREEDY_FOOD, hostId: OWNER },
      roundId: 'round-1',
      roundNumber: 7,
      phase: 'betting',
      secondsRemaining: 30,
      pool: { crab: 500, carrot: 100 },
      hostBets: [{ item: 'crab', amount: 500 }],
      hostBalance: 4500,
    });
  });

  it('returns NOT_FOUND when no casino window is active in the room', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(null);
    await expect(svc.getWindow(ROOM, OWNER)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GAME_SESSION_NOT_FOUND,
    });
  });
});

describe('RoomCasinoWindowService — onOwnerChanged', () => {
  it('re-points the active casino window host to the new room owner', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession({ id: 'sess-1' }));

    await svc.onOwnerChanged(ROOM, NEW_OWNER);

    expect(games.findActiveSessionForRoom).toHaveBeenCalledWith(ROOM);
    expect(games.updateSessionHost).toHaveBeenCalledWith('sess-1', NEW_OWNER);
  });

  it('is a no-op when the room has no active window', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(null);

    await svc.onOwnerChanged(ROOM, NEW_OWNER);

    expect(games.updateSessionHost).not.toHaveBeenCalled();
  });

  it('is a no-op when the room is running a board game (LUDO)', async () => {
    const { svc, games } = makeService();
    games.findActiveSessionForRoom.mockResolvedValue(windowSession({ code: GameCode.LUDO }));

    await svc.onOwnerChanged(ROOM, NEW_OWNER);

    expect(games.updateSessionHost).not.toHaveBeenCalled();
  });
});

describe('RoomCasinoWindowService — sweepOrphanWindows', () => {
  it('closes every active window whose audio room is no longer live', async () => {
    const { svc, games, rooms } = makeService();
    games.listActiveRoomWindows.mockResolvedValue([
      windowSession({ id: 'win-1', roomId: ROOM }),
      windowSession({ id: 'win-2', roomId: 'room-dead' }),
    ]);
    rooms.isRoomLive.mockImplementation(async (roomId: string) => roomId === ROOM);
    games.findActiveSessionForRoom.mockImplementation(async (roomId: string) =>
      roomId === 'room-dead' ? windowSession({ id: 'win-2', roomId: 'room-dead' }) : null,
    );

    const closed = await svc.sweepOrphanWindows();

    expect(closed).toBe(1);
    expect(games.completeSession).toHaveBeenCalledWith('win-2', null);
  });

  it('closes nothing when every window room is still live', async () => {
    const { svc, games, rooms } = makeService();
    games.listActiveRoomWindows.mockResolvedValue([
      windowSession({ id: 'win-1', roomId: ROOM }),
      windowSession({ id: 'win-2', roomId: 'room-2' }),
    ]);
    rooms.isRoomLive.mockResolvedValue(true);

    const closed = await svc.sweepOrphanWindows();

    expect(closed).toBe(0);
    expect(games.completeSession).not.toHaveBeenCalled();
  });

  it('continues past a window that raced to an already-closed state', async () => {
    const { svc, games, rooms } = makeService();
    games.listActiveRoomWindows.mockResolvedValue([
      windowSession({ id: 'win-gone', roomId: 'room-gone' }),
      windowSession({ id: 'win-dead', roomId: 'room-dead' }),
    ]);
    rooms.isRoomLive.mockResolvedValue(false);
    games.findActiveSessionForRoom.mockImplementation(async (roomId: string) =>
      roomId === 'room-dead' ? windowSession({ id: 'win-dead', roomId: 'room-dead' }) : null,
    );

    const closed = await svc.sweepOrphanWindows();

    expect(closed).toBe(1);
    expect(games.completeSession).toHaveBeenCalledWith('win-dead', null);
  });
});
