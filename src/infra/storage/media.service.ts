import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  COMPRESS_MAX_WIDTH,
  MediaCategory,
  STORAGE_POLICIES,
  THUMBNAIL_SIZE,
} from './storage.constants';
import { S3Service } from './s3.service';

export interface ProcessedImage {
  key: string;
  thumbnailKey: string;
  format: string;
  width: number;
  height: number;
  originalBytes: number;
  compressedBytes: number;
}

/** sharp image-format → mime. */
const FORMAT_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Image processing (compression + thumbnails) with sharp. Runs inside the
 * media-processing queue worker: bytes are fetched from S3, validated by their
 * real format (magic bytes), optimised, and the derivatives written back.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private readonly s3: S3Service) {}

  /** Real image format from the bytes (null if not a decodable image). */
  async detectFormat(buffer: Buffer): Promise<string | null> {
    try {
      return (await sharp(buffer).metadata()).format ?? null;
    } catch {
      return null;
    }
  }

  /** Resize-to-fit + re-encode preserving format (animated GIFs pass through). */
  async compressImage(buffer: Buffer, format: string): Promise<Buffer> {
    if (format === 'gif') return buffer; // don't risk breaking animation
    const pipeline = sharp(buffer).resize({
      width: COMPRESS_MAX_WIDTH,
      withoutEnlargement: true,
    });
    switch (format) {
      case 'jpeg':
        return pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      case 'png':
        return pipeline.png({ compressionLevel: 9 }).toBuffer();
      case 'webp':
        return pipeline.webp({ quality: 80 }).toBuffer();
      default:
        return buffer;
    }
  }

  /** Square cover-cropped WebP thumbnail. */
  async generateThumbnail(buffer: Buffer, size = THUMBNAIL_SIZE): Promise<Buffer> {
    return sharp(buffer).resize(size, size, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
  }

  /** `profile-images/u/x.png` → `thumbnails/u/x.webp` (swap prefix + extension). */
  private thumbnailKey(key: string): string {
    return key.replace(/^[^/]+\//, 'thumbnails/').replace(/\.[^./]+$/, '.webp');
  }

  /**
   * Fetch an uploaded image from S3, validate its true format against the
   * category policy, write back a compressed version, and store a thumbnail.
   * Throws on an invalid/unsupported image (after deleting it) so the queue
   * worker retries then dead-letters.
   */
  async processImageFromS3(key: string, category: MediaCategory): Promise<ProcessedImage> {
    const policy = STORAGE_POLICIES[category];
    if (!policy?.isImage) {
      throw new Error(`Category "${category}" is not an image category`);
    }

    const original = await this.s3.getObjectBuffer(key);
    const meta = await sharp(original)
      .metadata()
      .catch(() => null);
    const format = meta?.format;
    const mime = format ? FORMAT_MIME[format] : undefined;

    if (!mime || !policy.allowedMime.includes(mime)) {
      await this.s3.deleteObject(key);
      throw new Error(
        `Rejected ${key}: real format "${format ?? 'unknown'}" not allowed for ${category}`,
      );
    }

    const compressed = await this.compressImage(original, format!);
    await this.s3.putObject(key, compressed, mime);

    const thumb = await this.generateThumbnail(original);
    const thumbnailKey = this.thumbnailKey(key);
    await this.s3.putObject(thumbnailKey, thumb, 'image/webp');

    this.logger.log(
      `processed ${key}: ${original.length}→${compressed.length} bytes, thumb ${thumbnailKey}`,
    );
    return {
      key,
      thumbnailKey,
      format: format!,
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
      originalBytes: original.length,
      compressedBytes: compressed.length,
    };
  }
}
