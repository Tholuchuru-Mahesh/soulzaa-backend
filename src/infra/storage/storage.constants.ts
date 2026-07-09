/**
 * Media categories and their upload policies. Centralised so mime allowlists
 * and size caps are tunable in one place. `prefix` is the S3 key namespace;
 * `isImage` marks categories the media worker compresses + thumbnails.
 */
export const STORAGE_CATEGORIES = {
  PROFILE_IMAGE: 'profile-images',
  ROOM_BACKGROUND: 'room-backgrounds',
  GIFT_ASSET: 'gift-assets',
  VIDEO: 'videos',
  THUMBNAIL: 'thumbnails',
  AUDIO: 'audio-assets',
} as const;

export type MediaCategory = (typeof STORAGE_CATEGORIES)[keyof typeof STORAGE_CATEGORIES];

export interface StoragePolicy {
  prefix: string;
  isImage: boolean;
  allowedMime: string[];
  maxSizeBytes: number;
}

const MB = 1024 * 1024;

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

export const STORAGE_POLICIES: Record<MediaCategory, StoragePolicy> = {
  [STORAGE_CATEGORIES.PROFILE_IMAGE]: {
    prefix: STORAGE_CATEGORIES.PROFILE_IMAGE,
    isImage: true,
    allowedMime: IMAGE_MIME,
    maxSizeBytes: 5 * MB,
  },
  [STORAGE_CATEGORIES.ROOM_BACKGROUND]: {
    prefix: STORAGE_CATEGORIES.ROOM_BACKGROUND,
    isImage: true,
    allowedMime: IMAGE_MIME,
    maxSizeBytes: 10 * MB,
  },
  [STORAGE_CATEGORIES.GIFT_ASSET]: {
    prefix: STORAGE_CATEGORIES.GIFT_ASSET,
    isImage: true,
    allowedMime: [...IMAGE_MIME, 'image/gif'],
    maxSizeBytes: 10 * MB,
  },
  [STORAGE_CATEGORIES.THUMBNAIL]: {
    prefix: STORAGE_CATEGORIES.THUMBNAIL,
    isImage: true,
    allowedMime: IMAGE_MIME,
    maxSizeBytes: 2 * MB,
  },
  [STORAGE_CATEGORIES.VIDEO]: {
    prefix: STORAGE_CATEGORIES.VIDEO,
    isImage: false,
    allowedMime: ['video/mp4', 'video/webm'],
    maxSizeBytes: 100 * MB,
  },
  [STORAGE_CATEGORIES.AUDIO]: {
    prefix: STORAGE_CATEGORIES.AUDIO,
    isImage: false,
    allowedMime: ['audio/mpeg', 'audio/aac', 'audio/wav', 'audio/webm'],
    maxSizeBytes: 20 * MB,
  },
};

/** Thumbnail geometry produced by the media worker (square cover-crop, WebP). */
export const THUMBNAIL_SIZE = 256;

/** Max width the compressor resizes large images down to (keeps aspect ratio). */
export const COMPRESS_MAX_WIDTH = 1600;
