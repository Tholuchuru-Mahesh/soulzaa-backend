import { PostScoreScheduler } from './post-score.scheduler';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';

describe('PostScoreScheduler', () => {
  function build() {
    const registry = { register: jest.fn() };
    const queue = { schedule: jest.fn().mockResolvedValue(undefined) };
    const scoring = { recomputeActivePosts: jest.fn() };
    const scheduler = new PostScoreScheduler(registry as any, queue as any, scoring as any);
    return { scheduler, registry, queue, scoring };
  }

  it('registers a handler on the shared RANKING_PROCESSING queue', async () => {
    const { scheduler, registry } = build();
    await scheduler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.RANKING_PROCESSING,
      'post.score.decay',
      expect.any(Function),
    );
  });

  it('schedules a repeatable job with a fixed jobId', async () => {
    const { scheduler, queue } = build();
    await scheduler.onModuleInit();
    expect(queue.schedule).toHaveBeenCalledWith(
      QUEUE_NAMES.RANKING_PROCESSING,
      'post.score.decay',
      {},
      { pattern: '*/5 * * * *' },
      { jobId: 'post-score-decay', removeOnComplete: true, removeOnFail: true },
    );
  });

  it('the registered handler calls PostScoreService.recomputeActivePosts', async () => {
    const { scheduler, registry, scoring } = build();
    await scheduler.onModuleInit();
    const handler = registry.register.mock.calls[0][2];

    await handler();

    expect(scoring.recomputeActivePosts).toHaveBeenCalled();
  });
});
