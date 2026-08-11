import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { PresignedUpload, S3Service } from './s3.service';
import { MediaCategory, STORAGE_POLICIES } from './storage.constants';

export interface PresignResult extends PresignedUpload {
  category: MediaCategory;
  maxSizeBytes: number;
}

export interface ConfirmResult {
  key: string;
  status: 'processing' | 'ready';
  downloadUrl: string;
}

/** Extension by mime, so keys carry a sensible suffix. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
};

/**
 * Orchestrates presigned direct-to-S3 uploads. Declared metadata is validated
 * up front; after the client uploads, `confirmUpload` re-checks the real object
 * and offloads image optimisation to the media-processing queue.
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly s3: S3Service,
    private readonly queue: QueueService,
  ) {}

  /** Issue a presigned PUT URL after validating declared category/mime/size. */
  async createPresignedUpload(input: {
    category: MediaCategory;
    filename: string;
    contentType: string;
    size: number;
    userId: string;
  }): Promise<PresignResult> {
    const policy = this.policyOrThrow(input.category);
    if (!policy.allowedMime.includes(input.contentType)) {
      throw new BadRequestException(
        `Content-type "${input.contentType}" not allowed for ${input.category}`,
      );
    }
    if (input.size <= 0 || input.size > policy.maxSizeBytes) {
      throw new BadRequestException(
        `Size ${input.size} exceeds the ${policy.maxSizeBytes}-byte limit for ${input.category}`,
      );
    }

    const key = this.buildKey(input.category, input.userId, input.contentType, input.filename);
    const presigned = await this.s3.getPresignedUploadUrl(key, input.contentType);
    return { ...presigned, category: input.category, maxSizeBytes: policy.maxSizeBytes };
  }

  /**
   * Validate the uploaded object (existence + real size), then queue image
   * optimisation. Non-image uploads are immediately `ready`.
   */
  async confirmUpload(input: {
    key: string;
    category: MediaCategory;
    userId: string;
  }): Promise<ConfirmResult> {
    const policy = this.policyOrThrow(input.category);
    this.assertOwner(input.key, input.userId);

    const head = await this.s3.headObject(input.key);
    if (!head.exists) {
      throw new BadRequestException(`No uploaded object at "${input.key}"`);
    }
    if (head.size > policy.maxSizeBytes) {
      await this.s3.deleteObject(input.key);
      throw new BadRequestException(
        `Uploaded file (${head.size} bytes) exceeds the ${policy.maxSizeBytes}-byte limit`,
      );
    }

    if (policy.isImage) {
      await this.queue.enqueue(QUEUE_NAMES.MEDIA_PROCESSING, 'process-image', {
        key: input.key,
        category: input.category,
      });
    }

    const downloadUrl = await this.s3.getPresignedDownloadUrl(input.key);
    return { key: input.key, status: policy.isImage ? 'processing' : 'ready', downloadUrl };
  }

  /** Owner-scoped presigned GET. */
  async getDownloadUrl(key: string, userId: string): Promise<string> {
    this.assertOwner(key, userId);
    return this.s3.getPresignedDownloadUrl(key);
  }

  /** Owner-scoped delete. */
  async deleteUpload(key: string, userId: string): Promise<void> {
    this.assertOwner(key, userId);
    await this.s3.deleteObject(key);
  }

  private policyOrThrow(category: MediaCategory) {
    const policy = STORAGE_POLICIES[category];
    if (!policy) throw new BadRequestException(`Unknown category "${category}"`);
    return policy;
  }

  private buildKey(
    category: MediaCategory,
    userId: string,
    contentType: string,
    filename: string,
  ): string {
    const ext =
      MIME_EXT[contentType] ??
      filename
        .split('.')
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9]/g, '') ??
      'bin';
    return `${STORAGE_POLICIES[category].prefix}/${userId}/${randomUUID()}.${ext}`;
  }

  /** Keys are `${prefix}/${userId}/...`; only the owner may confirm/read/delete. */
  private assertOwner(key: string, userId: string): void {
    const owner = key.split('/')[1];
    if (owner !== userId) {
      throw new ForbiddenException('You do not own this object');
    }
  }
}
