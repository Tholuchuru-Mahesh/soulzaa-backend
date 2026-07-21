import { Injectable } from '@nestjs/common';
import { VideoRoomMemberRole } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import type { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  VIDEO_ROOM_PERMISSION_CACHE_TTL_SECONDS,
  videoRoomPermissionKey,
  videoRoomPermissionVersionKey,
} from '../constants/video-room.constants';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/** A memoised authorization decision, stamped with the version it resolved under. */
export interface CachedPermissionDecision {
  ver: number;
  role: VideoRoomMemberRole | null;
  permissions: VideoRoomPermission[];
  /** True when the backing grant carries an expiry (temporary admin/moderator). */
  temporary: boolean;
}

/** A freshly resolved decision, before the cache stamps a version onto it. */
export type PermissionDecision = Omit<CachedPermissionDecision, 'ver'>;

/**
 * Versioned permission cache (VR-7). A hit requires two independently-stored
 * values to agree — the room's current permission version and the version the
 * entry embeds — which makes the cache **fail-closed by construction**: eviction,
 * a flush, cross-instance skew, or a version key that resets all produce
 * disagreement, and disagreement means a database read. No Redis anomaly can
 * extend a grant that has been revoked.
 *
 * Invalidation is a single INCR on the room's version key, so it costs the same
 * whether one user or a hundred thousand are cached. That is what makes it safe
 * in exactly the hot rooms where a delete-every-member-key scheme degrades worst.
 *
 * Seat changes deliberately do NOT invalidate. Seats churn constantly, and
 * seat-derived roles carry an empty permission set, so the only staleness this
 * admits is an authority rank inside the 0-2 band — always below MODERATOR (3),
 * so it can neither confer management authority nor shield a user from a
 * moderator. Bounded by the entry TTL.
 */
@Injectable()
export class VideoRoomPermissionCache {
  constructor(
    private readonly cache: CacheService,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  /** The cached decision, or null on any miss (including a version mismatch). */
  async read(roomId: string, userId: string): Promise<CachedPermissionDecision | null> {
    const [version, entry] = await this.cache.mget<number | CachedPermissionDecision>([
      videoRoomPermissionVersionKey(roomId),
      videoRoomPermissionKey(roomId, userId),
    ]);

    const current = typeof version === 'number' ? version : null;
    const decision = this.asDecision(entry);

    if (current === null || decision === null || decision.ver !== current) {
      this.metrics.incPermissionCacheMiss();
      return null;
    }
    this.metrics.incPermissionCacheHit();
    return decision;
  }

  /** Memoise a freshly resolved decision under the room's current version. */
  async write(roomId: string, userId: string, decision: PermissionDecision): Promise<void> {
    const [version] = await this.cache.mget<number>([videoRoomPermissionVersionKey(roomId)]);
    const ver = typeof version === 'number' ? version : 0;
    await this.cache.set(
      videoRoomPermissionKey(roomId, userId),
      { ver, ...decision },
      VIDEO_ROOM_PERMISSION_CACHE_TTL_SECONDS,
    );
  }

  /**
   * Orphan every cached decision for a room. Called after a role grant/revoke,
   * a temporary-grant expiry, or an ownership change — always *after* the write
   * that changed authority, so no reader can repopulate a stale entry in between.
   */
  async invalidateRoom(roomId: string): Promise<void> {
    await this.cache.increment(videoRoomPermissionVersionKey(roomId));
  }

  /** Structural check — a malformed payload is a miss, never a throw. */
  private asDecision(value: unknown): CachedPermissionDecision | null {
    if (value === null || typeof value !== 'object') return null;
    const candidate = value as CachedPermissionDecision;
    return typeof candidate.ver === 'number' && Array.isArray(candidate.permissions)
      ? candidate
      : null;
  }
}
