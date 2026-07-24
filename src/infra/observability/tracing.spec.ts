import { Test, TestingModule } from '@nestjs/testing';
import { TracingService } from './tracing.service';

describe('TracingService', () => {
  let service: TracingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TracingService],
    }).compile();

    service = module.get<TracingService>(TracingService);
  });

  it('should start and end trace span', () => {
    const span = service.startSpan('TestOperation', { userId: 'usr-1' });
    expect(span.traceId).toBeDefined();
    expect(span.spanId).toBeDefined();
    expect(span.userId).toBe('usr-1');

    expect(() => service.endSpan(span, { status: 'OK' })).not.toThrow();
  });
});
