import { LeaderboardStore } from './leaderboard-store.service';

type Mock = ReturnType<typeof makeRedis>;

function makeRedis() {
  const pipeline = {
    zincrby: jest.fn().mockReturnThis(),
    zadd: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    incr: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  return {
    zincrby: jest.fn().mockResolvedValue('12'),
    zrevrange: jest.fn().mockResolvedValue(['u1', '30', 'u2', '10']),
    zmscore: jest.fn().mockResolvedValue(['30', null]),
    zrevrank: jest.fn().mockResolvedValue(3),
    zscore: jest.fn().mockResolvedValue('30'),
    zcard: jest.fn().mockResolvedValue(2),
    zunionstore: jest.fn().mockResolvedValue(2),
    zadd: jest.fn().mockResolvedValue(2),
    rename: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(7),
    get: jest.fn().mockResolvedValue('7'),
    set: jest.fn().mockResolvedValue('OK'),
    pipeline: jest.fn(() => pipeline),
    __pipeline: pipeline,
  };
}

describe('LeaderboardStore', () => {
  let redis: Mock;
  let store: LeaderboardStore;

  beforeEach(() => {
    redis = makeRedis();
    store = new LeaderboardStore(redis as never);
  });

  describe('key', () => {
    it('hash-tags on scope|dimension so unions stay in one Cluster slot', () => {
      expect(store.key('vrank', 'g', 'hosts', 'daily', '20260722')).toBe(
        'vrank:{g|hosts}:daily:20260722',
      );
    });

    it('keeps a room-scoped key in its own slot', () => {
      expect(store.key('vrank', 'r:abc', 'gifters', 'hourly', '2026072214')).toBe(
        'vrank:{r:abc|gifters}:hourly:2026072214',
      );
    });
  });

  describe('increment', () => {
    it('returns the new score as a number', async () => {
      await expect(store.increment('k', 'u1', 5)).resolves.toBe(12);
      expect(redis.zincrby).toHaveBeenCalledWith('k', 5, 'u1');
    });
  });

  describe('incrementMany', () => {
    it('issues one pipeline rather than N round trips', async () => {
      await store.incrementMany([
        { key: 'a', member: 'u1', delta: 5, ttlSeconds: 60 },
        { key: 'b', member: 'u1', delta: 5 },
      ]);
      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(redis.__pipeline.zincrby).toHaveBeenCalledTimes(2);
      // TTL applied only where requested.
      expect(redis.__pipeline.expire).toHaveBeenCalledTimes(1);
      expect(redis.__pipeline.expire).toHaveBeenCalledWith('a', 60);
      expect(redis.__pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('does nothing on an empty batch', async () => {
      await store.incrementMany([]);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe('range', () => {
    it('decodes the flat WITHSCORES array into entries', async () => {
      await expect(store.range('k', 0, 1)).resolves.toEqual([
        { member: 'u1', score: 30 },
        { member: 'u2', score: 10 },
      ]);
      expect(redis.zrevrange).toHaveBeenCalledWith('k', 0, 1, 'WITHSCORES');
    });
  });

  describe('top', () => {
    it('delegates to range for a positive limit', async () => {
      await expect(store.top('k', 2)).resolves.toEqual([
        { member: 'u1', score: 30 },
        { member: 'u2', score: 10 },
      ]);
      expect(redis.zrevrange).toHaveBeenCalledWith('k', 0, 1, 'WITHSCORES');
    });

    it('returns [] without calling Redis when limit is zero', async () => {
      await expect(store.top('k', 0)).resolves.toEqual([]);
      expect(redis.zrevrange).not.toHaveBeenCalled();
    });

    it('returns [] without calling Redis when limit is negative', async () => {
      // ZREVRANGE treats a stop of -1 ("limit - 1" at limit 0) as "last
      // element", so an unguarded top(key, 0) would return the whole ladder.
      await expect(store.top('k', -5)).resolves.toEqual([]);
      expect(redis.zrevrange).not.toHaveBeenCalled();
    });
  });

  describe('scoreMany', () => {
    it('maps absent members to null, present ones to numbers', async () => {
      await expect(store.scoreMany('k', ['u1', 'u9'])).resolves.toEqual([30, null]);
    });

    it('short-circuits on an empty member list', async () => {
      await expect(store.scoreMany('k', [])).resolves.toEqual([]);
      expect(redis.zmscore).not.toHaveBeenCalled();
    });
  });

  describe('derive', () => {
    it('unions the source keys into the destination and TTLs it', async () => {
      await expect(store.derive('dest', ['a', 'b'], 3600)).resolves.toBe(2);
      expect(redis.zunionstore).toHaveBeenCalledWith('dest', 2, 'a', 'b');
      expect(redis.expire).toHaveBeenCalledWith('dest', 3600);
    });

    it('clears the destination and skips the union when there are no sources', async () => {
      await expect(store.derive('dest', [], 3600)).resolves.toBe(0);
      expect(redis.zunionstore).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith('dest');
    });
  });

  describe('replace', () => {
    /** Reconstructs [score, member] pairs from every pipelined ZADD call. */
    function writtenPairs(tmp: string): Array<[number, string]> {
      const pairs: Array<[number, string]> = [];
      for (const call of redis.__pipeline.zadd.mock.calls) {
        const [calledKey, ...args] = call as [string, ...(number | string)[]];
        expect(calledKey).toBe(tmp);
        for (let i = 0; i < args.length; i += 2) {
          pairs.push([args[i] as number, args[i + 1] as string]);
        }
      }
      return pairs;
    }

    it('builds into a same-slot temp key via a pipelined ZADD, then RENAMEs over the live one', async () => {
      await store.replace('vrank:{g|hosts}:daily:20260722', [{ member: 'u1', score: 9 }], 600);
      const tmp = 'vrank:{g|hosts}:daily:20260722:tmp';
      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(writtenPairs(tmp)).toEqual([[9, 'u1']]);
      expect(redis.__pipeline.exec).toHaveBeenCalledTimes(1);
      expect(redis.rename).toHaveBeenCalledWith(tmp, 'vrank:{g|hosts}:daily:20260722');
      expect(redis.expire).toHaveBeenCalledWith('vrank:{g|hosts}:daily:20260722', 600);
    });

    it('writes every member/score pair correctly paired for a multi-entry replace', async () => {
      const entries = [
        { member: 'u1', score: 9 },
        { member: 'u2', score: 5 },
        { member: 'u3', score: 20 },
      ];
      await store.replace('k', entries, 600);
      const pairs = writtenPairs('k:tmp');
      // A mis-paired flatMap (e.g. entries.flatMap(({ member, score }) => [member, score]),
      // or scores/members zipped from separate arrays that got out of step)
      // would swap or scramble these pairs, so this must check pairing, not
      // just membership.
      expect(pairs).toEqual([
        [9, 'u1'],
        [5, 'u2'],
        [20, 'u3'],
      ]);
    });

    it('splits a 2,500-entry replace across multiple ZADD calls, writing all 2,500 pairs', async () => {
      const entries = Array.from({ length: 2500 }, (_, i) => ({ member: `u${i}`, score: i }));
      await store.replace('k', entries, 600);
      const calls = redis.__pipeline.zadd.mock.calls;
      // A single-spread implementation issues exactly one (unpipelined)
      // ZADD, so it never touches the pipeline's zadd stub at all — this
      // assertion fails against it (0 calls, not > 1).
      expect(calls.length).toBeGreaterThan(1);
      const pairs = writtenPairs('k:tmp');
      expect(pairs).toHaveLength(2500);
      expect(pairs).toEqual(entries.map(({ score, member }) => [score, member]));
    });

    it('deletes the live key and the tmp key outright when the recompute produced nothing', async () => {
      await store.replace('k', [], 600);
      expect(redis.pipeline).not.toHaveBeenCalled();
      expect(redis.rename).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith('k');
      expect(redis.del).toHaveBeenCalledWith('k:tmp');
      expect(redis.del).toHaveBeenCalledTimes(2);
    });
  });

  describe('markSeen', () => {
    it('reports true the first time and false on redelivery', async () => {
      redis.set.mockResolvedValueOnce('OK');
      await expect(store.markSeen('vrank', 'gift', 'txn-1', 3600)).resolves.toBe(true);
      expect(redis.set).toHaveBeenCalledWith('vrank:seen:gift:txn-1', '1', 'EX', 3600, 'NX');

      redis.set.mockResolvedValueOnce(null);
      await expect(store.markSeen('vrank', 'gift', 'txn-1', 3600)).resolves.toBe(false);
    });

    it('fails open when Redis errors — a missed increment is healed by recompute', async () => {
      redis.set.mockRejectedValueOnce(new Error('CONNRESET'));
      await expect(store.markSeen('vrank', 'gift', 'txn-1', 3600)).resolves.toBe(true);
    });

    it('fails open — without throwing — when Redis rejects with `undefined`', async () => {
      // A bare `(err as Error).message` would throw a NEW TypeError here
      // (reading `.message` off `undefined`), turning the fail-OPEN contract
      // into fail-CLOSED: the caller's `try/catch` around `markSeen` would
      // never run, and the write would be silently dropped instead of
      // proceeding as "not seen before".
      redis.set.mockRejectedValueOnce(undefined);
      await expect(store.markSeen('vrank', 'gift', 'txn-1', 3600)).resolves.toBe(true);
    });
  });

  describe('version', () => {
    it('reads 0 when unset and INCRs on bump', async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(store.version('vrank', 'g', 'hosts')).resolves.toBe(0);
      await expect(store.bumpVersion('vrank', 'g', 'hosts')).resolves.toBe(7);
      expect(redis.incr).toHaveBeenCalledWith('vrank:ver:{g|hosts}');
    });
  });

  describe('bumpVersionMany', () => {
    it('issues one pipeline rather than N round trips', async () => {
      await store.bumpVersionMany('vrank', [
        { scope: 'g', dimension: 'hosts' },
        { scope: 'c:IN', dimension: 'gifters' },
      ]);
      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(redis.__pipeline.incr).toHaveBeenCalledTimes(2);
      expect(redis.__pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('INCRs the correct version key for each pair', async () => {
      await store.bumpVersionMany('vrank', [
        { scope: 'g', dimension: 'hosts' },
        { scope: 'r:room-1', dimension: 'gifters' },
      ]);
      expect(redis.__pipeline.incr).toHaveBeenNthCalledWith(1, 'vrank:ver:{g|hosts}');
      expect(redis.__pipeline.incr).toHaveBeenNthCalledWith(2, 'vrank:ver:{r:room-1|gifters}');
    });

    it('does nothing on an empty batch', async () => {
      await store.bumpVersionMany('vrank', []);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });
  });
});
