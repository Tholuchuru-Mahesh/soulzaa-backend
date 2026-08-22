import { ConfigService } from '@nestjs/config';
import { PrivacyLevel } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions';
import { IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrivacyAction } from '../interfaces/privacy.interface';
import { IRelationshipProvider } from '../interfaces/relationship-provider.interface';
import { PrivacyRepository } from '../repositories/privacy.repository';
import { PrivacyService } from './privacy.service';

function settings(over: Partial<Record<string, PrivacyLevel>> = {}) {
  return {
    userId: 'target',
    onlineStatus: PrivacyLevel.EVERYONE,
    lastSeen: PrivacyLevel.EVERYONE,
    profileVisibility: PrivacyLevel.EVERYONE,
    callPermission: PrivacyLevel.EVERYONE,
    messagePermission: PrivacyLevel.EVERYONE,
    friendRequestPermission: PrivacyLevel.EVERYONE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as never;
}

describe('PrivacyService', () => {
  let repo: jest.Mocked<
    Pick<
      PrivacyRepository,
      | 'ensureSettings'
      | 'updateSettings'
      | 'ensurePreferences'
      | 'updatePreferences'
      | 'createBlock'
      | 'deleteBlock'
      | 'blockExists'
      | 'listBlocked'
      | 'getUsersDetails'
      | 'getUserProfiles'
      | 'blockRelationshipIds'
    >
  >;
  let cache: jest.Mocked<Pick<CacheService, 'get' | 'set' | 'del'>>;
  let bus: jest.Mocked<IEventBus>;
  let relationships: jest.Mocked<IRelationshipProvider>;
  let service: PrivacyService;

  beforeEach(() => {
    repo = {
      ensureSettings: jest.fn().mockResolvedValue(settings()),
      updateSettings: jest.fn().mockResolvedValue(settings()),
      ensurePreferences: jest.fn(),
      updatePreferences: jest.fn(),
      createBlock: jest.fn().mockResolvedValue(undefined),
      deleteBlock: jest.fn().mockResolvedValue({ count: 1 }),
      blockExists: jest.fn().mockResolvedValue(null),
      listBlocked: jest.fn().mockResolvedValue([]),
      getUsersDetails: jest.fn().mockResolvedValue([]),
      getUserProfiles: jest.fn().mockResolvedValue([]),
      blockRelationshipIds: jest.fn().mockResolvedValue([]),
    };
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    relationships = {
      isFriend: jest.fn().mockResolvedValue(false),
      isFollower: jest.fn().mockResolvedValue(false),
    };
    const config = { get: () => ({ cacheTtlSeconds: 300 }) } as unknown as ConfigService;
    service = new PrivacyService(
      repo as unknown as PrivacyRepository,
      cache as unknown as CacheService,
      bus,
      relationships,
      config,
    );
  });

  describe('check engine', () => {
    it('allows a user to see their own resource without touching settings', async () => {
      const ok = await service.check('me', 'me', PrivacyAction.VIEW_PROFILE);
      expect(ok).toBe(true);
      expect(repo.ensureSettings).not.toHaveBeenCalled();
    });

    it('allows EVERYONE for an anonymous viewer', async () => {
      repo.ensureSettings.mockResolvedValue(settings({ profileVisibility: PrivacyLevel.EVERYONE }));
      expect(await service.check(null, 'target', PrivacyAction.VIEW_PROFILE)).toBe(true);
    });

    it('denies NOBODY', async () => {
      repo.ensureSettings.mockResolvedValue(settings({ messagePermission: PrivacyLevel.NOBODY }));
      expect(await service.check('viewer', 'target', PrivacyAction.MESSAGE)).toBe(false);
    });

    it('resolves FRIENDS_ONLY through the relationship provider', async () => {
      repo.ensureSettings.mockResolvedValue(
        settings({ profileVisibility: PrivacyLevel.FRIENDS_ONLY }),
      );
      relationships.isFriend.mockResolvedValue(true);
      expect(await service.check('viewer', 'target', PrivacyAction.VIEW_PROFILE)).toBe(true);
      expect(relationships.isFriend).toHaveBeenCalledWith('viewer', 'target');
    });

    it('denies FRIENDS_ONLY for an anonymous viewer (no relationship possible)', async () => {
      repo.ensureSettings.mockResolvedValue(
        settings({ profileVisibility: PrivacyLevel.FRIENDS_ONLY }),
      );
      expect(await service.check(null, 'target', PrivacyAction.VIEW_PROFILE)).toBe(false);
      expect(relationships.isFriend).not.toHaveBeenCalled();
    });

    it('resolves FOLLOWERS_ONLY through the relationship provider', async () => {
      repo.ensureSettings.mockResolvedValue(
        settings({ callPermission: PrivacyLevel.FOLLOWERS_ONLY }),
      );
      relationships.isFollower.mockResolvedValue(true);
      expect(await service.check('viewer', 'target', PrivacyAction.CALL)).toBe(true);
      expect(relationships.isFollower).toHaveBeenCalledWith('viewer', 'target');
    });

    it('short-circuits to deny when a block relationship exists, ignoring the level', async () => {
      repo.blockRelationshipIds.mockResolvedValue(['target']);
      repo.ensureSettings.mockResolvedValue(settings({ profileVisibility: PrivacyLevel.EVERYONE }));
      expect(await service.check('viewer', 'target', PrivacyAction.VIEW_PROFILE)).toBe(false);
      expect(repo.ensureSettings).not.toHaveBeenCalled();
    });
  });

  describe('updateSettings', () => {
    it('persists only provided fields, invalidates cache, and emits privacy.updated', async () => {
      repo.updateSettings.mockResolvedValue(settings({ profileVisibility: PrivacyLevel.NOBODY }));
      const view = await service.updateSettings('u1', { profileVisibility: PrivacyLevel.NOBODY });
      expect(repo.updateSettings).toHaveBeenCalledWith('u1', {
        profileVisibility: PrivacyLevel.NOBODY,
      });
      expect(cache.del).toHaveBeenCalledWith('privacy:settings:u1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'privacy.updated',
          payload: expect.objectContaining({ kind: 'settings', changed: ['profileVisibility'] }),
        }),
      );
      expect(view.profileVisibility).toBe(PrivacyLevel.NOBODY);
    });
  });

  describe('getSettings', () => {
    it('returns a cached view without hitting the repository', async () => {
      cache.get.mockResolvedValue(settings());
      await service.getSettings('u1');
      expect(repo.ensureSettings).not.toHaveBeenCalled();
    });

    it('populates the cache on a miss', async () => {
      await service.getSettings('u1');
      expect(repo.ensureSettings).toHaveBeenCalledWith('u1');
      expect(cache.set).toHaveBeenCalledWith('privacy:settings:u1', expect.any(Object), 300);
    });
  });

  describe('block', () => {
    it('rejects blocking yourself', async () => {
      await expect(service.block('u1', 'u1')).rejects.toBeInstanceOf(BusinessException);
      expect(repo.createBlock).not.toHaveBeenCalled();
    });

    it('rejects a duplicate block', async () => {
      repo.blockExists.mockResolvedValue({ id: 'b1' } as never);
      await expect(service.block('u1', 'u2')).rejects.toBeInstanceOf(BusinessException);
      expect(repo.createBlock).not.toHaveBeenCalled();
    });

    it('creates the block, invalidates both block-sets, and emits user.blocked', async () => {
      await service.block('u1', 'u2', 'spam');
      expect(repo.createBlock).toHaveBeenCalledWith('u1', 'u2', 'spam');
      expect(cache.del).toHaveBeenCalledWith('privacy:blockset:u1', 'privacy:blockset:u2');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'user.blocked',
          payload: { blockerId: 'u1', blockedId: 'u2' },
        }),
      );
    });
  });

  describe('unblock', () => {
    it('deletes the block, invalidates cache, and emits user.unblocked', async () => {
      await service.unblock('u1', 'u2');
      expect(repo.deleteBlock).toHaveBeenCalledWith('u1', 'u2');
      expect(cache.del).toHaveBeenCalledWith('privacy:blockset:u1', 'privacy:blockset:u2');
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.unblocked' }));
    });
  });

  describe('blockedIdsFor', () => {
    it('caches the block relationship set', async () => {
      repo.blockRelationshipIds.mockResolvedValue(['a', 'b']);
      const ids = await service.blockedIdsFor('u1');
      expect(ids).toEqual(['a', 'b']);
      expect(cache.set).toHaveBeenCalledWith('privacy:blockset:u1', ['a', 'b'], 300);
    });

    it('serves from cache without querying', async () => {
      cache.get.mockResolvedValue(['x']);
      expect(await service.blockedIdsFor('u1')).toEqual(['x']);
      expect(repo.blockRelationshipIds).not.toHaveBeenCalled();
    });
  });
});
