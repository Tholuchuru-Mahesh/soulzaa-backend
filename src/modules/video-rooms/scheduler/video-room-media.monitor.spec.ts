import { VideoRoomMediaMonitor } from './video-room-media.monitor';

function makeMonitor(
  overrides: {
    acquire?: jest.Mock;
    release?: jest.Mock;
    findStale?: jest.Mock;
  } = {},
) {
  const release = overrides.release ?? jest.fn();
  const cfg = {
    get: () => ({
      mediaHeartbeatTtlSeconds: 30,
      mediaReconnectGraceSeconds: 60,
      mediaMonitorIntervalSeconds: 10,
    }),
  };
  const locks = { acquire: overrides.acquire ?? jest.fn().mockResolvedValue(release) };
  const recovery = { markRecovering: jest.fn(), expireRecovery: jest.fn() };
  const sessions = { findStale: overrides.findStale ?? jest.fn().mockResolvedValue([]) };
  const mon = new VideoRoomMediaMonitor(
    locks as never,
    recovery as never,
    sessions as never,
    cfg as never,
  );
  return { mon, locks, recovery, sessions, release };
}

describe('VideoRoomMediaMonitor', () => {
  it('marks recovering for a freshly-stale session, expires past grace', async () => {
    const now = Date.now();
    const { mon, recovery } = makeMonitor({
      findStale: jest.fn().mockResolvedValue([
        { roomId: 'r', userId: 'fresh', lastHeartbeatAt: new Date(now - 35_000) }, // stale, within grace
        { roomId: 'r', userId: 'gone', lastHeartbeatAt: new Date(now - 120_000) }, // past grace
      ]),
    });
    await mon.sweep();
    expect(recovery.markRecovering).toHaveBeenCalledWith('r', 'fresh');
    expect(recovery.expireRecovery).toHaveBeenCalledWith('r', 'gone');
  });

  it('acquires the fleet lock, sweeps, then releases it', async () => {
    const { mon, locks, release } = makeMonitor();
    await (mon as unknown as { tick(): Promise<void> }).tick();
    expect(locks.acquire).toHaveBeenCalledWith('video-room:media:monitor', 10_000);
    expect(release).toHaveBeenCalled();
  });

  it('skips the sweep when another instance already holds the lock', async () => {
    const { mon, locks } = makeMonitor({ acquire: jest.fn().mockResolvedValue(undefined) });
    const sweepSpy = jest.spyOn(mon, 'sweep');
    await (mon as unknown as { tick(): Promise<void> }).tick();
    expect(locks.acquire).toHaveBeenCalled();
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('sets an unref-able interval on init and clears it on destroy', () => {
    jest.useFakeTimers();
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const { mon } = makeMonitor();

    mon.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(unref).toHaveBeenCalled();

    mon.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    jest.useRealTimers();
  });
});
