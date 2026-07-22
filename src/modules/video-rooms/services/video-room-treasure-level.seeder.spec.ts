import {
  VIDEO_ROOM_TREASURE_SEED_LEVELS,
  VideoRoomTreasureLevelSeeder,
} from './video-room-treasure-level.seeder';

describe('VideoRoomTreasureLevelSeeder', () => {
  let repo: { seedLevel: jest.Mock };
  let seeder: VideoRoomTreasureLevelSeeder;

  beforeEach(() => {
    repo = { seedLevel: jest.fn().mockResolvedValue(true) };
    seeder = new VideoRoomTreasureLevelSeeder(repo as never);
  });

  it('seeds the four-level ladder from the PRD', () => {
    expect(VIDEO_ROOM_TREASURE_SEED_LEVELS.map((l) => l.threshold)).toEqual([
      15_000, 60_000, 200_000, 350_000,
    ]);
  });

  it('defaults every level to a 10% percentage pool with 3 random winners', () => {
    for (const level of VIDEO_ROOM_TREASURE_SEED_LEVELS) {
      expect(level.poolStrategy).toBe('PERCENTAGE');
      expect(level.poolPercentBps).toBe(1000);
      expect(level.winnerAlgorithm).toBe('RANDOM');
      expect(level.winnerCount).toBe(3);
    }
  });

  it('writes each threshold as BigInt', async () => {
    await seeder.onApplicationBootstrap();
    expect(repo.seedLevel).toHaveBeenCalledTimes(4);
    expect(repo.seedLevel).toHaveBeenCalledWith(1, expect.objectContaining({ threshold: 15_000n }));
    expect(repo.seedLevel).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ threshold: 350_000n }),
    );
  });

  it('does not pass `level` inside the data payload', async () => {
    await seeder.onApplicationBootstrap();
    expect(repo.seedLevel.mock.calls[0][1]).not.toHaveProperty('level');
  });

  // A seed failure must never stop the app booting — the feature is simply
  // unavailable until an operator configures levels.
  it('logs and continues when seeding throws', async () => {
    repo.seedLevel.mockRejectedValue(new Error('db down'));
    await expect(seeder.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
