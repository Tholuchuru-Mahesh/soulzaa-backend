import type { VideoRoom, VideoRoomSettings, VideoRoomStatistics } from '@prisma/client';
import type { IGiftsService } from '../../gifts/interfaces/gifts.service.interface';
import { deriveAccessPolicy, projectLifecycleState } from '../constants/video-room-lifecycle';
import type { VideoRoomDetail } from '../repositories/video-rooms.repository';
import type {
  VideoRoomDetailView,
  VideoRoomSettingsView,
  VideoRoomStatisticsView,
  VideoRoomStatusView,
} from '../entities/video-room-detail.view';

/** The resolved, display-ready shape of a room's required entry gift. */
export type RequiredEntryGiftView = NonNullable<VideoRoomDetailView['requiredEntryGift']>;

/**
 * Cross-module data the mapper cannot resolve on its own (unlike the raw
 * paid-entry columns, which live directly on `room`). Optional so callers
 * that never touch gift-lock (e.g. existing tests) keep compiling untouched.
 */
export interface VideoRoomDetailExtras {
  requiredEntryGift?: RequiredEntryGiftView | null;
  spectatorCount?: number;
}

/**
 * Turns the room's raw `giftLockEnabled`/`requiredEntryGiftId` columns into
 * the display-ready gift object the mobile client renders directly, with no
 * second fetch. This is the ONE place that resolution happens: both
 * `VideoRoomQueryService.getDetail()` (cache-miss read) and
 * `VideoRoomLifecycleService`'s private `buildDetail()` (cache refresh after
 * every create/settings-update/go-live/end, etc.) call it before invoking
 * `toVideoRoomDetailView`. They write to the SAME cached-snapshot key, so if
 * only one of them resolved the gift, the other would routinely overwrite the
 * cache with a view missing `requiredEntryGift` — sharing this function is
 * what keeps both writers in agreement.
 */
export async function resolveRequiredEntryGift(
  gifts: IGiftsService,
  room: { giftLockEnabled: boolean; requiredEntryGiftId: string | null },
): Promise<RequiredEntryGiftView | null> {
  if (!room.giftLockEnabled || !room.requiredEntryGiftId) return null;
  const gift = await gifts.getGift(room.requiredEntryGiftId);
  // A disabled/deleted gift can no longer be sent (GiftService rejects it),
  // so it is no longer a real requirement — advertising it as one would have
  // the client's "required gift" dialog point at something unsendable.
  if (!gift || !gift.enabled) return null;
  return { id: gift.id, name: gift.name, thumbnailUrl: gift.thumbnailUrl, coinValue: gift.coinValue };
}

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
export function toVideoRoomDetailView(
  detail: VideoRoomDetail,
  extras?: VideoRoomDetailExtras,
): VideoRoomDetailView {
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
    isLocked: (room as any).giftLockEnabled ?? false,
    paidEntryEnabled: (room as any).paidEntryEnabled ?? false,
    defaultEntryFee: (room as any).defaultEntryFee ? Number((room as any).defaultEntryFee) : null,
    entryFee: (room as any).defaultEntryFee ? Number((room as any).defaultEntryFee) : null,
    giftLockEnabled: (room as any).giftLockEnabled ?? false,
    requiredEntryGift: extras?.requiredEntryGift ?? null,
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
    spectatorCount: extras?.spectatorCount ?? statistics?.currentViewers ?? 0,
    activeViewers: extras?.spectatorCount ?? statistics?.currentViewers ?? 0,
    participantCount: extras?.spectatorCount ?? statistics?.currentViewers ?? 0,
  };
}

/** Map a room row to its "verify status" projection. */
export function toVideoRoomStatusView(room: VideoRoom): VideoRoomStatusView {
  return {
    roomId: room.id,
    lifecycleState: projectLifecycleState(room),
    status: room.status,
    isLocked: (room as any).giftLockEnabled ?? false,
    streamingStatus: room.streamingStatus,
    isDeleted: room.deletedAt != null,
    endedAt: room.endedAt,
  };
}
