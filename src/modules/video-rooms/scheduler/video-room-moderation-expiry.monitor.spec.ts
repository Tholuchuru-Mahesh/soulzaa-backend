import type { ConfigService } from '@nestjs/config';
import { VideoRoomModerationActionType } from '@prisma/client';
import { UserUnmutedEvent } from '../events/video-room-moderation.events';
import { VideoRoomModerationExpiryMonitor } from './video-room-moderation-expiry.monitor';

function configMock(expiryMonitorIntervalMs = 30_000): ConfigService {
  return {
    get: jest.fn().mockReturnValue({ moderation: { expiryMonitorIntervalMs } }),
  } as unknown as ConfigService;
}

describe('VideoRoomModerationExpiryMonitor', () => {
  let repo: {
    findExpiredMutes: jest.Mock;
    liftMute: jest.Mock;
    removeMuteMirror: jest.Mock;
    appendAction: jest.Mock;
  };
  let locks: { acquire: jest.Mock };
  let bus: { publish: jest.Mock };
  let monitor: VideoRoomModerationExpiryMonitor;

  beforeEach(() => {
    repo = {
      findExpiredMutes: jest.fn().mockResolvedValue([]),
      liftMute: jest.fn().mockResolvedValue(undefined),
      removeMuteMirror: jest.fn().mockResolvedValue(undefined),
      appendAction: jest.fn().mockResolvedValue(undefined),
    };
    // acquire returns a release fn so the critical section runs.
    locks = { acquire: jest.fn().mockResolvedValue(jest.fn().mockResolvedValue(undefined)) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    monitor = new VideoRoomModerationExpiryMonitor(
      repo as never,
      locks as never,
      bus as never,
      configMock(),
    );
  });

  it('lifts an expired mute, clears its mirror, audits the unmute, and publishes UserUnmutedEvent', async () => {
    const mute = {
      id: 'm1',
      roomId: 'r1',
      userId: 'u1',
      moderatorId: 'mod1',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    repo.findExpiredMutes.mockResolvedValue([mute]);

    await (monitor as any).sweep();

    expect(repo.liftMute).toHaveBeenCalledWith('m1', 'mod1');
    expect(repo.removeMuteMirror).toHaveBeenCalledWith('r1', 'u1');
    expect(repo.appendAction).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        moderatorId: 'mod1',
        targetUserId: 'u1',
        action: VideoRoomModerationActionType.UNMUTE,
        reason: 'expired',
      }),
    );
    expect(bus.publish).toHaveBeenCalledTimes(1);
    const event = bus.publish.mock.calls[0][0];
    expect(event).toBeInstanceOf(UserUnmutedEvent);
    expect(event.payload).toEqual({
      roomId: 'r1',
      moderatorId: 'mod1',
      targetUserId: 'u1',
      channels: ['chat'],
      reason: 'expired',
    });
  });

  it('does nothing when another instance already holds the sweep lock', async () => {
    locks.acquire.mockResolvedValue(null);

    await (monitor as any).sweep();

    expect(repo.findExpiredMutes).not.toHaveBeenCalled();
    expect(repo.liftMute).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('acquires the fleet-wide monitor lock, TTL’d to the configured interval', async () => {
    await (monitor as any).sweep();
    expect(locks.acquire).toHaveBeenCalledWith('video-room:moderation:monitor', 30_000);
  });

  it('never touches blocks — only expires mutes', async () => {
    await (monitor as any).sweep();
    expect(Object.keys(repo)).not.toEqual(expect.arrayContaining(['liftBlock']));
  });

  it('keeps sweeping the rest when one mute fails to lift', async () => {
    repo.findExpiredMutes.mockResolvedValue([
      { id: 'm1', roomId: 'r1', userId: 'u1', moderatorId: 'mod1' },
      { id: 'm2', roomId: 'r2', userId: 'u2', moderatorId: 'mod2' },
    ]);
    repo.liftMute.mockRejectedValueOnce(new Error('db down'));

    await (monitor as any).sweep();

    expect(repo.liftMute).toHaveBeenCalledTimes(2);
    // Only the failing mute is skipped; the healthy one still completes.
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it('releases the lock even when the sweep throws', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    locks.acquire.mockResolvedValue(release);
    repo.findExpiredMutes.mockRejectedValue(new Error('redis down'));

    await (monitor as any).sweep();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('sets up an unref’d interval on init and clears it on destroy', () => {
    const setSpy = jest.spyOn(global, 'setInterval');
    monitor.onModuleInit();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    monitor.onModuleDestroy();
    setSpy.mockRestore();
  });
});
