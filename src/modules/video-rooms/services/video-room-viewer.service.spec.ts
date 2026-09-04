import { VideoRoomViewerService } from './video-room-viewer.service';
import { VideoRoomPermission } from '../constants/video-room-permissions';

describe('VideoRoomViewerService', () => {
  let member: any;
  let session: any;
  let events: any;
  let audience: any;
  let metrics: any;
  let repo: any;
  let perm: any;
  let seat: any;
  let seatState: any;
  let media: any;
  let svc: VideoRoomViewerService;

  beforeEach(() => {
    member = {
      join: jest.fn(),
      leave: jest.fn(),
      reconnect: jest.fn(),
    };
    session = {
      heartbeat: jest.fn(),
    };
    events = {
      emitViewerJoined: jest.fn().mockResolvedValue(undefined),
      emitViewerLeft: jest.fn().mockResolvedValue(undefined),
      emitViewerPromoted: jest.fn().mockResolvedValue(undefined),
      emitViewerDemoted: jest.fn().mockResolvedValue(undefined),
    };
    audience = {
      audienceCount: jest.fn(),
    };
    metrics = {
      setPeakViewers: jest.fn(),
      incViewerPromotion: jest.fn(),
      incViewerDemotion: jest.fn(),
    };
    repo = {
      findById: jest.fn(),
      getMember: jest.fn(),
      setParticipantStats: jest.fn().mockResolvedValue(undefined),
    };
    perm = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      assertOutranks: jest.fn().mockResolvedValue(undefined),
    };
    seat = {
      findOpenSeat: jest.fn(),
      seatUser: jest.fn().mockResolvedValue(undefined),
      vacateUser: jest.fn().mockResolvedValue(undefined),
    };
    seatState = {
      getSnapshot: jest.fn(),
    };
    media = {
      demoteToSubscriber: jest.fn().mockResolvedValue(undefined),
    };
    svc = new VideoRoomViewerService(
      member,
      session,
      events,
      audience,
      metrics,
      repo,
      perm,
      seat,
      seatState,
      media,
    );
  });

  it('joinAsViewer delegates to member.join and emits ViewerJoined with the audience count', async () => {
    member.join.mockResolvedValue({ counts: { viewers: 9 } });
    audience.audienceCount.mockResolvedValue(7);
    const actor = { id: 'u1', roles: [] };
    const out = await svc.joinAsViewer(actor, 'r1', {}, { socketId: 's1' });
    expect(member.join).toHaveBeenCalledWith(actor, 'r1', {}, { socketId: 's1' });
    expect(audience.audienceCount).toHaveBeenCalledWith('r1');
    expect(events.emitViewerJoined).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: 'u1',
      viewerCount: 7,
    });
    expect(metrics.setPeakViewers).toHaveBeenCalledWith(7);
    expect(out).toBe(await member.join.mock.results[0].value);
  });

  it('leaveAsViewer delegates to member.leave and emits ViewerLeft with the audience count', async () => {
    member.leave.mockResolvedValue(undefined);
    audience.audienceCount.mockResolvedValue(6);
    const actor = { id: 'u1', roles: [] };
    await svc.leaveAsViewer(actor, 'r1', { socketId: 's1' }, { ip: '1.2.3.4' });
    expect(member.leave).toHaveBeenCalledWith(actor, 'r1', { socketId: 's1' }, { ip: '1.2.3.4' });
    expect(audience.audienceCount).toHaveBeenCalledWith('r1');
    expect(events.emitViewerLeft).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: 'u1',
      viewerCount: 6,
    });
  });

  it('reconnectViewer delegates to member.reconnect', async () => {
    const actor = { id: 'u1', roles: [] };
    const result = { counts: { viewers: 3 } };
    member.reconnect.mockResolvedValue(result);
    const out = await svc.reconnectViewer(
      actor,
      'r1',
      { previousSocketId: 's0' },
      { socketId: 's1' },
    );
    expect(member.reconnect).toHaveBeenCalledWith(
      actor,
      'r1',
      { previousSocketId: 's0' },
      { socketId: 's1' },
    );
    expect(out).toBe(result);
  });

  it('heartbeat delegates to the session service', async () => {
    session.heartbeat.mockResolvedValue(true);
    await expect(svc.heartbeat({ socketId: 's1', inBackground: true })).resolves.toEqual({
      alive: true,
    });
    expect(session.heartbeat).toHaveBeenCalledWith('s1', { inBackground: true });
  });

  describe('promote', () => {
    it('promote seats the viewer and bumps participant stats', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      repo.getMember.mockResolvedValue({ isActive: true });
      seat.findOpenSeat.mockResolvedValue(3);
      seatState.getSnapshot.mockResolvedValue({
        seats: [
          { status: 'OCCUPIED', occupantUserId: 'x' },
          { status: 'OCCUPIED', occupantUserId: 'u1' },
        ],
      });
      await svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4');
      expect(perm.assertPermission).toHaveBeenCalledWith(
        { id: 'owner', roles: [] },
        { id: 'r1', ownerId: 'owner', status: 'LIVE' },
        VideoRoomPermission.MANAGE_SEATS,
      );
      expect(seat.seatUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 3, '1.2.3.4');
      expect(repo.setParticipantStats).toHaveBeenCalledWith('r1', 2);
      expect(events.emitViewerPromoted).toHaveBeenCalledWith({
        roomId: 'r1',
        userId: 'u1',
        seatIndex: 3,
        actorId: 'owner',
      });
      expect(metrics.incViewerPromotion).toHaveBeenCalled();
    });

    it('promote honors an explicit seatIndex', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      repo.getMember.mockResolvedValue({ isActive: true });
      seatState.getSnapshot.mockResolvedValue({ seats: [] });
      await svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1', seatIndex: 5 });
      expect(seat.findOpenSeat).not.toHaveBeenCalled();
      expect(seat.seatUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 5, undefined);
    });

    it('promote rejects a non-member target', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      repo.getMember.mockResolvedValue(null);
      await expect(
        svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'ghost' }),
      ).rejects.toThrow(/not a viewer|VIDEO_ROOM_NOT_VIEWER/i);
    });

    it('promote rejects when the room is not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }),
      ).rejects.toThrow(/not found|VIDEO_ROOM_NOT_FOUND/i);
    });

    it('promote rejects when the room is not live', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'ENDED' });
      await expect(
        svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }),
      ).rejects.toThrow(/not live|VIDEO_ROOM_ENDED/i);
    });
  });

  describe('demote', () => {
    it('demote vacates the seat, downgrades media, and bumps stats', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({
        seats: [{ seatIndex: 3, status: 'OCCUPIED', occupantUserId: 'u1' }],
      });
      await svc.demote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4');
      expect(perm.assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        VideoRoomPermission.MANAGE_PARTICIPANTS,
      );
      expect(perm.assertOutranks).toHaveBeenCalledWith(
        { id: 'r1', ownerId: 'owner' },
        'owner',
        'u1',
      );
      expect(seat.vacateUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 'seat.demoted', '1.2.3.4');
      expect(media.demoteToSubscriber).toHaveBeenCalledWith('r1', 'u1', 'owner');
      expect(repo.setParticipantStats).toHaveBeenCalledWith('r1', 1);
      expect(events.emitViewerDemoted).toHaveBeenCalledWith({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'owner',
      });
      expect(metrics.incViewerDemotion).toHaveBeenCalled();
    });

    it('demote skips assertOutranks for self-demote', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({
        seats: [{ seatIndex: 3, status: 'OCCUPIED', occupantUserId: 'u1' }],
      });
      await svc.demote({ id: 'u1', roles: [] }, 'r1', { targetUserId: 'u1' });
      expect(perm.assertOutranks).not.toHaveBeenCalled();
    });

    // Stepping down from your own seat is not a moderation action: a plain
    // HOST holds no MANAGE_PARTICIPANTS, and asserting it left a seated
    // participant with no exit but leaving the room entirely.
    it('demote skips assertPermission for self-demote and still vacates the seat', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({
        seats: [{ seatIndex: 3, status: 'OCCUPIED', occupantUserId: 'u1' }],
      });
      await svc.demote({ id: 'u1', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4');
      expect(perm.assertPermission).not.toHaveBeenCalled();
      expect(seat.vacateUser).toHaveBeenCalledWith('r1', 'u1', 'u1', 'seat.demoted', '1.2.3.4');
      expect(media.demoteToSubscriber).toHaveBeenCalledWith('r1', 'u1', 'u1');
      expect(events.emitViewerDemoted).toHaveBeenCalledWith({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'u1',
      });
    });

    it('demote still asserts MANAGE_PARTICIPANTS when the target is someone else', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({
        seats: [{ seatIndex: 3, status: 'OCCUPIED', occupantUserId: 'u1' }],
      });
      perm.assertPermission.mockRejectedValueOnce(new Error('VIDEO_ROOM_FORBIDDEN'));
      await expect(
        svc.demote({ id: 'someone-else', roles: [] }, 'r1', { targetUserId: 'u1' }),
      ).rejects.toThrow(/VIDEO_ROOM_FORBIDDEN/);
      expect(seat.vacateUser).not.toHaveBeenCalled();
    });

    // Seat 0 is the protected owner seat: vacating it would leave the room
    // hosted by nobody. The owner's exits are transfer or close.
    it('demote refuses to vacate the owner seat, even for the owner themselves', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({
        seats: [{ seatIndex: 0, status: 'OCCUPIED', occupantUserId: 'owner' }],
      });
      await expect(
        svc.demote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'owner' }),
      ).rejects.toThrow(/owner seat|VIDEO_ROOM_FORBIDDEN/i);
      expect(seat.vacateUser).not.toHaveBeenCalled();
      expect(media.demoteToSubscriber).not.toHaveBeenCalled();
      expect(events.emitViewerDemoted).not.toHaveBeenCalled();
    });

    it('demote rejects when the room is not live', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'ENDED' });
      await expect(
        svc.demote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }),
      ).rejects.toThrow(/not live|VIDEO_ROOM_ENDED/i);
    });

    it('demote vacates the seat but does not record stats/event/metric when media downgrade fails', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({
        seats: [{ seatIndex: 3, status: 'OCCUPIED', occupantUserId: 'u1' }],
      });
      media.demoteToSubscriber.mockRejectedValue(new Error('lock timeout'));
      await expect(
        svc.demote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4'),
      ).rejects.toThrow('lock timeout');
      expect(seat.vacateUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 'seat.demoted', '1.2.3.4');
      expect(repo.setParticipantStats).not.toHaveBeenCalled();
      expect(events.emitViewerDemoted).not.toHaveBeenCalled();
      expect(metrics.incViewerDemotion).not.toHaveBeenCalled();
    });

    it('demote rejects a non-seated target with VIDEO_ROOM_NOT_PARTICIPANT and performs no mutation', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
      seatState.getSnapshot.mockResolvedValue({ seats: [] });
      await expect(
        svc.demote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4'),
      ).rejects.toThrow(/not a participant|VIDEO_ROOM_NOT_PARTICIPANT/i);
      expect(seat.vacateUser).not.toHaveBeenCalled();
      expect(media.demoteToSubscriber).not.toHaveBeenCalled();
      expect(repo.setParticipantStats).not.toHaveBeenCalled();
      expect(events.emitViewerDemoted).not.toHaveBeenCalled();
      expect(metrics.incViewerDemotion).not.toHaveBeenCalled();
    });
  });
});
