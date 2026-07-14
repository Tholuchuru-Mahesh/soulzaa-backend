import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Service } from './s3.service';

/**
 * Resolves a stored S3 object key to a servable URL. When a public/CDN base is
 * configured (MEDIA_PUBLIC_BASE_URL) it returns a stable `${base}/${key}` URL
 * (cacheable); otherwise it mints a short-lived presigned GET.
 *
 * Shared infra, not a module internal: profiles, search **and chat attachments**
 * all need it. Chat especially — `GET /storage/download-url` authorises by key
 * *ownership*, so it can never serve a peer their counterpart's media. Resolving
 * in the view instead means access is granted by conversation participation,
 * which is the correct question, and it costs no extra round trip per image.
 */
@Injectable()
export class MediaUrlResolver {
  private readonly publicBase?: string;

  constructor(
    config: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.publicBase = config.get('profile', { infer: true })!.mediaPublicBaseUrl;
  }

  /** Stable when a public base is set — safe to cache. */
  get isStable(): boolean {
    return !!this.publicBase;
  }

  async resolve(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    if (this.publicBase) return `${this.publicBase.replace(/\/$/, '')}/${key}`;
    return this.s3.getPresignedDownloadUrl(key);
  }
}
