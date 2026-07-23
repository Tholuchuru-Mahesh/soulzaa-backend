import { RankingsProcessor } from './rankings.processor';

describe('RankingsProcessor', () => {
  const support = {
    metrics: { observeDuration: jest.fn(), incCompleted: jest.fn(), incFailed: jest.fn() },
  };
  let rankings: { takeMidnightSnapshots: jest.Mock };
  let registry: { dispatch: jest.Mock };
  let processor: RankingsProcessor;

  beforeEach(() => {
    rankings = { takeMidnightSnapshots: jest.fn().mockResolvedValue(undefined) };
    registry = { dispatch: jest.fn().mockResolvedValue({ ok: true }) };
    processor = new RankingsProcessor(support as never, rankings as never, registry as never);
  });

  it('still runs the legacy snapshot job itself', async () => {
    await expect(processor.handle({ name: 'rankings.snapshot' } as never)).resolves.toEqual({
      snapshotTaken: true,
    });
    expect(rankings.takeMidnightSnapshots).toHaveBeenCalledTimes(1);
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it('routes any other job name to the domain registry', async () => {
    const job = { name: 'video-room.ranking.aggregate.daily' } as never;
    await expect(processor.handle(job)).resolves.toEqual({ ok: true });
    expect(registry.dispatch).toHaveBeenCalledWith('ranking-processing', job);
    expect(rankings.takeMidnightSnapshots).not.toHaveBeenCalled();
  });

  it('propagates a domain handler failure so BullMQ can retry it', async () => {
    registry.dispatch.mockRejectedValue(new Error('aggregation failed'));
    await expect(processor.handle({ name: 'video-room.ranking.cleanup' } as never)).rejects.toThrow(
      'aggregation failed',
    );
  });
});
