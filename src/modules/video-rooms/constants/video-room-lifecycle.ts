import { VideoRoomStatus, VideoRoomStreamingStatus, VideoRoomVisibility } from '@prisma/client';

/**
 * VR-2 lifecycle & visibility projections. The Video Room brief describes a rich
 * 7-state lifecycle and 7 visibility types; the VR-1 schema deliberately locked a
 * minimal set (`VideoRoomStatus = OFFLINE|LIVE|ENDED`, `VideoRoomVisibility =
 * PUBLIC|PRIVATE`, orthogonal `isLocked`/`passwordHash`/`deletedAt`/`streamingStatus`).
 *
 * Rather than migrate the schema, VR-2 **projects** the brief's concepts over the
 * existing columns (the "conventions won" decision from VR-0/VR-1). This module is
 * the single, pure, dependency-free source of truth for that projection + the
 * legal status-transition table — trivially unit-testable, no NestJS/exception
 * coupling (the service throws `VIDEO_ROOM_INVALID_STATE` on an illegal transition).
 */

/** The brief's conceptual lifecycle state, computed from durable columns. */
export enum VideoRoomLifecycleState {
  CREATED = 'CREATED',
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED',
  ARCHIVED = 'ARCHIVED',
  DELETED = 'DELETED',
}

/** The brief's extended visibility, stored as base visibility + metadata policy. */
export enum VideoRoomAccessPolicy {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
  PASSWORD = 'PASSWORD',
  INVITE_ONLY = 'INVITE_ONLY',
  FOLLOWERS_ONLY = 'FOLLOWERS_ONLY',
  FRIENDS_ONLY = 'FRIENDS_ONLY',
  VIP_ONLY = 'VIP_ONLY',
}

/** The subset of a room row the lifecycle projection reads. */
export interface LifecycleProjectionInput {
  status: VideoRoomStatus;
  isLocked: boolean;
  streamingStatus: VideoRoomStreamingStatus;
  deletedAt: Date | null;
  metadata: unknown;
}

/** The subset of a room row the access-policy projection reads. */
export interface AccessPolicyProjectionInput {
  visibility: VideoRoomVisibility;
  isLocked: boolean;
  metadata: unknown;
}

/**
 * Legal `status` transitions. Soft-delete (`deletedAt`) and lock (`isLocked`) are
 * ORTHOGONAL to status — they are not modelled here (delete works from any
 * non-deleted state, lock/unlock from any non-terminal state). Same-state is not a
 * transition. PAUSED/ARCHIVED are recognized in the projection but have no VR-2
 * status transition (PAUSED needs media; ARCHIVED is a retention concern).
 */
export const VIDEO_ROOM_STATUS_TRANSITIONS: Readonly<
  Record<VideoRoomStatus, readonly VideoRoomStatus[]>
> = {
  [VideoRoomStatus.OFFLINE]: [VideoRoomStatus.LIVE, VideoRoomStatus.ENDED], // activate | close
  [VideoRoomStatus.LIVE]: [VideoRoomStatus.ENDED], // close
  [VideoRoomStatus.ENDED]: [VideoRoomStatus.OFFLINE], // reopen
};

/** True if `from -> to` is a legal status transition (same-state is never legal). */
export function isValidStatusTransition(from: VideoRoomStatus, to: VideoRoomStatus): boolean {
  return VIDEO_ROOM_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Read a plain object's string field without leaking `any` into callers. */
function metadataString(metadata: unknown, key: string): string | undefined {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Project the brief's 7-state lifecycle from the durable columns, in precedence
 * order: DELETED > ARCHIVED > ENDED > PAUSED > LOCKED > ACTIVE > CREATED. The raw
 * columns (status/isLocked/streamingStatus/deletedAt) remain the source of truth;
 * this is a convenience label for the API.
 */
export function projectLifecycleState(room: LifecycleProjectionInput): VideoRoomLifecycleState {
  if (room.deletedAt != null) return VideoRoomLifecycleState.DELETED;
  if (room.status === VideoRoomStatus.ENDED) {
    return metadataString(room.metadata, 'archivedAt')
      ? VideoRoomLifecycleState.ARCHIVED
      : VideoRoomLifecycleState.ENDED;
  }
  if (room.status === VideoRoomStatus.LIVE) {
    if (room.streamingStatus === VideoRoomStreamingStatus.PAUSED) {
      return VideoRoomLifecycleState.PAUSED;
    }
    if (room.isLocked) return VideoRoomLifecycleState.LOCKED;
    return VideoRoomLifecycleState.ACTIVE;
  }
  return VideoRoomLifecycleState.CREATED;
}

const ACCESS_POLICY_VALUES = new Set<string>(Object.values(VideoRoomAccessPolicy));

/**
 * Derive the effective access policy: an explicit `metadata.accessPolicy` wins;
 * otherwise a locked room is PASSWORD-gated, else it falls back to the base
 * PUBLIC/PRIVATE visibility. Enforcement of the richer policies (invite/followers/
 * friends/vip) lands with the join phase; VR-2 only stores + echoes the intent.
 */
export function deriveAccessPolicy(room: AccessPolicyProjectionInput): VideoRoomAccessPolicy {
  const explicit = metadataString(room.metadata, 'accessPolicy');
  if (explicit && ACCESS_POLICY_VALUES.has(explicit)) {
    return explicit as VideoRoomAccessPolicy;
  }
  if (room.isLocked) return VideoRoomAccessPolicy.PASSWORD;
  return room.visibility === VideoRoomVisibility.PRIVATE
    ? VideoRoomAccessPolicy.PRIVATE
    : VideoRoomAccessPolicy.PUBLIC;
}
