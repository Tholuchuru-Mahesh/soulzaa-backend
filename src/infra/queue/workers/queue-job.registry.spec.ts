import { QUEUE_NAMES } from '../queue.constants';
import { QueueJobRegistry } from './queue-job.registry';

describe('QueueJobRegistry', () => {
  let registry: QueueJobRegistry;

  beforeEach(() => {
    registry = new QueueJobRegistry();
  });

  it('dispatches to the registered handler with the job data and the job', async () => {
    const handler = jest.fn().mockResolvedValue({ done: true });
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'video-room.gift.deliver', handler);
    const job = { name: 'video-room.gift.deliver', data: { batchId: 'b1' } };

    await expect(registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job as never)).resolves.toEqual({
      done: true,
    });
    expect(handler).toHaveBeenCalledWith({ batchId: 'b1' }, job);
  });

  /**
   * REGRESSION GUARD. GiftService enqueues `gift.sent` to gift-processing on
   * every audio-room gift and nothing handles it — the old stub processor
   * swallowed it. If dispatch threw on unknown names, every existing audio-room
   * gift would exhaust its retries and land in the dead-letter queue.
   */
  it('returns unhandled and NEVER throws for an unregistered job name', async () => {
    const job = { name: 'gift.sent', data: { transactionId: 't1' } };
    await expect(registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job as never)).resolves.toEqual({
      ok: true,
      unhandled: true,
    });
  });

  it('keys handlers by queue AND job name', async () => {
    const handler = jest.fn().mockResolvedValue('a');
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'shared-name', handler);

    await expect(
      registry.dispatch(QUEUE_NAMES.NOTIFICATIONS, { name: 'shared-name', data: {} } as never),
    ).resolves.toEqual({ ok: true, unhandled: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates handler errors so BullMQ can retry and dead-letter', async () => {
    registry.register(
      QUEUE_NAMES.GIFT_PROCESSING,
      'boom',
      jest.fn().mockRejectedValue(new Error('nope')),
    );
    await expect(
      registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, { name: 'boom', data: {} } as never),
    ).rejects.toThrow('nope');
  });

  it('rejects double registration of the same queue + job name', () => {
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'dup', jest.fn());
    expect(() => registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'dup', jest.fn())).toThrow(
      /already registered/i,
    );
  });

  it('supports several handlers on one queue', async () => {
    const a = jest.fn().mockResolvedValue('a');
    const b = jest.fn().mockResolvedValue('b');
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'a', a);
    registry.register(QUEUE_NAMES.GIFT_PROCESSING, 'b', b);

    await expect(
      registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, { name: 'b', data: {} } as never),
    ).resolves.toBe('b');
    expect(a).not.toHaveBeenCalled();
  });
});
