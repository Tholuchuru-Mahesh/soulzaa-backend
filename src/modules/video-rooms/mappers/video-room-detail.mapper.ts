import type { VideoRoom, VideoRoomSettings, VideoRoomStatistics } from '@prisma/client';
import { deriveAccessPolicy, projectLifecycleState } from '../constants/video-room-lifecycle';
import type { VideoRoomDetail } from '../repositories/video-rooms.repository';
import type {
  VideoRoomDetailView,
  VideoRoomSettingsView,
  VideoRoomStatisticsView,
  VideoRoomStatusView,
} from '../entities/video-room-detail.view';

export function toSettingsView(settings: VideoRoomSettings | null): VideoRoomSettingsView | null {
  if (!settings) return null;
  return {
    allowChat: settings.allowChat,
    slowModeSeconds: settings.slowModeSeconds,
    chatMode: settings.chatMode,
    chatMaxMessageLength: settings.chatMaxMessageLength,
    allowGifts: settings.allowGifts,
    allowTreasure: settings.allowTreasure,
    allowPk: settings.allowPk,
    allowBeauty: settings.allowBeauty,
    allowCameraSwitch: settings.allowCameraSwitch,
    allowInvite: settings.allowInvite,
    allowReporting: settings.allowReporting,
    allowAnnouncements: settings.allowAnnouncements,
    isRoomMuted: settings.isRoomMuted,
    hostSeatCount: settings.hostSeatCount,
    guestSeatCount: settings.guestSeatCount,
    seatApprovalRequired: settings.seatApprovalRequired,
  };
}

function toStatisticsView(stats: VideoRoomStatistics | null): VideoRoomStatisticsView | null {
  if (!stats) return null;
  return {
    peakViewers: stats.peakViewers,
    peakParticipants: stats.peakParticipants,
    totalJoins: Number(stats.totalJoins),
    currentViewers: stats.currentViewers,
    currentParticipants: stats.currentParticipants,
    totalDurationSeconds: Number(stats.totalDurationSeconds),
    avgWatchTimeSeconds: stats.avgWatchTimeSeconds,
    totalGifts: Number(stats.totalGifts),
    totalGiftCoins: Number(stats.totalGiftCoins),
    totalPkCount: stats.totalPkCount,
    totalChatMessages: Number(stats.totalChatMessages),
    totalSessions: Number(stats.totalSessions),
    lastActivityAt: stats.lastActivityAt,
  };
}

/**
 * Map a full room detail (room + settings + statistics) to its client-safe view,
 * computing the projected `lifecycleState` + `accessPolicy` from the durable
 * columns. One place owns the projection so a sensitive column cannot leak.
 */
export function toVideoRoomDetailView(detail: VideoRoomDetail): VideoRoomDetailView {
  const { room, settings, statistics, owner } = detail;
  return {
    id: room.id,
    ownerId: room.ownerId,
    ownerName: owner?.fullName || owner?.username || undefined,
    hostUsername: owner?.username || undefined,
    hostFullName: owner?.fullName || undefined,
    hostAvatarUrl: owner?.avatarUrl || undefined,
    ownerAvatarUrl: owner?.avatarUrl || undefined,
    name: room.name,
    description: room.description,
    imageKey: room.imageKey,
    thumbnailUrl: room.imageKey,
    coverUrl: room.imageKey,
    imageUrl: room.imageKey,
    categoryId: room.categoryId,
    language: room.language,
    country: room.country,
    tags: room.tags,
    visibility: room.visibility,
    accessPolicy: deriveAccessPolicy(room),
    isLocked: room.isLocked,
    paidEntryEnabled: (room as any).paidEntryEnabled ?? false,
    defaultEntryFee: (room as any).defaultEntryFee ? Number((room as any).defaultEntryFee) : null,
    entryFee: (room as any).defaultEntryFee ? Number((room as any).defaultEntryFee) : null,
    isDiscoverable: room.isDiscoverable,
    isVerified: room.isVerified,
    maxParticipants: room.maxParticipants,
    maxViewers: room.maxViewers,
    status: room.status,
    streamingStatus: room.streamingStatus,
    lifecycleState: projectLifecycleState(room),
    endedAt: room.endedAt,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    settings: toSettingsView(settings),
    statistics: toStatisticsView(statistics),
  };
}

/** Map a room row to its "verify status" projection. */
export function toVideoRoomStatusView(room: VideoRoom): VideoRoomStatusView {
  return {
    roomId: room.id,
    lifecycleState: projectLifecycleState(room),
    status: room.status,
    isLocked: room.isLocked,
    streamingStatus: room.streamingStatus,
    isDeleted: room.deletedAt != null,
    endedAt: room.endedAt,
  };
}
