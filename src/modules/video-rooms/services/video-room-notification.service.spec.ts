import { Logger } from '@nestjs/common';
import { VideoRoomNotificationService } from './video-room-notification.service';
import {
  VIDEO_ROOM_NOTIFICATION_KINDS as K,
  VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
} from '../constants/video-room-notification.constants';

// The batch-isolation and FOLLOWERS-guard cases intentionally trigger logger
// warnings; silence them so the suite output stays pristine.
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

function allOn() {
  // Note: not cast `as never` (as in the task brief) — that cast makes the
  // return value un-spreadable (`TS2698: Spread types may only be created
  // from object types`), which breaks the "preference toggle off" case below
  // that spreads it. Left as a plain object; the test doubles are untyped
  // (`as never` at the injection site), so no interface conformance is needed.
  return {
    pushEnabled: true,
    roomEvents: true,
    seatEvents: true,
    treasureEvents: true,
    pkEvents: true,
    announcementEvents: true,
    inviteEvents: true,
    giftEvents: true,
    systemEvents: true,
  };
}

function makeDeps() {
  const notifications = {
    create: jest.fn().mockResolvedValue({ id: 'n1' }),
    notify: jest.fn().mockResolvedValue(true),
    preferences: jest.fn().mockResolvedValue(allOn()),
  };
  const mute = { isMuted: jest.fn().mockResolvedValue(false) };
  const rooms = {
    listActiveMemberIds: jest.fn().mockResolvedValue(['a', 'b']),
    countActiveMembers: jest.fn().mockResolvedValue(2),
  };
  const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'j1' }) };
  const metrics = { incNotificationDispatched: jest.fn(), incNotificationSuppressed: jest.fn() };
  return { notifications, mute, rooms, queue, metrics };
}

const svcOf = (d: ReturnType<typeof makeDeps>) =>
  new VideoRoomNotificationService(
    d.notifications as never,
    d.mute as never,
    d.rooms as never,
    d.queue as never,
    d.metrics as never,
  );

describe('VideoRoomNotificationService', () => {
  it('TARGET seat approval: creates in-app + push for the target', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.SEAT_APPROVAL, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'Approved',
      body: 'You may take a seat',
    });
    expect(d.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 't1',
        type: 'SEAT_APPROVED',
        entityType: 'VIDEO_ROOM',
        entityId: 'r1',
      }),
    );
    expect(d.notifications.notify).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ badge: 'unread' }),
    );
  });

  it('suppresses when the recipient muted the room', async () => {
    const d = makeDeps();
    d.mute.isMuted.mockResolvedValue(true);
    await svcOf(d).dispatch(K.SEAT_APPROVAL, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'x',
      body: 'y',
    });
    expect(d.notifications.create).not.toHaveBeenCalled();
    expect(d.notifications.notify).not.toHaveBeenCalled();
    expect(d.metrics.incNotificationSuppressed).toHaveBeenCalledWith('mute');
  });

  it('suppresses when the preference toggle is off', async () => {
    const d = makeDeps();
    d.notifications.preferences.mockResolvedValue({ ...allOn(), seatEvents: false });
    await svcOf(d).dispatch(K.SEAT_APPROVAL, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'x',
      body: 'y',
    });
    expect(d.notifications.create).not.toHaveBeenCalled();
    expect(d.notifications.notify).not.toHaveBeenCalled();
    expect(d.metrics.incNotificationSuppressed).toHaveBeenCalledWith('preference');
  });

  it('ROOM_MEMBERS announcement resolves members via the repo', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'Notice', body: 'Hello room' });
    expect(d.rooms.listActiveMemberIds).toHaveBeenCalledWith('r1');
    expect(d.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('ROOM_MEMBERS in a large room (with occurrenceId) fans out instead of delivering inline', async () => {
    const d = makeDeps();
    d.rooms.countActiveMembers.mockResolvedValue(500); // > threshold (50)
    await svcOf(d).dispatch(K.ANNOUNCEMENT, {
      roomId: 'r1',
      occurrenceId: 'r1:evt1',
      title: 'a',
      body: 'b',
    });
    expect(d.queue.enqueue).toHaveBeenCalledWith(
      'notifications',
      VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
      expect.objectContaining({
        source: 'MEMBERS',
        roomId: 'r1',
        occurrenceId: 'r1:evt1',
        cursor: 0,
      }),
      expect.objectContaining({ jobId: 'vrnotif:r1:evt1:0' }),
    );
    expect(d.notifications.create).not.toHaveBeenCalled();
  });

  it('ROOM_MEMBERS in a small room (with occurrenceId) still delivers inline', async () => {
    const d = makeDeps();
    d.rooms.countActiveMembers.mockResolvedValue(2); // <= threshold
    await svcOf(d).dispatch(K.ANNOUNCEMENT, {
      roomId: 'r1',
      occurrenceId: 'r1:evt1',
      title: 'a',
      body: 'b',
    });
    expect(d.queue.enqueue).not.toHaveBeenCalled();
    expect(d.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('FOLLOWERS room-started enqueues a fan-out job instead of resolving inline', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.ROOM_STARTED, {
      roomId: 'r1',
      ownerId: 'o1',
      occurrenceId: 'occ1',
      title: 'Live',
      body: 'o1 is live',
    });
    expect(d.queue.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
      expect.objectContaining({ ownerId: 'o1', occurrenceId: 'occ1', cursor: 0 }),
      expect.anything(),
    );
    expect(d.notifications.create).not.toHaveBeenCalled();
  });

  it('an inApp-only kind (push:false) creates but does not push', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.SEAT_REJECTION, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'Declined',
      body: 'Your request was declined',
    });
    expect(d.notifications.create).toHaveBeenCalledTimes(1);
    expect(d.notifications.notify).not.toHaveBeenCalled();
  });

  it('does not count a push the global policy suppressed (notify returns false)', async () => {
    const d = makeDeps();
    d.notifications.notify.mockResolvedValue(false);
    await svcOf(d).dispatch(K.SEAT_APPROVAL, {
      roomId: 'r1',
      targetUserIds: ['t1'],
      title: 'x',
      body: 'y',
    });
    expect(d.notifications.notify).toHaveBeenCalled();
    expect(d.metrics.incNotificationDispatched).toHaveBeenCalledWith(K.SEAT_APPROVAL, 'inApp');
    expect(d.metrics.incNotificationDispatched).not.toHaveBeenCalledWith(K.SEAT_APPROVAL, 'push');
  });

  it('isolates a per-recipient failure so the rest of the batch still delivers', async () => {
    const d = makeDeps();
    // members are ['a','b']; fail the first recipient's create, succeed the second
    d.notifications.create.mockRejectedValueOnce(new Error('boom'));
    await svcOf(d).dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'Notice', body: 'Hello' });
    // both recipients attempted (create called twice), second one pushed
    expect(d.notifications.create).toHaveBeenCalledTimes(2);
    expect(d.notifications.notify).toHaveBeenCalledTimes(1);
    expect(d.metrics.incNotificationSuppressed).toHaveBeenCalledWith('error');
  });

  it('dispatchSystem ignores a FOLLOWERS override (no fan-out, no delivery)', async () => {
    const d = makeDeps();
    await svcOf(d).dispatchSystem({
      roomId: 'r1',
      title: 'System',
      body: 'notice',
      audience: 'FOLLOWERS',
    });
    expect(d.queue.enqueue).not.toHaveBeenCalled();
    expect(d.notifications.create).not.toHaveBeenCalled();
    expect(d.notifications.notify).not.toHaveBeenCalled();
  });
});
