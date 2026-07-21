import { VideoRoomMemberRole } from '@prisma/client';
import { VIDEO_ROOM_ROLE_EVENTS } from '../events/video-room-role.events';
import { VideoRoomRoleSocketListener } from './video-room-role-socket.listener';

describe('VideoRoomRoleSocketListener', () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let bus: any;
  let sockets: any;
  let subject: VideoRoomRoleSocketListener;

  beforeEach(() => {
    handlers.clear();
    bus = {
      subscribe: jest.fn((name: string, handler: (event: unknown) => void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    subject = new VideoRoomRoleSocketListener(bus, sockets);
    subject.onModuleInit();
  });

  const fire = (name: string, payload: Record<string, unknown>): void => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler subscribed for ${name}`);
    handler({ payload });
  };

  it('relays every role event to clients', () => {
    for (const name of Object.values(VIDEO_ROOM_ROLE_EVENTS)) {
      // TEMPORARY_ROLE_GRANTED is intentionally not relayed — the accompanying
      // ROLE_ASSIGNED already told the room, and its payload carries the expiry.
      if (name === VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_GRANTED) continue;
      expect(handlers.has(name)).toBe(true);
    }
  });

  it('broadcasts an assignment to the room on the /video-room namespace', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED, {
      roomId: 'r1',
      userId: 'u1',
      role: VideoRoomMemberRole.ADMIN,
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.role_assigned',
      expect.objectContaining({ roomId: 'r1', userId: 'u1' }),
    );
  });

  it('tells the affected user their own capabilities changed', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED, { roomId: 'r1', userId: 'u1' });
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      'video_room.permission_updated',
      { roomId: 'r1' },
    );
  });

  it('relays a removal', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_REMOVED, { roomId: 'r1', userId: 'u1' });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.role_removed',
      expect.anything(),
    );
  });

  it('relays an update', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_UPDATED, { roomId: 'r1', userId: 'u1' });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.role_updated',
      expect.anything(),
    );
  });

  // An expiry is a revocation from the client's point of view, so it reuses the
  // role_removed channel rather than inventing a second event for one effect.
  it('relays a temporary-role expiry as a removal', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_EXPIRED, { roomId: 'r1', userId: 'u1' });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.role_removed',
      expect.anything(),
    );
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      'video_room.permission_updated',
      { roomId: 'r1' },
    );
  });

  it('notifies both parties on an ownership transfer', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED, {
      roomId: 'r1',
      previousOwnerId: 'o1',
      newOwnerId: 'o2',
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.ownership_transferred',
      expect.anything(),
    );
    const notified = sockets.emitToUserEverywhere.mock.calls.map((call: unknown[]) => call[0]);
    expect(notified).toEqual(expect.arrayContaining(['o1', 'o2']));
  });
});
