import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import { toVideoRoomSeatView } from './video-room-stage.mapper';
import { toVideoRoomThemeView } from './video-room-content.mapper';

describe('video-room mappers drop internal columns', () => {
  it('toVideoRoomSeatView exposes only client-safe seat fields (no audit/metadata)', () => {
    const row: any = {
      id: 's1',
      roomId: 'r1',
      seatIndex: 1,
      seatType: VideoRoomSeatType.HOST,
      seatStatus: VideoRoomSeatStatus.OCCUPIED,
      occupantUserId: 'u1',
      reservedForUserId: null,
      isLocked: false,
      isMuted: false,
      isVideoOn: true,
      metadata: { secret: true },
      createdBy: 'owner',
      updatedBy: 'owner',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const view = toVideoRoomSeatView(row);
    expect(view).toEqual({
      seatIndex: 1,
      seatType: VideoRoomSeatType.HOST,
      seatStatus: VideoRoomSeatStatus.OCCUPIED,
      occupantUserId: 'u1',
      reservedForUserId: null,
      isLocked: false,
      isMuted: false,
      isVideoOn: true,
    });
    expect(view).not.toHaveProperty('metadata');
    expect(view).not.toHaveProperty('createdBy');
    expect(view).not.toHaveProperty('id');
  });

  it('toVideoRoomThemeView drops audit timestamps + sortOrder/isActive', () => {
    const row: any = {
      id: 't1',
      slug: 'neon',
      name: 'Neon',
      previewKey: null,
      assetKey: 'a/neon.zip',
      isPremium: true,
      sortOrder: 40,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const view = toVideoRoomThemeView(row);
    expect(view).toEqual({
      id: 't1',
      slug: 'neon',
      name: 'Neon',
      previewKey: null,
      assetKey: 'a/neon.zip',
      isPremium: true,
    });
    expect(view).not.toHaveProperty('sortOrder');
  });
});
