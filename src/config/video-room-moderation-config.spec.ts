/**
 * VR-16 config namespace: `videoRoom.moderation`. Exercises the real
 * `env.validation.ts` schema + `configuration.ts` factory (no ConfigService
 * involved) so a missing/renamed env var or a wrong default is caught here,
 * not only downstream in a mocked service spec.
 *
 * `configuration.ts` memoizes the coerced env in a module-level `coerced`
 * variable (lazy-parsed once per process). Each test therefore resets the
 * module registry and re-`require`s `./configuration` fresh so every case
 * gets its own parse of `process.env`.
 */

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/soulzaa_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('videoRoomConfig().moderation (VR-16)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, ...REQUIRED_ENV };
    // Strip any VIDEO_ROOM_MOD_* the real shell/.env might already export so
    // the "defaults" case is never accidentally satisfied by ambient env.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('VIDEO_ROOM_MOD_')) {
        delete process.env[key];
      }
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function loadModeration() {
    // A fresh `require` after `jest.resetModules()` is the only way to force
    // `./configuration` to re-parse `process.env` within a single test file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { videoRoomConfig } = require('./configuration') as typeof import('./configuration');
    return videoRoomConfig().moderation;
  }

  it('defaults every threshold/window when no VIDEO_ROOM_MOD_* env vars are set', () => {
    const moderation = loadModeration();

    expect(moderation).toEqual({
      spamThreshold: 5,
      spamWindowSec: 60,
      floodThreshold: 10,
      floodWindowSec: 10,
      duplicateWindowSec: 30,
      rapidJoinLeaveThreshold: 5,
      rapidJoinLeaveWindowSec: 60,
      excessiveReportsThreshold: 5,
      excessiveReportsWindowSec: 300,
      warningThreshold: 3,
      autoMuteMinutes: 15,
      autoActionCooldownSec: 30,
      expiryMonitorIntervalMs: 15_000,
      reasonMax: 500,
      descriptionMax: 1000,
    });
  });

  it('mirrors the audio-room chat auto-mod defaults (warning=3, mute-minutes=15, dup-window=30)', () => {
    const moderation = loadModeration();

    expect(moderation.warningThreshold).toBe(3);
    expect(moderation.autoMuteMinutes).toBe(15);
    expect(moderation.duplicateWindowSec).toBe(30);
  });

  it('coerces VIDEO_ROOM_MOD_* overrides to numbers', () => {
    process.env.VIDEO_ROOM_MOD_SPAM_THRESHOLD = '8';
    process.env.VIDEO_ROOM_MOD_AUTO_MUTE_MINUTES = '45';
    process.env.VIDEO_ROOM_MOD_EXPIRY_MONITOR_INTERVAL_MS = '20000';

    const moderation = loadModeration();

    expect(moderation.spamThreshold).toBe(8);
    expect(moderation.autoMuteMinutes).toBe(45);
    expect(moderation.expiryMonitorIntervalMs).toBe(20_000);
    expect(typeof moderation.spamThreshold).toBe('number');
  });

  it('rejects a non-numeric override (fail-fast validation)', () => {
    process.env.VIDEO_ROOM_MOD_SPAM_THRESHOLD = 'not-a-number';

    expect(() => loadModeration()).toThrow(/Invalid environment configuration/);
  });
});
