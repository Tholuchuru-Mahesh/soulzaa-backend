import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { VideoRoomMembersController } from './video-rooms-members.controller';

const USER: AuthenticatedUser = { id: 'u1', roles: [], sid: 'sid1' } as AuthenticatedUser;
const ROOM = 'room-uuid';

describe('VideoRoomMembersController', () => {
  let members: any;
  let sessions: any;
  let controller: VideoRoomMembersController;

  beforeEach(() => {
    members = {
      join: jest.fn().mockResolvedValue({ version: 1 }),
      leave: jest.fn().mockResolvedValue(undefined),
      reconnect: jest.fn().mockResolvedValue({ version: 2 }),
      listMembers: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listPresence: jest.fn().mockResolvedValue([]),
      getMySession: jest.fn().mockResolvedValue(null),
      sync: jest.fn().mockResolvedValue({ version: 3 }),
    };
    sessions = { heartbeat: jest.fn().mockResolvedValue(true) };
    controller = new VideoRoomMembersController(members, sessions);
  });

  it('join delegates with actor and join context (socket/device/ip/sid)', async () => {
    await controller.join(
      USER,
      ROOM,
      { socketId: 's1', deviceId: 'd1', platform: 'IOS' },
      '1.2.3.4',
    );
    expect(members.join).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      {},
      { socketId: 's1', deviceId: 'd1', platform: 'IOS', ip: '1.2.3.4', sid: 'sid1' },
    );
  });

  it('leave delegates the socket id and ip', async () => {
    await controller.leave(USER, ROOM, { socketId: 's1' }, '1.2.3.4');
    expect(members.leave).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      { socketId: 's1' },
      { ip: '1.2.3.4' },
    );
  });

  it('reconnect delegates the new socket + previousSocketId', async () => {
    await controller.reconnect(USER, ROOM, { socketId: 's2', previousSocketId: 's1' }, '1.2.3.4');
    expect(members.reconnect).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      ROOM,
      { previousSocketId: 's1' },
      expect.objectContaining({ socketId: 's2', sid: 'sid1' }),
    );
  });

  it('heartbeat delegates to the session service and returns { alive }', async () => {
    const res = await controller.heartbeat(USER, ROOM, { socketId: 's1', inBackground: true });
    expect(sessions.heartbeat).toHaveBeenCalledWith('s1', { inBackground: true });
    expect(res).toEqual({ alive: true });
  });

  it('members endpoint clamps pagination and delegates', async () => {
    await controller.members_(ROOM, '999', '5');
    expect(members.listMembers).toHaveBeenCalledWith(ROOM, 100, 5);
  });

  it('presence delegates to listPresence', async () => {
    await controller.presence(ROOM);
    expect(members.listPresence).toHaveBeenCalledWith(ROOM);
  });

  it('session delegates the caller id + room id', async () => {
    await controller.session(USER, ROOM);
    expect(members.getMySession).toHaveBeenCalledWith('u1', ROOM);
  });

  it('sync delegates the parsed lastVersion', async () => {
    await controller.sync(USER, ROOM, '7');
    expect(members.sync).toHaveBeenCalledWith({ id: 'u1', roles: [] }, ROOM, 7);
  });
});
