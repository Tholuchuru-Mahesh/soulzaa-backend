import {
  DEFAULT_VIDEO_ROOM_BACKGROUNDS,
  DEFAULT_VIDEO_ROOM_THEMES,
} from '../constants/reference-data';
import type { VideoRoomReferenceRepository } from '../repositories/video-room-reference.repository';
import { VideoRoomReferenceSeederService } from './video-room-reference-seeder.service';

describe('VideoRoomReferenceSeederService', () => {
  let reference: any;
  let seeder: VideoRoomReferenceSeederService;

  beforeEach(() => {
    reference = {
      upsertTheme: jest.fn().mockResolvedValue({}),
      upsertBackground: jest.fn().mockResolvedValue({}),
    };
    seeder = new VideoRoomReferenceSeederService(
      reference as unknown as VideoRoomReferenceRepository,
    );
  });

  it('seeds every default theme and background on bootstrap (idempotent upserts)', async () => {
    await seeder.onApplicationBootstrap();
    expect(reference.upsertTheme).toHaveBeenCalledTimes(DEFAULT_VIDEO_ROOM_THEMES.length);
    expect(reference.upsertBackground).toHaveBeenCalledTimes(DEFAULT_VIDEO_ROOM_BACKGROUNDS.length);
  });

  it('never throws on bootstrap even if the DB is not ready (migrations pending)', async () => {
    reference.upsertTheme.mockRejectedValueOnce(new Error('relation does not exist'));
    await expect(seeder.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
