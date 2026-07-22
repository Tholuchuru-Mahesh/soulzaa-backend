import { VIDEO_ROOM_GIFT_EVENTS } from '../events/video-room-gift.events';
import { VideoRoomGiftDeliveryService } from './video-room-gift-delivery.service';

const DATA = {
  batchId: 'b1',
  roomId: 'r1',
  senderId: 's1',
  giftId: 'g1',
  giftName: 'Rocket',
  animationUrl: 'a.svga',
  soundUrl: 's.mp3',
  comboTier: 2,
  quantity: 1,
  totalCoinValue: 200,
  transactionIds: ['t1', 't2'],
  receiverIds: ['u1', 'u2'],
};

const JOB = { id: 'j1', attemptsMade: 0, name: 'video-room.gift.deliver' };

describe('VideoRoomGiftDeliveryService', () => {
  let registry: { register: jest.Mock };
  let locks: { withLock: jest.Mock };
  let events: { appendEvent: jest.Mock };
  let bus: { publish: jest.Mock };
  let metrics: { incGiftFailure: jest.Mock };
  let service: VideoRoomGiftDeliveryService;

  const published = (name: string) =>
    bus.publish.mock.calls
      .map((c) => c[0] as { name: string; payload: Record<string, unknown> })
      .filter((e) => e.name === name);

  beforeEach(() => {
    registry = { register: jest.fn() };
    locks = { withLock: jest.fn().mockImplementation((_key, cb) => cb()) };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    metrics = { incGiftFailure: jest.fn() };
    service = new VideoRoomGiftDeliveryService(
      registry as never,
      locks as never,
      events as never,
      bus as never,
      metrics as never,
    );
  });

  it('registers itself on the gift queue at init', () => {
    service.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      'gift-processing',
      'video-room.gift.deliver',
      expect.any(Function),
    );
  });

  it('serialises delivery on the per-room lock', async () => {
    await service.handle(DATA, JOB as never);
    expect(locks.withLock.mock.calls[0][0]).toBe('video-room:gift:deliver:r1');
  });

  it('emits exactly ONE batch-level animation event', async () => {
    await service.handle(DATA, JOB as never);
    const animations = published(VIDEO_ROOM_GIFT_EVENTS.ANIMATION);
    expect(animations).toHaveLength(1);
    expect(animations[0].payload).toMatchObject({
      batchId: 'b1',
      receiverIds: ['u1', 'u2'],
      transactionIds: ['t1', 't2'],
      giftName: 'Rocket',
      comboTier: 2,
    });
  });

  it('emits ONE delivered event PER LEG with the full correlation envelope', async () => {
    await service.handle(DATA, JOB as never);
    const delivered = published(VIDEO_ROOM_GIFT_EVENTS.DELIVERED);
    expect(delivered).toHaveLength(2);
    expect(delivered[0].payload).toEqual({
      batchId: 'b1',
      transactionId: 't1',
      roomId: 'r1',
      senderId: 's1',
      receiverId: 'u1',
      giftId: 'g1',
      jobId: 'j1',
      attempt: 1,
    });
    expect(delivered[1].payload).toMatchObject({ transactionId: 't2', receiverId: 'u2' });
  });

  it('appends a delivered audit row per leg, correlated by batchId', async () => {
    await service.handle(DATA, JOB as never);
    expect(events.appendEvent).toHaveBeenCalledTimes(2);
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        eventType: 'gift.delivered',
        correlationId: 'b1',
        referenceId: 't1',
      }),
    );
  });

  it('reports attempt = attemptsMade + 1', async () => {
    await service.handle(DATA, { ...JOB, attemptsMade: 2 } as never);
    expect(published(VIDEO_ROOM_GIFT_EVENTS.DELIVERED)[0].payload.attempt).toBe(3);
  });

  it('returns the delivered leg count', async () => {
    await expect(service.handle(DATA, JOB as never)).resolves.toEqual({ delivered: 2 });
  });

  describe('failure handling', () => {
    it('rethrows so BullMQ can retry and dead-letter', async () => {
      bus.publish.mockRejectedValueOnce(new Error('socket down'));
      await expect(service.handle(DATA, JOB as never)).rejects.toThrow('socket down');
    });

    it('emits a failure event per leg carrying the reason and jobId', async () => {
      bus.publish.mockRejectedValueOnce(new Error('socket down'));
      await expect(service.handle(DATA, JOB as never)).rejects.toThrow();
      const failures = published(VIDEO_ROOM_GIFT_EVENTS.FAILED);
      expect(failures).toHaveLength(2);
      expect(failures[0].payload).toMatchObject({
        batchId: 'b1',
        receiverId: 'u1',
        jobId: 'j1',
        attempt: 1,
        reason: 'socket down',
      });
    });

    it('appends a delivery-failed audit row per leg', async () => {
      bus.publish.mockRejectedValueOnce(new Error('socket down'));
      await expect(service.handle(DATA, JOB as never)).rejects.toThrow();
      expect(events.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'gift.delivery.failed', correlationId: 'b1' }),
      );
    });

    it('counts the failure for monitoring', async () => {
      bus.publish.mockRejectedValueOnce(new Error('socket down'));
      await expect(service.handle(DATA, JOB as never)).rejects.toThrow();
      expect(metrics.incGiftFailure).toHaveBeenCalledTimes(1);
    });

    it('does not let a logging failure mask the original error', async () => {
      bus.publish.mockRejectedValueOnce(new Error('socket down'));
      events.appendEvent.mockRejectedValue(new Error('db down'));
      await expect(service.handle(DATA, JOB as never)).rejects.toThrow('socket down');
    });
  });

  describe('single-receiver batch', () => {
    const single = { ...DATA, transactionIds: ['t1'], receiverIds: ['u1'] };

    it('emits one animation and one delivery', async () => {
      await service.handle(single, JOB as never);
      expect(published(VIDEO_ROOM_GIFT_EVENTS.ANIMATION)).toHaveLength(1);
      expect(published(VIDEO_ROOM_GIFT_EVENTS.DELIVERED)).toHaveLength(1);
    });
  });
});
