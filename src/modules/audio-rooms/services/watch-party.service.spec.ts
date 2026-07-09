import { WatchPartyStatus } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { WatchPartyRepository } from '../repositories/watch-party.repository';
import { RoomPermissionService } from './room-permission.service';
import { WatchPartyService } from './watch-party.service';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const ROOM = 'room-1';
const VIDEO = 'dQw4w9WgXcQ';

function row(overrides: Record<string, unknown> = {}) {
  return {
    roomId: ROOM,
    videoId: VIDEO,
    status: WatchPartyStatus.PLAYING,
    positionSeconds: 10,
    controlledBy: OWNER.id,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WatchPartyService', () => {
  let repo: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let service: WatchPartyService;

  beforeEach(() => {
    repo = {
      get: jest.fn().mockResolvedValue(row()),
      upsert: jest
        .fn()
        .mockImplementation((roomId, data) =>
          Promise.resolve({ roomId, ...data, updatedAt: new Date() }),
        ),
    };
    permissions = { getEffectiveRole: jest.fn().mockResolvedValue('OWNER') };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new WatchPartyService(
      repo as unknown as WatchPartyRepository,
      permissions as unknown as RoomPermissionService,
      locks as unknown as LockService,
      bus,
    );
  });

  describe('setVideo', () => {
    it('sets a valid video PLAYING from position 0 and broadcasts', async () => {
      await service.setVideo(OWNER, ROOM, VIDEO);
      expect(repo.upsert).toHaveBeenCalledWith(
        ROOM,
        expect.objectContaining({
          videoId: VIDEO,
          status: WatchPartyStatus.PLAYING,
          positionSeconds: 0,
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.watch_party_updated' }),
      );
    });

    it('rejects an invalid video id', async () => {
      await expect(service.setVideo(OWNER, ROOM, 'short')).rejects.toMatchObject({
        errorCode: 'INVALID_VIDEO_ID',
      });
    });

    it('rejects a non owner/admin', async () => {
      permissions.getEffectiveRole.mockResolvedValue('LISTENER');
      await expect(service.setVideo(OWNER, ROOM, VIDEO)).rejects.toMatchObject({
        errorCode: 'WATCH_PARTY_NOT_AUTHORIZED',
      });
    });
  });

  describe('pause', () => {
    it('freezes at the drift-corrected position', async () => {
      repo.get.mockResolvedValue(
        row({ positionSeconds: 10, updatedAt: new Date(Date.now() - 5000) }),
      );
      await service.pause(OWNER, ROOM);
      // 10 + ~5s elapsed
      expect(repo.upsert).toHaveBeenCalledWith(
        ROOM,
        expect.objectContaining({
          status: WatchPartyStatus.PAUSED,
          positionSeconds: expect.any(Number),
        }),
      );
      const arg = repo.upsert.mock.calls[0][1];
      expect(arg.positionSeconds).toBeGreaterThanOrEqual(14);
    });
  });

  describe('play', () => {
    it('rejects when no watch party is active', async () => {
      repo.get.mockResolvedValue(null);
      await expect(service.play(OWNER, ROOM)).rejects.toMatchObject({
        errorCode: 'WATCH_PARTY_INACTIVE',
      });
    });
  });

  describe('getState', () => {
    it('returns the drift-corrected effective position while playing', async () => {
      repo.get.mockResolvedValue(
        row({ positionSeconds: 100, updatedAt: new Date(Date.now() - 3000) }),
      );
      const state = (await service.getState(ROOM)) as { positionSeconds: number };
      expect(state.positionSeconds).toBeGreaterThanOrEqual(102);
    });
  });
});
