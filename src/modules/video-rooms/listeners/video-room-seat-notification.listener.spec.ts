import { VideoRoomSeatNotificationListener } from './video-room-seat-notification.listener';
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = {
    subscribe: (n: string, h: (e: unknown) => void) => {
      handlers[n] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomSeatNotificationListener(bus as never, dispatcher as never).onModuleInit();
  return { handlers, dispatcher };
}

describe('VideoRoomSeatNotificationListener', () => {
  it('seat invitation (type SEAT) → SEAT_INVITATION to invitee', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT]({
      payload: {
        roomId: 'r1',
        invitationId: 'i1',
        inviterId: 'h1',
        inviteeUserId: 'u1',
        seatIndex: 0,
        expiresAt: 'x',
        type: 'SEAT',
      },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.SEAT_INVITATION,
      expect.objectContaining({ roomId: 'r1', targetUserIds: ['u1'], actorId: 'h1' }),
    );
  });

  it('room invitation (type ROOM) → ROOM_INVITATION', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT]({
      payload: {
        roomId: 'r1',
        invitationId: 'i1',
        inviterId: 'h1',
        inviteeUserId: 'u1',
        seatIndex: null,
        expiresAt: 'x',
        type: 'ROOM',
      },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.ROOM_INVITATION,
      expect.objectContaining({ targetUserIds: ['u1'] }),
    );
  });

  it('request resolved ACCEPTED → SEAT_APPROVAL; REJECTED → SEAT_REJECTION; others ignored', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({
      payload: { roomId: 'r1', requestId: 'q1', userId: 'u1', status: 'ACCEPTED' },
    });
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({
      payload: { roomId: 'r1', requestId: 'q2', userId: 'u2', status: 'REJECTED' },
    });
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({
      payload: { roomId: 'r1', requestId: 'q3', userId: 'u3', status: 'EXPIRED' },
    });
    const kinds = d.dispatcher.dispatch.mock.calls.map((c: unknown[]) => c[0]);
    expect(kinds).toEqual([K.SEAT_APPROVAL, K.SEAT_REJECTION]);
  });

  it('viewer promoted → VIEWER_PROMOTION; demoted → VIEWER_DEMOTION', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_EVENTS.VIEWER_PROMOTED]({
      payload: { roomId: 'r1', userId: 'u1', seatIndex: 1, actorId: 'h1' },
    });
    await d.handlers[VIDEO_ROOM_EVENTS.VIEWER_DEMOTED]({
      payload: { roomId: 'r1', userId: 'u2', actorId: 'h1' },
    });
    const kinds = d.dispatcher.dispatch.mock.calls.map((c: unknown[]) => c[0]);
    expect(kinds).toEqual([K.VIEWER_PROMOTION, K.VIEWER_DEMOTION]);
  });
});
