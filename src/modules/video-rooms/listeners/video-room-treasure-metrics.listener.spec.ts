import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomTreasureMetricsListener } from './video-room-treasure-metrics.listener';

describe('VideoRoomTreasureMetricsListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let metrics: Record<string, jest.Mock>;
  let listener: VideoRoomTreasureMetricsListener;

  const fire = (name: string, payload: object, occurredAt = new Date().toISOString()) =>
    bus.handlers.get(name)!({ name, payload, occurredAt });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => void) => handlers.set(n, f)),
    };
    metrics = {
      setTreasureProgress: jest.fn(),
      incTreasureUnlock: jest.fn(),
      incTreasureFailure: jest.fn(),
      incTreasureMinted: jest.fn(),
      observeTreasureDistribution: jest.fn(),
    };
    listener = new VideoRoomTreasureMetricsListener(bus as never, metrics as never);
    listener.onModuleInit();
  });

  it('records progress as a gauge', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, {
      roomId: 'r1',
      level: 2,
      progress: 12_000,
    });
    expect(metrics.setTreasureProgress).toHaveBeenCalledWith('r1', 2, 12_000);
  });

  it('counts unlocks by level and algorithm', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      roomId: 'r1',
      level: 1,
      algorithm: 'RANDOM',
      poolAmount: 1500,
      winners: [],
    });
    expect(metrics.incTreasureUnlock).toHaveBeenCalledWith(1, 'RANDOM');
  });

  it('observes distribution latency against the 5s SLO histogram', () => {
    fire(
      VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED,
      { roomId: 'r1', level: 1, algorithm: 'RANDOM', poolAmount: 0, winners: [] },
      new Date(Date.now() - 2000).toISOString(),
    );
    expect(metrics.observeTreasureDistribution).toHaveBeenCalledWith(1, expect.any(Number));
    const seconds = metrics.observeTreasureDistribution.mock.calls[0][1];
    expect(seconds).toBeGreaterThanOrEqual(1.9);
  });

  it('counts minted GOLD by level and strategy — this is treasure revenue', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED, {
      roomId: 'r1',
      level: 1,
      strategy: 'PERCENTAGE',
      poolAmount: 1500,
      sourceAmount: 15_000,
      winnerCount: 3,
    });
    expect(metrics.incTreasureMinted).toHaveBeenCalledWith(1, 'PERCENTAGE', 1500);
  });

  // The stage label is the point: it makes a failure attributable to validation
  // vs eligibility vs the wallet without reading code.
  it('labels a failure with the pipeline stage that produced it', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED, {
      roomId: 'r1',
      level: 1,
      stage: 'DISTRIBUTION',
      attempt: 2,
      error: 'wallet timeout',
    });
    expect(metrics.incTreasureFailure).toHaveBeenCalledWith('DISTRIBUTION');
  });

  // A metrics fault must not take a payout path down with it.
  it('never throws out of a handler', () => {
    metrics.setTreasureProgress.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    expect(() =>
      fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, { roomId: 'r1', level: 1, progress: 1 }),
    ).not.toThrow();
  });

  it('tolerates an unparseable timestamp rather than recording a bogus latency', () => {
    fire(
      VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED,
      { roomId: 'r1', level: 1, algorithm: 'RANDOM', poolAmount: 0, winners: [] },
      'not-a-date',
    );
    expect(metrics.observeTreasureDistribution).not.toHaveBeenCalled();
  });
});
