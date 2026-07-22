import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  TreasurePoolStrategy,
  TreasureWinnerAlgorithm,
} from '../constants/video-room-treasure.constants';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';

/**
 * The default video-room ladder (VR-11 spec §10, production.txt §7). Seeded on
 * a fresh database so the feature is usable out of the box; operators tune it
 * via `video_room_treasure_levels`. Idempotent by level — an existing level is
 * never overwritten, so tuning survives a redeploy.
 *
 * These thresholds deliberately differ from the audio ladder
 * (15k/60k/120k/300k/500k): video is four levels, and its L3/L4 are higher.
 */
export const VIDEO_ROOM_TREASURE_SEED_LEVELS = [
  { level: 1, threshold: 15_000 },
  { level: 2, threshold: 60_000 },
  { level: 3, threshold: 200_000 },
  { level: 4, threshold: 350_000 },
].map((l) => ({
  ...l,
  poolStrategy: TreasurePoolStrategy.PERCENTAGE,
  poolPercentBps: 1000,
  winnerAlgorithm: TreasureWinnerAlgorithm.RANDOM,
  winnerCount: 3,
  minStaySeconds: 120,
  minActivityEvents: 0,
}));

@Injectable()
export class VideoRoomTreasureLevelSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoRoomTreasureLevelSeeder.name);

  constructor(private readonly repo: VideoRoomTreasureRepository) {}

  /**
   * A seed failure must never stop the app booting — the feature is simply
   * unavailable until an operator configures levels, which the lifecycle
   * service reports as a configuration fault rather than a phantom session.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const { level, threshold, ...rest } of VIDEO_ROOM_TREASURE_SEED_LEVELS) {
        const inserted = await this.repo.seedLevel(level, {
          threshold: BigInt(threshold),
          enabled: true,
          ...rest,
        });
        if (inserted) created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} video-room treasure level(s)`);
    } catch (err) {
      this.logger.warn(`Video-room treasure level seed skipped: ${(err as Error).message}`);
    }
  }
}
