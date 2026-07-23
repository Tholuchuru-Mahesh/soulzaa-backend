import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { ModerationProcessingProcessor } from './moderation-processing.processor';

describe('ModerationProcessingProcessor', () => {
  const support = {
    metrics: { observeDuration: jest.fn(), incCompleted: jest.fn(), incFailed: jest.fn() },
  };
  let notifications: { enqueue: jest.Mock };
  let processor: ModerationProcessingProcessor;

  beforeEach(() => {
    notifications = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    processor = new ModerationProcessingProcessor(support as never, notifications as never);
  });

  it('forwards a "notify" job onto the shared notifications queue, keyed by its type', async () => {
    const job = {
      name: 'notify',
      data: { type: 'video_room.kicked', userId: 'user-1', roomId: 'room-1', reason: null },
    } as never;

    await processor.handle(job);

    expect(notifications.enqueue).toHaveBeenCalledWith(
      QUEUE_NAMES.NOTIFICATIONS,
      'video_room.kicked',
      { userId: 'user-1', roomId: 'room-1', reason: null },
    );
  });

  it('is a safe no-op for an unknown job name', async () => {
    const job = { name: 'something-else', data: {} } as never;

    await expect(processor.handle(job)).resolves.toEqual({ ok: true, unhandled: true });
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });
});
