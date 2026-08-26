import { SocketManager } from './socket.manager';

describe('SocketManager — incognito moderator join/leave', () => {
  let presence: Record<string, jest.Mock>;
  let manager: SocketManager;

  function makeClient(userId: string, roles: string[]) {
    const rooms = new Set<string>();
    return {
      id: `socket-${userId}`,
      data: { user: { id: userId, roles } },
      join: jest.fn(async (roomId: string) => {
        rooms.add(roomId);
      }),
      leave: jest.fn(async (roomId: string) => {
        rooms.delete(roomId);
      }),
      to: jest.fn(() => ({ emit: jest.fn() })),
    };
  }

  beforeEach(() => {
    presence = {
      joinRoom: jest.fn().mockResolvedValue(undefined),
      leaveRoom: jest.fn().mockResolvedValue(undefined),
    };
    manager = new SocketManager(
      {} as never, // tokenService — unused by joinRoom/leaveRoom
      presence as never,
      {} as never, // metrics
      {} as never, // event bus
      {} as never, // roleSource
      new Map() as never, // joinPolicies — empty, every namespace joins unconditionally
    );
  });

  describe('joinRoom', () => {
    it('a regular user in /audio-room is added to public presence and announced', async () => {
      const client = makeClient('user-1', ['USER']);
      const ok = await manager.joinRoom(client as never, 'room-1', '/audio-room');

      expect(ok).toBe(true);
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', 'user-1');
      expect(client.to).toHaveBeenCalledWith('room-1');
    });

    it('a MODERATOR in /audio-room is added to moderator-only presence and never announced', async () => {
      const client = makeClient('mod-1', ['MODERATOR']);
      const ok = await manager.joinRoom(client as never, 'room-1', '/audio-room');

      expect(ok).toBe(true);
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', 'mod-1', true);
      expect(client.to).not.toHaveBeenCalled();
    });

    it('an ADMIN in /video-room is incognito too', async () => {
      const client = makeClient('admin-1', ['ADMIN']);
      await manager.joinRoom(client as never, 'room-2', '/video-room');

      expect(presence.joinRoom).toHaveBeenCalledWith('room-2', 'admin-1', true);
      expect(client.to).not.toHaveBeenCalled();
    });

    it('a SUPER_ADMIN in /live is incognito too', async () => {
      const client = makeClient('super-1', ['SUPER_ADMIN']);
      await manager.joinRoom(client as never, 'stream-1', '/live');

      expect(presence.joinRoom).toHaveBeenCalledWith('stream-1', 'super-1', true);
      expect(client.to).not.toHaveBeenCalled();
    });

    it('a MODERATOR in /chat (out of scope namespace) is NOT made incognito', async () => {
      const client = makeClient('mod-1', ['MODERATOR']);
      await manager.joinRoom(client as never, 'room-1', '/chat');

      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', 'mod-1');
      expect(client.to).toHaveBeenCalledWith('room-1');
    });

    it('a MODERATOR with no namespace argument is NOT made incognito (unchanged legacy behavior)', async () => {
      const client = makeClient('mod-1', ['MODERATOR']);
      await manager.joinRoom(client as never, 'room-1');

      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', 'mod-1');
      expect(client.to).toHaveBeenCalledWith('room-1');
    });
  });

  describe('leaveRoom', () => {
    it('a regular user leaving /audio-room is removed from public presence and announced', async () => {
      const client = makeClient('user-1', ['USER']);
      await manager.leaveRoom(client as never, 'room-1', '/audio-room');

      expect(presence.leaveRoom).toHaveBeenCalledWith('room-1', 'user-1');
      expect(client.to).toHaveBeenCalledWith('room-1');
    });

    it('a MODERATOR leaving /audio-room is removed from moderator presence and never announced', async () => {
      const client = makeClient('mod-1', ['MODERATOR']);
      await manager.leaveRoom(client as never, 'room-1', '/audio-room');

      expect(presence.leaveRoom).toHaveBeenCalledWith('room-1', 'mod-1', true);
      expect(client.to).not.toHaveBeenCalled();
    });
  });
});

describe('SocketManager — namespace-scoped user targeting', () => {
  let manager: SocketManager;

  beforeEach(() => {
    manager = new SocketManager(
      {} as never, // tokenService
      {} as never, // presence
      {} as never, // metrics
      {} as never, // event bus
      {} as never, // roleSource
      new Map() as never, // joinPolicies
    );
  });

  describe('emitToUserInNamespace', () => {
    it('emits only to the target user within the given namespace', () => {
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      const server = { name: '/live', to } as never;
      manager.registerServer(server);

      manager.emitToUserInNamespace('/live', 'user-1', 'user.warned', { reason: 'be nice' });

      expect(to).toHaveBeenCalledWith('user:user-1');
      expect(emit).toHaveBeenCalledWith('user.warned', { reason: 'be nice' });
    });

    it('is a no-op when the namespace has not registered a server yet', () => {
      expect(() =>
        manager.emitToUserInNamespace('/live', 'user-1', 'user.warned', {}),
      ).not.toThrow();
    });
  });
});

describe('SocketManager — socket-only lobby channels never raise room domain events', () => {
  // A real audio room; every persisted room id is a `@db.Uuid` column.
  const ROOM_UUID = '11111111-1111-4111-8111-111111111111';
  // The casino's permanent broadcast channels. Socket names only — no DB row.
  const CASINO_LOBBY = 'greedy_food_global';

  let presence: Record<string, jest.Mock>;
  let bus: { publish: jest.Mock };
  let manager: SocketManager;

  function makeClient(userId: string) {
    return {
      id: `socket-${userId}`,
      data: { user: { id: userId, roles: ['USER'] } },
      join: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
      to: jest.fn(() => ({ emit: jest.fn() })),
    };
  }

  function publishedNames(): string[] {
    return bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);
  }

  beforeEach(() => {
    presence = {
      joinRoom: jest.fn().mockResolvedValue(undefined),
      leaveRoom: jest.fn().mockResolvedValue(undefined),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    manager = new SocketManager(
      {} as never,
      presence as never,
      {} as never,
      bus as never,
      {} as never,
      new Map() as never,
    );
  });

  it('publishes the join domain events for a real room', async () => {
    await manager.joinRoom(makeClient('user-1') as never, ROOM_UUID, '/audio-room');

    expect(publishedNames()).toEqual(expect.arrayContaining(['audio_room.joined', 'room.joined']));
  });

  it('publishes NOTHING for a casino lobby channel', async () => {
    // REGRESSION: `room.joined` is the same event name as
    // AUDIO_ROOM_EVENTS.JOINED, so publishing it here ran the analytics
    // visitor insert, the presence `currentRoomId` upsert and the member
    // roster query against UUID columns with the literal string
    // 'greedy_food_global' — Postgres: "Error creating UUID ... found `g` at 1".
    await manager.joinRoom(makeClient('user-1') as never, CASINO_LOBBY, '/casino');

    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('still joins the socket channel and Redis presence for a lobby', async () => {
    // The realtime path must be untouched — this is how a casino watcher
    // receives the host's live ticks.
    const client = makeClient('user-1');
    const ok = await manager.joinRoom(client as never, CASINO_LOBBY, '/casino');

    expect(ok).toBe(true);
    expect(client.join).toHaveBeenCalledWith(CASINO_LOBBY);
    expect(presence.joinRoom).toHaveBeenCalledWith(CASINO_LOBBY, 'user-1');
  });

  it('publishes no leave/duration events for a lobby, but still leaves it', async () => {
    const client = makeClient('user-1');
    await manager.joinRoom(client as never, CASINO_LOBBY, '/casino');
    bus.publish.mockClear();

    await manager.leaveRoom(client as never, CASINO_LOBBY, '/casino');

    expect(bus.publish).not.toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith(CASINO_LOBBY);
    expect(presence.leaveRoom).toHaveBeenCalledWith(CASINO_LOBBY, 'user-1');
  });

  it('publishes the leave domain event for a real room', async () => {
    const client = makeClient('user-1');
    await manager.joinRoom(client as never, ROOM_UUID, '/audio-room');
    bus.publish.mockClear();

    await manager.leaveRoom(client as never, ROOM_UUID, '/audio-room');

    expect(publishedNames()).toEqual(
      expect.arrayContaining(['room.duration_updated', 'audio_room.left']),
    );
  });
});
