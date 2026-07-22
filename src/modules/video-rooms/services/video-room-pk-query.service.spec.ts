import { HttpStatus } from '@nestjs/common';
import {
  VideoRoomPkBattle,
  VideoRoomPkMode,
  VideoRoomPkParticipant,
  VideoRoomPkSide,
  VideoRoomPkStatus,
  VideoRoomPkTeam,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPkQueryService } from './video-room-pk-query.service';

const ACTOR: RoomActor = { id: 'u1', roles: [] };

function battle(overrides: Partial<VideoRoomPkBattle> = {}): VideoRoomPkBattle {
  return {
    id: 'battle-1',
    roomId: 'r1',
    mode: VideoRoomPkMode.ONE_VS_ONE,
    status: VideoRoomPkStatus.LIVE,
    createdBy: 'owner-1',
    countdownSeconds: 10,
    durationSeconds: 300,
    startedAt: new Date('2026-07-22T10:00:00.000Z'),
    endsAt: new Date('2026-07-22T10:05:00.000Z'),
    pausedAt: null,
    totalPausedMs: 0,
    resumeSeq: 0,
    scoringSnapshot: {},
    rewardSnapshot: {},
    winningTeamId: null,
    isDraw: false,
    completedAt: null,
    cancelledAt: null,
    failureReason: null,
    createdAt: new Date('2026-07-22T09:00:00.000Z'),
    updatedAt: new Date('2026-07-22T09:00:00.000Z'),
    ...overrides,
  } as VideoRoomPkBattle;
}

function team(overrides: Partial<VideoRoomPkTeam> = {}): VideoRoomPkTeam {
  return {
    id: 'team-red',
    battleId: 'battle-1',
    roomId: 'r1',
    side: VideoRoomPkSide.RED,
    score: 100n,
    giftCount: 3,
    createdAt: new Date('2026-07-22T09:00:00.000Z'),
    ...overrides,
  };
}

function participant(overrides: Partial<VideoRoomPkParticipant> = {}): VideoRoomPkParticipant {
  return {
    id: 'p1',
    battleId: 'battle-1',
    teamId: 'team-red',
    roomId: 'r1',
    userId: 'u1',
    side: VideoRoomPkSide.RED,
    score: 60n,
    giftCount: 2,
    joinedAt: new Date('2026-07-22T09:00:00.000Z'),
    ...overrides,
  };
}

describe('VideoRoomPkQueryService', () => {
  let repo: {
    findCurrent: jest.Mock;
    listTeams: jest.Mock;
    listParticipants: jest.Mock;
    listBattles: jest.Mock;
    statistics: jest.Mock;
  };
  let rooms: { findById: jest.Mock };
  let permissions: { assertPermission: jest.Mock };
  let redis: { hgetall: jest.Mock };

  beforeEach(() => {
    repo = {
      findCurrent: jest.fn().mockResolvedValue(battle()),
      listTeams: jest
        .fn()
        .mockResolvedValue([
          team({ id: 'team-red', side: VideoRoomPkSide.RED, score: 100n }),
          team({ id: 'team-blue', side: VideoRoomPkSide.BLUE, score: 80n }),
        ]),
      listParticipants: jest.fn().mockResolvedValue([participant()]),
      listBattles: jest.fn().mockResolvedValue([[], 0]),
      statistics: jest.fn().mockResolvedValue({
        totalBattles: 0,
        totalWins: 0,
        totalDraws: 0,
        totalContributed: 0n,
        totalGiftCount: 0,
      }),
    };
    rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner-1' }) };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    redis = { hgetall: jest.fn().mockResolvedValue({}) };
  });

  function build(): VideoRoomPkQueryService {
    return new VideoRoomPkQueryService(
      repo as never,
      rooms as never,
      permissions as never,
      redis as never,
    );
  }

  describe('getCurrent', () => {
    it('returns { active: false } when the room has no battle', async () => {
      repo.findCurrent.mockResolvedValue(null);

      const out = await build().getCurrent('r1');

      expect(out.active).toBe(false);
      expect(out.id).toBeUndefined();
      expect(out.teams).toBeUndefined();
      expect(repo.listTeams).not.toHaveBeenCalled();
    });

    // Late join: the client needs the server's clock to correct its own skew.
    it('includes serverTime so a late joiner can correct clock skew', async () => {
      const out = await build().getCurrent('r1');
      expect(out.serverTime).toBeDefined();
      expect(Date.parse(out.serverTime!)).not.toBeNaN();
    });

    // Nothing writes a per-room late-join state key (Task 13's mirror only
    // writes pkScoreKey(battleId), which carries no roomId) — so getCurrent
    // must never assume such a key exists. This is the "cold Redis"
    // resolution: the mirror is an OPTIONAL accelerator for live team scores
    // only; status/timing always come from Postgres via findCurrent.
    it('reads live scores from the Redis mirror when present', async () => {
      redis.hgetall.mockResolvedValue({
        RED: '999',
        BLUE: '111',
        giftCount: '5',
        baseTotal: '1000',
      });

      const out = await build().getCurrent('r1');

      expect(redis.hgetall).toHaveBeenCalledWith('video-room:pk:score:battle-1');
      const red = out.teams!.find((t) => t.side === VideoRoomPkSide.RED);
      const blue = out.teams!.find((t) => t.side === VideoRoomPkSide.BLUE);
      expect(red!.score).toBe(999);
      expect(blue!.score).toBe(111);
    });

    it('falls back to Postgres when the mirror is cold', async () => {
      redis.hgetall.mockResolvedValue({});

      const out = await build().getCurrent('r1');

      const red = out.teams!.find((t) => t.side === VideoRoomPkSide.RED);
      const blue = out.teams!.find((t) => t.side === VideoRoomPkSide.BLUE);
      expect(red!.score).toBe(100); // the Postgres value from the team() fixture
      expect(blue!.score).toBe(80);
    });

    // A Redis fault must degrade to the Postgres path, never fail the read.
    it('falls back to Postgres when the Redis mirror read throws', async () => {
      redis.hgetall.mockRejectedValue(new Error('redis down'));

      const out = await build().getCurrent('r1');

      expect(out.teams!.find((t) => t.side === VideoRoomPkSide.RED)!.score).toBe(100);
    });

    it('converts BigInt scores to Number at the boundary', async () => {
      const out = await build().getCurrent('r1');
      expect(typeof out.teams![0].score).toBe('number');
    });

    // Every numeric field, not just one — a single passing assertion on
    // teams[0].score would miss a BigInt left behind on participants or on
    // the battle's own countdown/duration columns.
    it('returns every numeric field as a real number, never BigInt or a numeric string', async () => {
      const out = await build().getCurrent('r1');

      expect(typeof out.countdownSeconds).toBe('number');
      expect(typeof out.durationSeconds).toBe('number');
      for (const t of out.teams!) expect(typeof t.score).toBe('number');
      for (const p of out.participants!) {
        expect(typeof p.score).toBe('number');
        expect(typeof p.giftCount).toBe('number');
      }
      expect(() => JSON.stringify(out)).not.toThrow();
    });
  });

  describe('history', () => {
    it('history returns only terminal battles', async () => {
      // Defence in depth: even if the repository mock (standing in for a
      // WHERE-clause regression) hands back a live battle, the service must
      // never surface it in "past battles".
      const rows = [
        battle({ id: 'b-completed', status: VideoRoomPkStatus.COMPLETED }),
        battle({ id: 'b-live', status: VideoRoomPkStatus.LIVE }),
      ];
      repo.listBattles.mockResolvedValue([rows, 2]);

      const out = await build().history(ACTOR, 'r1', { page: 1, limit: 20 });

      expect(out.items.map((i) => i.id)).toEqual(['b-completed']);
    });

    it('history paginates via buildPaginated', async () => {
      const rows = [battle({ id: 'b1', status: VideoRoomPkStatus.COMPLETED })];
      repo.listBattles.mockResolvedValue([rows, 45]);

      const out = await build().history(ACTOR, 'r1', { page: 2, limit: 20 });

      expect(repo.listBattles).toHaveBeenCalledWith('r1', 20, 20);
      expect(out).toEqual({
        items: [expect.objectContaining({ id: 'b1' })],
        total: 45,
        page: 2,
        limit: 20,
        totalPages: 3,
      });
    });
  });

  describe('statistics', () => {
    it('statistics requires VIEW_ANALYTICS', async () => {
      permissions.assertPermission.mockRejectedValue(
        new BusinessException(
          ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
          'not allowed',
          HttpStatus.FORBIDDEN,
        ),
      );

      await expect(build().statistics(ACTOR, 'r1')).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        ACTOR,
        { id: 'r1', ownerId: 'owner-1' },
        VideoRoomPermission.VIEW_ANALYTICS,
      );
    });

    it('converts BigInt totalContributed to Number at the boundary', async () => {
      repo.statistics.mockResolvedValue({
        totalBattles: 3,
        totalWins: 2,
        totalDraws: 1,
        totalContributed: 12_345n,
        totalGiftCount: 10,
      });

      const out = await build().statistics(ACTOR, 'r1');

      expect(out).toEqual({
        totalBattles: 3,
        totalWins: 2,
        totalDraws: 1,
        totalContributed: 12_345,
        totalGiftCount: 10,
      });
      expect(typeof out.totalContributed).toBe('number');
    });
  });
});
