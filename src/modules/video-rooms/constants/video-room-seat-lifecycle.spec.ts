import { VideoRoomSeatStatus } from '@prisma/client';
import { canSeatTransition, displayStatusFor, isOwnerSeat } from './video-room-seat-lifecycle';

describe('seat lifecycle', () => {
  it('permits EMPTY→OCCUPIED and EMPTY→RESERVED', () => {
    expect(canSeatTransition(VideoRoomSeatStatus.EMPTY, VideoRoomSeatStatus.OCCUPIED)).toBe(true);
    expect(canSeatTransition(VideoRoomSeatStatus.EMPTY, VideoRoomSeatStatus.RESERVED)).toBe(true);
  });

  it('rejects LOCKED→OCCUPIED (must unlock first)', () => {
    expect(canSeatTransition(VideoRoomSeatStatus.LOCKED, VideoRoomSeatStatus.OCCUPIED)).toBe(false);
  });

  it('permits RESERVED→OCCUPIED (holder takes) and RESERVED→EMPTY (cancel/expire)', () => {
    expect(canSeatTransition(VideoRoomSeatStatus.RESERVED, VideoRoomSeatStatus.OCCUPIED)).toBe(
      true,
    );
    expect(canSeatTransition(VideoRoomSeatStatus.RESERVED, VideoRoomSeatStatus.EMPTY)).toBe(true);
  });

  it('marks index 0 as the owner seat', () => {
    expect(isOwnerSeat(0)).toBe(true);
    expect(isOwnerSeat(1)).toBe(false);
  });

  it('derives DISABLED / MAINTENANCE / INVITED / REQUESTED display statuses', () => {
    expect(
      displayStatusFor({ status: VideoRoomSeatStatus.LOCKED, reason: 'maintenance' }, {}),
    ).toBe('MAINTENANCE');
    expect(displayStatusFor({ status: VideoRoomSeatStatus.LOCKED, reason: 'disabled' }, {})).toBe(
      'DISABLED',
    );
    expect(displayStatusFor({ status: VideoRoomSeatStatus.LOCKED, reason: null }, {})).toBe(
      'LOCKED',
    );
    expect(
      displayStatusFor({ status: VideoRoomSeatStatus.RESERVED, reason: null }, { invited: true }),
    ).toBe('INVITED');
    expect(
      displayStatusFor({ status: VideoRoomSeatStatus.EMPTY, reason: null }, { requested: true }),
    ).toBe('REQUESTED');
    expect(displayStatusFor({ status: VideoRoomSeatStatus.OCCUPIED, reason: null }, {})).toBe(
      'OCCUPIED',
    );
  });
});
