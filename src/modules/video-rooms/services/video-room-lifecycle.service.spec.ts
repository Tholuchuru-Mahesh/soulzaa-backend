import { ForbiddenException } from '@nestjs/common';
import {
  VideoRoomLogAction,
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomAccessPolicy } from '../constants/video-room-lifecycle';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomLifecycleService } from './video-room-lifecycle.service';

function fullRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    ownerId: 'owner',
    name: 'Room',
    description: null,
    imageKey: null,
    categoryId: null,
    language: null,
    country: null,
    tags: [],
    visibility: VideoRoomVisibility.PUBLIC,
    isLocked: false,
    passwordHash: null,
    isDiscoverable: true,
    isVerified: false,
    maxParticipants: 12,
    maxViewers: 500,
    status: VideoRoomStatus.OFFLINE,
    streamingStatus: VideoRoomStreamingStatus.IDLE,
    endedAt: null,
    deletedAt: null,
    metadata: null,
    createdAt: new Date('2026-07-20T00:00:00Z'),
    updatedAt: new Date('2026-07-20T00:00:00Z'),
    ...overrides,
  };
}

const actor: RoomActor = { id: 'owner', roles: [] };

describe('VideoRoomLifecycleService', () => {
  let repo: any;
  let permissions: any;
  let events: any;
  let passwords: any;
  let locks: any;
  let metrics: any;
  let platformBans: any;
  let broadBans: any;
  let service: VideoRoomLifecycleService;

  beforeEach(() => {
    repo = {
      countActiveByOwner: jest.fn().mockResolvedValue(0),
      createRoomTx: jest.fn().mockResolvedValue(fullRoom()),
      findById: jest.fn().mockResolvedValue(fullRoom()),
      findDeletedById: jest.fn().mockResolvedValue(null),
      findDetail: jest
        .fn()
        .mockResolvedValue({ room: fullRoom(), settings: null, statistics: null }),
      updateRoom: jest.fn().mockResolvedValue(fullRoom()),
      softDelete: jest.fn().mockResolvedValue(fullRoom({ deletedAt: new Date() })),
      restore: jest.fn().mockResolvedValue(fullRoom()),
      appendLog: jest.fn().mockResolvedValue(undefined),
      setCachedSnapshot: jest.fn().mockResolvedValue(undefined),
      clearCachedSnapshot: jest.fn().mockResolvedValue(undefined),
      trendingBump: jest.fn().mockResolvedValue(undefined),
      trendingRemove: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
    };
    events = {
      emitRoomCreated: jest.fn().mockResolvedValue(undefined),
      emitRoomUpdated: jest.fn().mockResolvedValue(undefined),
      emitRoomClosed: jest.fn().mockResolvedValue(undefined),
      emitRoomDeleted: jest.fn().mockResolvedValue(undefined),
      emitRoomLocked: jest.fn().mockResolvedValue(undefined),
      emitRoomRestored: jest.fn().mockResolvedValue(undefined),
      emitRoomStarted: jest.fn().mockResolvedValue(undefined),
    };
    passwords = { hash: jest.fn().mockResolvedValue('HASH') };
    locks = { withLock: jest.fn((_key: string, fn: () => unknown) => fn()) };
    metrics = { incCreated: jest.fn(), incDeleted: jest.fn(), incLocked: jest.fn() };
    platformBans = { assertNotGloballyBanned: jest.fn().mockResolvedValue(undefined) };
    broadBans = { assertNotBroadBanned: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn().mockReturnValue({
        maxRoomsPerOwner: 1,
        defaultMaxParticipants: 12,
        maxParticipantsCap: 20,
        defaultMaxViewers: 500,
        maxViewersCap: 5000,
        cacheTtlSeconds: 60,
      }),
    };
    service = new VideoRoomLifecycleService(
      repo,
      permissions,
      events,
      passwords,
      locks,
      config as any,
      metrics,
      platformBans,
      broadBans,
    );
  });

  describe('create', () => {
    // The per-owner room cap was deliberately removed — a host may run several
    // rooms at once. This pins that: if the cap is ever re-enabled, this test
    // fails and forces the product decision to be made explicitly rather than
    // silently reinstated. See the commented-out block in create().
    it('does not cap how many rooms one owner may host', async () => {
      repo.countActiveByOwner.mockResolvedValue(5);
      const view = await service.create(actor, { name: 'x' } as any);
      expect(view.id).toBe('r1');
      expect(repo.createRoomTx).toHaveBeenCalled();
      expect(repo.countActiveByOwner).not.toHaveBeenCalled();
    });

    it('creates a room, caches, bumps trending, emits, and counts the metric', async () => {
      const view = await service.create(actor, { name: 'My Room' } as any);
      expect(repo.createRoomTx).toHaveBeenCalled();
      expect(repo.trendingBump).toHaveBeenCalledWith('r1');
      expect(repo.setCachedSnapshot).toHaveBeenCalled();
      expect(events.emitRoomCreated).toHaveBeenCalled();
      expect(metrics.incCreated).toHaveBeenCalled();
      expect(view.id).toBe('r1');
    });

    it('hashes a supplied password and locks the room', async () => {
      await service.create(actor, { name: 'x', password: 'secret' } as any);
      expect(passwords.hash).toHaveBeenCalledWith('secret');
      const data = repo.createRoomTx.mock.calls[0][0];
      expect(data.isLocked).toBe(true);
      expect(data.passwordHash).toBe('HASH');
    });

    it('rejects PASSWORD access policy without a password', async () => {
      await expect(
        service.create(actor, { name: 'x', accessPolicy: VideoRoomAccessPolicy.PASSWORD } as any),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID });
    });

    it('stores an extended access policy in metadata', async () => {
      await service.create(actor, {
        name: 'x',
        accessPolicy: VideoRoomAccessPolicy.VIP_ONLY,
      } as any);
      const data = repo.createRoomTx.mock.calls[0][0];
      expect(data.metadata).toEqual({ accessPolicy: VideoRoomAccessPolicy.VIP_ONLY });
    });

    it('clamps maxParticipants to the configured hard cap', async () => {
      await service.create(actor, { name: 'x', maxParticipants: 9999 } as any);
      expect(repo.createRoomTx.mock.calls[0][0].maxParticipants).toBe(20);
    });

    it('rejects room creation when the actor has an active Broad-ban creation restriction', async () => {
      broadBans.assertNotBroadBanned.mockRejectedValue(
        new ForbiddenException('creation restricted'),
      );
      await expect(service.create(actor, { name: 'My Room' } as any)).rejects.toThrow(
        'creation restricted',
      );
    });
  });

  describe('update', () => {
    it('throws NOT_FOUND for a missing room', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update(actor, 'r1', { name: 'x' } as any)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('checks MANAGE_ROOM and emits updated with the changed set', async () => {
      await service.update(actor, 'r1', { name: 'New', description: 'D' } as any);
      // VR-7: room editing moved off the coarse assertCanManage gate onto a real
      // permission, which is what keeps admins out of the room profile per PRD.
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        expect.anything(),
        VideoRoomPermission.MANAGE_ROOM,
      );
      expect(repo.updateRoom).toHaveBeenCalled();
      const payload = events.emitRoomUpdated.mock.calls[0][0];
      expect(payload.changed).toEqual(expect.arrayContaining(['name', 'description']));
    });
  });

  describe('lock / unlock', () => {
    it('locks with a password and emits locked + counts the metric', async () => {
      await service.lock(actor, 'r1', { password: 'pw' } as any);
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        expect.anything(),
        VideoRoomPermission.LOCK_ROOM,
      );
      const data = repo.updateRoom.mock.calls[0][1];
      expect(data).toMatchObject({ isLocked: true, passwordHash: 'HASH' });
      expect(events.emitRoomLocked).toHaveBeenCalledWith(
        expect.objectContaining({ isLocked: true }),
      );
      expect(metrics.incLocked).toHaveBeenCalled();
    });

    it('rejects locking an already-locked room with no new password', async () => {
      repo.findById.mockResolvedValue(fullRoom({ isLocked: true, passwordHash: 'OLD' }));
      await expect(service.lock(actor, 'r1', {} as any)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ALREADY_LOCKED,
      });
    });

    it('unlock clears the lock + password and emits locked(false)', async () => {
      repo.findById.mockResolvedValue(fullRoom({ isLocked: true, passwordHash: 'OLD' }));
      await service.unlock(actor, 'r1');
      const data = repo.updateRoom.mock.calls[0][1];
      expect(data).toMatchObject({ isLocked: false, passwordHash: null });
      expect(events.emitRoomLocked).toHaveBeenCalledWith(
        expect.objectContaining({ isLocked: false }),
      );
    });
  });

  describe('activate / close / reopen', () => {
    it('activate moves OFFLINE -> LIVE and bumps trending', async () => {
      await service.activate(actor, 'r1');
      expect(repo.updateRoom.mock.calls[0][1]).toMatchObject({ status: VideoRoomStatus.LIVE });
      expect(repo.trendingBump).toHaveBeenCalledWith('r1');
    });

    it('activate rejects an illegal transition (from ENDED)', async () => {
      repo.findById.mockResolvedValue(fullRoom({ status: VideoRoomStatus.ENDED }));
      await expect(service.activate(actor, 'r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
    });

    it('activate rejects reactivating a room the owner has an active Broad-ban creation restriction on', async () => {
      broadBans.assertNotBroadBanned.mockRejectedValue(
        new ForbiddenException('creation restricted'),
      );
      await expect(service.activate(actor, 'r1')).rejects.toThrow('creation restricted');
      expect(repo.updateRoom).not.toHaveBeenCalled();
    });

    it('close requires CLOSE_ROOM, ends the room, clears trending + cache, emits closed', async () => {
      repo.findById.mockResolvedValue(fullRoom({ status: VideoRoomStatus.LIVE }));
      await service.close(actor, 'r1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        expect.anything(),
        VideoRoomPermission.CLOSE_ROOM,
      );
      expect(repo.updateRoom.mock.calls[0][1]).toMatchObject({ status: VideoRoomStatus.ENDED });
      expect(repo.trendingRemove).toHaveBeenCalledWith('r1');
      expect(events.emitRoomClosed).toHaveBeenCalled();
    });

    it('reopen moves ENDED -> OFFLINE', async () => {
      repo.findById.mockResolvedValue(fullRoom({ status: VideoRoomStatus.ENDED }));
      await service.reopen(actor, 'r1');
      expect(repo.updateRoom.mock.calls[0][1]).toMatchObject({
        status: VideoRoomStatus.OFFLINE,
        endedAt: null,
      });
    });

    it('reopen rejects a non-ended room', async () => {
      repo.findById.mockResolvedValue(fullRoom({ status: VideoRoomStatus.OFFLINE }));
      await expect(service.reopen(actor, 'r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
    });
  });

  describe('remove / restore', () => {
    it('remove soft-deletes, clears runtime, emits deleted, counts the metric', async () => {
      const res = await service.remove(actor, 'r1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        expect.anything(),
        VideoRoomPermission.CLOSE_ROOM,
      );
      expect(repo.softDelete).toHaveBeenCalledWith('r1', 'owner');
      expect(repo.clearCachedSnapshot).toHaveBeenCalledWith('r1');
      expect(repo.trendingRemove).toHaveBeenCalledWith('r1');
      expect(events.emitRoomDeleted).toHaveBeenCalled();
      expect(metrics.incDeleted).toHaveBeenCalled();
      expect(res).toEqual({ deleted: true });
      // A DELETED audit row is written.
      expect(
        repo.appendLog.mock.calls.some((c: any[]) => c[0].action === VideoRoomLogAction.DELETED),
      ).toBe(true);
    });

    it('restore throws NOT_FOUND when there is no deleted room', async () => {
      repo.findDeletedById.mockResolvedValue(null);
      await expect(service.restore(actor, 'r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('restore un-deletes and emits restored', async () => {
      repo.findDeletedById.mockResolvedValue(fullRoom({ deletedAt: new Date() }));
      const view = await service.restore(actor, 'r1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        expect.anything(),
        VideoRoomPermission.MANAGE_ROOM,
      );
      expect(repo.restore).toHaveBeenCalledWith('r1', 'owner');
      expect(events.emitRoomRestored).toHaveBeenCalled();
      expect(view.id).toBe('r1');
    });
  });
});
