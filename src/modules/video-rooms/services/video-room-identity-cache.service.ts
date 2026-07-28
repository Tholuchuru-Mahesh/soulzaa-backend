import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
  type PublicIdentity,
} from 'src/modules/users/interfaces/profile.interface';
import {
  VIDEO_ROOM_IDENTITY_TTL_SECONDS,
  videoRoomIdentityKey,
} from '../constants/video-room-identity';

/**
 * Display identity for room surfaces (seat requests, member lists, join
 * toasts), cached in Redis.
 *
 * This is deliberately a THIN adapter: all data access lives in
 * `ProfileService.resolvePublicIdentities`, which already batch-loads
 * users + profiles + statistics + verification in four parallel queries.
 * Duplicating that join here would be a third copy of it. This class adds
 * caching and nothing else.
 *
 * `UsersModule` is `@Global()` and exports `PROFILE_SERVICE`, so no module
 * import is needed — the same way `games.service.ts` consumes it.
 */
@Injectable()
export class VideoRoomIdentityCache {
  constructor(
    private readonly cache: CacheService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  /**
   * Resolve display identity for a set of user ids. Ids the profile service
   * cannot resolve (deleted users) are absent from the map — never faked, so
   * callers render a placeholder rather than an invented name.
   */
  async resolve(userIds: string[]): Promise<Map<string, PublicIdentity>> {
    const unique = [...new Set(userIds)].filter((id) => !!id);
    const out = new Map<string, PublicIdentity>();
    if (unique.length === 0) return out;

    const cached = await this.cache.mget<PublicIdentity>(unique.map(videoRoomIdentityKey));
    const misses: string[] = [];
    unique.forEach((id, i) => {
      const hit = cached[i];
      if (hit) out.set(id, hit);
      else misses.push(id);
    });
    if (misses.length === 0) return out;

    const fresh = await this.profiles.resolvePublicIdentities(misses);
    await Promise.all(
      [...fresh.entries()].map(async ([id, identity]) => {
        out.set(id, identity);
        await this.cache.set(videoRoomIdentityKey(id), identity, VIDEO_ROOM_IDENTITY_TTL_SECONDS);
      }),
    );
    return out;
  }

  /** Drop a user's cached identity (profile or avatar changed). */
  async invalidate(userId: string): Promise<void> {
    await this.cache.del(videoRoomIdentityKey(userId));
  }
}
