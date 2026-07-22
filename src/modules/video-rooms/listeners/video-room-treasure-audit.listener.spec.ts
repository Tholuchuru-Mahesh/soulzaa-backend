import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomTreasureAuditListener } from './video-room-treasure-audit.listener';

describe('VideoRoomTreasureAuditListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => Promise<void>> };
  let events: { appendEvent: jest.Mock };
  let listener: VideoRoomTreasureAuditListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => Promise<void>) => handlers.set(n, f)),
    };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomTreasureAuditListener(bus as never, events as never);
    listener.onModuleInit();
  });

  it('audits all ten treasure events', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(10);
  });

  it('writes an append-only row carrying the full correlation envelope', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      boxId: 'b1',
      level: 2,
      poolAmount: 6000,
      winners: [],
      algorithm: 'RANDOM',
      nextLevel: 3,
    });
    expect(events.appendEvent).toHaveBeenCalledWith({
      roomId: 'r1',
      eventType: 'treasure.unlocked',
      referenceId: 'b1',
      correlationId: 'c1',
      actorId: null,
      payload: expect.objectContaining({ level: 2, poolAmount: 6000, sessionId: 's1' }),
    });
  });

  it('falls back to the session id as the reference when there is no box', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.CREATED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      createdBy: 'u1',
      levels: [1, 2],
    });
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: 's1',
        actorId: 'u1',
        eventType: 'treasure.created',
      }),
    );
  });

  it('resolves the actor from whichever field names them', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.CLOSED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      status: 'CLOSED',
      closedBy: 'u7',
    });
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'u7', eventType: 'treasure.closed' }),
    );
  });

  it('records a system-driven event with a null actor', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      boxId: 'b1',
      level: 1,
      progress: 500,
      threshold: 15_000,
      percent: 3.33,
    });
    expect(events.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ actorId: null }));
  });

  it('audits a failure with its stage', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      boxId: 'b1',
      level: 1,
      stage: 'DISTRIBUTION',
      attempt: 2,
      error: 'wallet timeout',
    });
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'treasure.failed',
        payload: expect.objectContaining({ stage: 'DISTRIBUTION' }),
      }),
    );
  });

  // The brief's AUDIT LOGGING section names Request ID. Owner actions carry one;
  // it lets an auditor join a treasure row back to the HTTP access log.
  it('persists the originating request id on an owner-driven event', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.CREATED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      createdBy: 'u1',
      levels: [1],
      requestId: 'req-abc',
    });
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ requestId: 'req-abc' }),
      }),
    );
  });

  // The unlock chain runs on a queue worker where no HTTP request exists;
  // correlationId is the identifier that carries meaning there.
  it('records a null request id for a queue-driven event', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      correlationId: 'c1',
      roomId: 'r1',
      sessionId: 's1',
      boxId: 'b1',
      level: 1,
      poolAmount: 0,
      winners: [],
      algorithm: 'RANDOM',
      nextLevel: null,
    });
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'c1',
        payload: expect.objectContaining({ requestId: null }),
      }),
    );
  });

  // Audit is observational. The payout has already happened, and throwing here
  // would poison the bus for every other subscriber.
  it('swallows repository failures', async () => {
    events.appendEvent.mockRejectedValue(new Error('db down'));
    await expect(
      fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
        correlationId: 'c1',
        roomId: 'r1',
        sessionId: 's1',
        boxId: 'b1',
        level: 1,
        poolAmount: 0,
        winners: [],
        algorithm: 'RANDOM',
        nextLevel: null,
      }),
    ).resolves.toBeUndefined();
  });
});
