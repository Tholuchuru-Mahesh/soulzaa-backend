import { CasinoGame, GameCode, GameSession } from '@prisma/client';
import { type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  AUDIO_ROOM_EVENTS,
  RoomDeletedEvent,
  RoomEndedEvent,
  RoomOwnershipTransferredEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { GAMES_NAMESPACE } from 'src/modules/games/constants/games.constants';
import { GamesRepository } from 'src/modules/games/repositories/games.repository';
import {
  CASINO_ROUND_BROADCAST,
  CasinoRoundBroadcastEvent,
} from '../events/casino-round-broadcast.event';
import { RoomCasinoWindowService } from '../services/room-casino-window.service';
import { RoomCasinoWindowListener } from './room-casino-window.listener';

function windowSession(overrides: Partial<GameSession> = {}): GameSession {
  return {
    id: 'sess-1',
    definitionId: 'def',
    code: GameCode.GREEDY_FOOD,
    lobbyId: null,
    joinCode: 'ABCDEF',
    hostId: 'host-1',
    roomId: 'room-1',
    category: 'PREMIUM',
    currency: 'GOLD',
    stake: 0n,
    playerCount: 0,
    mode: 'CLASSIC',
    carromMode: 'classic',
    teamCoinAssignment: 'team_a_white',
    potAmount: 0n,
    status: 'ACTIVE',
    startedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
    settledAt: null,
    createdBy: 'host-1',
    updatedBy: null,
    ...overrides,
  } as unknown as GameSession;
}

function makeListener() {
  const handlers = new Map<string, (e: unknown) => void | Promise<void>>();
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn((name: string, handler: (e: unknown) => void | Promise<void>) => {
      handlers.set(name, handler);
      return () => undefined;
    }),
  };

  const sockets = {
    emitToNamespaceRoom: jest.fn(),
  };

  const repo = {
    listActiveRoomWindowsByCode: jest.fn().mockResolvedValue([]),
    findActiveSessionForRoom: jest.fn().mockResolvedValue(null),
  };

  const windows = {
    closeWindow: jest.fn().mockResolvedValue({ ok: true }),
    onOwnerChanged: jest.fn().mockResolvedValue(undefined),
  };

  const listener = new RoomCasinoWindowListener(
    bus as unknown as IEventBus,
    sockets as unknown as SocketManager,
    repo as unknown as GamesRepository,
    windows as unknown as RoomCasinoWindowService,
  );
  listener.onModuleInit();

  return { listener, handlers, bus, sockets, repo, windows };
}

describe('RoomCasinoWindowListener — spectator mirror', () => {
  it('registers handlers for CASINO_ROUND_BROADCAST, ENDED, DELETED and OWNERSHIP_TRANSFERRED', () => {
    const { handlers } = makeListener();
    expect(handlers.has(CASINO_ROUND_BROADCAST)).toBe(true);
    expect(handlers.has(AUDIO_ROOM_EVENTS.ENDED)).toBe(true);
    expect(handlers.has(AUDIO_ROOM_EVENTS.DELETED)).toBe(true);
    expect(handlers.has(AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED)).toBe(true);
  });

  it('re-emits a global casino broadcast into every active window room on the /games namespace', async () => {
    const { handlers, sockets, repo } = makeListener();
    repo.listActiveRoomWindowsByCode.mockResolvedValue([
      windowSession({ id: 'win-1', roomId: 'room-1' }),
      windowSession({ id: 'win-2', roomId: 'room-2' }),
    ]);

    const payload = { roundId: 'round-9', phase: 'spinning', secondsRemaining: 10 };
    await handlers.get(CASINO_ROUND_BROADCAST)!(
      new CasinoRoundBroadcastEvent({
        game: CasinoGame.GREEDY_FOOD,
        event: 'greedy_food_spin',
        payload,
      }),
    );

    expect(repo.listActiveRoomWindowsByCode).toHaveBeenCalledWith(GameCode.GREEDY_FOOD);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      GAMES_NAMESPACE,
      'win-1',
      'greedy_food_spin',
      payload,
    );
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      GAMES_NAMESPACE,
      'win-2',
      'greedy_food_spin',
      payload,
    );
  });

  it('emits nothing when no window is active for that game', async () => {
    const { handlers, sockets, repo } = makeListener();
    repo.listActiveRoomWindowsByCode.mockResolvedValue([]);
    await handlers.get(CASINO_ROUND_BROADCAST)!(
      new CasinoRoundBroadcastEvent({
        game: CasinoGame.LUCKY_FRUIT,
        event: 'lucky_fruit_tick',
        payload: {},
      }),
    );
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });
});

describe('RoomCasinoWindowListener — room ended', () => {
  it('closes the room casino window (actorId null — no owner check)', async () => {
    const { handlers, repo, windows } = makeListener();
    repo.findActiveSessionForRoom.mockResolvedValue(windowSession({ id: 'win-1' }));

    await handlers.get(AUDIO_ROOM_EVENTS.ENDED)!(
      new RoomEndedEvent({
        roomId: 'room-1',
        actorId: 'x',
        ownerId: 'host-1',
        durationSeconds: 60,
      }),
    );

    expect(repo.findActiveSessionForRoom).toHaveBeenCalledWith('room-1');
    expect(windows.closeWindow).toHaveBeenCalledWith('room-1', null);
  });

  it('does not touch a board-game session (LUDO) on room end', async () => {
    const { handlers, repo, windows } = makeListener();
    repo.findActiveSessionForRoom.mockResolvedValue(
      windowSession({ id: 'win-1', code: GameCode.LUDO }),
    );

    await handlers.get(AUDIO_ROOM_EVENTS.ENDED)!(
      new RoomEndedEvent({
        roomId: 'room-1',
        actorId: 'x',
        ownerId: 'host-1',
        durationSeconds: 60,
      }),
    );

    expect(windows.closeWindow).not.toHaveBeenCalled();
  });

  it('is a no-op when the room has no active session', async () => {
    const { handlers, windows } = makeListener();
    await handlers.get(AUDIO_ROOM_EVENTS.ENDED)!(
      new RoomEndedEvent({
        roomId: 'room-1',
        actorId: 'x',
        ownerId: 'host-1',
        durationSeconds: 60,
      }),
    );
    expect(windows.closeWindow).not.toHaveBeenCalled();
  });
});

describe('RoomCasinoWindowListener — room deleted', () => {
  it('closes the room casino window on an admin DELETED (actorId null — no owner check)', async () => {
    const { handlers, repo, windows } = makeListener();
    repo.findActiveSessionForRoom.mockResolvedValue(windowSession({ id: 'win-1' }));

    await handlers.get(AUDIO_ROOM_EVENTS.DELETED)!(
      new RoomDeletedEvent({ roomId: 'room-1', actorId: 'admin', ownerId: 'host-1' }),
    );

    expect(repo.findActiveSessionForRoom).toHaveBeenCalledWith('room-1');
    expect(windows.closeWindow).toHaveBeenCalledWith('room-1', null);
  });

  it('does not touch a board-game session (LUDO) on room delete', async () => {
    const { handlers, repo, windows } = makeListener();
    repo.findActiveSessionForRoom.mockResolvedValue(
      windowSession({ id: 'win-1', code: GameCode.LUDO }),
    );

    await handlers.get(AUDIO_ROOM_EVENTS.DELETED)!(
      new RoomDeletedEvent({ roomId: 'room-1', actorId: 'admin', ownerId: 'host-1' }),
    );

    expect(windows.closeWindow).not.toHaveBeenCalled();
  });
});

describe('RoomCasinoWindowListener — ownership transferred', () => {
  it('re-points the active window host to the new room owner', async () => {
    const { handlers, windows } = makeListener();

    await handlers.get(AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED)!(
      new RoomOwnershipTransferredEvent({
        roomId: 'room-1',
        previousOwnerId: 'host-1',
        newOwnerId: 'host-2',
        actorId: 'host-1',
      }),
    );

    expect(windows.onOwnerChanged).toHaveBeenCalledWith('room-1', 'host-2');
    expect(windows.closeWindow).not.toHaveBeenCalled();
  });
});
