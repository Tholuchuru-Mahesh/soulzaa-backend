import type { VideoRoomAnnouncement, VideoRoomBackground, VideoRoomTheme } from '@prisma/client';
import type {
  VideoRoomAnnouncementView,
  VideoRoomBackgroundView,
  VideoRoomThemeView,
} from '../entities/video-room-content.view';

export function toVideoRoomAnnouncementView(a: VideoRoomAnnouncement): VideoRoomAnnouncementView {
  return {
    id: a.id,
    authorId: a.authorId,
    content: a.content,
    isPinned: a.isPinned,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export function toVideoRoomThemeView(t: VideoRoomTheme): VideoRoomThemeView {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    previewKey: t.previewKey,
    assetKey: t.assetKey,
    isPremium: t.isPremium,
  };
}

export function toVideoRoomBackgroundView(b: VideoRoomBackground): VideoRoomBackgroundView {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    imageKey: b.imageKey,
    isPremium: b.isPremium,
  };
}
