import { Test, TestingModule } from '@nestjs/testing';
import { PrismaPerformanceService } from './prisma-performance.service';

describe('PrismaPerformanceService', () => {
  let service: PrismaPerformanceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaPerformanceService],
    }).compile();

    service = module.get<PrismaPerformanceService>(PrismaPerformanceService);
  });

  it('should record fast query', () => {
    service.recordQuery('SELECT 1', 10);
    const stats = service.getDatabaseStatistics();
    expect(stats.totalQueriesExecuted).toBe(1);
    expect(stats.slowQueriesCount).toBe(0);
  });

  it('should record slow query and generate suggestions', () => {
    service.recordQuery('SELECT * FROM video_rooms WHERE status = "LIVE"', 250);
    const slow = service.getSlowQueries();
    expect(slow.length).toBe(1);
    expect(slow[0].durationMs).toBe(250);
    expect(slow[0].suggestion).toBeDefined();
  });
});
