import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from '../redis/redis.constants';
import { QueueName } from './queue.constants';
import { QueueService } from './queue.service';

export interface DLQJobRecord {
  id: string;
  queueName: string;
  name: string;
  data: Record<string, unknown>;
  failedReason: string;
  stacktrace?: string[];
  failedAt: string;
  attemptsMade: number;
}

const DLQ_HASH_KEY = 'dlq:failed_jobs';

@Injectable()
export class DLQService {
  private readonly logger = new Logger(DLQService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly queueService: QueueService,
  ) {}

  async pushToDLQ(record: DLQJobRecord): Promise<void> {
    const payload = JSON.stringify(record);
    await this.redis.hset(DLQ_HASH_KEY, record.id, payload);
    this.logger.error(
      `Job [${record.id}] pushed to Dead Letter Queue for queue [${record.queueName}]`,
    );
  }

  async listFailedJobs(): Promise<DLQJobRecord[]> {
    const rawMap = await this.redis.hgetall(DLQ_HASH_KEY);
    if (!rawMap) return [];
    return Object.values(rawMap).map((raw) => JSON.parse(raw) as DLQJobRecord);
  }

  async getJobById(id: string): Promise<DLQJobRecord | null> {
    const raw = await this.redis.hget(DLQ_HASH_KEY, id);
    return raw ? (JSON.parse(raw) as DLQJobRecord) : null;
  }

  /**
   * Re-enqueue a dead-lettered job onto its original queue and drop the DLQ
   * record. Returns false if the job id is unknown or its queue is unregistered.
   */
  private async requeue(id: string, verb: 'Retry' | 'Replay'): Promise<boolean> {
    const job = await this.getJobById(id);
    if (!job) return false;

    let queue;
    try {
      queue = this.queueService.getQueue(job.queueName as QueueName);
    } catch {
      this.logger.error(`${verb}: unknown queue [${job.queueName}] for DLQ job [${id}]`);
      return false;
    }

    await queue.add(job.name, job.data);
    await this.redis.hdel(DLQ_HASH_KEY, id);
    this.logger.log(`${verb}ed DLQ job [${id}] onto queue [${job.queueName}]`);
    return true;
  }

  async retryJob(id: string): Promise<boolean> {
    return this.requeue(id, 'Retry');
  }

  async replayJob(id: string): Promise<boolean> {
    return this.requeue(id, 'Replay');
  }

  async deleteJob(id: string): Promise<boolean> {
    const removed = await this.redis.hdel(DLQ_HASH_KEY, id);
    return removed > 0;
  }

  async purgeJob(id: string): Promise<boolean> {
    return this.deleteJob(id);
  }
}
