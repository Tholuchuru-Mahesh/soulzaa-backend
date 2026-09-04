import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { VideoRoomViewersController } from './video-rooms-viewers.controller';

const USER: AuthenticatedUser = { id: 'u1', roles: [], sid: 'sid1' } as AuthenticatedUser;
const ROOM = 'room-uuid';

describe('VideoRoomViewersController', () => {
  let viewer: any;
  let query: any;
  let controller: VideoRoomViewersController;

  beforeEach(() => {
    viewer = {
      joinAsViewer: jest.fn().mockResolvedValue({ version: 1 }),
      leaveAsViewer: jest.fn().mockResolvedValue(undefined),
      reconnectViewer: jest.fn().mockResolvedValue({ version: 2 }),
      heartbeat: jest.fn().mockResolvedValue({ alive: true }),
      promote: jest.fn().mockResolvedValue(undefined),
      demote: jest.fn().mockResolvedValue(undefined),
    };
    query = {
      listAudience: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      countAudience: jest.fn().mockResolvedValue({
        audience: 0,
        watching: 0,
        background: 0,
        reconnecting: 0,
      }),
      getMyViewer: jest.fn().mockResolvedValue(null),
    };
    controller = new VideoRoomViewersController(viewer, query);
  });

  it('join delegates with actor and join context (socket/device/ip/sid)', async () => {
    await controller.join(
      USER,
      ROOM,
      { socketId: 's1', deviceId: 'd1', platform: 'IOS', password: 'pw' },
      '1.2.3.4',
    );
    expect(viewer.joinAsViewer).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      {},
      { socketId: 's1', deviceId: 'd1', platform: 'IOS', ip: '1.2.3.4', sid: 'sid1' },
    );
  });

  it('leave delegates the socket id and ip', async () => {
    await controller.leave(USER, ROOM, { socketId: 's1' }, '1.2.3.4');
    expect(viewer.leaveAsViewer).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      { socketId: 's1' },
      { ip: '1.2.3.4' },
    );
  });

  it('reconnect delegates the new socket + previousSocketId', async () => {
    await controller.reconnect(USER, ROOM, { socketId: 's2', previousSocketId: 's1' }, '1.2.3.4');
    expect(viewer.reconnectViewer).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      { previousSocketId: 's1' },
      expect.objectContaining({ socketId: 's2', sid: 'sid1' }),
    );
  });

  it('heartbeat delegates to the viewer service and returns { alive }', async () => {
    const res = await controller.heartbeat(ROOM, { socketId: 's1', inBackground: true });
    expect(viewer.heartbeat).toHaveBeenCalledWith({ socketId: 's1', inBackground: true });
    expect(res).toEqual({ alive: true });
  });

  it('POST viewer/promote delegates with the actor, room, dto, ip', async () => {
    const user = { id: 'o1', roles: [], sid: 'sid1' };
    await controller.promote(user as any, 'r1', { targetUserId: 'u1', seatIndex: 3 }, '1.2.3.4');
    expect(viewer.promote).toHaveBeenCalledWith(
      { id: 'o1', roles: [] },
      'r1',
      { targetUserId: 'u1', seatIndex: 3 },
      '1.2.3.4',
    );
  });

  it('demote delegates with the actor, room, dto, ip', async () => {
    await controller.demote(USER, ROOM, { targetUserId: 'u2' }, '1.2.3.4');
    expect(viewer.demote).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      { targetUserId: 'u2' },
      '1.2.3.4',
    );
  });

  it('viewers endpoint clamps pagination and delegates to listAudience', async () => {
    await controller.viewers(ROOM, '999', '5');
    expect(query.listAudience).toHaveBeenCalledWith(ROOM, 100, 5);
  });

  it('viewers/count delegates to countAudience', async () => {
    await controller.viewersCount(ROOM);
    expect(query.countAudience).toHaveBeenCalledWith(ROOM);
  });

  it('viewer/me delegates the caller id + room id', async () => {
    await controller.me(USER, ROOM);
    expect(query.getMyViewer).toHaveBeenCalledWith('u1', ROOM);
  });
});
