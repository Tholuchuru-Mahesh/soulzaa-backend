import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  User,
  UserProfile,
  UserStatistics,
  UserVerification,
  VerificationStatus,
  VerificationType,
} from '@prisma/client';
import { CACHE_KEYS } from 'src/common/constants';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { CacheService } from 'src/infra/redis/cache.service';
import { STORAGE_CATEGORIES } from 'src/infra/storage/storage.constants';
import { UploadService } from 'src/infra/storage/upload.service';
import {
  PRIVACY_SERVICE,
  PrivacyAction,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import {
  UserAvatarUpdatedEvent,
  UserProfileUpdatedEvent,
  UserVerificationRequestedEvent,
  UserVerifiedEvent,
} from '../events/user.events';
import type {
  IProfileService,
  ProfileView,
  StatisticField,
  StatisticsView,
  UserCard,
  VerificationView,
} from '../interfaces/profile.interface';
import { ProfileRepository } from '../repositories/profile.repository';
import { UsersRepository } from '../repositories/users.repository';
import { MediaUrlResolver } from './media-url.resolver';
import {
  USER_SEARCH_PROVIDER,
  type IUserSearchProvider,
  type UserSearchOptions,
} from './search/user-search.provider';

/** Username policy (mirrors registration): 4–20 chars, letters/digits/underscore. */
const USERNAME_RE = /^[a-zA-Z0-9_]{4,20}$/;

/** JSON-safe cached snapshot — stores media KEYS; URLs resolved per response. */
interface CachedProfile {
  id: string;
  username: string;
  fullName: string | null;
  bio: string | null;
  avatarKey: string | null;
  coverKey: string | null;
  gender: ProfileView['gender'];
  birthday: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  preferredLanguage: string | null;
  statistics: StatisticsView;
  verification: VerificationView;
  createdAt: string;
}

/**
 * The User Domain profile service (STEP 14). Composes the profile view from the
 * four users-module tables, caches it (keys, not URLs), and owns update, avatar/
 * cover upload (presigned S3 via UploadService), search (delegated to the
 * swappable IUserSearchProvider), username availability, verification, and
 * sharing. Profile mutations invalidate the cache and emit events.
 */
@Injectable()
export class ProfileService implements IProfileService {
  private readonly cacheTtl: number;
  private readonly shareBase: string;
  private readonly deeplinkScheme: string;

  constructor(
    private readonly users: UsersRepository,
    private readonly profiles: ProfileRepository,
    private readonly media: MediaUrlResolver,
    private readonly uploads: UploadService,
    private readonly cache: CacheService,
    @Inject(USER_SEARCH_PROVIDER) private readonly searchProvider: IUserSearchProvider,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    config: ConfigService,
  ) {
    const cfg = config.get('profile', { infer: true })!;
    this.cacheTtl = Number(cfg.cacheTtlSeconds);
    this.shareBase = cfg.shareBaseUrl;
    this.deeplinkScheme = cfg.deeplinkScheme;
  }

  private cacheKey(userId: string): string {
    return `${CACHE_KEYS.USER}profile:${userId}`;
  }

  // ---- Reads ----

  async getProfileView(userId: string): Promise<ProfileView | null> {
    const cached = await this.cache.get<CachedProfile>(this.cacheKey(userId));
    if (cached) return this.resolveView(cached);

    const user = await this.users.findById(userId);
    if (!user) return null;

    let [profile, stats, verification] = await Promise.all([
      this.profiles.getProfile(userId),
      this.profiles.getStatistics(userId),
      this.profiles.getVerification(userId),
    ]);
    // Lazy-init for accounts created before the profile aggregate existed.
    if (!profile || !stats || !verification) {
      await this.profiles.ensureDefaults(userId);
      [profile, stats, verification] = await Promise.all([
        this.profiles.getProfile(userId),
        this.profiles.getStatistics(userId),
        this.profiles.getVerification(userId),
      ]);
    }

    const snapshot = this.buildSnapshot(user, profile!, stats!, verification!);
    await this.cache.set(this.cacheKey(userId), snapshot, this.cacheTtl);
    return this.resolveView(snapshot);
  }

  async getProfileByUsername(username: string, viewerId?: string): Promise<ProfileView | null> {
    const user = await this.users.findByUsername(username);
    if (!user) return null;
    // Privacy gate: hide the profile (as if not found) when the viewer is
    // blocked or the target's profileVisibility excludes them. Own profile and
    // internal/self reads via getProfileView stay ungated.
    const allowed = await this.privacy.check(viewerId ?? null, user.id, PrivacyAction.VIEW_PROFILE);
    if (!allowed) return null;
    return this.getProfileView(user.id);
  }

  async getStatistics(userId: string): Promise<StatisticsView | null> {
    const stats = await this.profiles.getStatistics(userId);
    return stats ? this.toStatisticsView(stats) : null;
  }

  async getCards(ids: string[]): Promise<UserCard[]> {
    const unique = [...new Set(ids)];
    const views = await Promise.all(unique.map((id) => this.getProfileView(id)));
    return views
      .filter((v): v is ProfileView => v !== null)
      .map((v) => ({
        id: v.id,
        username: v.username,
        fullName: v.fullName,
        avatarUrl: v.avatarUrl,
        verified: v.verification.verified,
        level: v.statistics.level,
        vipLevel: v.statistics.vipLevel,
        country: v.country,
      }));
  }

  async incrementStatistic(userId: string, field: StatisticField, delta: number): Promise<void> {
    await this.profiles.incrementStatistic(userId, field, delta);
    await this.invalidate(userId);
  }

  async search(
    query: string,
    opts: UserSearchOptions,
    viewerId?: string,
  ): Promise<Paginated<UserCard>> {
    // Drop anyone in a block relationship (either direction) with the viewer.
    const excludeIds = viewerId ? await this.privacy.blockedIdsFor(viewerId) : [];
    return this.searchProvider.search(query, { ...opts, excludeIds });
  }

  // ---- Commands ----

  async updateProfile(
    userId: string,
    input: {
      fullName?: string;
      bio?: string;
      gender?: ProfileView['gender'];
      country?: string;
      state?: string;
      city?: string;
      preferredLanguage?: string;
    },
  ): Promise<ProfileView> {
    const changed: string[] = [];

    // Identity display fields live on `users`; presentational extras on `user_profiles`.
    const identityData: Record<string, unknown> = {};
    for (const f of ['fullName', 'gender', 'country', 'preferredLanguage'] as const) {
      if (input[f] !== undefined) {
        identityData[f] = input[f];
        changed.push(f);
      }
    }
    if (Object.keys(identityData).length > 0) {
      await this.users.update(userId, { ...identityData, updatedBy: userId });
    }

    const profileData: { bio?: string; state?: string; city?: string } = {};
    for (const f of ['bio', 'state', 'city'] as const) {
      if (input[f] !== undefined) {
        profileData[f] = input[f];
        changed.push(f);
      }
    }
    if (Object.keys(profileData).length > 0) {
      await this.profiles.updateProfile(userId, profileData);
    }

    await this.invalidate(userId);
    const user = await this.users.findById(userId);
    await this.bus.publish(
      new UserProfileUpdatedEvent({ userId, username: user!.username, changed }),
    );
    return (await this.getProfileView(userId))!;
  }

  /** Issue a presigned URL for an avatar/cover upload (owner-scoped key). */
  requestMediaUpload(
    userId: string,
    input: { filename: string; contentType: string; size: number },
  ) {
    return this.uploads.createPresignedUpload({
      category: STORAGE_CATEGORIES.PROFILE_IMAGE,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      userId,
    });
  }

  /** Finalize an avatar/cover upload: validate the object, then store its key. */
  async confirmMedia(
    userId: string,
    kind: 'avatar' | 'cover',
    key: string,
  ): Promise<{ key: string; url: string | null }> {
    await this.uploads.confirmUpload({
      key,
      category: STORAGE_CATEGORIES.PROFILE_IMAGE,
      userId,
    });
    await this.profiles.setMediaKey(userId, kind, key);
    await this.invalidate(userId);
    await this.bus.publish(new UserAvatarUpdatedEvent({ userId, kind, key }));
    return { key, url: await this.media.resolve(key) };
  }

  async isUsernameAvailable(username: string): Promise<{ available: boolean; reason?: string }> {
    if (!USERNAME_RE.test(username)) {
      return { available: false, reason: 'Username must be 4–20 letters, digits or underscores' };
    }
    const taken = (await this.users.findByUsername(username)) !== null;
    return taken ? { available: false, reason: 'Username already taken' } : { available: true };
  }

  async submitVerification(
    userId: string,
    type: VerificationType,
    documentKey?: string,
  ): Promise<VerificationView> {
    const row = await this.profiles.submitVerification(userId, type, documentKey ?? null);
    await this.invalidate(userId);
    await this.bus.publish(new UserVerificationRequestedEvent({ userId, type }));
    return this.toVerificationView(row);
  }

  async reviewVerification(
    targetUserId: string,
    input: { approve: boolean; reviewedBy: string; reason?: string },
  ): Promise<VerificationView> {
    const existing = await this.profiles.getVerification(targetUserId);
    if (!existing || existing.status !== VerificationStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.VERIFICATION_NOT_FOUND,
        'No pending verification request for this user',
        HttpStatus.NOT_FOUND,
      );
    }
    const row = await this.profiles.reviewVerification(targetUserId, input);
    await this.invalidate(targetUserId);
    await this.bus.publish(
      new UserVerifiedEvent({
        userId: targetUserId,
        verified: row.verified,
        reviewedBy: input.reviewedBy,
      }),
    );
    return this.toVerificationView(row);
  }

  async buildShare(
    username: string,
  ): Promise<{ shareUrl: string; deepLink: string; title: string; description: string }> {
    const user = await this.users.findByUsername(username);
    if (!user) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    return {
      shareUrl: `${this.shareBase.replace(/\/$/, '')}/u/${username}`,
      deepLink: `${this.deeplinkScheme}user/${username}`,
      title: user.fullName ? `${user.fullName} (@${username})` : `@${username}`,
      description: `Check out @${username} on Soulzaa`,
    };
  }

  // ---- Helpers ----

  private async invalidate(userId: string): Promise<void> {
    await this.cache.del(this.cacheKey(userId));
  }

  private buildSnapshot(
    user: User,
    profile: UserProfile,
    stats: UserStatistics,
    verification: UserVerification,
  ): CachedProfile {
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      bio: profile.bio,
      avatarKey: profile.avatarKey,
      coverKey: profile.coverKey,
      gender: user.gender,
      birthday: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
      country: user.country,
      state: profile.state,
      city: profile.city,
      preferredLanguage: user.preferredLanguage,
      statistics: this.toStatisticsView(stats),
      verification: this.toVerificationView(verification),
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async resolveView(snap: CachedProfile): Promise<ProfileView> {
    const [avatarUrl, coverUrl] = await Promise.all([
      this.media.resolve(snap.avatarKey),
      this.media.resolve(snap.coverKey),
    ]);
    return {
      id: snap.id,
      username: snap.username,
      fullName: snap.fullName,
      bio: snap.bio,
      avatarUrl,
      coverUrl,
      gender: snap.gender,
      birthday: snap.birthday ? new Date(snap.birthday) : null,
      country: snap.country,
      state: snap.state,
      city: snap.city,
      preferredLanguage: snap.preferredLanguage,
      statistics: snap.statistics,
      verification: snap.verification,
      createdAt: new Date(snap.createdAt),
    };
  }

  private toStatisticsView(s: UserStatistics): StatisticsView {
    const hours = (minutes: number) => Number((minutes / 60).toFixed(1));
    return {
      followersCount: s.followersCount,
      followingCount: s.followingCount,
      friendsCount: s.friendsCount,
      giftsSent: Number(s.giftsSent),
      giftsReceived: Number(s.giftsReceived),
      coinsReceived: Number(s.coinsReceived),
      audioHours: hours(s.audioMinutes),
      videoHours: hours(s.videoMinutes),
      liveHours: hours(s.liveMinutes),
      exp: Number(s.exp),
      level: s.level,
      vipLevel: s.vipLevel,
    };
  }

  private toVerificationView(v: UserVerification): VerificationView {
    return { verified: v.verified, status: v.status, type: v.type };
  }
}
