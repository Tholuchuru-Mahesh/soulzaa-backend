import type { ConfigService } from '@nestjs/config';
import { BusinessException } from 'src/common/exceptions';
import type { VideoRoomStateSnapshot } from '../interfaces/room-state-manager.interface';
import { VideoRoomStateService } from './video-room-state.service';

function configMock(): ConfigService {
  return {
    get: jest.fn().mockReturnValue({ stateTtlSeconds: 300 }),
  } as unknown as ConfigService;
}

function snapshot(overrides: Partial<VideoRoomStateSnapshot> = {}): VideoRoomStateSnapshot {
  return {
    roomId: 'r1',
    version: 3,
    status: 'LIVE',
    participantCount: 1,
    viewerCount: 2,
    hostCount: 0,
    onlineCount: 2,
    reconnectingCount: 0,
    idleCount: 0,
    isLocked: false,
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('VideoRoomStateService', () => {
  let cache: any;
  let locks: any;
  let repo: any;
  let service: VideoRoomStateService;

  beforeEach(() => {
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    // withLock just runs the critical section.
    locks = { withLock: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()) };
    repo = { findById: jest.fn().mockResolvedValue(null) };
    service = new VideoRoomStateService(cache, locks, repo, configMock());
  });

  it('applyUpdate runs under the room state lock, bumps version, and persists', async () => {
    cache.get.mockResolvedValue(snapshot({ version: 3, viewerCount: 2 }));

    const next = await service.applyUpdate('r1', (c) => ({ viewerCount: c.viewerCount + 1 }));

    expect(locks.withLock).toHaveBeenCalledWith(
      expect.stringContaining('r1'),
      expect.any(Function),
    );
    expect(next.version).toBe(4);
    expect(next.viewerCount).toBe(3);
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('r1'), next, 300);
  });

  it('applyUpdate restores from the durable record when no snapshot is cached', async () => {
    cache.get.mockResolvedValue(null);
    repo.findById.mockResolvedValue({ id: 'r1', status: 'LIVE', isLocked: true });

    const next = await service.applyUpdate('r1', () => ({ participantCount: 5 }));

    // restore seeds version 1, then applyUpdate bumps to 2.
    expect(next.version).toBe(2);
    expect(next.participantCount).toBe(5);
    expect(next.isLocked).toBe(true);
  });

  it('applyUpdate throws VIDEO_ROOM_INVALID_STATE when the room does not exist', async () => {
    cache.get.mockResolvedValue(null);
    repo.findById.mockResolvedValue(null);

    await expect(service.applyUpdate('r1', () => ({}))).rejects.toThrow(BusinessException);
  });

  it('restore rebuilds a versioned snapshot from the durable room row', async () => {
    repo.findById.mockResolvedValue({ id: 'r1', status: 'OFFLINE', isLocked: false });

    const snap = await service.restore('r1');

    expect(snap).toMatchObject({ roomId: 'r1', version: 1, status: 'OFFLINE', isLocked: false });
    expect(cache.set).toHaveBeenCalled();
  });

  it('restore returns null when the room is gone', async () => {
    repo.findById.mockResolvedValue(null);
    expect(await service.restore('r1')).toBeNull();
  });
});
