import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatMetricsListener } from './video-room-seat-metrics.listener';

describe('VideoRoomSeatMetricsListener', () => {
  let handlers: Record<string, (e: { payload: unknown }) => void>;
  let metrics: Record<string, jest.Mock>;

  beforeEach(() => {
    handlers = {};
    const bus = {
      subscribe: (name: string, handler: (e: { payload: unknown }) => void) => {
        handlers[name] = handler;
      },
    };
    metrics = {
      incOccupiedSeat: jest.fn(),
      decOccupiedSeat: jest.fn(),
      incLockedSeat: jest.fn(),
      decLockedSeat: jest.fn(),
      incSeatTransfer: jest.fn(),
      incSeatSwitch: jest.fn(),
      incSeatRequest: jest.fn(),
      incSeatInvitation: jest.fn(),
      incReservationTimeout: jest.fn(),
    };
    new VideoRoomSeatMetricsListener(bus as never, metrics as never).onModuleInit();
  });

  it('tracks occupancy on take / left', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.TAKEN]({ payload: {} });
    handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: {} });
    expect(metrics.incOccupiedSeat).toHaveBeenCalledTimes(1);
    expect(metrics.decOccupiedSeat).toHaveBeenCalledTimes(1);
  });

  it('counts transfers, switches, requests, invitations', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.TRANSFERRED]({ payload: {} });
    handlers[VIDEO_ROOM_SEAT_EVENTS.SWITCHED]({ payload: {} });
    handlers[VIDEO_ROOM_SEAT_EVENTS.REQUESTED]({ payload: {} });
    handlers[VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT]({ payload: {} });
    expect(metrics.incSeatTransfer).toHaveBeenCalled();
    expect(metrics.incSeatSwitch).toHaveBeenCalled();
    expect(metrics.incSeatRequest).toHaveBeenCalled();
    expect(metrics.incSeatInvitation).toHaveBeenCalled();
  });

  it('counts only expiry-reason releases as reservation timeouts', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.RELEASED]({ payload: { reason: 'cancelled' } });
    handlers[VIDEO_ROOM_SEAT_EVENTS.RELEASED]({ payload: { reason: 'expired' } });
    expect(metrics.incReservationTimeout).toHaveBeenCalledTimes(1);
  });
});
