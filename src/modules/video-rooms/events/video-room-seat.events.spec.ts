import {
  SeatInvitationResolvedEvent,
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
