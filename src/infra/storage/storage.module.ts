import { Global, Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { S3Service } from './s3.service';
import { StorageController } from './storage.controller';
import { UploadService } from './upload.service';

/**
 * Media storage. Presigned direct-to-S3 uploads (S3Service), the upload
 * orchestrator + HTTP API (UploadService/StorageController), and sharp-based
 * image optimisation (MediaService) run by the media-processing queue worker.
 */
@Global()
@Module({
  controllers: [StorageController],
  providers: [S3Service, MediaService, UploadService],
  exports: [S3Service, MediaService, UploadService],
})
export class StorageModule {}
