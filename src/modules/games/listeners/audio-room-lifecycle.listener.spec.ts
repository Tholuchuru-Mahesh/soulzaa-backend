import { GameCode, GameSessionStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_EVENTS,
  RoomEndedEvent,
  RoomOwnershipTransferredEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { GamesRepository } from '../repositories/games.repository';
import { GamesService } from '../services/games.service';
import { AudioRoomLifecycleListener } from './audio-room-lifecycle.listener';

function activeSession(code: GameCode, overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    definitionId: 'def-1',
    code,
    lobbyId: 'lobby-1',
    joinCode: 'ABCDEF',
    hostId: 'host-1',
    roomId: 'room-1',
    category: 'PREMIUM',
    currency: 'GOLD',
    stake: 100n,
    playerCount: 2,
    potAmount: 200n,
    status: GameSessionStatus.ACTIVE,
    startedAt: new Date(),
    settledAt: null,
    ...overrides,
  };
}

describe('AudioRoomLifecycleListener', () => {
  let bus: { subscribe: jest.Mock };
  let repo: Record<string, jest.Mock>;
  let games: Record<string, jest.Mock>;
  let listener: AudioRoomLifecycleListener;
  let endHandler: (e: RoomEndedEvent) => void;
  let transferHandler: (e: RoomOwnershipTransferredEvent) => void;

  beforeEach(() => {
    bus = { subscribe: jest.fn() };
    repo = { findActiveSessionForRoom: jest.fn().mockResolvedValue(null) };
    games = {
      abortSession: jest.fn().mockResolvedValue({ refunded: [] }),
      closeRoomBoundLobby: jest.fn().mockResolvedValue(undefined),
      repointRoomGameHost: jest.fn().mockResolvedValue(undefined),
    };
    listener = new AudioRoomLifecycleListener(
      bus as unknown as IEventBus,
      repo as unknown as GamesRepository,
      games as unknown as GamesService,
    );
    listener.onModuleInit();
    endHandler = bus.subscribe.mock.calls[0][1];
    transferHandler = bus.subscribe.mock.calls[1][1];
  });

  const endRoom = (roomId: string) =>
    endHandler(new RoomEndedEvent({ roomId, actorId: 'a', ownerId: 'o', durationSeconds: 10 }));

  const transferOwnership = (roomId: string, newOwnerId: string) =>
    transferHandler(
      new RoomOwnershipTransferredEvent({
        roomId,
        previousOwnerId: 'old',
        newOwnerId,
        actorId: 'actor',
      }),
    );

  it('subscribes to the room-ended and ownership-transferred events', () => {
    expect(bus.subscribe).toHaveBeenCalledWith(AUDIO_ROOM_EVENTS.ENDED, expect.any(Function));
    expect(bus.subscribe).toHaveBeenCalledWith(
      AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      expect.any(Function),
    );
  });

  it('aborts the room-bound active board-game session on room end', async () => {
    repo.findActiveSessionForRoom.mockResolvedValue(activeSession(GameCode.GREEDY));
    await endRoom('room-1');
    await new Promise((r) => setImmediate(r));
    expect(games.abortSession).toHaveBeenCalledWith(
      'sess-1',
      GameSessionStatus.ABORTED,
      null,
      'room_ended',
    );
  });

  it('closes the room-bound open lobby on room end even when no session exists', async () => {
    repo.findActiveSessionForRoom.mockResolvedValue(null);
    await endRoom('room-1');
    await new Promise((r) => setImmediate(r));
    expect(games.abortSession).not.toHaveBeenCalled();
    expect(games.closeRoomBoundLobby).toHaveBeenCalledWith('room-1');
  });

  it('aborts a board session AND closes the open lobby on room end', async () => {
    repo.findActiveSessionForRoom.mockResolvedValue(activeSession(GameCode.LUDO));
    await endRoom('room-1');
    await new Promise((r) => setImmediate(r));
    expect(games.abortSession).toHaveBeenCalled();
    expect(games.closeRoomBoundLobby).toHaveBeenCalledWith('room-1');
  });

  it('does not touch casino window sessions (GREEDY_FOOD / LUCKY_FRUIT)', async () => {
    repo.findActiveSessionForRoom.mockResolvedValue(activeSession(GameCode.GREEDY_FOOD));
    await endRoom('room-1');
    await new Promise((r) => setImmediate(r));
    expect(games.abortSession).not.toHaveBeenCalled();
    expect(games.closeRoomBoundLobby).toHaveBeenCalledWith('room-1');

    repo.findActiveSessionForRoom.mockResolvedValue(activeSession(GameCode.LUCKY_FRUIT));
    await endRoom('room-1');
    await new Promise((r) => setImmediate(r));
    expect(games.abortSession).not.toHaveBeenCalled();
  });

  it('re-points the room-bound board game host on ownership transfer', async () => {
    await transferOwnership('room-1', 'new-owner');
    await new Promise((r) => setImmediate(r));
    expect(games.repointRoomGameHost).toHaveBeenCalledWith('room-1', 'new-owner');
  });

  it('logs a warning instead of throwing when abort already raced the session away', async () => {
    repo.findActiveSessionForRoom.mockResolvedValue(activeSession(GameCode.GREEDY));
    games.abortSession.mockRejectedValue(new Error('Session is not active.'));
    expect(() => endRoom('room-1')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it('logs a warning instead of throwing when the lobby close fails', async () => {
    games.closeRoomBoundLobby.mockRejectedValue(new Error('lobby gone'));
    expect(() => endRoom('room-1')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it('logs a warning instead of throwing when the host re-point fails', async () => {
    games.repointRoomGameHost.mockRejectedValue(new Error('session gone'));
    expect(() => transferOwnership('room-1', 'new-owner')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
