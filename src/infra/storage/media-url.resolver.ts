import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Service } from './s3.service';
import { STORAGE_CATEGORIES } from './storage.constants';

/**
 * Key prefixes whose objects may be served from the public base URL.
 *
 * This is an allowlist, deliberately — everything not named here falls back to a
 * presigned GET, so a category added later is private until someone decides
 * otherwise. It must stay in lockstep with the bucket policy: a prefix listed
 * here but not public in S3 yields 403s, and a prefix public in S3 but not
 * listed here merely costs a signature.
 *
 * Notably absent:
 * - `chat-*` — direct-message media. Private by definition.
 * - `thumbnails/` — MediaService derives thumbnail keys by swapping *any*
 *   category prefix for this one, so it holds chat thumbnails alongside avatar
 *   ones. Mixed provenance means it cannot be public as a whole.
 */
const PUBLICLY_SERVABLE_PREFIXES: readonly string[] = [
  STORAGE_CATEGORIES.PROFILE_IMAGE,
  STORAGE_CATEGORIES.ROOM_BACKGROUND,
  STORAGE_CATEGORIES.GIFT_ASSET,
  STORAGE_CATEGORIES.COSMETIC_ASSET,
];

/**
 * Resolves a stored S3 object key to a servable URL. Public assets (avatars,
 * room display pictures, gift art) get a stable `${base}/${key}` URL when
 * MEDIA_PUBLIC_BASE_URL is configured — cacheable, and cheap. Everything else
 * gets a short-lived presigned GET, as does everything when no base is set.
 *
 * Shared infra, not a module internal: profiles, search **and chat attachments**
 * all need it. Chat especially — `GET /storage/download-url` authorises by key
 * *ownership*, so it can never serve a peer their counterpart's media. Resolving
 * in the view instead means access is granted by conversation participation,
 * which is the correct question, and it costs no extra round trip per image.
 *
 * That last argument is exactly why the public base cannot apply to chat. A
 * presigned URL expresses "this participant, for the next few minutes"; a public
 * one expresses "anybody, forever". Handing DM media the second while believing
 * you granted the first is how private conversations leak, so the choice is made
 * here by key prefix rather than left to a single global switch.
 */
@Injectable()
export class MediaUrlResolver {
  private readonly publicBase?: string;
  private readonly bucket: string;

  constructor(
    config: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.publicBase = config.get('profile', { infer: true })!.mediaPublicBaseUrl;
    this.bucket = config.get('S3_BUCKET') || 'soulzaa-media';
  }

  /**
   * Whether [resolve] returns a stable, cacheable URL for [key]. Key-dependent:
   * public assets are stable once a base is configured, private ones never are.
   */
  isStable(key?: string | null): boolean {
    return !!this.publicBase && this.isPubliclyServable(key);
  }

  async resolve(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;

    let cleanKey = key;
    const bucketInPath = `/${this.bucket}/`;
    const bucketIndex = key.indexOf(bucketInPath);
    if (bucketIndex !== -1) {
      const fullPath = key.substring(bucketIndex + bucketInPath.length);
      const queryIndex = fullPath.indexOf('?');
      cleanKey = queryIndex !== -1 ? fullPath.substring(0, queryIndex) : fullPath;
    }

    if (
      cleanKey.startsWith('http://') ||
      cleanKey.startsWith('https://') ||
      cleanKey.startsWith('data:')
    ) {
      return cleanKey;
    }
    if (this.publicBase && this.isPubliclyServable(cleanKey)) {
      return `${this.publicBase.replace(/\/$/, '')}/${cleanKey}`;
    }
    return this.s3.getPresignedDownloadUrl(cleanKey);
  }

  /** True when [key] sits under a prefix the bucket serves without a signature. */
  private isPubliclyServable(key: string | null | undefined): boolean {
    if (!key) return false;
    // Match on the whole first path segment: a `startsWith` on the bare prefix
    // would also accept `profile-images-backup/…`, which is a different bucket
    // location with its own (unknown) policy.
    const category = key.split('/', 1)[0];
    return PUBLICLY_SERVABLE_PREFIXES.includes(category);
  }
}
