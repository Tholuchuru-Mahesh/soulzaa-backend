import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VideoRoomPkSocketListener } from './video-room-pk-socket.listener';

const BASE = { roomId: 'r1', battleId: 'b1' };

describe('VideoRoomPkSocketListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let sockets: { emitToNamespaceRoom: jest.Mock; emitToUserEverywhere: jest.Mock };
  let listener: VideoRoomPkSocketListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });
  const emitted = () => sockets.emitToNamespaceRoom.mock.calls.map((c) => c[2] as string);

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = {
      handlers,
      subscribe: jest.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    listener = new VideoRoomPkSocketListener(bus as never, sockets as never);
    listener.onModuleInit();
  });

  it('relays all 11 outbound socket events', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(11);
  });

  // PkCreatedEvent fires before anyone is invited — broadcasting it would tell
  // clients a battle exists that they cannot yet act on.
  it('does not relay PkCreatedEvent to sockets', () => {
    const names = bus.subscribe.mock.calls.map((c) => c[0]);
    expect(names).not.toContain(VIDEO_ROOM_PK_EVENTS.CREATED);
    expect(bus.handlers.has(VIDEO_ROOM_PK_EVENTS.CREATED)).toBe(false);
  });

  it('emits to the room channel on the /video-room namespace', () => {
    fire(VIDEO_ROOM_PK_EVENTS.STARTED, {
      ...BASE,
      mode: 'ONE_VS_ONE',
      countdownSeconds: 5,
      durationSeconds: 300,
      startedAt: '2026-07-22T00:00:00.000Z',
      endsAt: '2026-07-22T00:05:05.000Z',
      teams: [],
      participants: [],
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'r1',
      'pkStarted',
      expect.objectContaining({ battleId: 'b1' }),
    );
  });

  it('maps each relayed event to exactly the right socket event(s)', () => {
    const cases: [string, object, string[]][] = [
      [
        VIDEO_ROOM_PK_EVENTS.INVITATION_SENT,
        {
          ...BASE,
          invitationId: 'i1',
          inviteeUserId: 'u1',
          inviterUserId: 'u2',
          side: 'RED',
          attempt: 1,
          expiresAt: '2026-07-22T00:05:00.000Z',
        },
        ['pkInvitationSent'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED,
        { ...BASE, invitationId: 'i1', inviteeUserId: 'u1' },
        ['pkInvitationAccepted'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED,
        { ...BASE, invitationId: 'i1', inviteeUserId: 'u1' },
        ['pkInvitationRejected'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.STARTED,
        {
          ...BASE,
          mode: 'ONE_VS_ONE',
          countdownSeconds: 5,
          durationSeconds: 300,
          startedAt: '2026-07-22T00:00:00.000Z',
          endsAt: '2026-07-22T00:05:05.000Z',
          teams: [],
          participants: [],
        },
        ['pkStarted', 'pkCountdown'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED,
        {
          ...BASE,
          side: 'RED',
          teams: [],
          participantId: 'p1',
          userId: 'u1',
          scoredAmount: 100,
          multiplierBps: 10_000,
        },
        ['pkScoreUpdated'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.PAUSED,
        { ...BASE, pausedAt: '2026-07-22T00:01:00.000Z', remainingMs: 1000, involuntary: false },
        ['pkPaused'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.RESUMED,
        {
          ...BASE,
          resumedAt: '2026-07-22T00:01:05.000Z',
          endsAt: '2026-07-22T00:06:00.000Z',
          resumeSeq: 1,
        },
        ['pkResumed'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.ENDED,
        {
          ...BASE,
          winningTeamId: 't1',
          isDraw: false,
          teams: [],
          durationSeconds: 300,
          giftCount: 10,
          totalBase: 1000,
        },
        ['pkEnded'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED,
        { ...BASE, winningTeamId: 't1', isDraw: false, winners: ['u1'] },
        ['pkWinner'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED,
        { ...BASE, poolAmount: 1000, allocatedAmount: 900, rewards: [] },
        ['pkWinner'],
      ],
      [
        VIDEO_ROOM_PK_EVENTS.RECOVERED,
        { ...BASE, reason: 'HOST_RETURNED', previousStatus: 'RECOVERING', newStatus: 'LIVE' },
        ['pkRecovered'],
      ],
    ];
    for (const [busEvent, payload, expected] of cases) {
      sockets.emitToNamespaceRoom.mockClear();
      fire(busEvent, payload);
      expect(emitted()).toEqual(expected);
    }
  });

  // A payout must reach a winner even if they navigated away from the room —
  // the VR-11 treasure precedent.
  it('tells every reward recipient about their reward wherever they are', () => {
    fire(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, {
      ...BASE,
      poolAmount: 1000,
      allocatedAmount: 900,
      rewards: [
        { userId: 'u1', kind: 'WINNER', amount: 600 },
        { userId: 'u2', kind: 'WINNER', amount: 300 },
      ],
    });
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      'pkWinner',
      expect.objectContaining({ battleId: 'b1' }),
    );
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u2',
      'pkWinner',
      expect.objectContaining({ battleId: 'b1' }),
    );
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledTimes(2);
  });
});
