import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { VIDEO_ROOM_ANALYTICS_QUEUES } from '../constants/video-room-analytics.constants';
import { VideoRoomAnalyticsAggregationProcessor } from './video-room-analytics-aggregation.processor';
import { VideoRoomAnalyticsAggregationService } from '../services/video-room-analytics-aggregation.service';

describe('VideoRoomAnalyticsAggregationProcessor', () => {
  let processor: VideoRoomAnalyticsAggregationProcessor;
  let aggregationServiceMock: any;
  let supportMock: any;
  let queueMock: any;

  beforeEach(async () => {
    aggregationServiceMock = {
      aggregateHourly: jest.fn().mockResolvedValue({ period: 'HOURLY' }),
      aggregateDaily: jest.fn().mockResolvedValue({ period: 'DAILY' }),
      aggregateWeekly: jest.fn().mockResolvedValue({ period: 'WEEKLY' }),
      aggregateMonthly: jest.fn().mockResolvedValue({ period: 'MONTHLY' }),
      refreshCache: jest.fn().mockResolvedValue(undefined),
    };

    supportMock = {
      wrapHandler: jest.fn((job, fn) => fn()),
    };

    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsAggregationProcessor,
        { provide: getQueueToken(VIDEO_ROOM_ANALYTICS_QUEUES.AGGREGATION), useValue: queueMock },
        { provide: VideoRoomAnalyticsAggregationService, useValue: aggregationServiceMock },
        { provide: QueueSupport, useValue: supportMock },
      ],
    }).compile();

    processor = module.get<VideoRoomAnalyticsAggregationProcessor>(
      VideoRoomAnalyticsAggregationProcessor,
    );
  });

  it('should process hourly-analytics job', async () => {
    const job: any = { name: 'hourly-analytics', data: {} };
    const res = await processor.handle(job);
    expect(aggregationServiceMock.aggregateHourly).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should process daily-analytics job', async () => {
    const job: any = { name: 'daily-analytics', data: {} };
    const res = await processor.handle(job);
    expect(aggregationServiceMock.aggregateDaily).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should process weekly-analytics job', async () => {
    const job: any = { name: 'weekly-analytics', data: {} };
    const res = await processor.handle(job);
    expect(aggregationServiceMock.aggregateWeekly).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should process monthly-analytics job', async () => {
    const job: any = { name: 'monthly-analytics', data: {} };
    const res = await processor.handle(job);
    expect(aggregationServiceMock.aggregateMonthly).toHaveBeenCalled();
    expect(res).toBeDefined();
  });
});
