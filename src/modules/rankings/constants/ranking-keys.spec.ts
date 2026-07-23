import { buildLeaderboardKey, leaderboardTag } from './ranking-keys';

describe('ranking-keys', () => {
  describe('buildLeaderboardKey', () => {
    it('builds the exact documented key shape', () => {
      expect(
        buildLeaderboardKey({
          namespace: 'vrank',
          scope: 'g',
          dimension: 'hosts',
          period: 'daily',
          dateKey: '20260722',
        }),
      ).toBe('vrank:{g|hosts}:daily:20260722');
    });

    // The single most valuable assertion in this file: ZUNIONSTORE and RENAME
    // across dateKeys must resolve to one Redis Cluster slot, which only holds
    // if the hash tag wraps `scope|dimension` and nothing else.
    it('wraps ONLY `scope|dimension` in the hash tag — period and dateKey sit outside the braces', () => {
      const key = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
      });
      expect(key).toMatch(/^vrank:\{g\|hosts\}:daily:20260722$/);

      const tagMatch = key.match(/\{([^}]*)\}/);
      expect(tagMatch).not.toBeNull();
      expect(tagMatch![1]).toBe('g|hosts');

      // Nothing outside the braces contains a brace, and nothing inside the
      // braces leaked the period or dateKey.
      const outsideBraces = key.replace(/\{[^}]*\}/, '');
      expect(outsideBraces).not.toContain('{');
      expect(outsideBraces).not.toContain('}');
      expect(tagMatch![1]).not.toContain('daily');
      expect(tagMatch![1]).not.toContain('20260722');
    });

    it('produces the SAME hash tag for keys differing only in dateKey — the property that keeps cross-dateKey unions Cluster-safe', () => {
      const a = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'hosts',
        period: 'monthly',
        dateKey: '202601',
      });
      const b = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'hosts',
        period: 'monthly',
        dateKey: '202602',
      });

      const tagA = a.match(/\{[^}]*\}/)![0];
      const tagB = b.match(/\{[^}]*\}/)![0];

      expect(tagA).toBe(tagB);
      expect(tagA).toBe('{g|hosts}');
      // Sanity: the keys themselves still differ (only the dateKey changed).
      expect(a).not.toBe(b);
    });

    it('produces DIFFERENT hash tags for different scopes', () => {
      const g = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
      });
      const room = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'r:abc-123',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
      });

      expect(g.match(/\{[^}]*\}/)![0]).not.toBe(room.match(/\{[^}]*\}/)![0]);
    });

    it('produces DIFFERENT hash tags for different dimensions', () => {
      const hosts = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
      });
      const gifters = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'gifters',
        period: 'daily',
        dateKey: '20260722',
      });

      expect(hosts.match(/\{[^}]*\}/)![0]).not.toBe(gifters.match(/\{[^}]*\}/)![0]);
    });

    it('round-trips a room-scoped key (containing a `:`) into the tag intact', () => {
      const key = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'r:abc-123',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
      });

      expect(key).toBe('vrank:{r:abc-123|hosts}:daily:20260722');
      expect(key.match(/\{([^}]*)\}/)![1]).toBe('r:abc-123|hosts');
    });
  });

  describe('leaderboardTag', () => {
    it('returns exactly the `{scope|dimension}`-shaped tag', () => {
      expect(leaderboardTag('g', 'hosts')).toBe('{g|hosts}');
    });

    it('agrees with the tag embedded by buildLeaderboardKey', () => {
      const key = buildLeaderboardKey({
        namespace: 'vrank',
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
      });

      expect(key).toContain(leaderboardTag('g', 'hosts'));
    });

    it('round-trips a room-scoped tag with an embedded `:`', () => {
      expect(leaderboardTag('r:abc-123', 'hosts')).toBe('{r:abc-123|hosts}');
    });
  });
});
