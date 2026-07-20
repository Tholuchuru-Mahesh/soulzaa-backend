import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  DEFAULT_VIDEO_ROOM_BACKGROUNDS,
  DEFAULT_VIDEO_ROOM_THEMES,
} from '../constants/reference-data';
import { VideoRoomReferenceRepository } from '../repositories/video-room-reference.repository';

/**
 * Idempotently seeds the default video-room themes + backgrounds on bootstrap so
 * the pickers return data on a fresh database. Upserts by unique slug via the
 * reference repository — safe on every instance (the unique constraint guards
 * concurrency) and only fills what is missing, so operator edits are never
 * clobbered. Categories/languages are seeded by the audio-rooms RoomReferenceSeeder
 * (shared reference), not here.
 */
@Injectable()
export class VideoRoomReferenceSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoRoomReferenceSeederService.name);

  constructor(private readonly reference: VideoRoomReferenceRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seed();
    } catch (err) {
      // Never block startup on seed failures (e.g. migrations not yet applied).
      this.logger.warn(`Video-room reference seed skipped: ${(err as Error).message}`);
    }
  }

  private async seed(): Promise<void> {
    for (const theme of DEFAULT_VIDEO_ROOM_THEMES) {
      await this.reference.upsertTheme(theme);
    }
    for (const background of DEFAULT_VIDEO_ROOM_BACKGROUNDS) {
      await this.reference.upsertBackground(background);
    }
    this.logger.log(
      `Video-room reference ready: ${DEFAULT_VIDEO_ROOM_THEMES.length} themes, ` +
        `${DEFAULT_VIDEO_ROOM_BACKGROUNDS.length} backgrounds`,
    );
  }
}
