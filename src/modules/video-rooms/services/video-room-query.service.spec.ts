import {
  PlatformRole,
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomAccessPolicy, VideoRoomLifecycleState } from '../constants/video-room-lifecycle';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomQueryService } from './video-room-query.service';

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

function actor(id = 'owner', roles: PlatformRole[] = []): RoomActor {
  return { id, roles };
}

describe('VideoRoomQueryService', () => {
  let repo: any;
  let service: VideoRoomQueryService;

  beforeEach(() => {
    repo = {
      findDetail: jest.fn(),
      findAnyById: jest.fn(),
      getCachedSnapshot: jest.fn().mockResolvedValue(null),
      setCachedSnapshot: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      popular: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      trendingTopIds: jest.fn().mockResolvedValue([]),
      findManyByIds: jest.fn().mockResolvedValue([]),
      findByOwnerId: jest.fn().mockResolvedValue([]),
    };
    const config = { get: jest.fn().mockReturnValue({ cacheTtlSeconds: 60 }) };
    service = new VideoRoomQueryService(repo, config as any);
  });

  describe('getDetail', () => {
    it('returns the cached detail view without hitting the DB', async () => {
      repo.getCachedSnapshot.mockResolvedValue({ id: 'r1', name: 'cached' });
      const view = await service.getDetail('r1');
      expect(view).toEqual({ id: 'r1', name: 'cached' });
      expect(repo.findDetail).not.toHaveBeenCalled();
    });

    it('throws VIDEO_ROOM_NOT_FOUND (404) when the room is missing', async () => {
      repo.findDetail.mockResolvedValue(null);
      await expect(service.getDetail('r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        status: 404,
      });
    });

    it('maps + caches a found room with projected lifecycleState + accessPolicy', async () => {
      repo.findDetail.mockResolvedValue({
        room: fullRoom({ status: VideoRoomStatus.LIVE, isLocked: true }),
        settings: null,
        statistics: null,
      });
      const view = await service.getDetail('r1');
      expect(view.lifecycleState).toBe(VideoRoomLifecycleState.LOCKED);
      expect(view.accessPolicy).toBe(VideoRoomAccessPolicy.PASSWORD);
      expect(repo.setCachedSnapshot).toHaveBeenCalledWith('r1', view, 60);
    });
  });

  describe('verifyStatus', () => {
    it('throws NOT_FOUND when the room does not exist at all', async () => {
      repo.findAnyById.mockResolvedValue(null);
      await expect(service.verifyStatus('r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('projects DELETED for a soft-deleted room', async () => {
      repo.findAnyById.mockResolvedValue(
        fullRoom({ status: VideoRoomStatus.LIVE, deletedAt: new Date() }),
      );
      const status = await service.verifyStatus('r1');
      expect(status).toMatchObject({
        roomId: 'r1',
        lifecycleState: VideoRoomLifecycleState.DELETED,
        isDeleted: true,
      });
    });
  });

  describe('list', () => {
    it('forces discoverableOnly for a non-admin and paginates the mapped views', async () => {
      repo.list.mockResolvedValue({ items: [fullRoom()], total: 1 });
      const res = await service.list({ page: 1, limit: 20 } as any, actor('u2'));
      expect(repo.list.mock.calls[0][0]).toMatchObject({
        skip: 0,
        take: 20,
        discoverableOnly: true,
      });
      expect(res).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(res.items[0].id).toBe('r1');
    });

    it('does NOT force discoverableOnly for a platform admin', async () => {
      await service.list({ page: 1, limit: 20 } as any, actor('admin', [PlatformRole.ADMIN]));
      expect(repo.list.mock.calls[0][0].discoverableOnly).toBe(false);
    });
  });

  describe('search', () => {
    it('passes facets through (country, tags, accessPolicy) with role-scoped discoverability', async () => {
      await service.search(
        { page: 1, limit: 10, country: 'US', tags: ['music'], accessPolicy: 'VIP_ONLY' } as any,
        actor('u2'),
      );
      expect(repo.search.mock.calls[0][0]).toMatchObject({
        country: 'US',
        tags: ['music'],
        accessPolicy: 'VIP_ONLY',
        discoverableOnly: true,
      });
    });
  });

  describe('featured', () => {
    it('forces the isVerified facet', async () => {
      await service.featured({ page: 1, limit: 10 } as any, actor('u2'));
      expect(repo.search.mock.calls[0][0].isVerified).toBe(true);
    });
  });

  describe('trending', () => {
    it('hydrates the top ids preserving zset order', async () => {
      repo.trendingTopIds.mockResolvedValue(['b', 'a']);
      repo.findManyByIds.mockResolvedValue([fullRoom({ id: 'b' }), fullRoom({ id: 'a' })]);
      const items = await service.trending(10);
      expect(repo.trendingTopIds).toHaveBeenCalledWith(10);
      expect(items.map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('returns an empty list when nothing is trending', async () => {
      repo.trendingTopIds.mockResolvedValue([]);
      expect(await service.trending(10)).toEqual([]);
      expect(repo.findManyByIds).not.toHaveBeenCalled();
    });
  });

  describe('mine', () => {
    it("returns the owner's rooms as views", async () => {
      repo.findByOwnerId.mockResolvedValue([fullRoom()]);
      const items = await service.mine(actor('owner'));
      expect(repo.findByOwnerId).toHaveBeenCalledWith('owner');
      expect(items[0].id).toBe('r1');
    });
  });
});
