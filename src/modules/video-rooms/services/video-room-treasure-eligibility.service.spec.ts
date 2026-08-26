import { VideoRoomTreasureEligibilityService } from './video-room-treasure-eligibility.service';
import type { TreasureLevelRules } from './video-room-treasure-pool.service';

const NOW = 1_700_000_000_000;

const rules = (over: Partial<TreasureLevelRules> = {}): TreasureLevelRules => ({
  level: 1,
  threshold: 15_000,
  poolStrategy: 'PERCENTAGE',
  poolPercentBps: 1000,
  poolFixedAmount: null,
  winnerAlgorithm: 'RANDOM',
  winnerCount: 3,
  minStaySeconds: 120,
  minActivityEvents: 0,
  ...over,
});

describe('VideoRoomTreasureEligibilityService', () => {
  let redis: Record<string, jest.Mock>;
  let repo: Record<string, jest.Mock>;
  let vip: { getEffectiveLevel: jest.Mock };
  let service: VideoRoomTreasureEligibilityService;

  const call = (over: Record<string, unknown> = {}) =>
    service.resolve({
      roomId: 'r1',
      sessionId: 's1',
      rules: rules(),
      want: 3,
      oversampleFactor: 3,
      oversampleMin: 50,
      ...over,
    } as never);

  beforeEach(() => {
    redis = {
      srandmember: jest.fn().mockResolvedValue([]),
      hmget: jest.fn().mockResolvedValue([]),
    };
    repo = {
      findEligibleMembers: jest.fn().mockResolvedValue([]),
      findBlockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    vip = { getEffectiveLevel: jest.fn().mockResolvedValue(0) };
    service = new VideoRoomTreasureEligibilityService(
      redis as never,
      repo as never,
      vip as never,
      () => NOW,
    );
  });

  describe('sampling', () => {
    it('oversamples to the configured floor, not just want*factor', async () => {
      await call();
      // max(3 * 3, 50) = 50 per presence set
      expect(redis.srandmember).toHaveBeenCalledWith(expect.stringContaining('viewers'), 50);
      expect(redis.srandmember).toHaveBeenCalledTimes(3);
    });

    it('uses want*factor when it exceeds the floor', async () => {
      await call({ want: 30, oversampleFactor: 3, oversampleMin: 50 });
      expect(redis.srandmember).toHaveBeenCalledWith(expect.anything(), 90);
    });

    it('samples all three presence sets', async () => {
      await call();
      const keys = redis.srandmember.mock.calls.map((c) => c[0] as string);
      expect(keys.some((k) => k.includes('viewers'))).toBe(true);
      expect(keys.some((k) => k.includes('participants'))).toBe(true);
      expect(keys.some((k) => k.includes('hosts'))).toBe(true);
    });

    it('dedupes users present in more than one presence set', async () => {
      redis.srandmember
        .mockResolvedValueOnce(['u1', 'u2'])
        .mockResolvedValueOnce(['u2'])
        .mockResolvedValueOnce(['u3']);
      repo.findEligibleMembers.mockResolvedValue(['u1', 'u2', 'u3']);
      const res = await call();
      expect(res.candidateCount).toBe(3);
      expect([...res.eligible].sort()).toEqual(['u1', 'u2', 'u3']);
    });

    it('survives a presence set returning null', async () => {
      redis.srandmember.mockResolvedValue(null);
      expect((await call()).eligible).toEqual([]);
    });
  });

  describe('filtering', () => {
    it('passes the min-stay cutoff to the repository rather than filtering in Node', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1']).mockResolvedValue([]);
      await call({ rules: rules({ minStaySeconds: 120 }) });
      expect(repo.findEligibleMembers).toHaveBeenCalledWith('r1', ['u1'], new Date(NOW - 120_000));
    });

    // A blocked user can still hold a stale presence entry, so the block list is
    // applied explicitly rather than trusting membership alone.
    it('excludes blocked users even when presence still lists them', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1', 'u2']);
      repo.findBlockedUserIds.mockResolvedValue(new Set(['u2']));
      expect((await call()).eligible).toEqual(['u1']);
    });

    it('never queries Postgres when the room is empty at unlock', async () => {
      const res = await call();
      expect(res.eligible).toEqual([]);
      expect(res.candidateCount).toBe(0);
      expect(repo.findEligibleMembers).not.toHaveBeenCalled();
      expect(repo.findBlockedUserIds).not.toHaveBeenCalled();
    });
  });

  describe('activity', () => {
    it('applies the activity floor when configured', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1', 'u2']);
      redis.hmget.mockResolvedValue(['5', '1']);
      expect((await call({ rules: rules({ minActivityEvents: 3 }) })).eligible).toEqual(['u1']);
    });

    it('treats a missing activity entry as zero', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1', 'u2']);
      redis.hmget.mockResolvedValue(['5', null]);
      expect((await call({ rules: rules({ minActivityEvents: 1 }) })).eligible).toEqual(['u1']);
    });

    // Reads the same HASH the progress service writes with HINCRBY. If these
    // ever diverge again, every count silently reads as zero.
    it('reads activity as one HMGET against the session hash', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1']);
      redis.hmget.mockResolvedValue(['7']);
      const res = await call({ rules: rules({ winnerAlgorithm: 'ACTIVITY_BASED' }) });
      expect(redis.hmget).toHaveBeenCalledWith('video-room:treasure:activity:r1:s1', 'u1');
      expect(res.activity.get('u1')).toBe(7);
    });

    // The common RANDOM draw must not pay for a round-trip it never reads.
    it('skips the activity fetch entirely when nothing needs it', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1']);
      await call();
      expect(redis.hmget).not.toHaveBeenCalled();
    });
  });

  describe('VIP tiers', () => {
    // Without this, VIP_PRIORITY receives an empty tier map and degenerates
    // into a plain uniform draw — the strategy would exist but do nothing.
    it('resolves VIP ordinals for a VIP_PRIORITY draw', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1', 'u2']);
      vip.getEffectiveLevel.mockImplementation(async (id: string) => (id === 'u1' ? 5 : 0));
      const res = await call({ rules: rules({ winnerAlgorithm: 'VIP_PRIORITY' }) });
      expect(res.vipTiers.get('u1')).toBe(5);
      expect(res.vipTiers.get('u2')).toBe(0);
    });

    it('does not call the VIP service for any other algorithm', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1']);
      await call();
      expect(vip.getEffectiveLevel).not.toHaveBeenCalled();
    });

    // A VIP lookup failure must not sink an entire payout.
    it('treats a VIP lookup failure as tier 0', async () => {
      redis.srandmember.mockResolvedValueOnce(['u1']).mockResolvedValue([]);
      repo.findEligibleMembers.mockResolvedValue(['u1']);
      vip.getEffectiveLevel.mockRejectedValue(new Error('vip down'));
      const res = await call({ rules: rules({ winnerAlgorithm: 'VIP_PRIORITY' }) });
      expect(res.vipTiers.get('u1')).toBe(0);
      expect(res.eligible).toEqual(['u1']);
    });
  });
});
