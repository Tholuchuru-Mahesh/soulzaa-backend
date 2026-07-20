import type {
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import type {
  VideoRoomAccessPolicy,
  VideoRoomLifecycleState,
} from '../constants/video-room-lifecycle';

/** Client-safe projection of the per-room settings row (drops audit/timestamps). */
export interface VideoRoomSettingsView {
  allowChat: boolean;
  allowViewerChat: boolean;
  slowModeSeconds: number;
  allowGifts: boolean;
  allowTreasure: boolean;
  allowPk: boolean;
  allowBeauty: boolean;
  allowCameraSwitch: boolean;
  allowScreenShare: boolean;
  allowRecording: boolean;
  joinApprovalRequired: boolean;
  allowJoinRequest: boolean;
  allowShare: boolean;
  allowInvite: boolean;
  allowFollow: boolean;
  allowReporting: boolean;
  allowAnnouncements: boolean;
  isRoomMuted: boolean;
  maxDurationMinutes: number | null;
  hostSeatCount: number;
  guestSeatCount: number;
}

/** Client-safe projection of the denormalised statistics row (BigInt → number). */
export interface VideoRoomStatisticsView {
  peakViewers: number;
  peakParticipants: number;
  totalJoins: number;
  currentViewers: number;
  currentParticipants: number;
  totalDurationSeconds: number;
  avgWatchTimeSeconds: number;
  totalGifts: number;
  totalGiftCoins: number;
  totalPkCount: number;
  totalChatMessages: number;
  totalSessions: number;
  lastActivityAt: Date;
}

/**
 * The complete client-safe room detail (VR-2). Extends the list `VideoRoomView`
 * fields with the projected `lifecycleState` + `accessPolicy`, the streaming
 * status, and the bundled settings + statistics. Never exposes `passwordHash`,
 * audit, or soft-delete columns.
 */
export interface VideoRoomDetailView {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  imageKey: string | null;
  categoryId: string | null;
  language: string | null;
  country: string | null;
  tags: string[];
  visibility: VideoRoomVisibility;
  accessPolicy: VideoRoomAccessPolicy;
  isLocked: boolean;
  isDiscoverable: boolean;
  isVerified: boolean;
  maxParticipants: number;
  maxViewers: number;
  status: VideoRoomStatus;
  streamingStatus: VideoRoomStreamingStatus;
  lifecycleState: VideoRoomLifecycleState;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  settings: VideoRoomSettingsView | null;
  statistics: VideoRoomStatisticsView | null;
}

/** The "verify room status" projection — the lifecycle snapshot for a room. */
export interface VideoRoomStatusView {
  roomId: string;
  lifecycleState: VideoRoomLifecycleState;
  status: VideoRoomStatus;
  isLocked: boolean;
  streamingStatus: VideoRoomStreamingStatus;
  isDeleted: boolean;
  endedAt: Date | null;
}
