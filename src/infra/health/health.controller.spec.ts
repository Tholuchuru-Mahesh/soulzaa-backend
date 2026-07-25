import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';
import { RedisHealthIndicator } from './redis.health';
import { QueueHealthIndicator } from './queue.health';
import { StorageHealthIndicator } from './storage.health';
import { SocketHealthIndicator } from './socket.health';
import { EventLoopHealthIndicator } from './event-loop.health';
import { SystemHealthIndicator } from './system.health';
import { ZegoHealthIndicator } from './zego.health';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            check: jest.fn().mockImplementation((fns) => Promise.all(fns.map((f: any) => f()))),
          },
        },
        {
          provide: PrismaHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ database: { status: 'up' } }) },
        },
        {
          provide: RedisHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up' } }) },
        },
        {
          provide: QueueHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ queues: { status: 'up' } }) },
        },
        {
          provide: StorageHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ storage: { status: 'up' } }) },
        },
        {
          provide: SocketHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ socket: { status: 'up' } }) },
        },
        {
          provide: MemoryHealthIndicator,
          useValue: { checkRSS: jest.fn().mockResolvedValue({ memory_rss: { status: 'up' } }) },
        },
        {
          provide: EventLoopHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ event_loop: { status: 'up' } }) },
        },
        {
          provide: ZegoHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ zego: { status: 'up' } }) },
        },
        {
          provide: SystemHealthIndicator,
          useValue: { isHealthy: jest.fn().mockResolvedValue({ system: { status: 'up' } }) },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-app-id') } },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should run liveness check', async () => {
    const res = await controller.liveness();
    expect(res).toBeDefined();
  });

  it('should run readiness check', async () => {
    const res = await controller.readiness();
    expect(res).toBeDefined();
  });

  it('should run deep health check', async () => {
    const res = await controller.deep();
    expect(res).toBeDefined();
  });
});
