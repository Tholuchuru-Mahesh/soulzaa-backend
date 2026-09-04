import { VideoRoomNotificationService } from './services/video-room-notification.service';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from './constants/video-room-notification.constants';

// Verifies the dispatcher end-to-end with real matrix + fakes for the seams.
describe('VR-15 notification integration', () => {
  function build(prefsOverride: Record<string, boolean> = {}) {
    const created: unknown[] = [];
    const pushed: unknown[] = [];
    const notifications = {
      create: jest.fn(async (i: unknown) => {
        created.push(i);
        return { id: 'n' };
      }),
      notify: jest.fn(async (u: string, i: unknown) => {
        pushed.push({ u, i });
        return true;
      }),
      preferences: jest.fn().mockResolvedValue({
        pushEnabled: true,
        roomEvents: true,
        seatEvents: true,
        treasureEvents: true,
        pkEvents: true,
        announcementEvents: true,
        inviteEvents: true,
        giftEvents: true,
        systemEvents: true,
        ...prefsOverride,
      }),
    };
    const mute = { isMuted: jest.fn().mockResolvedValue(false) };
    const rooms = {
      listActiveMemberIds: jest.fn().mockResolvedValue(['m1', 'm2']),
      appendLog: jest.fn(),
    };
    const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'j' }) };
    const metrics = {
      incNotificationDispatched: jest.fn(),
      incNotificationSuppressed: jest.fn(),
      observeFanoutBatch: jest.fn(),
    };
    const svc = new VideoRoomNotificationService(
      notifications as never,
      mute as never,
      rooms as never,
      queue as never,
      metrics as never,
    );
    return { svc, created, pushed, notifications, mute, rooms, queue };
  }

  it('a mention reaches in-app + push for the target', async () => {
    const t = build();
    await t.svc.dispatch(K.MENTION, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'a',
      body: 'b',
    });
    expect(t.created).toHaveLength(1);
    expect(t.pushed).toHaveLength(1);
  });

  it('seat approval — disabled per requirement — reaches neither in-app nor push', async () => {
    const t = build();
    await t.svc.dispatch(K.SEAT_APPROVAL, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'a',
      body: 'b',
    });
    expect(t.created).toHaveLength(0);
    expect(t.pushed).toHaveLength(0);
  });

  it('announcement reaches every room member', async () => {
    const t = build();
    await t.svc.dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'a', body: 'b' });
    expect(t.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('a muted member receives nothing', async () => {
    const t = build();
    t.mute.isMuted.mockResolvedValue(true);
    await t.svc.dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'a', body: 'b' });
    expect(t.notifications.create).not.toHaveBeenCalled();
  });

  it('room started enqueues the followers fan-out', async () => {
    const t = build();
    await t.svc.dispatch(K.ROOM_STARTED, {
      roomId: 'r1',
      ownerId: 'o1',
      occurrenceId: 'occ1',
      title: 'a',
      body: 'b',
    });
    expect(t.queue.enqueue).toHaveBeenCalled();
  });
});
