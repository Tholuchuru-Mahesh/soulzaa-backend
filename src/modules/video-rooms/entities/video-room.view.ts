import type { VideoRoomStatus, VideoRoomVisibility } from '@prisma/client';

/**
 * The client-safe projection of a video room. Excludes internal columns
 * (passwordHash, audit fields, soft-delete). Returned by read endpoints in later
 * phases; defined in VR-0 so the API shape is stable from the start.
 */
export interface VideoRoomView {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  imageKey: string | null;
  categoryId: string | null;
  language: string | null;
  visibility: VideoRoomVisibility;
  isLocked: boolean;
  isDiscoverable: boolean;
  maxParticipants: number;
  maxViewers: number;
  status: VideoRoomStatus;
  createdAt: Date;
}
