import { loadVideoRoomTreasureConfig } from './video-room-treasure.config';

const svc = (raw: unknown) => ({ get: () => raw }) as never;

const FULL = {
  enabled: 'true',
  poolBps: '1000',
  winnerCount: '3',
  oversampleFactor: '3',
  oversampleMin: '50',
  minStaySeconds: '120',
  minActivityEvents: '0',
  progressEmitPerSecond: '5',
  orphanTimeoutSeconds: '120',
  recoveryEnabled: 'false',
  monitorIntervalSeconds: '30',
};

describe('loadVideoRoomTreasureConfig', () => {
  it('coerces env strings to numbers', () => {
    const cfg = loadVideoRoomTreasureConfig(svc(FULL));
    expect(cfg.poolBps).toBe(1000);
    expect(cfg.winnerCount).toBe(3);
    expect(cfg.progressEmitPerSecond).toBe(5);
    expect(cfg.orphanTimeoutSeconds).toBe(120);
  });

  // The repo-wide z.coerce.boolean() idiom turns the STRING "false" into true,
  // because any non-empty string is truthy. An operator writing
  // VIDEO_ROOM_TREASURE_RECOVERY_ENABLED=false would silently enable DLQ replay.
  it('treats the string "false" as false, not as a truthy non-empty string', () => {
    const cfg = loadVideoRoomTreasureConfig(
      svc({ ...FULL, enabled: 'false', recoveryEnabled: 'false' }),
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.recoveryEnabled).toBe(false);
  });

  it('accepts the other spellings an operator means by "off"', () => {
    for (const off of ['0', 'no', 'off', 'FALSE']) {
      expect(loadVideoRoomTreasureConfig(svc({ ...FULL, enabled: off })).enabled).toBe(false);
    }
  });

  // A blank env var must not produce NaN and silently disable the throttle or
  // zero the pool.
  it('falls back to the documented default when a numeric value is blank', () => {
    const cfg = loadVideoRoomTreasureConfig(
      svc({ ...FULL, poolBps: '', winnerCount: undefined, progressEmitPerSecond: 'abc' }),
    );
    expect(cfg.poolBps).toBe(1000);
    expect(cfg.winnerCount).toBe(3);
    expect(cfg.progressEmitPerSecond).toBe(5);
  });

  it('defaults enabled to true and recovery to false', () => {
    const cfg = loadVideoRoomTreasureConfig(svc({}));
    expect(cfg.enabled).toBe(true);
    expect(cfg.recoveryEnabled).toBe(false);
  });

  it('throws when the namespace is not registered', () => {
    expect(() => loadVideoRoomTreasureConfig(svc(undefined))).toThrow(
      'videoRoomTreasure config namespace is not registered',
    );
  });
});
