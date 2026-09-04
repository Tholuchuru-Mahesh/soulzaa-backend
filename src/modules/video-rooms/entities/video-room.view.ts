import type { VideoRoomStatus, VideoRoomVisibility } from '@prisma/client';

/**
 * The client-safe projection of a video room. Excludes internal columns
 * (audit fields, soft-delete). Returned by read endpoints in later
 * phases; defined in VR-0 so the API shape is stable from the start.
 * `isLocked` reflects `giftLockEnabled` (the password-lock feature it
 * originally mirrored was removed).
 */
export interface VideoRoomView {
  id: string;
  ownerId: string;
  ownerName?: string;
  hostUsername?: string;
  hostFullName?: string;
  hostAvatarUrl?: string | null;
  ownerAvatarUrl?: string | null;
  name: string;
  description: string | null;
  imageKey: string | null;
  thumbnailUrl?: string | null;
  coverUrl?: string | null;
  imageUrl?: string | null;
  categoryId: string | null;
  language: string | null;
  visibility: VideoRoomVisibility;
  isLocked: boolean;
  isDiscoverable: boolean;
  maxParticipants: number;
  maxViewers: number;
  status: VideoRoomStatus;
  createdAt: Date;
  giftCoins?: number;
}
