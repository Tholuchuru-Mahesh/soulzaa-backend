import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MonitoringMetrics } from '../observability/monitoring.metrics';

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

export interface ObjectHead {
  exists: boolean;
  size: number;
  contentType?: string;
}

/**
 * S3 media storage. Uploads are done directly client → S3 via presigned URLs
 * (keeps large media off the API). Works against real AWS S3 or an
 * S3-compatible endpoint (MinIO) when S3_ENDPOINT is set.
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  /**
   * Client used only to SIGN presigned URLs. Separate from [client] because a
   * SigV4 signature covers the request host, so a URL the caller (a browser or a
   * physical device) must reach has to be signed with the host they'll use. When
   * S3_PUBLIC_ENDPOINT is unset this is the same instance as [client].
   */
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly presignExpiry: number;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MonitoringMetrics,
  ) {
    const cfg = this.config.get('storage', { infer: true })!;
    this.bucket = cfg.bucket;
    // `configuration.ts` surfaces raw process.env strings (zod coercion isn't
    // written back), so coerce the boolean/number values the SDK needs typed.
    this.presignExpiry = Number(cfg.presignExpirySeconds);
    const forcePathStyle = String(cfg.forcePathStyle) === 'true';
    const credentials =
      cfg.accessKeyId && cfg.secretAccessKey
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
        : undefined;
    const common = {
      region: cfg.region,
      forcePathStyle,
      // Don't bake a CRC32 checksum into presigned PUT URLs — third-party
      // clients (browsers/curl) can't send the matching header, and S3-compatible
      // stores (MinIO/R2) reject the mismatch. Only add checksums when required.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      credentials,
    };
    this.client = new S3Client({ ...common, endpoint: cfg.endpoint || undefined });
    // Sign presigned URLs with the public host when one is configured, so the
    // client can actually reach the object (server↔MinIO stays on [client]).
    this.presignClient = cfg.publicEndpoint
      ? new S3Client({ ...common, endpoint: cfg.publicEndpoint })
      : this.client;
  }

  async getPresignedUploadUrl(key: string, contentType?: string): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.presignClient, command, {
      expiresIn: this.presignExpiry,
    });
    return { key, uploadUrl, expiresInSeconds: this.presignExpiry };
  }

  async getPresignedDownloadUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.presignClient, command, { expiresIn: this.presignExpiry });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.logger.debug(`Deleted s3://${this.bucket}/${key}`);
  }

  /** Upload a buffer (used by the media worker to store compressed/thumbnail derivatives). */
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      this.metrics.recordStorageOp('put', 'success');
      this.metrics.recordStorageBytes('up', body.length);
      this.logger.debug(`Put s3://${this.bucket}/${key} (${body.length} bytes)`);
    } catch (err) {
      this.metrics.recordStorageOp('put', 'error');
      throw err;
    }
  }

  /** Download an object into a Buffer (used by the media worker). */
  async getObjectBuffer(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      const buffer = Buffer.from(bytes);
      this.metrics.recordStorageOp('get', 'success');
      this.metrics.recordStorageBytes('down', buffer.length);
      return buffer;
    } catch (err) {
      this.metrics.recordStorageOp('get', 'error');
      throw err;
    }
  }

  /** Bucket reachability check for the storage health indicator. */
  async headBucket(): Promise<boolean> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }

  /** Object metadata; `exists: false` when the object is missing (404/NotFound). */
  async headObject(key: string): Promise<ObjectHead> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { exists: true, size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (err as { name?: string }).name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return { exists: false, size: 0 };
      }
      throw err;
    }
  }
}
