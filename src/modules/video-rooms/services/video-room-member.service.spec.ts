import type { ConfigService } from '@nestjs/config';
import { VideoRoomLogAction, VideoRoomMemberRole } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomMemberService } from './video-room-member.service';

function configMock(): ConfigService {
  return {
    get: jest.fn().mockReturnValue({
      sessionTtlSeconds: 90,
      heartbeatIntervalSeconds: 25,
      reconnectTimeoutSeconds: 120,
      idleTimeoutSeconds: 300,
    }),
  } as unknown as ConfigService;
}

const OWNER = 'owner';
const ROOM = 'r1';

function liveRoom(over: Record<string, unknown> = {}) {
  return {
    id: ROOM,
    status: 'LIVE',
    ownerId: OWNER,
    isLocked: false,
    passwordHash: null,
    maxViewers: 500,
    ...over,
  };
}

describe('VideoRoomMemberService.join', () => {
  let repo: any;
  let moderation: any;
  let passwords: any;
  let state: any;
  let sessions: any;
  let presence: any;
  let events: any;
  let eventsRepo: any;
  let query: any;
  let metrics: any;
  let locks: any;
  let seats: any;
  let identities: any;
  let service: VideoRoomMemberService;

  const actor = (id = 'u1', roles: any[] = []) => ({ id, roles });
  const ctx = { socketId: 's1', deviceId: 'd1', platform: 'IOS', ip: '1.2.3.4', sid: 'sid1' };

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(liveRoom()),
      getMember: jest.fn().mockResolvedValue(null),
      upsertActiveMember: jest.fn().mockResolvedValue({ id: 'm1' }),
      bumpStatsOnJoin: jest.fn().mockResolvedValue(undefined),
      appendLog: jest.fn().mockResolvedValue(undefined),
      listActiveMembers: jest.fn().mockResolvedValue([]),
      countActiveMembers: jest.fn().mockResolvedValue(1),
      deactivateMember: jest.fn().mockResolvedValue(undefined),
      bumpStatsOnLeave: jest.fn().mockResolvedValue(undefined),
    };
    moderation = { isActivelyBlocked: jest.fn().mockResolvedValue(false) };
    passwords = { verify: jest.fn().mockResolvedValue(false) };
    state = {
      applyUpdate: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockResolvedValue({
        version: 4,
        viewerCount: 1,
        onlineCount: 1,
        reconnectingCount: 0,
        idleCount: 0,
        participantCount: 0,
      }),
      restore: jest.fn().mockResolvedValue(null),
    };
    sessions = {
      register: jest.fn().mockResolvedValue({ duplicateOf: null }),
      touchReconnect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue({ socketId: 's1', connectedAt: new Date().toISOString() }),
      endUserRoomSessions: jest.fn().mockResolvedValue([]),
      listUserSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockResolvedValue(null),
      roomSessionCount: jest.fn().mockResolvedValue(1),
    };
    presence = {
      addViewer: jest.fn().mockResolvedValue(undefined),
      removeViewer: jest.fn().mockResolvedValue(undefined),
      viewerCount: jest.fn().mockResolvedValue(0),
    };
    events = {
      emitUserJoined: jest.fn().mockResolvedValue(undefined),
      emitSessionCreated: jest.fn().mockResolvedValue(undefined),
      emitUserLeft: jest.fn().mockResolvedValue(undefined),
      emitUserReconnected: jest.fn().mockResolvedValue(undefined),
      emitRoomSynchronized: jest.fn().mockResolvedValue(undefined),
      emitHeartbeatMissed: jest.fn().mockResolvedValue(undefined),
      emitSessionExpired: jest.fn().mockResolvedValue(undefined),
    };
    eventsRepo = {
      appendEvent: jest.fn().mockResolvedValue(undefined),
      listAnnouncements: jest.fn().mockResolvedValue([]),
    };
    query = { getDetail: jest.fn().mockResolvedValue({ id: ROOM }) };
    metrics = {
      incJoin: jest.fn(),
      incLeave: jest.fn(),
      incReconnect: jest.fn(),
      observeSessionDuration: jest.fn(),
      setViewers: jest.fn(),
    };
    locks = { withLock: jest.fn((_k: string, fn: () => Promise<unknown>) => fn()) };
    seats = { hasActiveRoomInvitation: jest.fn().mockResolvedValue(false) };
    identities = { resolve: jest.fn().mockResolvedValue(new Map()) };

    service = new VideoRoomMemberService(
      repo,
      moderation,
      passwords,
      state,
      sessions,
      presence,
      events,
      eventsRepo,
      query,
      metrics,
      locks,
      configMock(),
      seats as never,
      identities as never,
    );
  });

  async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(BusinessException);
    await promise.catch((e) => expect((e as BusinessException).errorCode).toBe(code));
  }

  it('throws VIDEO_ROOM_NOT_FOUND when the room is missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expectCode(service.join(actor(), ROOM, {}, ctx), ERROR_CODES.VIDEO_ROOM_NOT_FOUND);
  });

  it('throws VIDEO_ROOM_ENDED when the room is not LIVE', async () => {
    repo.findById.mockResolvedValue(liveRoom({ status: 'OFFLINE' }));
    await expectCode(service.join(actor(), ROOM, {}, ctx), ERROR_CODES.VIDEO_ROOM_ENDED);
  });

  it('throws VIDEO_ROOM_BLOCKED when the user is on the block-list', async () => {
    moderation.isActivelyBlocked.mockResolvedValue(true);
    await expectCode(service.join(actor(), ROOM, {}, ctx), ERROR_CODES.VIDEO_ROOM_BLOCKED);
  });

  it('throws VIDEO_ROOM_PASSWORD_INVALID on a locked room with a wrong password', async () => {
    repo.findById.mockResolvedValue(liveRoom({ isLocked: true, passwordHash: 'h' }));
    passwords.verify.mockResolvedValue(false);
    await expectCode(
      service.join(actor(), ROOM, { password: 'nope' }, ctx),
      ERROR_CODES.VIDEO_ROOM_PASSWORD_INVALID,
    );
  });

  // VR-15 — a held ROOM invitation bypasses the private-room password gate.
  it('lets a user with an active ROOM invitation join a locked room without a password', async () => {
    repo.findById.mockResolvedValue(liveRoom({ isLocked: true, passwordHash: 'h' }));
    seats.hasActiveRoomInvitation.mockResolvedValue(true);
    await expect(service.join(actor(), ROOM, {}, ctx)).resolves.toBeDefined();
    expect(seats.hasActiveRoomInvitation).toHaveBeenCalledWith(ROOM, 'u1');
  });

  it('still throws VIDEO_ROOM_PASSWORD_INVALID for a no-password join without a room invitation', async () => {
    repo.findById.mockResolvedValue(liveRoom({ isLocked: true, passwordHash: 'h' }));
    seats.hasActiveRoomInvitation.mockResolvedValue(false);
    await expectCode(service.join(actor(), ROOM, {}, ctx), ERROR_CODES.VIDEO_ROOM_PASSWORD_INVALID);
  });

  it('throws VIDEO_ROOM_CAPACITY_EXCEEDED when the room is full', async () => {
    repo.findById.mockResolvedValue(liveRoom({ maxViewers: 2 }));
    presence.viewerCount.mockResolvedValue(2);
    await expectCode(
      service.join(actor(), ROOM, {}, ctx),
      ERROR_CODES.VIDEO_ROOM_CAPACITY_EXCEEDED,
    );
  });

  it('lets the owner bypass the password gate on a locked room', async () => {
    repo.findById.mockResolvedValue(liveRoom({ isLocked: true, passwordHash: 'h' }));
    await expect(service.join(actor(OWNER), ROOM, {}, ctx)).resolves.toBeDefined();
    expect(repo.upsertActiveMember).toHaveBeenCalledWith(
      expect.objectContaining({ role: VideoRoomMemberRole.OWNER }),
    );
  });

  it('runs the full write chain and returns the sync payload on a happy join', async () => {
    presence.viewerCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const result = await service.join(actor('u1'), ROOM, {}, ctx);

    expect(presence.addViewer).toHaveBeenCalledWith(ROOM, 'u1');
    expect(repo.upsertActiveMember).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1', role: VideoRoomMemberRole.VIEWER }),
    );
    expect(sessions.register).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1', socketId: 's1', deviceId: 'd1' }),
    );
    expect(state.applyUpdate).toHaveBeenCalled();
    expect(repo.bumpStatsOnJoin).toHaveBeenCalledWith(ROOM, 1);
    expect(repo.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: VideoRoomLogAction.JOINED }),
    );
    expect(eventsRepo.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'member.joined' }),
    );
    expect(events.emitUserJoined).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1', participantCount: 1 }),
    );
    expect(events.emitSessionCreated).toHaveBeenCalled();
    expect(metrics.incJoin).toHaveBeenCalled();
    expect(result.version).toBe(4);
    expect(locks.withLock).toHaveBeenCalled();
  });

  it('emits the joiner real display name, not undefined', async () => {
    identities.resolve = jest.fn().mockResolvedValue(
      new Map([
        [
          'u1',
          {
            displayName: 'Rahul',
            avatarUrl: 'https://cdn/a.jpg',
            username: 'rahul_92',
            level: 24,
            vipLevel: 3,
            verified: true,
          },
        ],
      ]),
    );

    await service.join(actor('u1'), ROOM, {}, ctx);

    expect(events.emitUserJoined).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Rahul',
        username: 'rahul_92',
        avatarUrl: 'https://cdn/a.jpg',
      }),
    );
  });

  it('still emits the join when identity resolution fails', async () => {
    identities.resolve = jest.fn().mockRejectedValue(new Error('redis down'));

    await service.join(actor('u1'), ROOM, {}, ctx);

    expect(events.emitUserJoined).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', name: undefined }),
    );
  });

  // ---- leave ----

  it('leave removes presence, ends the session, deactivates, and publishes UserLeft', async () => {
    await service.leave(actor('u1'), ROOM, { socketId: 's1' }, { ip: '1.2.3.4' });

    expect(presence.removeViewer).toHaveBeenCalledWith(ROOM, 'u1');
    expect(sessions.end).toHaveBeenCalledWith('s1');
    expect(repo.deactivateMember).toHaveBeenCalledWith(ROOM, 'u1', 'u1');
    expect(repo.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: VideoRoomLogAction.LEFT }),
    );
    expect(events.emitUserLeft).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1' }),
    );
    expect(metrics.incLeave).toHaveBeenCalled();
    expect(metrics.observeSessionDuration).toHaveBeenCalled();
  });

  it('leave ends all the user room sessions when no socket id is given', async () => {
    await service.leave(actor('u1'), ROOM, {});
    expect(sessions.endUserRoomSessions).toHaveBeenCalledWith(ROOM, 'u1');
  });

  it('leave throws VIDEO_ROOM_NOT_FOUND for an unknown room', async () => {
    repo.findById.mockResolvedValue(null);
    await expectCode(service.leave(actor('u1'), ROOM, {}), ERROR_CODES.VIDEO_ROOM_NOT_FOUND);
  });

  // ---- reconnect ----

  it('reconnect re-registers, restores ONLINE, and publishes UserReconnected', async () => {
    repo.getMember.mockResolvedValue({ isActive: true });

    const result = await service.reconnect(actor('u1'), ROOM, { previousSocketId: 's0' }, ctx);

    expect(sessions.register).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1', socketId: 's1' }),
    );
    expect(sessions.touchReconnect).toHaveBeenCalledWith('s1', 's0');
    expect(events.emitUserReconnected).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1', socketId: 's1' }),
    );
    expect(metrics.incReconnect).toHaveBeenCalled();
    expect(result.version).toBe(4);
  });

  it('reconnect throws VIDEO_ROOM_RECONNECT_FAILED when the member was reclaimed', async () => {
    repo.getMember.mockResolvedValue({ isActive: false });
    await expectCode(
      service.reconnect(actor('u1'), ROOM, {}, ctx),
      ERROR_CODES.VIDEO_ROOM_RECONNECT_FAILED,
    );
  });

  // ---- sync ----

  it('sync builds the payload and publishes RoomSynchronized', async () => {
    const result = await service.sync(actor('u1'), ROOM);
    expect(result.version).toBe(4);
    expect(events.emitRoomSynchronized).toHaveBeenCalledWith({ roomId: ROOM, version: 4 });
  });

  // ---- listMembers ----

  it('listMembers maps rows to views and returns the total', async () => {
    repo.listActiveMembers.mockResolvedValue([
      {
        userId: 'u1',
        role: VideoRoomMemberRole.VIEWER,
        memberStatus: 'ACTIVE',
        joinedAt: new Date(),
        lastActiveAt: new Date(),
        isActive: true,
      },
    ]);
    repo.countActiveMembers.mockResolvedValue(1);

    const res = await service.listMembers(ROOM, 20, 0);
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ userId: 'u1', role: VideoRoomMemberRole.VIEWER });
  });

  describe('listMembers identity enrichment', () => {
    it('attaches identity to every member row', async () => {
      repo.listActiveMembers = jest.fn().mockResolvedValue([
        {
          userId: 'u1',
          role: 'OWNER',
          memberStatus: 'ACTIVE',
          joinedAt: new Date(0),
          lastActiveAt: new Date(0),
          isActive: true,
        },
        {
          userId: 'u2',
          role: 'VIEWER',
          memberStatus: 'ACTIVE',
          joinedAt: new Date(0),
          lastActiveAt: new Date(0),
          isActive: true,
        },
      ]);
      repo.countActiveMembers = jest.fn().mockResolvedValue(2);
      identities.resolve = jest.fn().mockResolvedValue(
        new Map([
          [
            'u1',
            {
              displayName: 'Rahul',
              avatarUrl: null,
              username: 'rahul_92',
              level: 24,
              vipLevel: 3,
              verified: true,
            },
          ],
          [
            'u2',
            {
              displayName: 'Priya',
              avatarUrl: null,
              username: 'priya',
              level: 5,
              vipLevel: 0,
              verified: false,
            },
          ],
        ]),
      );

      const out = await service.listMembers('room1', 50, 0);

      expect(identities.resolve).toHaveBeenCalledWith(['u1', 'u2']);
      expect(out.items[0].user?.displayName).toBe('Rahul');
      expect(out.items[1].user?.level).toBe(5);
      expect(out.total).toBe(2);
    });

    it('returns bare rows when identity resolution throws', async () => {
      repo.listActiveMembers = jest.fn().mockResolvedValue([
        {
          userId: 'u1',
          role: 'VIEWER',
          memberStatus: 'ACTIVE',
          joinedAt: new Date(0),
          lastActiveAt: new Date(0),
          isActive: true,
        },
      ]);
      repo.countActiveMembers = jest.fn().mockResolvedValue(1);
      identities.resolve = jest.fn().mockRejectedValue(new Error('redis down'));

      const out = await service.listMembers('room1', 50, 0);

      expect(out.items[0].user).toBeUndefined();
      expect(out.items[0].userId).toBe('u1');
    });
  });

  // ---- reclaim (called by the monitor) ----

  it('reclaim deactivates the member (no other session), decrements, and publishes expiry events', async () => {
    sessions.listUserSessions.mockResolvedValue([]); // no other live session
    presence.viewerCount.mockResolvedValue(0);

    await service.reclaim({
      roomId: ROOM,
      userId: 'u1',
      socketId: 's1',
      joinedAt: new Date(Date.now() - 120_000),
    });

    expect(events.emitHeartbeatMissed).toHaveBeenCalled();
    expect(presence.removeViewer).toHaveBeenCalledWith(ROOM, 'u1');
    expect(repo.deactivateMember).toHaveBeenCalledWith(ROOM, 'u1', 'u1');
    expect(events.emitUserLeft).toHaveBeenCalledWith(expect.objectContaining({ roomId: ROOM }));
    expect(events.emitSessionExpired).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: 'u1' }),
    );
    expect(metrics.incLeave).toHaveBeenCalled();
    expect(metrics.observeSessionDuration).toHaveBeenCalled();
  });

  it('reclaim keeps the member active when another session survives', async () => {
    sessions.listUserSessions.mockResolvedValue(['s2']);
    sessions.getSession.mockResolvedValue({ roomId: ROOM, userId: 'u1', socketId: 's2' });

    await service.reclaim({ roomId: ROOM, userId: 'u1', socketId: 's1', joinedAt: new Date() });

    expect(repo.deactivateMember).not.toHaveBeenCalled();
    expect(events.emitSessionExpired).toHaveBeenCalled();
  });
});
