import {
  SeatInvitationDeliveredEvent,
  SeatInvitationExpiredEvent,
  SeatInvitationResolvedEvent,
  SeatQueueUpdatedEvent,
  SeatRequestExpiredEvent,
  SeatRequestResolvedEvent,
  SeatReservedEvent,
  SeatTakenEvent,
  SeatTransferredEvent,
  VIDEO_ROOM_SEAT_EVENTS,
} from './video-room-seat.events';

describe('video-room seat events', () => {
  it('each event carries its bus name and payload', () => {
    const taken = new SeatTakenEvent({ roomId: 'r', version: 2, seatIndex: 3, userId: 'u' });
    expect(taken.name).toBe(VIDEO_ROOM_SEAT_EVENTS.TAKEN);
    expect(taken.payload.seatIndex).toBe(3);

    expect(
      new SeatReservedEvent({
        roomId: 'r',
        version: 3,
        seatIndex: 1,
        reservedForUserId: 'u',
        actorId: 'a',
      }).name,
    ).toBe(VIDEO_ROOM_SEAT_EVENTS.RESERVED);

    expect(
      new SeatTransferredEvent({
        roomId: 'r',
        version: 4,
        userId: 'u',
        fromSeatIndex: 1,
        toSeatIndex: 2,
        actorId: 'a',
        forced: true,
      }).payload.forced,
    ).toBe(true);

    expect(
      new SeatRequestResolvedEvent({
        roomId: 'r',
        requestId: 'q',
        userId: 'u',
        status: 'ACCEPTED',
        actorId: 'a',
      }).name,
    ).toBe(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED);

    expect(
      new SeatInvitationResolvedEvent({
        roomId: 'r',
        invitationId: 'i',
        inviteeUserId: 'u',
        status: 'REJECTED',
      }).payload.status,
    ).toBe('REJECTED');
  });
});

describe('VR-8 seat workflow events', () => {
  it('names the four new event types', () => {
    expect(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED).toBe('video_room.seat_request_expired');
    expect(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED).toBe('video_room.seat_invitation_expired');
    expect(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED).toBe(
      'video_room.seat_invitation_delivered',
    );
    expect(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED).toBe('video_room.seat_queue_updated');
  });

  it('carries the request id and user on an expiry event', () => {
    const e = new SeatRequestExpiredEvent({ roomId: 'r1', requestId: 'q1', userId: 'u1' });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED);
    expect(e.payload).toEqual({ roomId: 'r1', requestId: 'q1', userId: 'u1' });
  });

  it('carries the invitation id and invitee on an invitation expiry event', () => {
    const e = new SeatInvitationExpiredEvent({
      roomId: 'r1',
      invitationId: 'i1',
      inviteeUserId: 'u2',
    });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED);
    expect(e.payload.inviteeUserId).toBe('u2');
  });

  it('carries the delivery timestamp on a delivered event', () => {
    const e = new SeatInvitationDeliveredEvent({
      roomId: 'r1',
      invitationId: 'i1',
      inviteeUserId: 'u2',
      deliveredAt: '2026-07-21T10:00:00.000Z',
    });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED);
    expect(e.payload.deliveredAt).toBe('2026-07-21T10:00:00.000Z');
  });

  it('carries size and a bounded preview on a queue update', () => {
    const e = new SeatQueueUpdatedEvent({
      roomId: 'r1',
      size: 42,
      top: [{ userId: 'u1', position: 1, vipLevel: 3 }],
    });
    expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED);
    expect(e.payload.size).toBe(42);
    expect(e.payload.top).toHaveLength(1);
    expect(e.payload.top[0].position).toBe(1);
  });
});
