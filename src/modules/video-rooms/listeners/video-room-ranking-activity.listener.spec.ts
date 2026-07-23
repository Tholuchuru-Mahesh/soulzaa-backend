import { Logger } from '@nestjs/common';
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomRankingActivityListener } from './video-room-ranking-activity.listener';

/**
 * The brief this task was written from assumed three event shapes that don't
 * match the real declarations:
 *
 *  - `PkEndedEvent`'s payload has no `participants` field (only
 *    `PkStartedEvent` does) — this listener reads them back from
 *    `VideoRoomPkRepository.listParticipants` instead of widening a shipped
 *    event.
 *  - `TreasureRewardDistributedEvent`'s payload is `{ userId, amount,
 *    walletTxnId }` — ONE winner, not a `winners: [...]` array. The unlock
 *    service already publishes it once per recipient, so "one win per
 *    recipient" is exercised here as two separate deliveries.
 *  - `RoomClosedEvent`'s payload has no `sessionId` — only `roomId, actorId,
 *    ownerId, durationSeconds`.
 *
 * Every fixture below matches the real declarations, not the brief.
 */
describe('VideoRoomRankingActivityListener', () => {
  let handlers: Record<string, (e: unknown) => unknown>;
  let bus: { subscribe: jest.Mock };
  let rankings: {
    recordGift: jest.Mock;
    recordPkResult: jest.Mock;
    recordTreasureWin: jest.Mock;
    recordRoomActivity: jest.Mock;
  };
  let seats: { getSnapshot: jest.Mock };
  let pkRepo: { listParticipants: jest.Mock };
  let listener: VideoRoomRankingActivityListener;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  const fire = (
    name: string,
    payload: object,
    meta: { eventId?: string; occurredAt?: string } = {},
  ) =>
    handlers[name]({
      payload,
      eventId: meta.eventId ?? 'evt-1',
      occurredAt: meta.occurredAt ?? '2026-07-22T14:35:00.000Z',
    });

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, h: (e: unknown) => unknown) => {
        handlers[name] = h;
        return () => undefined;
      }),
    };
    rankings = {
      recordGift: jest.fn().mockResolvedValue(undefined),
      recordPkResult: jest.fn().mockResolvedValue(undefined),
      recordTreasureWin: jest.fn().mockResolvedValue(undefined),
      recordRoomActivity: jest.fn().mockResolvedValue(undefined),
    };
    seats = {
      getSnapshot: jest.fn().mockResolvedValue({
        roomId: 'room-1',
        version: 1,
        updatedAt: '2026-07-22T00:00:00.000Z',
        hostSeatCount: 1,
        guestSeatCount: 0,
        seats: [{ seatIndex: 0, occupantUserId: 'r1', status: 'OCCUPIED' }],
      }),
    };
    pkRepo = { listParticipants: jest.fn().mockResolvedValue([]) };
    listener = new VideoRoomRankingActivityListener(
      bus as never,
      rankings as never,
      seats as never,
      pkRepo as never,
    );
    listener.onModuleInit();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const giftPayload = (over: Record<string, unknown> = {}) => ({
    transactionId: 'txn-1',
    senderId: 's1',
    receiverId: 'r1',
    giftId: 'g1',
    giftType: 'NORMAL',
    giftName: 'Rose',
    contextType: 'VIDEO_ROOM',
    contextId: 'room-1',
    quantity: 1,
    comboTier: 0,
    unitCoinValue: 100,
    totalCoinValue: 100,
    creatorEarnings: 80,
    luckyMultiplier: 1,
    isLuckyWin: false,
    senderExp: 10,
    receiverExp: 5,
    createdAt: '2026-07-22T14:35:00.000Z',
    ...over,
  });

  it('subscribes to every source event exactly once (and never to gift.refunded)', () => {
    expect(Object.keys(handlers).sort()).toEqual(
      [
        GIFT_EVENTS.SENT,
        VIDEO_ROOM_PK_EVENTS.ENDED,
        VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
        VIDEO_ROOM_EVENTS.CLOSED,
      ].sort(),
    );
    expect(handlers[GIFT_EVENTS.REFUNDED]).toBeUndefined();
  });

  describe('gift.sent', () => {
    it('records a VIDEO_ROOM gift with the receiver seat state', async () => {
      await fire(GIFT_EVENTS.SENT, giftPayload());
      expect(rankings.recordGift).toHaveBeenCalledWith({
        transactionId: 'txn-1',
        roomId: 'room-1',
        senderId: 's1',
        receiverId: 'r1',
        totalCoinValue: 100,
        quantity: 1,
        receiverIsSeated: true,
        occurredAt: new Date('2026-07-22T14:35:00.000Z'),
      });
    });

    it('ignores gifts from every other context', async () => {
      for (const contextType of ['AUDIO_ROOM', 'LIVE_STREAM', 'PRIVATE_CHAT']) {
        await fire(GIFT_EVENTS.SENT, giftPayload({ contextType }));
      }
      expect(rankings.recordGift).not.toHaveBeenCalled();
      expect(seats.getSnapshot).not.toHaveBeenCalled();
    });

    it('marks the receiver unseated when they hold no seat in the snapshot', async () => {
      seats.getSnapshot.mockResolvedValue({
        roomId: 'room-1',
        version: 1,
        updatedAt: '2026-07-22T00:00:00.000Z',
        hostSeatCount: 1,
        guestSeatCount: 0,
        seats: [{ seatIndex: 0, occupantUserId: 'someone-else', status: 'OCCUPIED' }],
      });
      await fire(GIFT_EVENTS.SENT, giftPayload());
      expect(rankings.recordGift.mock.calls[0][0].receiverIsSeated).toBe(false);
    });

    it('marks the receiver unseated when the snapshot is cold', async () => {
      seats.getSnapshot.mockResolvedValue(null);
      await fire(GIFT_EVENTS.SENT, giftPayload());
      expect(rankings.recordGift.mock.calls[0][0].receiverIsSeated).toBe(false);
    });

    it('treats an unavailable seat lookup as unseated rather than failing', async () => {
      seats.getSnapshot.mockRejectedValue(new Error('redis down'));
      await fire(GIFT_EVENTS.SENT, giftPayload());
      expect(rankings.recordGift.mock.calls[0][0].receiverIsSeated).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('swallows a downstream failure so the gift flow is unaffected', async () => {
      rankings.recordGift.mockRejectedValue(new Error('boom'));
      await expect(fire(GIFT_EVENTS.SENT, giftPayload())).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('never throws even when the rejection reason is undefined', async () => {
      // A subscriber that does `throw undefined` / an empty `Promise.reject()`
      // must not turn a swallow-and-log catch into a NEW throw via a bare
      // `(err as Error).message` — this is what `errorMessage` exists to
      // prevent.
      rankings.recordGift.mockRejectedValue(undefined);
      await expect(fire(GIFT_EVENTS.SENT, giftPayload())).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('pk.ended', () => {
    const endedPayload = {
      battleId: 'b1',
      roomId: 'room-1',
      winningTeamId: 't1',
      isDraw: false,
      teams: [
        { teamId: 't1', side: 'RED', score: 900 },
        { teamId: 't2', side: 'BLUE', score: 400 },
      ],
      durationSeconds: 300,
      giftCount: 10,
      totalBase: 1300,
    };

    it("reads participants from the PK repository (absent from the shipped event) and maps team outcomes to per-user win/loss, scored from EACH PARTICIPANT'S OWN score (ONE_VS_ONE: own-score == team-score)", async () => {
      pkRepo.listParticipants.mockResolvedValue([
        { userId: 'w', teamId: 't1', side: 'RED', score: 900n },
        { userId: 'l', teamId: 't2', side: 'BLUE', score: 400n },
      ]);
      await fire(VIDEO_ROOM_PK_EVENTS.ENDED, endedPayload);
      expect(pkRepo.listParticipants).toHaveBeenCalledWith('b1');
      expect(rankings.recordPkResult.mock.calls[0][0].outcomes).toEqual([
        { userId: 'w', won: true, lost: false, score: 900 },
        { userId: 'l', won: false, lost: true, score: 400 },
      ]);
    });

    /**
     * The lambda design's whole premise: the write path here and the
     * recompute path (`aggregatePkOutcomes` → `entry.score += p.score`) MUST
     * produce the same number for the same window. The recompute sums each
     * participant's OWN `VideoRoomPkParticipant.score` — never the team
     * total, which is the SUM of its participants' scores. A TEAM battle
     * (`VideoRoomPkMode.TEAM`) is the only case where "own score" and "team
     * score" diverge, since ONE_VS_ONE has exactly one participant per team.
     *
     * This test FAILS against the pre-fix code, which credited every
     * participant with `scoreByTeam.get(participant.teamId)` — the whole
     * team's score — regardless of that participant's own contribution.
     * With two teammates on the winning team scoring 700 and 200 (team total
     * 900), the old code emitted `score: 900` for BOTH of them (1800 total
     * credited vs. 900 actually earned); the fix emits each participant's
     * own 700 / 200.
     */
    it('TEAM mode: credits each participant with THEIR OWN score, not the team total', async () => {
      pkRepo.listParticipants.mockResolvedValue([
        { userId: 'w1', teamId: 't1', side: 'RED', score: 700n },
        { userId: 'w2', teamId: 't1', side: 'RED', score: 200n },
        { userId: 'l1', teamId: 't2', side: 'BLUE', score: 150n },
        { userId: 'l2', teamId: 't2', side: 'BLUE', score: 250n },
      ]);
      await fire(VIDEO_ROOM_PK_EVENTS.ENDED, {
        ...endedPayload,
        teams: [
          { teamId: 't1', side: 'RED', score: 900 },
          { teamId: 't2', side: 'BLUE', score: 400 },
        ],
      });
      expect(rankings.recordPkResult.mock.calls[0][0].outcomes).toEqual([
        { userId: 'w1', won: true, lost: false, score: 700 },
        { userId: 'w2', won: true, lost: false, score: 200 },
        { userId: 'l1', won: false, lost: true, score: 150 },
        { userId: 'l2', won: false, lost: true, score: 250 },
      ]);
    });

    it('records a draw as neither win nor loss', async () => {
      pkRepo.listParticipants.mockResolvedValue([
        { userId: 'a', teamId: 't1', side: 'RED', score: 500n },
      ]);
      await fire(VIDEO_ROOM_PK_EVENTS.ENDED, {
        ...endedPayload,
        winningTeamId: null,
        isDraw: true,
        teams: [{ teamId: 't1', side: 'RED', score: 500 }],
      });
      expect(rankings.recordPkResult.mock.calls[0][0].outcomes[0]).toEqual({
        userId: 'a',
        won: false,
        lost: false,
        score: 500,
      });
    });

    it('does not record when the battle has no participants', async () => {
      pkRepo.listParticipants.mockResolvedValue([]);
      await fire(VIDEO_ROOM_PK_EVENTS.ENDED, endedPayload);
      expect(rankings.recordPkResult).not.toHaveBeenCalled();
    });

    it('swallows a downstream failure', async () => {
      pkRepo.listParticipants.mockRejectedValue(new Error('db down'));
      await expect(fire(VIDEO_ROOM_PK_EVENTS.ENDED, endedPayload)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('treasure.reward_distributed', () => {
    const winnerPayload = (over: Record<string, unknown> = {}) => ({
      correlationId: 'c1',
      roomId: 'room-1',
      sessionId: 's1',
      boxId: 'b1',
      userId: 'u1',
      amount: 100,
      walletTxnId: 'wtx-1',
      ...over,
    });

    it('records one win per recipient across separate deliveries, each with a unique dedupe id', async () => {
      // The real event fires once PER WINNER (see
      // VideoRoomTreasureUnlockService), not once per box with a `winners`
      // array — so "one win per recipient" is exercised as two deliveries.
      await fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED, winnerPayload({ userId: 'u1' }));
      await fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED, winnerPayload({ userId: 'u2' }));
      expect(rankings.recordTreasureWin).toHaveBeenCalledTimes(2);
      const ids = rankings.recordTreasureWin.mock.calls.map((c) => c[0].rewardId);
      expect(new Set(ids).size).toBe(2);
    });

    it('keys the dedupe id on boxId + userId', async () => {
      await fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED, winnerPayload());
      expect(rankings.recordTreasureWin).toHaveBeenCalledWith(
        expect.objectContaining({ rewardId: 'b1:u1', roomId: 'room-1', userId: 'u1', amount: 100 }),
      );
    });

    it('falls back to correlationId when boxId is absent', async () => {
      await fire(
        VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
        winnerPayload({ boxId: undefined }),
      );
      expect(rankings.recordTreasureWin.mock.calls[0][0].rewardId).toBe('c1:u1');
    });

    it('swallows a downstream failure', async () => {
      rankings.recordTreasureWin.mockRejectedValue(new Error('boom'));
      await expect(
        fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED, winnerPayload()),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('video_room.closed', () => {
    const closedPayload = {
      roomId: 'room-1',
      actorId: 'owner-1',
      ownerId: 'owner-1',
      durationSeconds: 3600,
    };

    it('records a room-activity tick keyed by the event id', async () => {
      await fire(VIDEO_ROOM_EVENTS.CLOSED, closedPayload, { eventId: 'evt-close-1' });
      expect(rankings.recordRoomActivity).toHaveBeenCalledWith({
        activityId: expect.stringContaining('evt-close-1'),
        roomId: 'room-1',
        occurredAt: new Date('2026-07-22T14:35:00.000Z'),
      });
    });

    it('never forwards durationSeconds as avgWatchSeconds — room uptime is not per-viewer watch time', async () => {
      await fire(VIDEO_ROOM_EVENTS.CLOSED, closedPayload, { eventId: 'evt-close-1' });
      const input = rankings.recordRoomActivity.mock.calls[0][0];
      expect(input.avgWatchSeconds).toBeUndefined();
      expect(input).not.toHaveProperty('avgWatchSeconds');
    });

    it('swallows a downstream failure', async () => {
      rankings.recordRoomActivity.mockRejectedValue(new Error('boom'));
      await expect(fire(VIDEO_ROOM_EVENTS.CLOSED, closedPayload)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
