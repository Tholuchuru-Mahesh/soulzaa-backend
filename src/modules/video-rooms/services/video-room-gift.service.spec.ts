import { HttpStatus } from '@nestjs/common';
import { GiftCategory } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { VideoRoomGiftTarget } from '../dto/send-video-room-gift.dto';
import { VIDEO_ROOM_ECONOMY_EVENTS } from '../constants/video-room-economy.constants';
import { VideoRoomGiftService } from './video-room-gift.service';

const ACTOR = { id: 'sender-1', roles: ['USER'] } as never;
const ROOM = 'r1';

const GIFT = {
  id: 'g1',
  name: 'Rocket',
  category: GiftCategory.LUXURY,
  animationUrl: 'a.svga',
  soundUrl: 's.mp3',
  comboEnabled: true,
  comboWindowSeconds: 10,
};

const txn = (receiverId: string, id = `t-${receiverId}`) =>
  ({
    id,
    receiverId,
    senderId: 'sender-1',
    giftId: 'g1',
    quantity: 1,
    comboTier: 1,
    totalCoinValue: 100n,
    creatorEarnings: 30n,
    createdAt: new Date(),
    metadata: { batchId: 'b1', giftName: 'Rocket' },
  }) as never;

const dto = (overrides: Record<string, unknown> = {}) =>
  ({ giftId: 'g1', target: VideoRoomGiftTarget.SEAT_ALL, quantity: 1, ...overrides }) as never;

describe('VideoRoomGiftService.send', () => {
  let resolver: { resolve: jest.Mock };
  let gifts: { sendGiftBatch: jest.Mock };
  let catalog: { getGift: jest.Mock };
  let combo: { tick: jest.Mock };
  let statistics: { record: jest.Mock };
  let events: { appendEvent: jest.Mock };
  let queue: Record<string, jest.Mock>;
  let metrics: Record<string, jest.Mock>;
  let bus: { publish: jest.Mock };
  let walletMetrics: Record<string, jest.Mock>;
  let service: VideoRoomGiftService;

  beforeEach(() => {
    resolver = { resolve: jest.fn().mockResolvedValue(['u1', 'u2']) };
    gifts = { sendGiftBatch: jest.fn().mockResolvedValue([txn('u1'), txn('u2')]) };
    catalog = { getGift: jest.fn().mockResolvedValue(GIFT) };
    combo = { tick: jest.fn().mockResolvedValue({ tier: 3, started: false }) };
    statistics = { record: jest.fn().mockResolvedValue(undefined) };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    queue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 2, delayed: 1, active: 1 }),
    };
    metrics = {
      incGiftSent: jest.fn(),
      observeGiftSendLatency: jest.fn(),
      observeGiftWalletLatency: jest.fn(),
      setGiftQueueDepth: jest.fn(),
      setGiftAnimationQueueDepth: jest.fn(),
      incGiftFailure: jest.fn(),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    walletMetrics = {
      recordMovement: jest.fn(),
      recordFailed: jest.fn(),
      recordReconciliationDrift: jest.fn(),
    };
    service = new VideoRoomGiftService(
      resolver as never,
      gifts as never,
      catalog as never,
      combo as never,
      statistics as never,
      events as never,
      queue as never,
      metrics as never,
      bus as never,
      walletMetrics as never,
    );
  });

  it('resolves the target then delegates to the shared batch pipeline', async () => {
    await service.send(ACTOR, ROOM, dto());
    expect(resolver.resolve).toHaveBeenCalledWith(ROOM, expect.anything(), 'sender-1');
    expect(gifts.sendGiftBatch).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        contextType: 'VIDEO_ROOM',
        contextId: ROOM,
        receiverIds: ['u1', 'u2'],
      }),
    );
  });

  it('rejects an unknown gift before resolving anyone', async () => {
    catalog.getGift.mockResolvedValue(null);
    await expect(service.send(ACTOR, ROOM, dto())).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_NOT_FOUND,
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  /** The transaction-boundary contract, asserted rather than documented. */
  it('performs NO queue, statistics or combo work before the batch commits', async () => {
    gifts.sendGiftBatch.mockImplementation(async () => {
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(statistics.record).not.toHaveBeenCalled();
      expect(combo.tick).not.toHaveBeenCalled();
      expect(events.appendEvent).not.toHaveBeenCalled();
      return [txn('u1')];
    });
    await service.send(ACTOR, ROOM, dto());
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it('enqueues exactly ONE delivery job per batch', async () => {
    await service.send(ACTOR, ROOM, dto());
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues with the category priority, attempts and backoff', async () => {
    await service.send(ACTOR, ROOM, dto());
    const [queueName, jobName, data, opts] = queue.enqueue.mock.calls[0];
    expect(queueName).toBe('gift-processing');
    expect(jobName).toBe('video-room.gift.deliver');
    expect(data).toMatchObject({
      batchId: 'b1',
      roomId: ROOM,
      transactionIds: ['t-u1', 't-u2'],
      receiverIds: ['u1', 'u2'],
    });
    expect(opts).toMatchObject({
      priority: 1,
      attempts: 5,
      backoff: { type: 'exponential', delay: 500 },
    });
  });

  it('ticks the combo once per send, not once per receiver', async () => {
    await service.send(ACTOR, ROOM, dto());
    expect(combo.tick).toHaveBeenCalledTimes(1);
    expect(combo.tick).toHaveBeenCalledWith(ROOM, 'sender-1', GIFT, 200);
  });

  it('skips the combo tick for a gift with combos disabled', async () => {
    catalog.getGift.mockResolvedValue({ ...GIFT, comboEnabled: false });
    await service.send(ACTOR, ROOM, dto());
    expect(combo.tick).not.toHaveBeenCalled();
  });

  it('records statistics for the whole batch', async () => {
    await service.send(ACTOR, ROOM, dto());
    expect(statistics.record).toHaveBeenCalledWith(ROOM, [
      expect.objectContaining({ receiverId: 'u1' }),
      expect.objectContaining({ receiverId: 'u2' }),
    ]);
  });

  it('writes the animation-queued audit row correlated by batchId', async () => {
    await service.send(ACTOR, ROOM, dto());
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: ROOM,
        eventType: 'gift.animation.queued',
        correlationId: 'b1',
        referenceId: 't-u1',
      }),
    );
  });

  it('propagates a send failure and enqueues nothing', async () => {
    gifts.sendGiftBatch.mockRejectedValue(new Error('insufficient balance'));
    await expect(service.send(ACTOR, ROOM, dto())).rejects.toThrow('insufficient balance');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(statistics.record).not.toHaveBeenCalled();
  });

  it('publishes GIFT_FAILED and rethrows the ORIGINAL wallet error on send failure', async () => {
    const walletError = new BusinessException(
      ERROR_CODES.INSUFFICIENT_BALANCE,
      'Insufficient balance for this transaction.',
      HttpStatus.CONFLICT,
    );
    gifts.sendGiftBatch.mockRejectedValue(walletError);

    await expect(service.send(ACTOR, ROOM, dto())).rejects.toBe(walletError);

    expect(walletMetrics.recordFailed).toHaveBeenCalledWith(ERROR_CODES.INSUFFICIENT_BALANCE);

    expect(bus.publish).toHaveBeenCalledTimes(1);
    const failedEvent = bus.publish.mock.calls
      .map((c) => c[0] as { name: string; payload: Record<string, unknown> })
      .find((e) => e.name === VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED);
    expect(failedEvent?.payload).toMatchObject({
      userId: 'sender-1',
      roomId: ROOM,
      giftId: 'g1',
      errorCode: ERROR_CODES.INSUFFICIENT_BALANCE,
    });
  });

  it('still succeeds when the queue is down — the gift is already paid for', async () => {
    queue.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(service.send(ACTOR, ROOM, dto())).resolves.toMatchObject({ batchId: 'b1' });
  });

  it('still succeeds when statistics fail', async () => {
    statistics.record.mockRejectedValue(new Error('stats down'));
    await expect(service.send(ACTOR, ROOM, dto())).resolves.toMatchObject({ batchId: 'b1' });
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it('still succeeds when the combo tick fails', async () => {
    combo.tick.mockRejectedValue(new Error('combo down'));
    await expect(service.send(ACTOR, ROOM, dto())).resolves.toBeDefined();
  });

  describe('monitoring (registered metrics must actually be fed)', () => {
    it('counts one gift per ledger row, labelled by category, with its coins', async () => {
      await service.send(ACTOR, ROOM, dto());
      expect(metrics.incGiftSent).toHaveBeenCalledTimes(2);
      expect(metrics.incGiftSent).toHaveBeenCalledWith('LUXURY', 100);
    });

    it('observes send and wallet latency', async () => {
      await service.send(ACTOR, ROOM, dto());
      expect(metrics.observeGiftSendLatency).toHaveBeenCalledTimes(1);
      expect(metrics.observeGiftWalletLatency).toHaveBeenCalledTimes(1);
    });

    it('publishes queue depth as a socket event AND a gauge', async () => {
      await service.send(ACTOR, ROOM, dto());
      expect(metrics.setGiftQueueDepth).toHaveBeenCalledWith(3);
      expect(metrics.setGiftAnimationQueueDepth).toHaveBeenCalledWith(4);
      const queueEvent = bus.publish.mock.calls
        .map((c) => c[0] as { name: string; payload: Record<string, unknown> })
        .find((e) => e.name === 'video_room.gift.queue_updated');
      expect(queueEvent?.payload).toMatchObject({ roomId: ROOM, pending: 3, active: 1 });
    });

    it('counts a failure when the delivery job cannot be enqueued', async () => {
      queue.enqueue.mockRejectedValue(new Error('redis down'));
      await service.send(ACTOR, ROOM, dto());
      expect(metrics.incGiftFailure).toHaveBeenCalledTimes(1);
    });

    it('still succeeds when the queue depth read fails', async () => {
      queue.getJobCounts.mockRejectedValue(new Error('counts unavailable'));
      await expect(service.send(ACTOR, ROOM, dto())).resolves.toMatchObject({ batchId: 'b1' });
    });
  });

  it('returns a per-receiver view with the batch total', async () => {
    const view = await service.send(ACTOR, ROOM, dto());
    expect(view).toMatchObject({
      batchId: 'b1',
      roomId: ROOM,
      giftId: 'g1',
      comboTier: 3,
      totalCoinValue: 200,
    });
    expect(view.transactions).toEqual([
      { transactionId: 't-u1', receiverId: 'u1', coinValue: 100, receiverEarnings: 30 },
      { transactionId: 't-u2', receiverId: 'u2', coinValue: 100, receiverEarnings: 30 },
    ]);
  });
});
