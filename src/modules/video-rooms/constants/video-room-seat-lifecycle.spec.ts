import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import {
  buildSeatLayout,
  canSeatTransition,
  displayStatusFor,
  isOwnerSeat,
} from './video-room-seat-lifecycle';

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

  describe('buildSeatLayout', () => {
    it('lays out 1 + hosts + guests seats with index 0 as OWNER', () => {
      const layout = buildSeatLayout(9, 0);
      expect(layout).toHaveLength(10);
      expect(layout[0]).toEqual({ seatIndex: 0, seatType: VideoRoomSeatType.OWNER });
      expect(layout.map((s) => s.seatIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(layout.slice(1).every((s) => s.seatType === VideoRoomSeatType.HOST)).toBe(true);
    });

    it('places GUEST seats after the host block', () => {
      const layout = buildSeatLayout(2, 3);
      expect(layout).toHaveLength(6);
      expect(layout.map((s) => s.seatType)).toEqual([
        VideoRoomSeatType.OWNER,
        VideoRoomSeatType.HOST,
        VideoRoomSeatType.HOST,
        VideoRoomSeatType.GUEST,
        VideoRoomSeatType.GUEST,
        VideoRoomSeatType.GUEST,
      ]);
    });

    it('degenerates to the owner seat alone when no host/guest seats are configured', () => {
      expect(buildSeatLayout(0, 0)).toEqual([{ seatIndex: 0, seatType: VideoRoomSeatType.OWNER }]);
    });

    it('is all-GUEST past the owner when hostSeatCount is 0', () => {
      expect(buildSeatLayout(0, 2).map((s) => s.seatType)).toEqual([
        VideoRoomSeatType.OWNER,
        VideoRoomSeatType.GUEST,
        VideoRoomSeatType.GUEST,
      ]);
    });
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
