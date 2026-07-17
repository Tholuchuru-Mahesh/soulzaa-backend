import { ConfigService } from '@nestjs/config';
import { VerificationStatus, VerificationType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { UploadService } from 'src/infra/storage/upload.service';
import type { IPrivacyService } from 'src/modules/privacy/interfaces/privacy.interface';
import { ProfileRepository } from '../repositories/profile.repository';
import { UsersRepository } from '../repositories/users.repository';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { ProfileService } from './profile.service';
import type { IUserSearchProvider } from './search/user-search.provider';

const CFG = {
  cacheTtlSeconds: 300,
  shareBaseUrl: 'https://soulzaa.app',
  deeplinkScheme: 'soulzaa://',
};

function makeUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    username: 'aditya',
    fullName: 'Aditya',
    gender: null,
    dateOfBirth: new Date('2000-01-01'),
    country: 'IN',
    preferredLanguage: 'en',
    createdAt: new Date(),
    ...over,
  } as never;
}
const emptyProfile = {
  userId: 'u1',
  bio: null,
  avatarKey: null,
  coverKey: null,
  state: null,
  city: null,
} as never;
const emptyStats = {
  userId: 'u1',
  followersCount: 0,
  followingCount: 0,
  friendsCount: 0,
  giftsSent: 0n,
  giftsReceived: 0n,
  coinsReceived: 0n,
  audioMinutes: 0,
  videoMinutes: 0,
  liveMinutes: 0,
  exp: 0n,
  level: 1,
  vipLevel: 0,
} as never;
const emptyVerification = {
  userId: 'u1',
  verified: false,
  status: VerificationStatus.NONE,
  type: null,
} as never;

describe('ProfileService', () => {
  let users: jest.Mocked<Pick<UsersRepository, 'findById' | 'findByUsername' | 'update'>>;
  let profiles: jest.Mocked<
    Pick<
      ProfileRepository,
      | 'getProfile'
      | 'getStatistics'
      | 'getVerification'
      | 'ensureDefaults'
      | 'updateProfile'
      | 'setMediaKey'
      | 'submitVerification'
      | 'reviewVerification'
    >
  >;
  let cache: jest.Mocked<Pick<CacheService, 'get' | 'set' | 'del'>>;
  let media: jest.Mocked<Pick<MediaUrlResolver, 'resolve'>>;
  let uploads: jest.Mocked<Pick<UploadService, 'confirmUpload' | 'createPresignedUpload'>>;
  let search: jest.Mocked<IUserSearchProvider>;
  let bus: jest.Mocked<IEventBus>;
  let privacy: jest.Mocked<Pick<IPrivacyService, 'check' | 'blockedIdsFor'>>;
  let service: ProfileService;

  beforeEach(() => {
    users = { findById: jest.fn(), findByUsername: jest.fn(), update: jest.fn() };
    profiles = {
      getProfile: jest.fn().mockResolvedValue(emptyProfile),
      getStatistics: jest.fn().mockResolvedValue(emptyStats),
      getVerification: jest.fn().mockResolvedValue(emptyVerification),
      ensureDefaults: jest.fn().mockResolvedValue(undefined),
      updateProfile: jest.fn().mockResolvedValue(emptyProfile),
      setMediaKey: jest.fn().mockResolvedValue(emptyProfile),
      submitVerification: jest.fn(),
      reviewVerification: jest.fn(),
    };
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    };
    media = { resolve: jest.fn().mockResolvedValue(null) };
    uploads = { confirmUpload: jest.fn().mockResolvedValue({}), createPresignedUpload: jest.fn() };
    search = { search: jest.fn() };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    privacy = {
      check: jest.fn().mockResolvedValue(true),
      blockedIdsFor: jest.fn().mockResolvedValue([]),
    };
    const config = { get: () => CFG } as unknown as ConfigService;
    service = new ProfileService(
      users as unknown as UsersRepository,
      profiles as unknown as ProfileRepository,
      media as unknown as MediaUrlResolver,
      uploads as unknown as UploadService,
      cache as unknown as CacheService,
      search,
      bus,
      privacy as unknown as IPrivacyService,
      config,
    );
  });

  describe('getProfileView', () => {
    it('composes from the tables and caches the snapshot on a miss', async () => {
      users.findById.mockResolvedValue(makeUser());
      const view = await service.getProfileView('u1');
      expect(view?.username).toBe('aditya');
      expect(view?.statistics.level).toBe(1);
      expect(view?.verification.verified).toBe(false);
      expect(cache.set).toHaveBeenCalled();
    });

    it('serves from cache without touching the DB', async () => {
      cache.get.mockResolvedValue({
        id: 'u1',
        username: 'aditya',
        fullName: 'Aditya',
        bio: null,
        avatarKey: null,
        coverKey: null,
        gender: null,
        birthday: null,
        country: 'IN',
        state: null,
        city: null,
        preferredLanguage: 'en',
        statistics: {
          followersCount: 0,
          followingCount: 0,
          friendsCount: 0,
          giftsSent: 0,
          giftsReceived: 0,
          coinsReceived: 0,
          audioHours: 0,
          videoHours: 0,
          liveHours: 0,
          exp: 0,
          level: 1,
          vipLevel: 0,
        },
        verification: { verified: false, status: 'NONE', type: null },
        createdAt: new Date().toISOString(),
      });
      const view = await service.getProfileView('u1');
      expect(view?.username).toBe('aditya');
      expect(users.findById).not.toHaveBeenCalled();
    });

    it('returns null for an unknown user', async () => {
      users.findById.mockResolvedValue(null);
      expect(await service.getProfileView('nope')).toBeNull();
    });
  });

  describe('getProfileByUsername (privacy-aware)', () => {
    it('returns null for an unknown username without a privacy check', async () => {
      users.findByUsername.mockResolvedValue(null);
      expect(await service.getProfileByUsername('ghost', 'viewer')).toBeNull();
      expect(privacy.check).not.toHaveBeenCalled();
    });

    it('hides the profile (null) when the viewer fails the privacy check', async () => {
      users.findByUsername.mockResolvedValue(makeUser());
      privacy.check.mockResolvedValue(false);
      expect(await service.getProfileByUsername('aditya', 'viewer')).toBeNull();
      expect(privacy.check).toHaveBeenCalledWith('viewer', 'u1', 'VIEW_PROFILE');
    });

    it('passes null for an anonymous viewer and returns the view when allowed', async () => {
      users.findByUsername.mockResolvedValue(makeUser());
      users.findById.mockResolvedValue(makeUser());
      const view = await service.getProfileByUsername('aditya');
      expect(privacy.check).toHaveBeenCalledWith(null, 'u1', 'VIEW_PROFILE');
      expect(view?.username).toBe('aditya');
    });
  });

  describe('getPublicProfile (username or UUID)', () => {
    const UUID = 'f67cf300-6b54-48c5-82c5-1d854711c634';

    it('resolves a UUID identifier by id (not username) — the deep-link path', async () => {
      users.findById.mockResolvedValue(makeUser({ id: UUID }));
      const view = await service.getPublicProfile(UUID, 'viewer');
      expect(users.findById).toHaveBeenCalledWith(UUID);
      expect(users.findByUsername).not.toHaveBeenCalled();
      expect(privacy.check).toHaveBeenCalledWith('viewer', UUID, 'VIEW_PROFILE');
      expect(view?.username).toBe('aditya');
    });

    it('resolves a non-UUID identifier by username', async () => {
      users.findByUsername.mockResolvedValue(makeUser());
      users.findById.mockResolvedValue(makeUser());
      const view = await service.getPublicProfile('aditya', 'viewer');
      expect(users.findByUsername).toHaveBeenCalledWith('aditya');
      expect(view?.username).toBe('aditya');
    });

    it('returns null (→ 404) for an unknown id without leaking existence', async () => {
      users.findById.mockResolvedValue(null);
      expect(await service.getPublicProfile(UUID, 'viewer')).toBeNull();
      expect(privacy.check).not.toHaveBeenCalled();
    });

    it('honours the privacy gate for the by-id path', async () => {
      users.findById.mockResolvedValue(makeUser({ id: UUID }));
      privacy.check.mockResolvedValue(false);
      expect(await service.getPublicProfile(UUID, 'viewer')).toBeNull();
    });
  });

  describe('search (block-aware)', () => {
    it('excludes the viewer block relationships', async () => {
      privacy.blockedIdsFor.mockResolvedValue(['blocked-1']);
      search.search.mockResolvedValue({ items: [], meta: {} } as never);
      await service.search('adi', { page: 1 }, 'viewer');
      expect(privacy.blockedIdsFor).toHaveBeenCalledWith('viewer');
      expect(search.search).toHaveBeenCalledWith(
        'adi',
        expect.objectContaining({ excludeIds: ['blocked-1'] }),
      );
    });

    it('does not compute an exclude set for an anonymous search', async () => {
      search.search.mockResolvedValue({ items: [], meta: {} } as never);
      await service.search('adi', {});
      expect(privacy.blockedIdsFor).not.toHaveBeenCalled();
      expect(search.search).toHaveBeenCalledWith(
        'adi',
        expect.objectContaining({ excludeIds: [] }),
      );
    });
  });

  it('updateProfile writes both tables, invalidates cache and emits', async () => {
    users.findById.mockResolvedValue(makeUser());
    await service.updateProfile('u1', { fullName: 'New Name', bio: 'hi', city: 'Hyderabad' });
    expect(users.update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ fullName: 'New Name' }),
    );
    expect(profiles.updateProfile).toHaveBeenCalledWith('u1', { bio: 'hi', city: 'Hyderabad' });
    expect(cache.del).toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'user.profile_updated' }),
    );
  });

  it('confirmMedia validates the upload, stores the key and invalidates', async () => {
    media.resolve.mockResolvedValue('https://cdn/x.jpg');
    const res = await service.confirmMedia('u1', 'avatar', 'profile-images/u1/x.jpg');
    expect(uploads.confirmUpload).toHaveBeenCalled();
    expect(profiles.setMediaKey).toHaveBeenCalledWith('u1', 'avatar', 'profile-images/u1/x.jpg');
    expect(cache.del).toHaveBeenCalled();
    expect(res.url).toBe('https://cdn/x.jpg');
  });

  describe('isUsernameAvailable', () => {
    it('rejects a malformed username', async () => {
      expect((await service.isUsernameAvailable('a b')).available).toBe(false);
      expect(users.findByUsername).not.toHaveBeenCalled();
    });
    it('reports taken vs free', async () => {
      users.findByUsername.mockResolvedValueOnce(makeUser()).mockResolvedValueOnce(null);
      expect((await service.isUsernameAvailable('aditya_r')).available).toBe(false);
      expect((await service.isUsernameAvailable('free_name')).available).toBe(true);
    });
  });

  it('submitVerification sets PENDING and emits', async () => {
    profiles.submitVerification.mockResolvedValue({
      verified: false,
      status: VerificationStatus.PENDING,
      type: VerificationType.CREATOR,
    } as never);
    const res = await service.submitVerification('u1', VerificationType.CREATOR);
    expect(res.status).toBe('PENDING');
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'user.verification_requested' }),
    );
  });

  it('reviewVerification approves a pending request', async () => {
    profiles.getVerification.mockResolvedValue({ status: VerificationStatus.PENDING } as never);
    profiles.reviewVerification.mockResolvedValue({
      verified: true,
      status: VerificationStatus.APPROVED,
      type: VerificationType.CREATOR,
    } as never);
    const res = await service.reviewVerification('u1', { approve: true, reviewedBy: 'admin' });
    expect(res.verified).toBe(true);
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.verified' }));
  });

  it('reviewVerification throws when nothing is pending', async () => {
    profiles.getVerification.mockResolvedValue({ status: VerificationStatus.NONE } as never);
    await expect(
      service.reviewVerification('u1', { approve: true, reviewedBy: 'a' }),
    ).rejects.toMatchObject({
      errorCode: 'VERIFICATION_NOT_FOUND',
    });
  });

  it('buildShare returns a share url + deep link', async () => {
    users.findByUsername.mockResolvedValue(makeUser());
    const share = await service.buildShare('aditya');
    expect(share.shareUrl).toBe('https://soulzaa.app/u/aditya');
    expect(share.deepLink).toBe('soulzaa://user/aditya');
  });
});
