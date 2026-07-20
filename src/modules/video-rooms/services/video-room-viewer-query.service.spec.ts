import { VideoRoomPresenceState, ViewerStatus } from '../enums';
import { VideoRoomViewerQueryService } from './video-room-viewer-query.service';

describe('VideoRoomViewerQueryService', () => {
  let presence: any;
  let members: any;
  let perm: any;
  let repo: any;
  let svc: VideoRoomViewerQueryService;

  beforeEach(() => {
    presence = {
      listAudience: jest.fn(),
      audienceCount: jest.fn(),
    };
    members = {
      listPresence: jest.fn(),
      getMySession: jest.fn(),
    };
    perm = {
      resolveEffectiveRole: jest.fn(),
    };
    repo = {
      findById: jest.fn(),
    };
    svc = new VideoRoomViewerQueryService(presence, members, perm, repo);
  });

  it('listAudience delegates to the audience seam', async () => {
    const page = { items: [{ userId: 'a' }], total: 1 };
    presence.listAudience.mockResolvedValue(page);
    const out = await svc.listAudience('r1', 20, 0);
    expect(presence.listAudience).toHaveBeenCalledWith('r1', 20, 0);
    expect(out).toBe(page);
  });

  it('countAudience returns the audience total + a state breakdown', async () => {
    presence.audienceCount.mockResolvedValue(8);
    members.listPresence.mockResolvedValue([
      { userId: 'a', state: VideoRoomPresenceState.ONLINE },
      { userId: 'b', state: VideoRoomPresenceState.IDLE },
      { userId: 'c', state: VideoRoomPresenceState.RECONNECTING },
    ]);
    const out = await svc.countAudience('r1');
    expect(out.audience).toBe(8);
    expect(out.watching).toBe(1);
    expect(out.background).toBe(1);
    expect(out.reconnecting).toBe(1);
  });

  it('getMyViewer reports effective role, viewer status, and capabilities', async () => {
    repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'o1' });
    perm.resolveEffectiveRole.mockResolvedValue(null); // audience viewer
    members.getMySession.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      presenceState: VideoRoomPresenceState.ONLINE,
      connectedAt: '2026-07-20T00:00:00.000Z',
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      reconnectCount: 0,
    });
    const me = await svc.getMyViewer('u1', 'r1');
    expect(me.effectiveRole).toBeNull();
    expect(me.status).toBe(ViewerStatus.WATCHING);
    expect(me.capabilities.canRequestSeat).toBe(true);
  });

  it('getMyViewer reports OFFLINE when the caller has no live session', async () => {
    repo.findById.mockResolvedValue(null);
    members.getMySession.mockResolvedValue(null);
    const me = await svc.getMyViewer('u1', 'r1');
    expect(perm.resolveEffectiveRole).not.toHaveBeenCalled();
    expect(me.effectiveRole).toBeNull();
    expect(me.status).toBe(ViewerStatus.OFFLINE);
    expect(me.session).toBeNull();
  });
});
