import { Test, TestingModule } from '@nestjs/testing';
import { DLQService, DLQJobRecord } from './dlq.service';
import { REDIS_CLIENT } from '../redis/redis.constants';

describe('DLQService', () => {
  let service: DLQService;
  let redisMock: any;

  beforeEach(async () => {
    redisMock = {
      hset: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({
        'job-1': JSON.stringify({
          id: 'job-1',
          queueName: 'wallet',
          name: 'payout',
          data: {},
          failedReason: 'Error',
          failedAt: new Date().toISOString(),
          attemptsMade: 3,
        }),
      }),
      hget: jest.fn().mockResolvedValue(
        JSON.stringify({
          id: 'job-1',
          queueName: 'wallet',
          name: 'payout',
          data: {},
          failedReason: 'Error',
          failedAt: new Date().toISOString(),
          attemptsMade: 3,
        }),
      ),
      hdel: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DLQService, { provide: REDIS_CLIENT, useValue: redisMock }],
    }).compile();

    service = module.get<DLQService>(DLQService);
  });

  it('should push failed job to DLQ', async () => {
    const record: DLQJobRecord = {
      id: 'job-1',
      queueName: 'wallet',
      name: 'payout',
      data: {},
      failedReason: 'Error',
      failedAt: new Date().toISOString(),
      attemptsMade: 3,
    };

    await service.pushToDLQ(record);
    expect(redisMock.hset).toHaveBeenCalled();
  });

  it('should list failed jobs', async () => {
    const jobs = await service.listFailedJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe('job-1');
  });

  it('should retry job', async () => {
    const success = await service.retryJob('job-1');
    expect(success).toBe(true);
  });

  it('should delete job', async () => {
    const deleted = await service.deleteJob('job-1');
    expect(deleted).toBe(true);
  });
});
