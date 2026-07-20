import { VideoRoomsService } from './video-rooms.service';

describe('VideoRoomsService', () => {
  let repo: any;
  let service: VideoRoomsService;

  beforeEach(() => {
    repo = { findById: jest.fn() };
    service = new VideoRoomsService(repo);
  });

  it('isRoomLive is true only for a LIVE room', async () => {
    repo.findById.mockResolvedValue({ status: 'LIVE' });
    expect(await service.isRoomLive('r1')).toBe(true);
  });

  it('isRoomLive is false for a non-LIVE room', async () => {
    repo.findById.mockResolvedValue({ status: 'OFFLINE' });
    expect(await service.isRoomLive('r1')).toBe(false);
  });

  it('isRoomLive is false when the room is missing/soft-deleted', async () => {
    repo.findById.mockResolvedValue(null);
    expect(await service.isRoomLive('r1')).toBe(false);
  });
});
