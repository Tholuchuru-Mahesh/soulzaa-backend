import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrivacyLevel, PrivacySettings, UserPreferences } from '@prisma/client';
import { CACHE_KEYS } from 'src/common/constants';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  PrivacyUpdatedEvent,
  UserBlockedEvent,
  UserUnblockedEvent,
} from '../events/privacy.events';
import {
  PrivacyAction,
  type BlockedUserView,
  type IPrivacyService,
  type PreferencesView,
  type PrivacySettingsView,
} from '../interfaces/privacy.interface';
import {
  RELATIONSHIP_SERVICE,
  type IRelationshipProvider,
} from '../interfaces/relationship-provider.interface';
import { PrivacyRepository } from '../repositories/privacy.repository';

/** Maps each gated action to the settings column that governs it. */
const ACTION_LEVEL: Record<PrivacyAction, keyof PrivacySettingsView> = {
  [PrivacyAction.VIEW_PROFILE]: 'profileVisibility',
  [PrivacyAction.VIEW_ONLINE]: 'onlineStatus',
  [PrivacyAction.VIEW_LAST_SEEN]: 'lastSeen',
  [PrivacyAction.MESSAGE]: 'messagePermission',
  [PrivacyAction.CALL]: 'callPermission',
  [PrivacyAction.FRIEND_REQUEST]: 'friendRequestPermission',
};

/**
 * Privacy & Safety domain service. Authoritative store for per-user visibility/
 * permission levels, the block list, and general preferences. Exposes a cached
 * check engine (block short-circuit → level resolution via RELATIONSHIP_SERVICE)
 * that other domains consult, and publishes events for realtime socket sync.
 */
@Injectable()
export class PrivacyService implements IPrivacyService {
  private readonly cacheTtl: number;

  constructor(
    private readonly repo: PrivacyRepository,
    private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(RELATIONSHIP_SERVICE) private readonly relationships: IRelationshipProvider,
    config: ConfigService,
  ) {
    this.cacheTtl = Number(config.get('privacy', { infer: true })!.cacheTtlSeconds);
  }

  private settingsKey(userId: string): string {
    return `${CACHE_KEYS.PRIVACY}settings:${userId}`;
  }
  private blockSetKey(userId: string): string {
    return `${CACHE_KEYS.PRIVACY}blockset:${userId}`;
  }

  // ---- Settings ----

  async getSettings(userId: string): Promise<PrivacySettingsView> {
    const cached = await this.cache.get<PrivacySettingsView>(this.settingsKey(userId));
    if (cached) return cached;
    const row = await this.repo.ensureSettings(userId);
    const view = this.toSettingsView(row);
    await this.cache.set(this.settingsKey(userId), view, this.cacheTtl);
    return view;
  }

  async updateSettings(
    userId: string,
    patch: Partial<PrivacySettingsView>,
  ): Promise<PrivacySettingsView> {
    const data: Record<string, PrivacyLevel> = {};
    const changed: string[] = [];
    for (const key of Object.keys(ACTION_LEVEL).map((a) => ACTION_LEVEL[a as PrivacyAction])) {
      const val = patch[key];
      if (val !== undefined) {
        data[key] = val;
        changed.push(key);
      }
    }
    const row = await this.repo.updateSettings(userId, data);
    await this.cache.del(this.settingsKey(userId));
    await this.bus.publish(new PrivacyUpdatedEvent({ userId, kind: 'settings', changed }));
    return this.toSettingsView(row);
  }

  // ---- Preferences ----

  async getPreferences(userId: string): Promise<PreferencesView> {
    return this.toPreferencesView(await this.repo.ensurePreferences(userId));
  }

  async updatePreferences(
    userId: string,
    patch: Partial<PreferencesView>,
  ): Promise<PreferencesView> {
    const data: Record<string, boolean> = {};
    const changed: string[] = [];
    for (const key of ['searchable', 'showActivity', 'readReceipts', 'allowTagging'] as const) {
      if (patch[key] !== undefined) {
        data[key] = patch[key]!;
        changed.push(key);
      }
    }
    const row = await this.repo.updatePreferences(userId, data);
    await this.bus.publish(new PrivacyUpdatedEvent({ userId, kind: 'preferences', changed }));
    return this.toPreferencesView(row);
  }

  // ---- Blocking ----

  async block(blockerId: string, blockedId: string, reason?: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_BLOCK_SELF,
        'You cannot block yourself',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (await this.repo.blockExists(blockerId, blockedId)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_BLOCKED,
        'User is already blocked',
        HttpStatus.CONFLICT,
      );
    }
    await this.repo.createBlock(blockerId, blockedId, reason ?? null);
    await this.invalidateBlock(blockerId, blockedId);
    await this.bus.publish(new UserBlockedEvent({ blockerId, blockedId }));
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.repo.deleteBlock(blockerId, blockedId);
    await this.invalidateBlock(blockerId, blockedId);
    await this.bus.publish(new UserUnblockedEvent({ blockerId, blockedId }));
  }

  async listBlocked(blockerId: string): Promise<BlockedUserView[]> {
    const rows = await this.repo.listBlocked(blockerId);
    if (rows.length === 0) return [];

    const blockedIds = rows.map((r) => r.blockedId);
    const [details, profiles] = await Promise.all([
      this.repo.getUsersDetails(blockedIds),
      this.repo.getUserProfiles(blockedIds),
    ]);

    return rows.map((r) => {
      const detail = details.find((d) => d.id === r.blockedId);
      const profile = profiles.find((p) => p.userId === r.blockedId);

      return {
        userId: r.blockedId,
        reason: r.reason,
        createdAt: r.createdAt,
        username: detail?.username ?? 'Unknown',
        fullName: detail?.fullName ?? null,
        avatarKey: profile?.avatarKey ?? null,
      };
    });
  }

  async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    return (await this.repo.blockExists(blockerId, blockedId)) !== null;
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    return (await this.blockedIdsFor(a)).includes(b);
  }

  async blockedIdsFor(userId: string): Promise<string[]> {
    const key = this.blockSetKey(userId);
    const cached = await this.cache.get<string[]>(key);
    if (cached) return cached;
    const ids = await this.repo.blockRelationshipIds(userId);
    await this.cache.set(key, ids, this.cacheTtl);
    return ids;
  }

  // ---- Check engine ----

  async check(viewerId: string | null, targetId: string, action: PrivacyAction): Promise<boolean> {
    // A user is never restricted from their own resources.
    if (viewerId && viewerId === targetId) return true;

    // Any block relationship (either direction) hides the two users from each other.
    if (viewerId && (await this.isBlockedEitherWay(viewerId, targetId))) return false;

    const settings = await this.getSettings(targetId);
    const level = settings[ACTION_LEVEL[action]];

    switch (level) {
      case PrivacyLevel.EVERYONE:
        return true;
      case PrivacyLevel.NOBODY:
        return false;
      case PrivacyLevel.FRIENDS_ONLY:
        return viewerId ? this.relationships.isFriend(viewerId, targetId) : false;
      case PrivacyLevel.FOLLOWERS_ONLY:
        return viewerId ? this.relationships.isFollower(viewerId, targetId) : false;
      default:
        return false;
    }
  }

  // ---- Helpers ----

  private async invalidateBlock(a: string, b: string): Promise<void> {
    await this.cache.del(this.blockSetKey(a), this.blockSetKey(b));
  }

  private toSettingsView(s: PrivacySettings): PrivacySettingsView {
    return {
      onlineStatus: s.onlineStatus,
      lastSeen: s.lastSeen,
      profileVisibility: s.profileVisibility,
      callPermission: s.callPermission,
      messagePermission: s.messagePermission,
      friendRequestPermission: s.friendRequestPermission,
    };
  }

  private toPreferencesView(p: UserPreferences): PreferencesView {
    return {
      searchable: p.searchable,
      showActivity: p.showActivity,
      readReceipts: p.readReceipts,
      allowTagging: p.allowTagging,
    };
  }
}
