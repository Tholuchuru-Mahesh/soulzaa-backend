/**
 * Media categories and their upload policies. Centralised so mime allowlists
 * and size caps are tunable in one place. `prefix` is the S3 key namespace;
 * `isImage` marks categories the media worker compresses + thumbnails.
 */
export const STORAGE_CATEGORIES = {
  PROFILE_IMAGE: 'profile-images',
  ROOM_BACKGROUND: 'room-backgrounds',
  EVENT_BANNER: 'event-banners',
  // Home Screen banner carousel (Super Admin-managed) — its own namespace,
  // separate from EVENT_BANNER, because it accepts video as well as images
  // and EVENT_BANNER's policy (shared with the unrelated platform Events
  // feature) must stay image-only.
  HOME_BANNER: 'home-banners',
  GIFT_ASSET: 'gift-assets',
  GIFT_ANIMATION: 'gift-animations',
  COSMETIC_ASSET: 'cosmetic-assets',
  CONTENT_ASSET: 'content-assets',
  // Super-Admin-uploaded icon art for Wealth Level tiers/benefits.
  WEALTH_LEVEL_ICON: 'wealth-level-icons',
  VIDEO: 'videos',
  THUMBNAIL: 'thumbnails',
  AUDIO: 'audio-assets',
  POST_IMAGE: 'post-images',
  // Direct-message media — separate namespaces so retention/ACL policy can
  // diverge from public assets, and so voice notes get their own size cap.
  CHAT_IMAGE: 'chat-images',
  CHAT_VOICE: 'chat-voice',
  CHAT_VIDEO: 'chat-videos',
  CHAT_FILE: 'chat-files',
  // Identity documents backing a role request (Aadhaar, PAN, bank proof…).
  // Never processed by the media worker: re-encoding a KYC scan destroys the
  // evidence a reviewer is meant to judge, and thumbnails of an ID would leak
  // the document through a derivative key with a laxer lifetime.
  KYC_DOCUMENT: 'kyc-documents',
  // Proof attached to a moderator's Broad Ban action. Never processed by the
  // media worker, for the same reason KYC scans aren't: re-encoding would
  // alter evidence a reviewer is meant to judge as-is.
  BROAD_BAN_EVIDENCE: 'broad-ban-evidence',
} as const;

export type MediaCategory = (typeof STORAGE_CATEGORIES)[keyof typeof STORAGE_CATEGORIES];

/**
 * Key prefixes served over HTTP without a bearer token.
 *
 * These are catalog/presentation assets every client renders in an <img> or
 * CachedNetworkImage, neither of which can attach an Authorization header — so
 * requiring a JWT makes them permanently unloadable rather than secure.
 *
 * Everything absent from this list stays authenticated. That is deliberate and
 * load-bearing for `kyc-documents` (Aadhaar, PAN, bank proof), the
 * `broad-ban-evidence` moderation trail and the `chat-*` namespaces, none of
 * which may be readable by key alone.
 */
export const PUBLIC_ASSET_PREFIXES: readonly string[] = [
  STORAGE_CATEGORIES.PROFILE_IMAGE,
  STORAGE_CATEGORIES.ROOM_BACKGROUND,
  STORAGE_CATEGORIES.EVENT_BANNER,
  STORAGE_CATEGORIES.HOME_BANNER,
  STORAGE_CATEGORIES.GIFT_ASSET,
  STORAGE_CATEGORIES.GIFT_ANIMATION,
  STORAGE_CATEGORIES.COSMETIC_ASSET,
  STORAGE_CATEGORIES.CONTENT_ASSET,
  STORAGE_CATEGORIES.THUMBNAIL,
];

/**
 * True when `key` sits under a public prefix. Compares the first path segment
 * so a lookalike such as `kyc-documents-old/…` cannot pass on a prefix match,
 * and rejects any key that tries to climb out of its namespace.
 */
export function isPublicAssetKey(key: string): boolean {
  if (!key || key.includes('..')) return false;
  const segment = key.replace(/^\/+/, '').split('/')[0];
  return PUBLIC_ASSET_PREFIXES.includes(segment);
}

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
  [STORAGE_CATEGORIES.EVENT_BANNER]: {
    prefix: STORAGE_CATEGORIES.EVENT_BANNER,
    isImage: true,
    allowedMime: IMAGE_MIME,
    // 16:9 event banners run larger than a room cover; same ceiling as
    // room-backgrounds so the mobile picker's limits stay uniform.
    maxSizeBytes: 10 * MB,
  },
  [STORAGE_CATEGORIES.HOME_BANNER]: {
    prefix: STORAGE_CATEGORIES.HOME_BANNER,
    isImage: false,
    allowedMime: [...IMAGE_MIME, 'video/mp4', 'video/webm'],
    // Short promotional video banners run larger than a static image; same
    // ceiling as the other mixed image/video categories (gifts, cosmetics).
    maxSizeBytes: 50 * MB,
  },
  [STORAGE_CATEGORIES.GIFT_ASSET]: {
    prefix: STORAGE_CATEGORIES.GIFT_ASSET,
    isImage: false,
    allowedMime: [
      ...IMAGE_MIME,
      'image/gif',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'application/json',
      'application/x-svga',
      'application/octet-stream',
    ],
    maxSizeBytes: 50 * MB,
  },
  [STORAGE_CATEGORIES.GIFT_ANIMATION]: {
    prefix: STORAGE_CATEGORIES.GIFT_ANIMATION,
    isImage: false,
    allowedMime: [
      ...IMAGE_MIME,
      'image/gif',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'application/json',
      'application/x-svga',
      'application/octet-stream',
    ],
    maxSizeBytes: 50 * MB,
  },
  [STORAGE_CATEGORIES.COSMETIC_ASSET]: {
    prefix: STORAGE_CATEGORIES.COSMETIC_ASSET,
    isImage: false,
    allowedMime: [
      ...IMAGE_MIME,
      'image/svg+xml',
      'image/gif',
      'video/mp4',
      'video/webm',
      'application/json',
      'application/x-svga',
      'application/octet-stream',
    ],
    maxSizeBytes: 50 * MB,
  },
  [STORAGE_CATEGORIES.CONTENT_ASSET]: {
    prefix: STORAGE_CATEGORIES.CONTENT_ASSET,
    isImage: false,
    allowedMime: [
      ...IMAGE_MIME,
      'image/svg+xml',
      'image/gif',
      'video/mp4',
      'video/webm',
      'application/json',
      'application/x-svga',
      'application/octet-stream',
    ],
    maxSizeBytes: 50 * MB,
  },
  [STORAGE_CATEGORIES.WEALTH_LEVEL_ICON]: {
    prefix: STORAGE_CATEGORIES.WEALTH_LEVEL_ICON,
    isImage: true,
    allowedMime: IMAGE_MIME,
    maxSizeBytes: 5 * MB,
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
  [STORAGE_CATEGORIES.POST_IMAGE]: {
    prefix: STORAGE_CATEGORIES.POST_IMAGE,
    isImage: true,
    allowedMime: IMAGE_MIME,
    maxSizeBytes: 10 * MB,
  },
  [STORAGE_CATEGORIES.CHAT_IMAGE]: {
    prefix: STORAGE_CATEGORIES.CHAT_IMAGE,
    isImage: true,
    allowedMime: [...IMAGE_MIME, 'image/gif'],
    maxSizeBytes: 10 * MB,
  },
  [STORAGE_CATEGORIES.CHAT_VOICE]: {
    prefix: STORAGE_CATEGORIES.CHAT_VOICE,
    isImage: false,
    allowedMime: ['audio/mpeg', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/mp4'],
    maxSizeBytes: 10 * MB,
  },
  [STORAGE_CATEGORIES.CHAT_VIDEO]: {
    prefix: STORAGE_CATEGORIES.CHAT_VIDEO,
    isImage: false,
    allowedMime: ['video/mp4', 'video/webm', 'video/quicktime'],
    maxSizeBytes: 100 * MB,
  },
  [STORAGE_CATEGORIES.CHAT_FILE]: {
    prefix: STORAGE_CATEGORIES.CHAT_FILE,
    isImage: false,
    allowedMime: [
      'application/pdf',
      'application/zip',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ],
    maxSizeBytes: 25 * MB,
  },
  // 5MB and JPG/PNG/PDF only — the same limits the mobile upload screen shows
  // the applicant, so a file the UI accepts is never rejected by the API.
  [STORAGE_CATEGORIES.KYC_DOCUMENT]: {
    prefix: STORAGE_CATEGORIES.KYC_DOCUMENT,
    isImage: false,
    allowedMime: ['image/jpeg', 'image/png', 'application/pdf'],
    maxSizeBytes: 5 * MB,
  },
  [STORAGE_CATEGORIES.BROAD_BAN_EVIDENCE]: {
    prefix: STORAGE_CATEGORIES.BROAD_BAN_EVIDENCE,
    isImage: false,
    allowedMime: ['image/jpeg', 'image/png', 'application/pdf'],
    maxSizeBytes: 10 * MB,
  },
};

/** Thumbnail geometry produced by the media worker (square cover-crop, WebP). */
export const THUMBNAIL_SIZE = 256;

/** Max width the compressor resizes large images down to (keeps aspect ratio). */
export const COMPRESS_MAX_WIDTH = 1600;
