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
