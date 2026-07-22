import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomTreasureSocketListener } from './video-room-treasure-socket.listener';

const BASE = { correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1 };

describe('VideoRoomTreasureSocketListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let sockets: { emitToNamespaceRoom: jest.Mock; emitToUserEverywhere: jest.Mock };
  let listener: VideoRoomTreasureSocketListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });
  const emitted = () => sockets.emitToNamespaceRoom.mock.calls.map((c) => c[2] as string);

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = {
      handlers,
      subscribe: jest.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    listener = new VideoRoomTreasureSocketListener(bus as never, sockets as never);
    listener.onModuleInit();
  });

  it('subscribes to every treasure event that has a socket counterpart', () => {
    for (const name of [
      VIDEO_ROOM_TREASURE_EVENTS.STARTED,
      VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED,
      VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED,
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED,
      VIDEO_ROOM_TREASURE_EVENTS.RECOVERED,
    ]) {
      expect(bus.subscribe).toHaveBeenCalledWith(name, expect.any(Function));
    }
  });

  // REWARD_GENERATED fires when the pool is MINTED, before anyone is paid, and
  // carries {strategy, poolAmount} rather than {userId, amount}. Bridging it to
  // treasureRewardDistributed announced a payout that had not happened.
  it('does not bridge the pool-generated event to any socket event', () => {
    expect(bus.handlers.has(VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED)).toBe(false);
  });

  // Pins the exact bus-event -> socket-event mapping. The previous suite only
  // asserted that a subscription existed, which let a wrong mapping pass.
  it('maps each bridged event to exactly the right socket event', () => {
    const cases: [string, object, string[]][] = [
      [
        VIDEO_ROOM_TREASURE_EVENTS.STARTED,
        { ...BASE, startedBy: 'u1', threshold: 1 },
        ['treasureLevelChanged'],
      ],
      [
        VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED,
        {
          ...BASE,
          algorithm: 'RANDOM',
          algorithmVersion: 1,
          eligibleCount: 1,
          candidateCount: 1,
          winners: [],
        },
        ['treasureWinnerSelected'],
      ],
      [
        VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
        { ...BASE, userId: 'u1', amount: 1, walletTxnId: 'w1' },
        ['treasureRewardDistributed'],
      ],
      [
        VIDEO_ROOM_TREASURE_EVENTS.RECOVERED,
        { ...BASE, reason: 'ORPHAN_RECLAIM', attempt: 1 },
        ['treasureRecovered'],
      ],
    ];
    for (const [busEvent, payload, expected] of cases) {
      sockets.emitToNamespaceRoom.mockClear();
      fire(busEvent, payload);
      expect(emitted()).toEqual(expected);
    }
  });

  it('broadcasts progress to the room on the /video-room namespace', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, {
      ...BASE,
      progress: 500,
      threshold: 15_000,
      percent: 3.33,
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'treasureProgressUpdated',
      expect.objectContaining({ level: 1, progress: 500 }),
    );
  });

  // One unlock produces BOTH the data event and the animation trigger, so a
  // client that only drives visuals need not parse the payload event.
  it('emits treasureUnlocked, treasureAnimation and treasureLevelChanged for one unlock', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      ...BASE,
      poolAmount: 1500,
      winners: [],
      algorithm: 'RANDOM',
      nextLevel: 2,
    });
    expect(emitted()).toEqual(['treasureUnlocked', 'treasureAnimation', 'treasureLevelChanged']);
  });

  it('does not emit treasureLevelChanged when the ladder just completed', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      ...BASE,
      level: 4,
      poolAmount: 35_000,
      winners: [],
      algorithm: 'RANDOM',
      nextLevel: null,
    });
    expect(emitted()).toEqual(['treasureUnlocked', 'treasureAnimation']);
  });

  it('includes the winner count on the animation payload', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      ...BASE,
      poolAmount: 1500,
      winners: [{ userId: 'u1', amount: 500, shareBps: 3333 }],
      algorithm: 'RANDOM',
      nextLevel: null,
    });
    const animation = sockets.emitToNamespaceRoom.mock.calls.find(
      (c) => c[2] === 'treasureAnimation',
    );
    expect(animation![3]).toEqual(expect.objectContaining({ winnerCount: 1, poolAmount: 1500 }));
  });

  // A payout must land even if the winner navigated away from the room.
  it('tells a winner about their reward wherever they are', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED, {
      ...BASE,
      userId: 'u9',
      amount: 500,
      walletTxnId: 'w1',
    });
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u9',
      'treasureRewardDistributed',
      expect.objectContaining({ userId: 'u9', amount: 500 }),
    );
  });

  it('carries the correlationId onto every socket payload', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED, {
      ...BASE,
      algorithm: 'RANDOM',
      algorithmVersion: 1,
      eligibleCount: 9,
      candidateCount: 50,
      winners: [],
    });
    expect(sockets.emitToNamespaceRoom.mock.calls[0][3]).toEqual(
      expect.objectContaining({ correlationId: 'c1' }),
    );
  });

  // Throttling already happened upstream in onSend; re-throttling here could
  // silently drop a threshold crossing.
  it('does not throttle — it relays whatever reaches the bus', () => {
    const payload = { ...BASE, progress: 1, threshold: 2, percent: 50 };
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, payload);
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, payload);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('relays a recovery to the room', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.RECOVERED, {
      ...BASE,
      reason: 'ORPHAN_RECLAIM',
      attempt: 1,
    });
    expect(emitted()).toEqual(['treasureRecovered']);
  });
});
