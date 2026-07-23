import { loadVideoRoomRankingConfig } from './video-room-ranking.config';

const svc = (raw: unknown) => ({ get: () => raw }) as never;

describe('loadVideoRoomRankingConfig', () => {
  it('throws when the namespace is not registered', () => {
    expect(() => loadVideoRoomRankingConfig(svc(undefined))).toThrow(/videoRoomRanking/);
  });

  it('applies documented defaults for an empty namespace', () => {
    const cfg = loadVideoRoomRankingConfig(svc({}));
    expect(cfg.enabled).toBe(true);
    expect(cfg.cacheTtlSeconds).toBe(15);
    expect(cfg.dedupeTtlSeconds).toBe(172_800);
    expect(cfg.roomLadderTtlSeconds).toBe(604_800);
    expect(cfg.coalesceWindowMs).toBe(1_000);
    expect(cfg.weights.host.coins).toBe(1);
    expect(cfg.weights.host.pkWin).toBe(500);
    expect(cfg.weights.rooms.peakViewers).toBe(10);
    expect(cfg.weights.pk.win).toBe(1000);
    expect(cfg.retentionDays.hourly).toBe(90);
    expect(cfg.retentionDays.daily).toBe(400);
  });

  it('coerces numeric strings, since namespaced env values arrive as strings', () => {
    const cfg = loadVideoRoomRankingConfig(svc({ cacheTtlSeconds: '45', hostCoinWeight: '3' }));
    expect(cfg.cacheTtlSeconds).toBe(45);
    expect(cfg.weights.host.coins).toBe(3);
  });

  it('falls back rather than propagating NaN or empty strings', () => {
    const cfg = loadVideoRoomRankingConfig(svc({ cacheTtlSeconds: 'abc', coalesceWindowMs: '' }));
    expect(cfg.cacheTtlSeconds).toBe(15);
    expect(cfg.coalesceWindowMs).toBe(1_000);
  });

  it('reads the string "false" as false rather than truthy', () => {
    expect(loadVideoRoomRankingConfig(svc({ enabled: 'false' })).enabled).toBe(false);
  });
});
