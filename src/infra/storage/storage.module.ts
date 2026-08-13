import { Global, Module } from '@nestjs/common';
import { FrameProcessorService } from './frame-processor.service';
import { MediaService } from './media.service';
import { MediaUrlResolver } from './media-url.resolver';
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
  providers: [S3Service, MediaService, UploadService, MediaUrlResolver, FrameProcessorService],
  exports: [S3Service, MediaService, UploadService, MediaUrlResolver, FrameProcessorService],
})
export class StorageModule {}
