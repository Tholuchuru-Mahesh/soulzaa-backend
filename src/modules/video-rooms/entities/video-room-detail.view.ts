import type {
  VideoRoomChatMode,
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import type {
  VideoRoomAccessPolicy,
  VideoRoomLifecycleState,
} from '../constants/video-room-lifecycle';

/**
 * Client-safe projection of the per-room settings row (drops audit/timestamps).
 *
 * Contains ONLY settings that are implemented today. Columns that exist but are
 * unenforced are deliberately absent — advertising them told clients the room
 * could do things it cannot. They return with their guards in sub-projects B/C.
 */
export interface VideoRoomSettingsView {
  allowChat: boolean;
  slowModeSeconds: number;
  allowGifts: boolean;
  allowTreasure: boolean;
  allowPk: boolean;
  allowBeauty: boolean;
  allowCameraSwitch: boolean;
  allowInvite: boolean;
  allowReporting: boolean;
  allowAnnouncements: boolean;
  isRoomMuted: boolean;
  hostSeatCount: number;
  guestSeatCount: number;
  /**
   * VR-17: writable via `PATCH :id/settings`, so it MUST be projected here.
   * This view is the payload of the `video_room.settings_updated` broadcast;
   * omitting a writable field means every client reconciling from that
   * broadcast resets it to its client-side default, silently undoing the
   * change the actor just made.
   */
  seatApprovalRequired: boolean;

  /**
   * VR-9.1a chat policy, projected because the CLIENT cannot behave correctly
   * without it and must not guess.
   *
   * `chatMaxMessageLength` is the room's own ceiling, which can be below the
   * DTO's 4000-character safety bound; a composer that hardcodes 4000 lets a
   * user type a message the server will certainly reject. `chatMode` decides
   * who may speak at all, so a client that does not know it either offers a
   * composer that cannot work or hides one that can. Both are enforced
   * server-side by `VideoRoomChatPolicyService` regardless — this is for the
   * UI, never for authorization.
   *
   * `chatMaxAttachments` and `chatRateLimitPerMinute` stay UNPROJECTED: no
   * client behaviour depends on either (a rate-limited send is discovered from
   * the 429, not predicted), so advertising them is surface for nothing.
   *
   * Like every other writable field here, these ride the
   * `video_room.settings_updated` broadcast, so a mid-session change reaches
   * every connected client without a refetch.
   */
  chatMode: VideoRoomChatMode;
  chatMaxMessageLength: number;
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
