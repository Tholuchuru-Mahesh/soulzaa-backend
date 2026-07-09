import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MediaService } from '../../storage/media.service';
import { MediaCategory } from '../../storage/storage.constants';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';

interface ProcessImageJob {
  key: string;
  category: MediaCategory;
}

/** Media transcoding/thumbnailing/moderation for uploads. */
@Processor(QUEUE_NAMES.MEDIA_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class MediaProcessingProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly media: MediaService,
  ) {
    super(QUEUE_NAMES.MEDIA_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    this.logger.log(`[media-processing] processing job ${job.id} (${job.name})`);
    if (job.name === 'process-image') {
      const { key, category } = job.data as ProcessImageJob;
      return this.media.processImageFromS3(key, category);
    }
    return { ok: true };
  }
}
