import type { VideoRoom } from '@prisma/client';
import type { VideoRoomView } from '../entities/video-room.view';

/**
 * Map a persisted VideoRoom row to its client-safe view, dropping internal
 * columns (audit, soft-delete). One place owns the projection so a new
 * sensitive column cannot leak by being spread into a response.
 */
export function toVideoRoomView(
  room: VideoRoom,
  giftCoins?: number,
  ownerName?: string,
  ownerAvatarUrl?: string,
  spectatorCount?: number,
): VideoRoomView {
  return {
    id: room.id,
    ownerId: room.ownerId,
    ownerName: ownerName,
    hostUsername: ownerName,
    hostAvatarUrl: ownerAvatarUrl,
    ownerAvatarUrl: ownerAvatarUrl,
    name: room.name,
    description: room.description,
    imageKey: room.imageKey,
    thumbnailUrl: room.imageKey,
    coverUrl: room.imageKey,
    imageUrl: room.imageKey,
    categoryId: room.categoryId,
    language: room.language,
    visibility: room.visibility,
    isLocked: (room as any).giftLockEnabled ?? false,
    isDiscoverable: room.isDiscoverable,
    maxParticipants: room.maxParticipants,
    maxViewers: room.maxViewers,
    status: room.status,
    createdAt: room.createdAt,
    giftCoins: giftCoins,
    spectatorCount: spectatorCount ?? 0,
    activeViewers: spectatorCount ?? 0,
    participantCount: spectatorCount ?? 0,
  };
}
