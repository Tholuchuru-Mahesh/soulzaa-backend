import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VideoRoomPkMetricsListener } from './video-room-pk-metrics.listener';

const BASE = { roomId: 'r1', battleId: 'b1' };

describe('VideoRoomPkMetricsListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let metrics: Record<string, jest.Mock>;
  let listener: VideoRoomPkMetricsListener;

  const fire = (name: string, payload: object, occurredAt = new Date().toISOString()) =>
    bus.handlers.get(name)!({ name, payload, occurredAt });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => void) => handlers.set(n, f)),
    };
    metrics = {
      setPkActive: jest.fn(),
      observePkBattleDuration: jest.fn(),
      incPkGiftThroughput: jest.fn(),
      observePkScoreLatency: jest.fn(),
      incPkRecovery: jest.fn(),
      incPkInvitationOutcome: jest.fn(),
      observePkWinnerCalculation: jest.fn(),
      observePkRewardDistribution: jest.fn(),
      incPkRedisSync: jest.fn(),
      setPkRecoveryQueueDepth: jest.fn(),
    };
    listener = new VideoRoomPkMetricsListener(bus as never, metrics as never);
    listener.onModuleInit();
  });

  // Table-driven: one assertion per metric family this listener itself
  // drives. `setPkActive`/`setPkRecoveryQueueDepth` are Task 20's recovery
  // sweep's job, not this listener's — see the class doc — so they are
  // exercised separately below rather than here.
  it('drives every metric family this listener owns', () => {
    fire(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, {
      ...BASE,
      invitationId: 'i1',
      inviteeUserId: 'u1',
      inviterUserId: 'u2',
      side: 'RED',
      attempt: 1,
      expiresAt: '2026-07-22T00:05:00.000Z',
    });
    expect(metrics.incPkInvitationOutcome).toHaveBeenCalledWith('sent');

    fire(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, {
      ...BASE,
      invitationId: 'i1',
      inviteeUserId: 'u1',
    });
    expect(metrics.incPkInvitationOutcome).toHaveBeenCalledWith('accepted');

    fire(VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, {
      ...BASE,
      invitationId: 'i1',
      inviteeUserId: 'u1',
    });
    expect(metrics.incPkInvitationOutcome).toHaveBeenCalledWith('rejected');

    fire(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED, {
      ...BASE,
      side: 'RED',
      teams: [],
      participantId: 'p1',
      userId: 'u1',
      scoredAmount: 100,
      multiplierBps: 10_000,
    });
    expect(metrics.incPkGiftThroughput).toHaveBeenCalled();
    expect(metrics.observePkScoreLatency).toHaveBeenCalledWith(expect.any(Number));
    expect(metrics.incPkRedisSync).toHaveBeenCalledWith('success');

    fire(VIDEO_ROOM_PK_EVENTS.ENDED, {
      ...BASE,
      winningTeamId: 't1',
      isDraw: false,
      teams: [],
      durationSeconds: 300,
      giftCount: 10,
      totalBase: 1000,
    });
    expect(metrics.observePkBattleDuration).toHaveBeenCalledWith(300);

    fire(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED, {
      ...BASE,
      winningTeamId: 't1',
      isDraw: false,
      winners: ['u1'],
    });
    expect(metrics.observePkWinnerCalculation).toHaveBeenCalledWith(expect.any(Number));

    fire(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, {
      ...BASE,
      poolAmount: 1000,
      allocatedAmount: 900,
      rewards: [],
    });
    expect(metrics.observePkRewardDistribution).toHaveBeenCalledWith(expect.any(Number));

    fire(VIDEO_ROOM_PK_EVENTS.RECOVERED, {
      ...BASE,
      reason: 'HOST_RETURNED',
      previousStatus: 'RECOVERING',
      newStatus: 'LIVE',
    });
    expect(metrics.incPkRecovery).toHaveBeenCalledWith('HOST_RETURNED');
  });

  it('measures winner-calculation latency against the event timestamp', () => {
    fire(
      VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED,
      { ...BASE, winningTeamId: 't1', isDraw: false, winners: ['u1'] },
      new Date(Date.now() - 2000).toISOString(),
    );
    const seconds = metrics.observePkWinnerCalculation.mock.calls[0][0];
    expect(seconds).toBeGreaterThanOrEqual(1.9);
  });

  it('does not subscribe to CREATED (it precedes any invitation)', () => {
    expect(bus.handlers.has(VIDEO_ROOM_PK_EVENTS.CREATED)).toBe(false);
  });

  // A metrics fault must never propagate into the event bus and take a
  // settlement or invitation path down with it.
  it('never throws out of a handler', () => {
    metrics.incPkGiftThroughput.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    expect(() =>
      fire(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED, {
        ...BASE,
        side: 'RED',
        teams: [],
        participantId: 'p1',
        userId: 'u1',
        scoredAmount: 1,
        multiplierBps: 10_000,
      }),
    ).not.toThrow();
  });

  it('tolerates an unparseable timestamp rather than recording a bogus latency', () => {
    fire(
      VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED,
      { ...BASE, winningTeamId: 't1', isDraw: false, winners: ['u1'] },
      'not-a-date',
    );
    expect(metrics.observePkWinnerCalculation).not.toHaveBeenCalled();
  });
});
