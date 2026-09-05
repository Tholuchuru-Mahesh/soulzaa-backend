import type { ConfigService } from '@nestjs/config';
import { PlatformRole, VideoRoomLogAction, VideoRoomMemberRole } from '@prisma/client';
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
    maxViewers: 500,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('VideoRoomMemberService.join', () => {
  let repo: any;
  let moderation: any;
  let state: any;
  let sessions: any;
  let presence: any;
  let events: any;
  let eventsRepo: any;
  let query: any;
  let metrics: any;
  let locks: any;
  let gifts: any;
  let identities: any;
  let platformAudit: any;
  let platformBans: any;
  let giftLockAccessRepo: any;
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
      deactivateAllMembers: jest.fn().mockResolvedValue(undefined),
      endActiveBroadcastSession: jest.fn().mockResolvedValue(undefined),
      trendingRemove: jest.fn().mockResolvedValue(undefined),
      clearCachedSnapshot: jest.fn().mockResolvedValue(undefined),
      updateRoom: jest.fn().mockResolvedValue(undefined),
      getActiveBroadcastSession: jest.fn().mockResolvedValue(null),
    };
    moderation = { isActivelyBlocked: jest.fn().mockResolvedValue(false) };
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
      clear: jest.fn().mockResolvedValue(undefined),
    };
    sessions = {
      register: jest.fn().mockResolvedValue({ duplicateOf: null }),
      touchReconnect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue({ socketId: 's1', connectedAt: new Date().toISOString() }),
      endUserRoomSessions: jest.fn().mockResolvedValue([]),
      endAllRoomSessions: jest.fn().mockResolvedValue([]),
      listUserSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockResolvedValue(null),
      roomSessionCount: jest.fn().mockResolvedValue(1),
    };
    presence = {
      addViewer: jest.fn().mockResolvedValue(undefined),
      removeViewer: jest.fn().mockResolvedValue(undefined),
      viewerCount: jest.fn().mockResolvedValue(0),
      addModerator: jest.fn().mockResolvedValue(undefined),
      removeModerator: jest.fn().mockResolvedValue(undefined),
      isModeratorPresent: jest.fn().mockResolvedValue(false),
      clearRoom: jest.fn().mockResolvedValue(undefined),
    };
    events = {
      emitUserJoined: jest.fn().mockResolvedValue(undefined),
      emitSessionCreated: jest.fn().mockResolvedValue(undefined),
      emitUserLeft: jest.fn().mockResolvedValue(undefined),
      emitUserReconnected: jest.fn().mockResolvedValue(undefined),
      emitRoomSynchronized: jest.fn().mockResolvedValue(undefined),
      emitHeartbeatMissed: jest.fn().mockResolvedValue(undefined),
      emitSessionExpired: jest.fn().mockResolvedValue(undefined),
      emitRoomClosed: jest.fn().mockResolvedValue(undefined),
      emitRoomUpdated: jest.fn().mockResolvedValue(undefined),
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
    // Default true: existing gift-lock tests exercise a still-enabled gift;
    // the fail-open behaviour (Fix 1) is exercised by its own test below.
    gifts = { isGiftEnabled: jest.fn().mockResolvedValue(true) };
    identities = { resolve: jest.fn().mockResolvedValue(new Map()) };

    platformAudit = { record: jest.fn().mockResolvedValue(undefined) };
    platformBans = { assertNotGloballyBanned: jest.fn().mockResolvedValue(undefined) };
    giftLockAccessRepo = { hasGrantedAccess: jest.fn().mockResolvedValue(true) };

    service = new VideoRoomMemberService(
      repo,
      moderation,
      state,
      sessions,
      presence,
      events,
      eventsRepo,
      query,
      metrics,
      locks,
      configMock(),
      identities as never,
      { isAccessGranted: jest.fn().mockResolvedValue(true) } as never, // entryAccessRepo
      giftLockAccessRepo as never, // giftLockAccessRepo
      gifts as never, // gifts (GIFTS_SERVICE)
      undefined, // performanceStats
      undefined, // investigationRecording
      undefined, // reportRepo
      platformAudit as never, // platformAudit
      platformBans as never, // platformBans
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

  it('exempts a platform Moderator from the block-list, like Admin/Super Admin', async () => {
    moderation.isActivelyBlocked.mockResolvedValue(true);
    await expect(
      service.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx),
    ).resolves.toBeDefined();
    expect(moderation.isActivelyBlocked).not.toHaveBeenCalled();
  });

  describe('join — gift-lock gate', () => {
    it('throws VIDEO_ROOM_GIFT_REQUIRED for a new viewer with no granted access', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null); // not already a member
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });
      giftLockAccessRepo.hasGrantedAccess.mockResolvedValue(false);

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).rejects.toMatchObject({ response: { errorCode: 'VIDEO_ROOM_GIFT_REQUIRED' } });
    });

    it('allows join when gift-lock access was already granted', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null);
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });
      giftLockAccessRepo.hasGrantedAccess.mockResolvedValue(true);

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
    });

    it('never gates the room owner', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null);
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });

      await expect(
        service.join({ id: 'owner-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
      expect(giftLockAccessRepo.hasGrantedAccess).not.toHaveBeenCalled();
    });

    it('fails OPEN (lets the joiner in) when the required gift has since been disabled in the catalog', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null); // not already a member
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });
      gifts.isGiftEnabled.mockResolvedValue(false); // gift disabled/deleted since lock was set
      giftLockAccessRepo.hasGrantedAccess.mockResolvedValue(false); // nobody could ever satisfy this

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
      expect(gifts.isGiftEnabled).toHaveBeenCalledWith('gift-1');
      // The misconfigured lock must not even bother checking granted access —
      // it fails open before that read.
      expect(giftLockAccessRepo.hasGrantedAccess).not.toHaveBeenCalled();
    });

    it('never gates an already-active member (e.g. a seat-holder)', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue({ isActive: true });
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
      expect(giftLockAccessRepo.hasGrantedAccess).not.toHaveBeenCalled();
    });
  });

  it('throws VIDEO_ROOM_CAPACITY_EXCEEDED when the room is full', async () => {
    repo.findById.mockResolvedValue(liveRoom({ maxViewers: 2 }));
    presence.viewerCount.mockResolvedValue(2);
    await expectCode(
      service.join(actor(), ROOM, {}, ctx),
      ERROR_CODES.VIDEO_ROOM_CAPACITY_EXCEEDED,
    );
  });

  it('lets the owner join their own room', async () => {
    repo.findById.mockResolvedValue(liveRoom());
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

  describe('join-triggered investigation recording', () => {
    let investigationRecording: Record<string, jest.Mock>;
    let reportRepo: Record<string, jest.Mock>;
    let recordingService: VideoRoomMemberService;

    beforeEach(() => {
      investigationRecording = {
        beginOrReuseRecording: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      };
      reportRepo = {
        listPendingReports: jest.fn().mockResolvedValue([]),
      };
      recordingService = new VideoRoomMemberService(
        repo,
        moderation,
        state,
        sessions,
        presence,
        events,
        eventsRepo,
        query,
        metrics,
        locks,
        configMock(),
        identities as never,
        { isAccessGranted: jest.fn().mockResolvedValue(true) } as never, // entryAccessRepo
        giftLockAccessRepo as never, // giftLockAccessRepo
        gifts as never, // gifts (GIFTS_SERVICE)
        undefined, // performanceStats
        investigationRecording as any, // investigationRecording
        reportRepo as any, // reportRepo
      );
    });

    it('opens/reuses a recording per pending report when a MODERATOR joins', async () => {
      reportRepo.listPendingReports.mockResolvedValue([
        { id: 'report-1', targetUserId: 'target-a' },
        { id: 'report-2', targetUserId: 'target-b' },
      ]);
      await recordingService.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx);
      // Room-join fires the recording lookups off the awaited-in-body promise
      // chain; flush microtasks so the fire-and-forget `.then()` resolves.
      await new Promise((r) => setImmediate(r));

      expect(investigationRecording.beginOrReuseRecording).toHaveBeenCalledWith(
        expect.objectContaining({ moderatorId: 'mod-1', targetUserId: 'target-a', roomId: ROOM }),
      );
      expect(investigationRecording.beginOrReuseRecording).toHaveBeenCalledWith(
        expect.objectContaining({ moderatorId: 'mod-1', targetUserId: 'target-b', roomId: ROOM }),
      );
    });

    it('opens nothing for a non-moderator join', async () => {
      reportRepo.listPendingReports.mockResolvedValue([
        { id: 'report-1', targetUserId: 'target-a' },
      ]);
      await recordingService.join(actor('u1'), ROOM, {}, ctx);
      await new Promise((r) => setImmediate(r));
      expect(investigationRecording.beginOrReuseRecording).not.toHaveBeenCalled();
    });

    it('opens nothing when the room has no pending reports', async () => {
      reportRepo.listPendingReports.mockResolvedValue([]);
      await recordingService.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx);
      await new Promise((r) => setImmediate(r));
      expect(investigationRecording.beginOrReuseRecording).not.toHaveBeenCalled();
    });

    describe('join — moderator incognito path', () => {
      it('does not create a member row or emit UserJoined for a moderator', async () => {
        await service.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx);
        expect(repo.upsertActiveMember).not.toHaveBeenCalled();
        expect(events.emitUserJoined).not.toHaveBeenCalled();
      });

      it('routes the moderator into presence via addModerator', async () => {
        await service.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx);
        expect(presence.addModerator).toHaveBeenCalledWith(ROOM, 'mod-1');
        expect(presence.addViewer).not.toHaveBeenCalled();
      });

      it('writes an INCOGNITO_JOIN audit row', async () => {
        await service.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx);
        expect(platformAudit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            moderatorId: 'mod-1',
            action: 'INCOGNITO_JOIN',
            roomType: 'VIDEO_ROOM',
            roomId: ROOM,
          }),
        );
      });
    });

    describe('join — global ban gate', () => {
      it('rejects a banned regular user before joining', async () => {
        platformBans.assertNotGloballyBanned.mockRejectedValueOnce(new Error('You are banned.'));
        await expect(service.join(actor('u1'), ROOM, {}, ctx)).rejects.toThrow('You are banned.');
        expect(presence.addViewer).not.toHaveBeenCalled();
      });

      it('does not check the global ban for a moderator', async () => {
        await service.join(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, {}, ctx);
        expect(platformBans.assertNotGloballyBanned).not.toHaveBeenCalled();
      });

      it('checks the global ban for a regular user', async () => {
        await service.join(actor('u1'), ROOM, {}, ctx);
        expect(platformBans.assertNotGloballyBanned).toHaveBeenCalledWith('u1');
      });
    });

    describe('leave — moderator incognito path', () => {
      it('removes the moderator from presence and does not emit UserLeft', async () => {
        await service.leave(actor('mod-1', [PlatformRole.MODERATOR]), ROOM, { socketId: 's1' });
        expect(presence.removeModerator).toHaveBeenCalledWith(ROOM, 'mod-1');
        expect(presence.removeViewer).not.toHaveBeenCalled();
        expect(events.emitUserLeft).not.toHaveBeenCalled();
      });
    });
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

  it('leave auto-ends the broadcast when the last member leaves, tearing down presence/sessions/roster/state', async () => {
    // presence.viewerCount is mocked to 0, so the leaving user is always "the
    // last one" in this fixture — exercising the auto-end path on every leave.
    await service.leave(actor('u1'), ROOM, { socketId: 's1' });

    expect(presence.clearRoom).toHaveBeenCalledWith(ROOM);
    expect(sessions.endAllRoomSessions).toHaveBeenCalledWith(ROOM);
    expect(repo.deactivateAllMembers).toHaveBeenCalled();
    expect(state.clear).toHaveBeenCalledWith(ROOM);
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
    identities.resolve.mockResolvedValue(new Map([['u1', { displayName: 'u1', username: 'u1' }]]));
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

    it('drops a hidden staff account from the roster entirely, not just its identity', async () => {
      repo.listActiveMembers = jest.fn().mockResolvedValue([
        {
          userId: 'u1',
          role: 'VIEWER',
          memberStatus: 'ACTIVE',
          joinedAt: new Date(0),
          lastActiveAt: new Date(0),
          isActive: true,
        },
        {
          userId: 'mod-1',
          role: 'VIEWER',
          memberStatus: 'ACTIVE',
          joinedAt: new Date(0),
          lastActiveAt: new Date(0),
          isActive: true,
        },
      ]);
      repo.countActiveMembers = jest.fn().mockResolvedValue(2);
      // resolvePublicIdentities-backed cache: 'mod-1' has no entry, exactly
      // like the real hidden-account behavior — resolution succeeded, the
      // hidden user is just absent from the map.
      identities.resolve = jest
        .fn()
        .mockResolvedValue(
          new Map([['u1', { displayName: 'Rahul', avatarUrl: null, username: 'rahul_92' }]]),
        );

      const out = await service.listMembers('room1', 50, 0);

      expect(out.items.map((i) => i.userId)).toEqual(['u1']);
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
