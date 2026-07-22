import { loadVideoRoomPkConfig } from './video-room-pk.config';

const svc = (raw: Record<string, unknown>) =>
  ({ get: () => raw }) as unknown as import('@nestjs/config').ConfigService;

describe('loadVideoRoomPkConfig', () => {
  it('applies defaults when nothing is configured', () => {
    const cfg = loadVideoRoomPkConfig(svc({}));
    expect(cfg.enabled).toBe(true);
    expect(cfg.countdownSeconds).toBe(10);
    expect(cfg.poolBps).toBe(1000);
    expect(cfg.multiplierCapBps).toBe(30_000);
  });

  // The VR-10/VR-11 string-coercion trap: z.coerce.boolean()("false") === true,
  // so booleans bypass zod and are read raw.
  it('reads the STRING "false" as false', () => {
    expect(loadVideoRoomPkConfig(svc({ enabled: 'false' })).enabled).toBe(false);
    expect(loadVideoRoomPkConfig(svc({ recoveryEnabled: 'false' })).recoveryEnabled).toBe(false);
  });

  it('coerces numeric strings', () => {
    expect(loadVideoRoomPkConfig(svc({ poolBps: '2500' })).poolBps).toBe(2500);
  });

  it('keeps the reward split within the pool', () => {
    const cfg = loadVideoRoomPkConfig(svc({}));
    expect(cfg.winnerBps + cfg.participationBps + cfg.bonusBps).toBeLessThanOrEqual(10_000);
  });
});
