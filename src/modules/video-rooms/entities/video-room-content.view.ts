/**
 * Client-safe projections of room content + reference entities: announcements and
 * the theme/background pickers. Reference pickers intentionally omit `assetKey`
 * (an internal S3 key resolved to a URL elsewhere) is kept — it is not sensitive —
 * but audit/soft-delete columns are dropped.
 */

export interface VideoRoomAnnouncementView {
  id: string;
  authorId: string;
  content: string;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface VideoRoomThemeView {
  id: string;
  slug: string;
  name: string;
  previewKey: string | null;
  assetKey: string | null;
  isPremium: boolean;
}

export interface VideoRoomBackgroundView {
  id: string;
  slug: string;
  name: string;
  imageKey: string | null;
  isPremium: boolean;
}
