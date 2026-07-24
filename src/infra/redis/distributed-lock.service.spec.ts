import { Test, TestingModule } from '@nestjs/testing';
import { DistributedLockService } from './distributed-lock.service';
import { REDIS_CLIENT } from './redis.constants';

describe('DistributedLockService', () => {
  let service: DistributedLockService;
  let redisMock: any;

  beforeEach(async () => {
    redisMock = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DistributedLockService, { provide: REDIS_CLIENT, useValue: redisMock }],
    }).compile();

    service = module.get<DistributedLockService>(DistributedLockService);
  });

  it('should acquire lock successfully', async () => {
    const lock = await service.acquireLock('wallet:123');
    expect(lock).toBeDefined();
    expect(lock?.resource).toBe('wallet:123');
    expect(redisMock.set).toHaveBeenCalledWith(
      'lock:wallet:123',
      expect.any(String),
      'PX',
      5000,
      'NX',
    );
  });

  it('should release lock safely via Lua script', async () => {
    const lock = await service.acquireLock('wallet:123');
    expect(lock).toBeDefined();

    const released = await service.releaseLock(lock!);
    expect(released).toBe(true);
    expect(redisMock.eval).toHaveBeenCalled();
  });

  it('should execute task within lock wrapper', async () => {
    const task = jest.fn().mockResolvedValue('result');
    const res = await service.runWithLock('gift:456', task);
    expect(res).toBe('result');
    expect(task).toHaveBeenCalled();
    expect(redisMock.eval).toHaveBeenCalled();
  });
});
