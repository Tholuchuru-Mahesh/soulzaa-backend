import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import type { SeatEntrySnapshot, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import { seatRowToEntry, toSeatStageView } from './video-room-seat-stage.mapper';

const seat = (i: number, over: Partial<SeatEntrySnapshot> = {}): SeatEntrySnapshot => ({
  seatIndex: i,
  seatType: VideoRoomSeatType.HOST,
  status: VideoRoomSeatStatus.EMPTY,
  occupantUserId: null,
  reservedForUserId: null,
  isLocked: false,
  isMuted: false,
  isVideoOn: false,
  reason: null,
  premium: false,
  ...over,
});

describe('seat stage mapper', () => {
  it('overlays REQUESTED/INVITED and computes displayStatus + version', () => {
    const snap: SeatStageSnapshot = {
      roomId: 'r',
      version: 5,
      updatedAt: 't',
      hostSeatCount: 9,
      guestSeatCount: 0,
      seats: [seat(1), seat(2, { status: VideoRoomSeatStatus.RESERVED, reservedForUserId: 'u2' })],
    };
    const view = toSeatStageView(
      snap,
      [{ userId: 'u9', seatIndex: 1 }],
      [{ inviteeUserId: 'u2', seatIndex: 2 }],
    );
    expect(view.version).toBe(5);
    expect(view.seats[0].displayStatus).toBe('REQUESTED');
    expect(view.seats[0].requestedBy).toEqual(['u9']);
    expect(view.seats[1].displayStatus).toBe('INVITED');
    expect(view.seats[1].invitedUserId).toBe('u2');
  });

  it('maps a DB row → entry, reading reason/premium from metadata', () => {
    const entry = seatRowToEntry({
      seatIndex: 0,
      seatType: VideoRoomSeatType.OWNER,
      seatStatus: VideoRoomSeatStatus.LOCKED,
      occupantUserId: null,
      reservedForUserId: null,
      isLocked: true,
      isMuted: false,
      isVideoOn: false,
      metadata: { reason: 'maintenance', premium: true },
    } as never);
    expect(entry.reason).toBe('maintenance');
    expect(entry.premium).toBe(true);
    expect(entry.status).toBe(VideoRoomSeatStatus.LOCKED);
    expect(entry.seatType).toBe(VideoRoomSeatType.OWNER);
  });
});
