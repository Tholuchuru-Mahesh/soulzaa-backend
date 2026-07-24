import { Test, TestingModule } from '@nestjs/testing';
import { DLQService, DLQJobRecord } from './dlq.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { QueueService } from './queue.service';

describe('DLQService', () => {
  let service: DLQService;
  let redisMock: any;
  let addMock: jest.Mock;
  let queueMock: { getQueue: jest.Mock };

  beforeEach(async () => {
    addMock = jest.fn().mockResolvedValue({ id: 'requeued-1' });
    queueMock = { getQueue: jest.fn().mockReturnValue({ add: addMock }) };

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
      providers: [
        DLQService,
        { provide: REDIS_CLIENT, useValue: redisMock },
        { provide: QueueService, useValue: queueMock },
      ],
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

  it('should retry job: re-enqueue onto its queue and clear the DLQ record', async () => {
    const success = await service.retryJob('job-1');
    expect(success).toBe(true);
    expect(queueMock.getQueue).toHaveBeenCalledWith('wallet');
    expect(addMock).toHaveBeenCalledWith('payout', {});
    expect(redisMock.hdel).toHaveBeenCalledWith('dlq:failed_jobs', 'job-1');
  });

  it('should replay job the same way', async () => {
    const success = await service.replayJob('job-1');
    expect(success).toBe(true);
    expect(addMock).toHaveBeenCalledWith('payout', {});
    expect(redisMock.hdel).toHaveBeenCalledWith('dlq:failed_jobs', 'job-1');
  });

  it('returns false for an unknown job id (nothing re-enqueued)', async () => {
    redisMock.hget.mockResolvedValueOnce(null);
    const success = await service.retryJob('missing');
    expect(success).toBe(false);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('should delete job', async () => {
    const deleted = await service.deleteJob('job-1');
    expect(deleted).toBe(true);
  });
});
