import type { VideoRoom } from '@prisma/client';
import type { VideoRoomView } from '../entities/video-room.view';

/**
 * Map a persisted VideoRoom row to its client-safe view, dropping internal
 * columns (passwordHash, audit, soft-delete). One place owns the projection so
 * a new sensitive column cannot leak by being spread into a response.
 */
export function toVideoRoomView(room: VideoRoom): VideoRoomView {
  return {
    id: room.id,
    ownerId: room.ownerId,
    name: room.name,
    description: room.description,
    imageKey: room.imageKey,
    categoryId: room.categoryId,
    language: room.language,
    visibility: room.visibility,
    isLocked: room.isLocked,
    isDiscoverable: room.isDiscoverable,
    maxParticipants: room.maxParticipants,
    maxViewers: room.maxViewers,
    status: room.status,
    createdAt: room.createdAt,
  };
}
