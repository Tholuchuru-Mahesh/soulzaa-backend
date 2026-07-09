import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Service } from 'src/infra/storage/s3.service';

/**
 * Resolves a stored S3 object key to a servable URL. When a public/CDN base is
 * configured (MEDIA_PUBLIC_BASE_URL) it returns a stable `${base}/${key}` URL
 * (cacheable); otherwise it mints a short-lived presigned GET. Shared by the
 * profile view and search results so URL logic lives in one place.
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
