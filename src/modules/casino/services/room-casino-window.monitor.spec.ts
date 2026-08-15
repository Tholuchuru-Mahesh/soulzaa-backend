import { LockService } from 'src/infra/redis/lock.service';
import {
  CASINO_WINDOW_SWEEP_INTERVAL_MS,
  CASINO_WINDOW_SWEEP_LOCK_KEY,
} from '../constants/casino.constants';
import { RoomCasinoWindowMonitor } from './room-casino-window.monitor';
import { RoomCasinoWindowService } from './room-casino-window.service';

function makeMonitor() {
  const windows = { sweepOrphanWindows: jest.fn().mockResolvedValue(0) };
  const locks = {
    acquire: jest.fn().mockResolvedValue(() => Promise.resolve()),
  };
  const monitor = new RoomCasinoWindowMonitor(
    windows as unknown as RoomCasinoWindowService,
    locks as unknown as LockService,
  );
  return { monitor, windows, locks };
}

/** Flush the async `void this.tick()` chain (all promises here are already-resolved). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RoomCasinoWindowMonitor — orphan-window sweep', () => {
  it('acquires the Redis lock and sweeps orphan windows on bootstrap', async () => {
    const { monitor, windows, locks } = makeMonitor();
    monitor.onModuleInit();
    await flush();

    expect(locks.acquire).toHaveBeenCalledWith(
      CASINO_WINDOW_SWEEP_LOCK_KEY,
      CASINO_WINDOW_SWEEP_INTERVAL_MS,
    );
    expect(windows.sweepOrphanWindows).toHaveBeenCalledTimes(1);

    monitor.onModuleDestroy();
  });

  it('skips the sweep entirely when another instance holds the lock', async () => {
    const { monitor, windows, locks } = makeMonitor();
    locks.acquire.mockResolvedValue(null);
    monitor.onModuleInit();
    await flush();

    expect(windows.sweepOrphanWindows).not.toHaveBeenCalled();

    monitor.onModuleDestroy();
  });

  it('does not run a sweep concurrently while a previous one is in flight', async () => {
    const { monitor, windows } = makeMonitor();
    let releaseSweep!: () => void;
    windows.sweepOrphanWindows.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSweep = () => resolve(0);
        }),
    );
    monitor.onModuleInit();
    await flush();
    expect(windows.sweepOrphanWindows).toHaveBeenCalledTimes(1);

    await (monitor as unknown as { tick(): Promise<void> }).tick();
    expect(windows.sweepOrphanWindows).toHaveBeenCalledTimes(1);

    releaseSweep();
    await flush();
    monitor.onModuleDestroy();
  });

  it('clears the interval on shutdown', () => {
    const { monitor } = makeMonitor();
    monitor.onModuleInit();
    const timer = (monitor as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(timer).not.toBeNull();
    monitor.onModuleDestroy();
    expect((monitor as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });
});
