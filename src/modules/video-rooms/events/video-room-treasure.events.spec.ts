import {
  TreasureClosedEvent,
  TreasureCreatedEvent,
  TreasureProgressUpdatedEvent,
  TreasureRecoveredEvent,
  TreasureRewardDistributedEvent,
  TreasureRewardGeneratedEvent,
  TreasureStartedEvent,
  TreasureUnlockedEvent,
  TreasureUnlockFailedEvent,
  TreasureWinnerSelectedEvent,
  VIDEO_ROOM_TREASURE_EVENTS,
} from './video-room-treasure.events';

const BASE = { correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 2 };

describe('video-room treasure events', () => {
  it('registers ten event names', () => {
    expect(Object.keys(VIDEO_ROOM_TREASURE_EVENTS)).toHaveLength(10);
  });

  it('dot-namespaces every event name under video_room.treasure', () => {
    for (const name of Object.values(VIDEO_ROOM_TREASURE_EVENTS)) {
      expect(name).toMatch(/^video_room\.treasure\.[a-z_]+$/);
    }
  });

  it('gives every event class a distinct name', () => {
    const names = Object.values(VIDEO_ROOM_TREASURE_EVENTS);
    expect(new Set(names).size).toBe(names.length);
  });

  it('carries the full correlation envelope on the unlock payload', () => {
    const e = new TreasureUnlockedEvent({
      ...BASE,
      poolAmount: 6000,
      winners: [{ userId: 'u1', amount: 2000, shareBps: 3333 }],
      algorithm: 'RANDOM',
      nextLevel: 3,
    });
    expect(e.name).toBe(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED);
    expect(e.payload).toEqual(expect.objectContaining(BASE));
    expect(e.payload.nextLevel).toBe(3);
  });

  it('allows a null nextLevel for the final box', () => {
    const e = new TreasureUnlockedEvent({
      ...BASE,
      level: 4,
      poolAmount: 35000,
      winners: [],
      algorithm: 'RANDOM',
      nextLevel: null,
    });
    expect(e.payload.nextLevel).toBeNull();
  });

  it('stamps eventId and occurredAt from the DomainEvent base', () => {
    const e = new TreasureProgressUpdatedEvent({
      ...BASE,
      progress: 500,
      threshold: 15000,
      percent: 3.33,
    });
    expect(e.eventId).toEqual(expect.any(String));
    expect(Date.parse(e.occurredAt)).not.toBeNaN();
  });

  it('carries the optional batchId when a gift batch originated it', () => {
    const e = new TreasureProgressUpdatedEvent({
      ...BASE,
      batchId: 'batch-1',
      progress: 1,
      threshold: 2,
      percent: 50,
    });
    expect(e.payload.batchId).toBe('batch-1');
  });

  // The stage label is what makes a failure attributable to validation vs
  // eligibility vs the wallet without reading code.
  it('names the failing stage on the failure event', () => {
    const e = new TreasureUnlockFailedEvent({
      ...BASE,
      stage: 'DISTRIBUTION',
      attempt: 2,
      error: 'wallet timeout',
    });
    expect(e.payload.stage).toBe('DISTRIBUTION');
    expect(e.payload.attempt).toBe(2);
  });

  it('distinguishes the two recovery reasons', () => {
    const orphan = new TreasureRecoveredEvent({ ...BASE, reason: 'ORPHAN_RECLAIM', attempt: 1 });
    const dlq = new TreasureRecoveredEvent({ ...BASE, reason: 'DLQ_REPLAY', attempt: 3 });
    expect(orphan.payload.reason).toBe('ORPHAN_RECLAIM');
    expect(dlq.payload.reason).toBe('DLQ_REPLAY');
  });

  it('constructs the remaining lifecycle and pipeline events', () => {
    expect(
      new TreasureCreatedEvent({ ...BASE, boxId: undefined, createdBy: 'u1', levels: [1, 2] }).name,
    ).toBe(VIDEO_ROOM_TREASURE_EVENTS.CREATED);
    expect(new TreasureStartedEvent({ ...BASE, startedBy: 'u1', threshold: 15000 }).name).toBe(
      VIDEO_ROOM_TREASURE_EVENTS.STARTED,
    );
    expect(
      new TreasureRewardGeneratedEvent({
        ...BASE,
        strategy: 'PERCENTAGE',
        poolAmount: 1500,
        sourceAmount: 15000,
        winnerCount: 3,
      }).name,
    ).toBe(VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED);
    expect(
      new TreasureWinnerSelectedEvent({
        ...BASE,
        algorithm: 'RANDOM',
        algorithmVersion: 1,
        eligibleCount: 9,
        candidateCount: 50,
        winners: [],
      }).name,
    ).toBe(VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED);
    expect(
      new TreasureRewardDistributedEvent({ ...BASE, userId: 'u1', amount: 500, walletTxnId: 'w1' })
        .name,
    ).toBe(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED);
    expect(new TreasureClosedEvent({ ...BASE, status: 'CLOSED', closedBy: 'u1' }).name).toBe(
      VIDEO_ROOM_TREASURE_EVENTS.CLOSED,
    );
  });
});
