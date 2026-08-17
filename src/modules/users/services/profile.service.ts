import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  User,
  UserProfile,
  UserStatistics,
  UserVerification,
  VerificationStatus,
  VerificationType,
} from '@prisma/client';
import { CACHE_KEYS } from 'src/common/constants';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { CacheService } from 'src/infra/redis/cache.service';
import { STORAGE_CATEGORIES } from 'src/infra/storage/storage.constants';
import { UploadService } from 'src/infra/storage/upload.service';
import { BACKPACK_EVENTS } from 'src/modules/backpack/events/backpack.events';
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
  PublicIdentity,
  StatisticField,
  StatisticsView,
  UserCard,
  VerificationView,
} from '../interfaces/profile.interface';
import { ProfileRepository } from '../repositories/profile.repository';
import { UsersRepository } from '../repositories/users.repository';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  USER_SEARCH_PROVIDER,
  type IUserSearchProvider,
  type UserSearchOptions,
} from './search/user-search.provider';

/**
 * Username policy (mirrors registration): 4–20 chars, letters/digits/underscore.
 *
 * Forbidding hyphens is what keeps usernames and UUIDs disjoint, so the
 * `/users/:x` route can accept either without ambiguity. The UUID half of that
 * test lives in `UsersRepository.findByIdOrPrefix`, which also handles short-id
 * prefixes.
 */
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
  isHiddenAccount: boolean;
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
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    private readonly prisma: PrismaService,
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
    return this.gatedView(await this.users.findByUsername(username), viewerId);
  }

  /**
   * Resolve a public profile by *either* a username or a user id (UUID).
   *
   * The client's `/users/:x` route is opaque: a tapped @handle carries a
   * username, but a tapped notification / deep link carries the actor's UUID
   * (an FCM follow push only knows the follower's id, not their handle). Since a
   * UUID can never be a valid username, accepting both here is unambiguous — and
   * it is what stops a follow-notification tap from 404ing on a real user.
   */
  async getPublicProfile(identifier: string, viewerId?: string): Promise<ProfileView | null> {
    let user = await this.users.findByIdOrPrefix(identifier);
    if (!user) {
      user = await this.users.findByUsername(identifier);
    }
    return this.gatedView(user, viewerId);
  }

  /**
   * Privacy gate shared by the public reads: hide the profile (as if not found)
   * when the viewer is blocked or the target's profileVisibility excludes them.
   * Own profile and internal/self reads via getProfileView stay ungated.
   */
  private async gatedView(user: User | null, viewerId?: string): Promise<ProfileView | null> {
    if (!user) return null;
    // A hidden staff account is indistinguishable from one that does not exist.
    // Null (→ 404) rather than a 403: a 403 would itself confirm the handle
    // belongs to staff, which is the very thing that must stay secret.
    if (user.isHiddenAccount && !(await this.viewerIsStaff(viewerId))) return null;
    const allowed = await this.privacy.check(viewerId ?? null, user.id, PrivacyAction.VIEW_PROFILE);
    if (!allowed) return null;
    return this.getProfileView(user.id);
  }

  /**
   * Only Admin/Super Admin can identify hidden staff accounts (Task 36).
   * Restrict to ADMIN/SUPER_ADMIN specifically, excluding MODERATOR.
   */
  private async viewerIsStaff(viewerId?: string): Promise<boolean> {
    if (!viewerId) return false;
    const viewer = await this.users.findById(viewerId);
    if (!viewer) return false;
    const isLegacyAdmin = (viewer.roles ?? []).some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN');
    if (isLegacyAdmin) return true;
    const rbacRoles = await this.prisma.userRole.findMany({
      where: { userId: viewerId },
      include: { role: true },
    });
    return rbacRoles.some((ur) => ur.role?.name === 'ADMIN' || ur.role?.name === 'SUPER_ADMIN');
  }

  async getStatistics(userId: string): Promise<StatisticsView | null> {
    const stats = await this.profiles.getStatistics(userId);
    return stats ? this.toStatisticsView(stats) : null;
  }

  async getCards(ids: string[]): Promise<UserCard[]> {
    const unique = [...new Set(ids)];
    const views = await Promise.all(unique.map((id) => this.getProfileView(id)));
    return (
      views
        .filter((v): v is ProfileView => v !== null)
        // Platform-staff accounts are invisible to every consumer of this
        // resolver — followers, friends, room members, live viewers, gift panels
        // and mentions all resolve identities through here.
        .filter((v) => !v.isHiddenAccount)
        .map((v) => ({
          id: v.id,
          username: v.username,
          fullName: v.fullName,
          avatarUrl: v.avatarUrl,
          equippedFrameUrl: v.equippedFrameUrl,
          verified: v.verification.verified,
          level: v.statistics.level,
          vipLevel: v.statistics.vipLevel,
          country: v.country,
        }))
    );
  }

  /**
   * Batch identity resolver for other modules (e.g. games player panels,
   * video-room seat/request panels) that only need displayName + avatar plus
   * badge fields (username, level, vipLevel, verified), not the full
   * profile/stats/verification aggregate — avoids the N+1 cache-then-DB path
   * `getProfileView` takes per id. `fullName`/`username` live on `users`,
   * `avatarKey` on `user_profiles`, `level`/`vipLevel` on `user_statistics`,
   * `verified` on `user_verifications`; all four are batch-loaded in parallel
   * and joined in memory. Missing ids are dropped; missing statistics/
   * verification rows default to level 1, vipLevel 0, verified false.
   */
  async resolvePublicIdentities(ids: string[]): Promise<Map<string, PublicIdentity>> {
    const unique = [...new Set(ids)];
    const result = new Map<string, PublicIdentity>();
    if (unique.length === 0) return result;

    const [identityUsers, profileRows, statsRows, verificationRows] = await Promise.all([
      this.users.findByIds(unique),
      this.profiles.profilesByIds(unique),
      this.profiles.statisticsByIds(unique),
      this.profiles.verificationsByIds(unique),
    ]);
    const profileByUserId = new Map(profileRows.map((p) => [p.userId, p]));
    const statsByUserId = new Map(statsRows.map((s) => [s.userId, s]));
    const verifiedByUserId = new Map(verificationRows.map((v) => [v.userId, v]));

    await Promise.all(
      // Same rule as getCards: staff accounts resolve to nothing. This path
      // batch-loads rather than going through getProfileView, so it needs its
      // own filter — game player panels and video-room seat panels use it.
      identityUsers
        .filter((user) => !user.isHiddenAccount)
        .map(async (user) => {
          const avatarKey = profileByUserId.get(user.id)?.avatarKey ?? null;
          const stats = statsByUserId.get(user.id);
          result.set(user.id, {
            displayName: user.fullName ?? user.username,
            avatarUrl: await this.media.resolve(avatarKey),
            equippedFrameUrl: await this.resolveEquippedFrameUrl(user.id),
            username: user.username,
            level: stats?.level ?? 1,
            vipLevel: stats?.vipLevel ?? 0,
            verified: verifiedByUserId.get(user.id)?.verified ?? false,
          });
        }),
    );
    return result;
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
      username?: string;
      fullName?: string;
      bio?: string;
      gender?: ProfileView['gender'];
      country?: string;
      state?: string;
      city?: string;
      preferredLanguage?: string;
      dateOfBirth?: string;
    },
  ): Promise<ProfileView> {
    const changed: string[] = [];

    // Identity display fields live on `users`; presentational extras on `user_profiles`.
    const identityData: Record<string, unknown> = {};
    if (input.username !== undefined) {
      const trimmed = input.username.trim();
      if (!USERNAME_RE.test(trimmed)) {
        throw new BusinessException(
          ERROR_CODES.USERNAME_INVALID,
          'Username must be 4–20 letters, digits or underscores',
          HttpStatus.BAD_REQUEST,
        );
      }
      const existing = await this.users.findByUsername(trimmed);
      if (existing && existing.id !== userId) {
        throw new BusinessException(
          ERROR_CODES.DUPLICATE_USERNAME,
          'Username is already taken',
          HttpStatus.CONFLICT,
        );
      }
      identityData['username'] = trimmed;
      changed.push('username');
    }

    for (const f of ['fullName', 'gender', 'country', 'preferredLanguage'] as const) {
      if (input[f] !== undefined) {
        identityData[f] = input[f];
        changed.push(f);
      }
    }
    if (input.dateOfBirth !== undefined) {
      identityData['dateOfBirth'] = input.dateOfBirth ? new Date(input.dateOfBirth) : null;
      changed.push('dateOfBirth');
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

    if (input.approve) {
      // 1. Find or create the Creator Role in rbac
      let role = await this.prisma.role.findUnique({
        where: { name: 'CREATOR' },
      });
      if (!role) {
        role = await this.prisma.role.create({
          data: {
            name: 'CREATOR',
            displayName: 'Creator',
            description: 'Creator verification status role',
            isSystem: false,
          },
        });
      }

      // 2. Map UserRole relationship
      const existingUserRole = await this.prisma.userRole.findUnique({
        where: {
          userId_roleId: {
            userId: targetUserId,
            roleId: role.id,
          },
        },
      });
      if (!existingUserRole) {
        await this.prisma.userRole.create({
          data: {
            userId: targetUserId,
            roleId: role.id,
          },
        });
      }

      // 3. Update User model's PlatformRole roles array
      const user = await this.users.findById(targetUserId);
      if (user) {
        const currentRoles = user.roles || [];
        if (!currentRoles.includes('CREATOR' as any)) {
          await this.prisma.user.update({
            where: { id: targetUserId },
            data: {
              roles: {
                set: [...currentRoles, 'CREATOR' as any],
              },
            },
          });
        }
      }

      // 4. Send success notification
      try {
        await this.notifications.create({
          userId: targetUserId,
          type: 'ROLE_GRANTED',
          data: {
            title: 'Creator Verification Approved',
            body: 'Congratulations! You have been verified as a Creator. Your badge is active.',
          },
        });
      } catch (err) {
        console.error('Failed to send verification success notification:', err);
      }
    } else {
      // Send rejection notification
      try {
        await this.notifications.create({
          userId: targetUserId,
          type: 'SYSTEM',
          data: {
            title: 'Creator Verification Rejected',
            body: `Your Creator Verification request was rejected. Reason: ${input.reason || 'Not specified'}. You can resubmit your request.`,
          },
        });
      } catch (err) {
        console.error('Failed to send verification rejection notification:', err);
      }
    }

    await this.invalidate(targetUserId);
    await this.bus.publish(
      new UserVerifiedEvent({
        userId: targetUserId,
        verified: row.verified,
        reviewedBy: input.reviewedBy,
      }),
    );
    await this.invalidate(targetUserId);
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

  /**
   * Public face of `invalidate`, for modules that change a field this snapshot
   * carries. Without it a freshly-promoted Admin would stay visible in every
   * card list until the TTL lapsed.
   */
  async invalidateProfile(userId: string): Promise<void> {
    await this.invalidate(userId);
  }

  @OnEvent('authorization.role.assigned')
  @OnEvent('authorization.role.revoked')
  @OnEvent('role.assigned')
  @OnEvent('role.revoked')
  @OnEvent('user.verification.updated')
  async handleRoleOrVerificationChange(payload: any): Promise<void> {
    const userId = payload?.userId ?? payload?.data?.userId;
    if (userId) {
      await this.invalidate(userId);
    }
  }

  @OnEvent(BACKPACK_EVENTS.EQUIPPED)
  @OnEvent(BACKPACK_EVENTS.UNEQUIPPED)
  @OnEvent('backpack.item_equipped')
  @OnEvent('backpack.item_unequipped')
  @OnEvent('backpack.item.equipped')
  @OnEvent('backpack.item.unequipped')
  async handleBackpackEquipChange(payload: any): Promise<void> {
    const userId = payload?.userId ?? payload?.data?.userId;
    if (userId) {
      await this.invalidate(userId);
    }
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
      isHiddenAccount: user.isHiddenAccount,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async resolveEquippedFrameUrl(userId: string): Promise<string | null> {
    try {
      const cosmeticId = '00000000-0000-0000-0000-000000000001';
      const grantKey = `default-pink-frame:${userId}`;
      const prisma = this.users['prisma'];

      // 1. Ensure the Cosmetic catalog entry exists
      await prisma.cosmetic.upsert({
        where: { id: cosmeticId },
        create: {
          id: cosmeticId,
          type: 'FRAME',
          name: 'Default Pink Frame',
          mediaUrl: 'default_pink_frame',
          thumbnailUrl: 'default_pink_frame',
          rarity: 'COMMON',
          enabled: true,
          price: 0,
          isPremium: false,
        },
        update: {},
      });

      // 2. Ensure this user owns the default pink frame in their backpack
      const exists = await prisma.backpackItem.count({
        where: { grantKey },
      });
      if (exists === 0) {
        const activeFrame = await prisma.backpackItem.findFirst({
          where: { userId, type: 'FRAME', equipped: true },
        });
        await prisma.backpackItem.create({
          data: {
            userId,
            type: 'FRAME',
            refId: cosmeticId,
            name: 'Default Pink Frame',
            source: 'ADMIN',
            quantity: 1,
            equipped: activeFrame ? false : true, // Equip by default if no other active frame
            transferable: false,
            grantKey,
            metadata: {
              cosmeticId,
              mediaUrl: 'default_pink_frame',
              rarity: 'COMMON',
            },
          },
        });
      }

      const item = await prisma.backpackItem.findFirst({
        where: { userId, type: 'FRAME', equipped: true },
      });
      if (!item) return null;
      let mediaUrl: string | null = null;
      if (item.refId) {
        const cosmetic = await prisma.cosmetic.findUnique({
          where: { id: item.refId },
        });
        mediaUrl = cosmetic?.mediaUrl ?? null;
      }
      if (!mediaUrl) {
        mediaUrl = (item.metadata as any)?.mediaUrl ?? null;
      }
      return this.media.resolve(mediaUrl);
    } catch {
      return null;
    }
  }

  private async resolveView(snap: CachedProfile): Promise<ProfileView> {
    const [avatarUrl, coverUrl, equippedFrameUrl] = await Promise.all([
      this.media.resolve(snap.avatarKey),
      this.media.resolve(snap.coverKey),
      this.resolveEquippedFrameUrl(snap.id),
    ]);
    const isHidden = snap.isHiddenAccount ?? false;
    return {
      id: snap.id,
      username: snap.username,
      fullName: snap.fullName,
      bio: snap.bio,
      avatarUrl,
      coverUrl,
      equippedFrameUrl,
      gender: snap.gender,
      birthday: snap.birthday ? new Date(snap.birthday) : null,
      country: snap.country,
      state: snap.state,
      city: snap.city,
      preferredLanguage: snap.preferredLanguage,
      // Task 35: Suppress cosmetic indicators (VIP, level, verification badges) for hidden staff accounts
      statistics: isHidden
        ? {
            ...snap.statistics,
            level: 1,
            vipLevel: 0,
            exp: 0,
          }
        : snap.statistics,
      verification: isHidden
        ? { verified: false, status: 'UNVERIFIED' as any, type: null }
        : snap.verification,
      isHiddenAccount: isHidden,
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
