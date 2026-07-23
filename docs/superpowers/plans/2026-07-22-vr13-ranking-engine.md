# VR-13 Enterprise Ranking & Leaderboard Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scope-aware, real-time ranking and leaderboard engine for Video Rooms — hot Redis ZSET ladders fed by gift/PK/treasure/room events, healed by authoritative BullMQ recompute jobs, persisted as historical snapshots, and served over REST + Socket.IO.

**Architecture:** `src/modules/rankings/` is promoted into a generic ranking core (period resolver, ZSET store, page cache) with no video knowledge. `src/modules/video-rooms/` builds VR-13 on that core: dimensions, write-path fan-out, recompute, jobs, REST, sockets. Correctness follows a lambda model — a deduped incremental path for latency, an authoritative recompute path for truth.

**Tech Stack:** NestJS 11, TypeScript (CommonJS), Prisma (multi-file schema at `prisma/schema/`), ioredis (`Redis | Cluster`), BullMQ, Socket.IO, Jest, Prometheus (`prom-client`).

**Spec:** `docs/superpowers/specs/2026-07-22-video-room-ranking-engine-design.md`

## Global Constraints

- **Never run `git commit` or `git push`.** The user stages and commits all work themselves. Every task ends with verification, not a commit. If a task feels finished, report it and stop.
- **No Prisma inside services.** All database access goes through a repository. This is enforced by `pnpm boundaries` (dependency-cruiser).
- **Backward compatibility is non-negotiable.** `prisma/schema/rankings.prisma`, the `RankingSnapshot` table, the `rankings:*` Redis keys, the four existing `GET /rankings/*` endpoints, `RankingsActivityListener`, `giftTopSendersKey`/`giftTopKey`, and the audio-rooms / live-streaming / families modules must all be unchanged in behaviour.
- **Never write `rankings:*` keys from VR-13.** The platform `RankingsActivityListener` already consumes `gift.sent` for `contextType: VIDEO_ROOM`. VR-13 writes only `vrank:*`. Violating this double-counts real coins.
- **Redis Cluster safety.** Every multi-key command (`ZUNIONSTORE`, `RENAME`) must operate on keys sharing one `{hash-tag}`. The VR-13 tag is `scope|dimension`.
- **Timezone:** all VR-13 date keys are UTC. The existing `RankingsService` is local-time for daily/monthly and UTC for weekly — that inconsistency is preserved deliberately, never "fixed".
- **Money-adjacent code never throws into the caller.** Ranking listeners swallow and log; a ranking failure must not fail a gift, PK settlement or treasure payout.
- **Test command:** `pnpm test -- <path>`. **Lint:** `pnpm lint`. **Boundaries:** `pnpm boundaries`.
- Every new `.ts` source file gets a colocated `.spec.ts`, matching every shipped VR phase.

---

## File Structure

### Core — `src/modules/rankings/` (generic, no video knowledge)

| File | Responsibility |
|---|---|
| `constants/ranking-keys.ts` | key-part types + `buildLeaderboardKey` |
| `services/ranking-period.resolver.ts` | dateKey math, window bounds, constituent keys, validation |
| `services/leaderboard-store.service.ts` | ZSET ops, `ZUNIONSTORE` derive, atomic replace, version counter |
| `services/leaderboard-cache.service.ts` | version-stamped hydrated page cache + hit/miss counters |
| `services/rankings.service.ts` | **modified** — refactored onto resolver + store, behaviour identical |
| `processors/rankings.processor.ts` | **modified** — registry fallthrough for domain-owned jobs |
| `rankings.module.ts` | **modified** — provide + export the three new core services |

### VR-13 — `src/modules/video-rooms/`

| File | Responsibility |
|---|---|
| `../../../prisma/schema/video_rooms_rankings.prisma` | 3 tables |
| `constants/video-room-ranking.constants.ts` | scopes, dimensions, key builders, job names, socket events |
| `config/video-room-ranking.config.ts` | weights, TTLs, retention, limits |
| `exceptions/video-room-ranking.exceptions.ts` | 5 exception classes |
| `events/video-room-ranking.events.ts` | 9 domain events |
| `dto/video-room-ranking.dto.ts` | query + response DTOs |
| `repositories/video-room-ranking.repository.ts` | the 3 tables + source-table aggregate reads |
| `services/video-room-ranking-score.engine.ts` | weights → composite (pure) |
| `services/video-room-ranking-scope.resolver.ts` | user → country/city, cached |
| `services/video-room-ranking.service.ts` | write path: dedupe + fan-out |
| `services/video-room-ranking-query.service.ts` | read path: hydration, guest gate, permissions |
| `services/video-room-leaderboard.service.ts` | friends/following/VIP projections |
| `services/video-room-ranking-aggregation.service.ts` | recompute a window from sources |
| `services/video-room-ranking-snapshot.service.ts` | persist top-N at period close |
| `services/video-room-ranking-recovery.service.ts` | replay a dateKey, heal drift |
| `services/video-room-ranking-jobs.service.ts` | BullMQ handlers via `QueueJobRegistry` |
| `scheduler/video-room-ranking.scheduler.ts` | repeatable job registration |
| `listeners/video-room-ranking-activity.listener.ts` | gift/PK/treasure/room → write path |
| `listeners/video-room-ranking-socket.listener.ts` | coalesced `/video-room` broadcast |
| `listeners/video-room-ranking-metrics.listener.ts` | Prometheus |
| `listeners/video-room-ranking-audit.listener.ts` | append to `VideoRoomEvent` |
| `controllers/video-rooms-rankings.controller.ts` | 11 REST routes |
| `video-rooms.metrics.ts` | **modified** — 9 ranking metric families |
| `video-rooms.module.ts` | **modified** — wiring |

---

## Task 1: Core — RankingPeriodResolver

**Files:**
- Create: `src/modules/rankings/constants/ranking-keys.ts`
- Create: `src/modules/rankings/services/ranking-period.resolver.ts`
- Test: `src/modules/rankings/services/ranking-period.resolver.spec.ts`

**Interfaces:**
- Consumes: nothing (pure, no injection beyond `@Injectable()`).
- Produces:
  - `type RankingPeriodName = 'hourly'|'daily'|'weekly'|'monthly'|'quarterly'|'yearly'|'alltime'|'custom'`
  - `type RankingTimezone = 'utc'|'local'`
  - `interface LeaderboardKeyParts { namespace: string; scope: string; dimension: string; period: string; dateKey: string }`
  - `buildLeaderboardKey(parts: LeaderboardKeyParts): string`
  - `class RankingPeriodResolver` with:
    - `dateKeyFor(period: RankingPeriodName, date: Date, tz?: RankingTimezone): string`
    - `windowFor(period: RankingPeriodName, dateKey: string): { start: Date; end: Date }`
    - `constituentsOf(period: RankingPeriodName, dateKey: string): { period: RankingPeriodName; dateKey: string }[]`
    - `isValidDateKey(period: RankingPeriodName, dateKey: string): boolean`
    - `HOT_PERIODS: readonly RankingPeriodName[]`
    - `DERIVED_PERIODS: readonly RankingPeriodName[]`

- [ ] **Step 1: Write the key builder**

Create `src/modules/rankings/constants/ranking-keys.ts`:

```ts
/**
 * Generic leaderboard key shape, shared by every ranking namespace.
 *
 *   <namespace>:{<scope>|<dimension>}:<period>:<dateKey>
 *
 * The Redis Cluster hash tag is deliberately `scope|dimension`, NOT the whole
 * key and NOT the scope alone. Every multi-key command this engine issues —
 * ZUNIONSTORE (quarterly from 3 monthlies) and RENAME (atomic replace) — stays
 * within one scope+dimension across dateKeys, so co-locating on that pair is
 * exactly enough to keep them Cluster-safe. Tagging on the scope alone would
 * collapse every global ladder onto a single slot; tagging more narrowly would
 * scatter the union sources across slots and make derivation impossible.
 */
export interface LeaderboardKeyParts {
  /** Root namespace, e.g. 'vrank'. Keeps engines from colliding. */
  namespace: string;
  /** Ranking universe: 'g' | 'r:<roomId>' | 'c:<ISO2>' | 'y:<cityId>'. */
  scope: string;
  /** What is being ranked: 'hosts' | 'gifters' | ... */
  dimension: string;
  period: string;
  dateKey: string;
}

export function buildLeaderboardKey(parts: LeaderboardKeyParts): string {
  const { namespace, scope, dimension, period, dateKey } = parts;
  return `${namespace}:{${scope}|${dimension}}:${period}:${dateKey}`;
}

/** The `{scope|dimension}` hash tag alone — for version counters and temp keys. */
export function leaderboardTag(scope: string, dimension: string): string {
  return `{${scope}|${dimension}}`;
}
```

- [ ] **Step 2: Write the failing resolver test**

Create `src/modules/rankings/services/ranking-period.resolver.spec.ts`:

```ts
import { RankingPeriodResolver } from './ranking-period.resolver';

describe('RankingPeriodResolver', () => {
  const resolver = new RankingPeriodResolver();
  // 2026-07-22T14:35:00Z — a Wednesday in ISO week 30, Q3.
  const d = new Date('2026-07-22T14:35:00.000Z');

  describe('dateKeyFor (utc)', () => {
    it('formats every period', () => {
      expect(resolver.dateKeyFor('hourly', d)).toBe('2026072214');
      expect(resolver.dateKeyFor('daily', d)).toBe('20260722');
      expect(resolver.dateKeyFor('weekly', d)).toBe('2026W30');
      expect(resolver.dateKeyFor('monthly', d)).toBe('202607');
      expect(resolver.dateKeyFor('quarterly', d)).toBe('2026Q3');
      expect(resolver.dateKeyFor('yearly', d)).toBe('2026');
      expect(resolver.dateKeyFor('alltime', d)).toBe('alltime');
    });

    it('pads single-digit months, days and hours', () => {
      const early = new Date('2026-01-05T03:00:00.000Z');
      expect(resolver.dateKeyFor('hourly', early)).toBe('2026010503');
      expect(resolver.dateKeyFor('daily', early)).toBe('20260105');
      expect(resolver.dateKeyFor('monthly', early)).toBe('202601');
    });

    it('assigns Jan 1 2027 (a Friday) to ISO week 53 of 2026', () => {
      // ISO-8601: a week belongs to the year containing its Thursday.
      expect(resolver.dateKeyFor('weekly', new Date('2027-01-01T00:00:00.000Z'))).toBe('2026W53');
    });

    it('assigns Dec 31 2024 (a Tuesday) to ISO week 1 of 2025', () => {
      expect(resolver.dateKeyFor('weekly', new Date('2024-12-31T00:00:00.000Z'))).toBe('2025W01');
    });

    it('maps month boundaries to the right quarter', () => {
      expect(resolver.dateKeyFor('quarterly', new Date('2026-03-31T23:59:59Z'))).toBe('2026Q1');
      expect(resolver.dateKeyFor('quarterly', new Date('2026-04-01T00:00:00Z'))).toBe('2026Q2');
      expect(resolver.dateKeyFor('quarterly', new Date('2026-12-31T23:59:59Z'))).toBe('2026Q4');
    });

    it('throws for custom, which has no derivable key', () => {
      expect(() => resolver.dateKeyFor('custom', d)).toThrow(/custom/i);
    });
  });

  describe('dateKeyFor (local) — preserves legacy RankingsService behaviour', () => {
    it('uses local calendar fields rather than UTC', () => {
      const local = resolver.dateKeyFor('daily', d, 'local');
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      expect(local).toBe(`${yyyy}${mm}${dd}`);
    });
  });

  describe('windowFor', () => {
    it('returns a half-open [start, end) window per period', () => {
      expect(resolver.windowFor('daily', '20260722')).toEqual({
        start: new Date('2026-07-22T00:00:00.000Z'),
        end: new Date('2026-07-23T00:00:00.000Z'),
      });
      expect(resolver.windowFor('hourly', '2026072214')).toEqual({
        start: new Date('2026-07-22T14:00:00.000Z'),
        end: new Date('2026-07-22T15:00:00.000Z'),
      });
      expect(resolver.windowFor('monthly', '202607')).toEqual({
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-08-01T00:00:00.000Z'),
      });
      expect(resolver.windowFor('quarterly', '2026Q3')).toEqual({
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-10-01T00:00:00.000Z'),
      });
      expect(resolver.windowFor('yearly', '2026')).toEqual({
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2027-01-01T00:00:00.000Z'),
      });
    });

    it('rolls December into the next year', () => {
      expect(resolver.windowFor('monthly', '202612').end).toEqual(
        new Date('2027-01-01T00:00:00.000Z'),
      );
    });

    it('starts an ISO week on Monday 00:00Z', () => {
      const { start, end } = resolver.windowFor('weekly', '2026W30');
      expect(start.getUTCDay()).toBe(1);
      expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000);
    });

    it('spans the epoch-to-far-future for alltime', () => {
      const { start, end } = resolver.windowFor('alltime', 'alltime');
      expect(start.getTime()).toBe(0);
      expect(end.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('constituentsOf', () => {
    it('decomposes a quarter into its three months', () => {
      expect(resolver.constituentsOf('quarterly', '2026Q3')).toEqual([
        { period: 'monthly', dateKey: '202607' },
        { period: 'monthly', dateKey: '202608' },
        { period: 'monthly', dateKey: '202609' },
      ]);
    });

    it('decomposes a year into twelve months', () => {
      const parts = resolver.constituentsOf('yearly', '2026');
      expect(parts).toHaveLength(12);
      expect(parts[0]).toEqual({ period: 'monthly', dateKey: '202601' });
      expect(parts[11]).toEqual({ period: 'monthly', dateKey: '202612' });
    });

    it('returns nothing for a hot period — it is materialised, not derived', () => {
      expect(resolver.constituentsOf('daily', '20260722')).toEqual([]);
      expect(resolver.constituentsOf('alltime', 'alltime')).toEqual([]);
    });
  });

  describe('isValidDateKey', () => {
    it('accepts well-formed keys', () => {
      expect(resolver.isValidDateKey('daily', '20260722')).toBe(true);
      expect(resolver.isValidDateKey('weekly', '2026W30')).toBe(true);
      expect(resolver.isValidDateKey('alltime', 'alltime')).toBe(true);
    });

    it('rejects malformed keys, wrong-period keys and impossible dates', () => {
      expect(resolver.isValidDateKey('daily', '2026-07-22')).toBe(false);
      expect(resolver.isValidDateKey('daily', '202607')).toBe(false);
      expect(resolver.isValidDateKey('weekly', '2026W54')).toBe(false);
      expect(resolver.isValidDateKey('monthly', '202613')).toBe(false);
      expect(resolver.isValidDateKey('quarterly', '2026Q5')).toBe(false);
      expect(resolver.isValidDateKey('daily', '20260732')).toBe(false);
      expect(resolver.isValidDateKey('alltime', '20260722')).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm test -- src/modules/rankings/services/ranking-period.resolver.spec.ts
```

Expected: FAIL — `Cannot find module './ranking-period.resolver'`.

- [ ] **Step 4: Implement the resolver**

Create `src/modules/rankings/services/ranking-period.resolver.ts`:

```ts
import { Injectable } from '@nestjs/common';

export type RankingPeriodName =
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'alltime'
  | 'custom';

/**
 * `utc` is the VR-13 default and the only correct choice for a global ladder:
 * a "daily" ranking must close at the same instant for every user on earth.
 *
 * `local` exists solely to preserve the pre-existing RankingsService behaviour,
 * which derives daily/monthly keys from local calendar fields. Changing that
 * would silently shift the day boundary of ladders already in production, so
 * the legacy caller opts into it explicitly rather than the resolver quietly
 * "fixing" it.
 */
export type RankingTimezone = 'utc' | 'local';

/** Periods materialised on the write path. */
const HOT: readonly RankingPeriodName[] = ['hourly', 'daily', 'weekly', 'monthly', 'alltime'];

/** Periods produced by ZUNIONSTORE over hot keys, never incremented directly. */
const DERIVED: readonly RankingPeriodName[] = ['quarterly', 'yearly'];

const PATTERNS: Record<string, RegExp> = {
  hourly: /^\d{10}$/,
  daily: /^\d{8}$/,
  weekly: /^\d{4}W\d{2}$/,
  monthly: /^\d{6}$/,
  quarterly: /^\d{4}Q[1-4]$/,
  yearly: /^\d{4}$/,
  alltime: /^alltime$/,
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

@Injectable()
export class RankingPeriodResolver {
  readonly HOT_PERIODS = HOT;
  readonly DERIVED_PERIODS = DERIVED;

  /**
   * The bucket key `date` falls into for `period`.
   *
   * `custom` throws: a custom range is defined by its caller-supplied bounds,
   * so there is no key to derive from a single instant. Returning something
   * plausible here would silently write custom-range data into a bucket nobody
   * queries.
   */
  dateKeyFor(period: RankingPeriodName, date: Date, tz: RankingTimezone = 'utc'): string {
    if (period === 'alltime') return 'alltime';
    if (period === 'custom') {
      throw new Error('dateKeyFor: "custom" has no derivable date key — supply one explicitly');
    }

    const y = tz === 'utc' ? date.getUTCFullYear() : date.getFullYear();
    const m = (tz === 'utc' ? date.getUTCMonth() : date.getMonth()) + 1;
    const d = tz === 'utc' ? date.getUTCDate() : date.getDate();
    const h = tz === 'utc' ? date.getUTCHours() : date.getHours();

    switch (period) {
      case 'hourly':
        return `${y}${pad(m)}${pad(d)}${pad(h)}`;
      case 'daily':
        return `${y}${pad(m)}${pad(d)}`;
      case 'monthly':
        return `${y}${pad(m)}`;
      case 'quarterly':
        return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
      case 'yearly':
        return `${y}`;
      case 'weekly':
        return this.isoWeekKey(date, tz);
    }
  }

  /**
   * ISO-8601 week key. A week belongs to the year containing its Thursday,
   * which is why 2027-01-01 lands in 2026W53 and 2024-12-31 in 2025W01.
   * Always computed on a UTC-normalised copy so the arithmetic below cannot be
   * perturbed by a DST shift in the host timezone.
   */
  private isoWeekKey(date: Date, tz: RankingTimezone): string {
    const y = tz === 'utc' ? date.getUTCFullYear() : date.getFullYear();
    const m = tz === 'utc' ? date.getUTCMonth() : date.getMonth();
    const d = tz === 'utc' ? date.getUTCDate() : date.getDate();

    const t = new Date(Date.UTC(y, m, d));
    const dayNum = t.getUTCDay() || 7; // Sunday 0 → 7
    t.setUTCDate(t.getUTCDate() + 4 - dayNum); // move to this week's Thursday
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}W${pad(week)}`;
  }

  /** Half-open `[start, end)` UTC window a dateKey covers. */
  windowFor(period: RankingPeriodName, dateKey: string): { start: Date; end: Date } {
    if (period === 'alltime') {
      return { start: new Date(0), end: new Date(Date.UTC(9999, 0, 1)) };
    }
    if (!this.isValidDateKey(period, dateKey)) {
      throw new Error(`windowFor: "${dateKey}" is not a valid ${period} date key`);
    }

    const y = Number(dateKey.slice(0, 4));

    switch (period) {
      case 'hourly': {
        const start = new Date(
          Date.UTC(y, Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8)), Number(dateKey.slice(8, 10))),
        );
        return { start, end: new Date(start.getTime() + 3_600_000) };
      }
      case 'daily': {
        const start = new Date(
          Date.UTC(y, Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8))),
        );
        return { start, end: new Date(start.getTime() + 86_400_000) };
      }
      case 'weekly': {
        const start = this.isoWeekStart(y, Number(dateKey.slice(5)));
        return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
      }
      case 'monthly': {
        const mo = Number(dateKey.slice(4, 6)) - 1;
        return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
      }
      case 'quarterly': {
        const q = Number(dateKey.slice(5));
        return {
          start: new Date(Date.UTC(y, (q - 1) * 3, 1)),
          end: new Date(Date.UTC(y, q * 3, 1)),
        };
      }
      case 'yearly':
        return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
      case 'custom':
        throw new Error('windowFor: "custom" bounds must be supplied by the caller');
    }
  }

  /** Monday 00:00:00Z of ISO week `week` in ISO year `isoYear`. */
  private isoWeekStart(isoYear: number, week: number): Date {
    // Jan 4 is always in ISO week 1.
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86_400_000);
    return new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
  }

  /**
   * The hot keys a derived period unions over. Monthly is the union unit for
   * both quarterly and yearly: unioning 365 daily keys would be a far larger
   * ZUNIONSTORE for an identical result.
   */
  constituentsOf(
    period: RankingPeriodName,
    dateKey: string,
  ): { period: RankingPeriodName; dateKey: string }[] {
    if (period === 'quarterly') {
      const y = dateKey.slice(0, 4);
      const first = (Number(dateKey.slice(5)) - 1) * 3 + 1;
      return [0, 1, 2].map((i) => ({
        period: 'monthly' as const,
        dateKey: `${y}${pad(first + i)}`,
      }));
    }
    if (period === 'yearly') {
      return Array.from({ length: 12 }, (_, i) => ({
        period: 'monthly' as const,
        dateKey: `${dateKey}${pad(i + 1)}`,
      }));
    }
    return [];
  }

  /**
   * Shape check plus a real-date check. The shape alone would accept '20260732'
   * and '2026W54', which look right and index nothing.
   */
  isValidDateKey(period: RankingPeriodName, dateKey: string): boolean {
    const pattern = PATTERNS[period];
    if (!pattern || !pattern.test(dateKey)) return false;

    if (period === 'alltime') return true;

    const y = Number(dateKey.slice(0, 4));

    if (period === 'weekly') {
      const w = Number(dateKey.slice(5));
      if (w < 1 || w > 53) return false;
      // A 53rd week exists only when the ISO year actually has one.
      return w !== 53 || this.isoWeeksInYear(y) === 53;
    }

    if (period === 'monthly' || period === 'daily' || period === 'hourly') {
      const mo = Number(dateKey.slice(4, 6));
      if (mo < 1 || mo > 12) return false;
      if (period === 'monthly') return true;

      const day = Number(dateKey.slice(6, 8));
      if (day < 1 || day > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
      if (period === 'daily') return true;

      const hour = Number(dateKey.slice(8, 10));
      return hour >= 0 && hour <= 23;
    }

    return true; // quarterly + yearly are fully constrained by their patterns
  }

  /** An ISO year has 53 weeks iff Jan 1 or Dec 31 falls on a Thursday. */
  private isoWeeksInYear(isoYear: number): number {
    const jan1 = new Date(Date.UTC(isoYear, 0, 1)).getUTCDay();
    const dec31 = new Date(Date.UTC(isoYear, 11, 31)).getUTCDay();
    return jan1 === 4 || dec31 === 4 ? 53 : 52;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm test -- src/modules/rankings/services/ranking-period.resolver.spec.ts
```

Expected: PASS, all describe blocks green.

- [ ] **Step 6: Lint**

```bash
pnpm lint
```

Expected: exit 0, no warnings.

- [ ] **Step 7: Report and stop**

Report the file paths created and the passing test count. **Do not commit.**

---

## Task 2: Core — LeaderboardStore

**Files:**
- Create: `src/modules/rankings/services/leaderboard-store.service.ts`
- Test: `src/modules/rankings/services/leaderboard-store.service.spec.ts`

**Interfaces:**
- Consumes: `buildLeaderboardKey`, `leaderboardTag` (Task 1); `REDIS_CLIENT`/`RedisClient` from `src/infra/redis/redis.constants`.
- Produces:
  - `interface RankedEntry { member: string; score: number }`
  - `class LeaderboardStore` with `key`, `increment`, `incrementMany`, `range`, `top`, `scoreMany`, `rank`, `score`, `count`, `derive`, `replace`, `expire`, `version`, `bumpVersion`, `markSeen`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/rankings/services/leaderboard-store.service.spec.ts`:

```ts
import { LeaderboardStore } from './leaderboard-store.service';

type Mock = ReturnType<typeof makeRedis>;

function makeRedis() {
  const pipeline = {
    zincrby: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
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
    it('builds into a same-slot temp key then RENAMEs over the live one', async () => {
      await store.replace('vrank:{g|hosts}:daily:20260722', [{ member: 'u1', score: 9 }], 600);
      const tmp = 'vrank:{g|hosts}:daily:20260722:tmp';
      expect(redis.zadd).toHaveBeenCalledWith(tmp, 9, 'u1');
      expect(redis.rename).toHaveBeenCalledWith(tmp, 'vrank:{g|hosts}:daily:20260722');
      expect(redis.expire).toHaveBeenCalledWith('vrank:{g|hosts}:daily:20260722', 600);
    });

    it('deletes the live key outright when the recompute produced nothing', async () => {
      await store.replace('k', [], 600);
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(redis.rename).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith('k');
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
  });

  describe('version', () => {
    it('reads 0 when unset and INCRs on bump', async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(store.version('vrank', 'g', 'hosts')).resolves.toBe(0);
      await expect(store.bumpVersion('vrank', 'g', 'hosts')).resolves.toBe(7);
      expect(redis.incr).toHaveBeenCalledWith('vrank:ver:{g|hosts}');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test -- src/modules/rankings/services/leaderboard-store.service.spec.ts
```

Expected: FAIL — `Cannot find module './leaderboard-store.service'`.

- [ ] **Step 3: Implement the store**

Create `src/modules/rankings/services/leaderboard-store.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { buildLeaderboardKey, leaderboardTag } from '../constants/ranking-keys';

export interface RankedEntry {
  member: string;
  score: number;
}

export interface LeaderboardIncrement {
  key: string;
  member: string;
  delta: number;
  /** Refreshed on every write; omit for ladders that must not expire. */
  ttlSeconds?: number;
}

/**
 * Generic sorted-set leaderboard store. Knows nothing about video rooms,
 * gifts or any dimension — it moves scores in and out of ZSETs and derives
 * one ladder from others.
 *
 * Cluster safety: every multi-key command here (ZUNIONSTORE, RENAME) requires
 * its keys to share a slot. That is guaranteed by `buildLeaderboardKey`'s
 * `{scope|dimension}` hash tag plus the rule that a derive only ever unions
 * keys of the SAME scope+dimension across dateKeys, and a replace only ever
 * renames a `:tmp` suffix of the very key it targets.
 */
@Injectable()
export class LeaderboardStore {
  private readonly logger = new Logger(LeaderboardStore.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  key(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
  ): string {
    return buildLeaderboardKey({ namespace, scope, dimension, period, dateKey });
  }

  async increment(key: string, member: string, delta: number): Promise<number> {
    return Number(await this.redis.zincrby(key, delta, member));
  }

  /**
   * One pipeline for a whole fan-out. A single gift touches ~5 periods across
   * ~4 scopes for ~4 dimensions; issuing those as individual round trips would
   * put ~80 RTTs on the hot path of every gift sent on the platform.
   */
  async incrementMany(increments: LeaderboardIncrement[]): Promise<void> {
    if (increments.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const { key, member, delta, ttlSeconds } of increments) {
      pipe.zincrby(key, delta, member);
      if (ttlSeconds !== undefined) pipe.expire(key, ttlSeconds);
    }
    await pipe.exec();
  }

  async range(key: string, start: number, stop: number): Promise<RankedEntry[]> {
    return this.decode(await this.redis.zrevrange(key, start, stop, 'WITHSCORES'));
  }

  top(key: string, limit: number): Promise<RankedEntry[]> {
    return this.range(key, 0, limit - 1);
  }

  private decode(flat: string[]): RankedEntry[] {
    const entries: RankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      entries.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return entries;
  }

  /** Scores for many members in one call — the projection primitive. */
  async scoreMany(key: string, members: string[]): Promise<(number | null)[]> {
    if (members.length === 0) return [];
    const raw = await this.redis.zmscore(key, ...members);
    return raw.map((s) => (s === null ? null : Number(s)));
  }

  async rank(key: string, member: string): Promise<number | null> {
    return this.redis.zrevrank(key, member);
  }

  async score(key: string, member: string): Promise<number | null> {
    const s = await this.redis.zscore(key, member);
    return s === null ? null : Number(s);
  }

  count(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  /**
   * Materialise `destKey` as the union of `sourceKeys` (a derived period built
   * from its hot constituents). With no sources the destination is deleted
   * rather than left holding a previous run's data — a quarter with no months
   * must read as empty, not as stale.
   */
  async derive(destKey: string, sourceKeys: string[], ttlSeconds: number): Promise<number> {
    if (sourceKeys.length === 0) {
      await this.redis.del(destKey);
      return 0;
    }
    const written = await this.redis.zunionstore(destKey, sourceKeys.length, ...sourceKeys);
    await this.redis.expire(destKey, ttlSeconds);
    return written;
  }

  /**
   * Atomically swap a ladder's contents — the recompute path's commit step.
   *
   * Built into `<key>:tmp` and RENAMEd rather than DEL-then-ZADD so readers
   * never observe a half-built or empty ladder. The `:tmp` suffix sits OUTSIDE
   * the `{...}` hash tag, so both keys hash to the same slot and RENAME is
   * legal on Cluster.
   */
  async replace(key: string, entries: RankedEntry[], ttlSeconds: number): Promise<void> {
    if (entries.length === 0) {
      await this.redis.del(key);
      return;
    }
    const tmp = `${key}:tmp`;
    await this.redis.del(tmp);
    const pipe = this.redis.pipeline();
    for (const { member, score } of entries) pipe.zadd(tmp, score, member);
    await pipe.exec();
    await this.redis.rename(tmp, key);
    await this.redis.expire(key, ttlSeconds);
  }

  expire(key: string, ttlSeconds: number): Promise<number> {
    return this.redis.expire(key, ttlSeconds);
  }

  /**
   * Monotonic ladder version. Cached pages embed the value read at write time;
   * a page whose embed no longer matches is a miss. Invalidating every cached
   * page of a ladder is therefore one INCR, however many pages exist — the same
   * technique VideoRoomPermissionCache uses for room permissions.
   */
  async version(namespace: string, scope: string, dimension: string): Promise<number> {
    const raw = await this.redis.get(this.versionKey(namespace, scope, dimension));
    return raw === null ? 0 : Number(raw);
  }

  bumpVersion(namespace: string, scope: string, dimension: string): Promise<number> {
    return this.redis.incr(this.versionKey(namespace, scope, dimension));
  }

  private versionKey(namespace: string, scope: string, dimension: string): string {
    return `${namespace}:ver:${leaderboardTag(scope, dimension)}`;
  }

  /**
   * Claim a source event exactly once. `true` means "you own this event, apply
   * it"; `false` means it was already applied.
   *
   * FAILS OPEN. If Redis is unreachable the answer is `true`, so a gift still
   * moves the ladder. The asymmetry is deliberate: an over-count is corrected
   * by the next recompute, while a write refused because the dedupe layer was
   * down is lost until that same recompute — and the user watching the ladder
   * sees nothing happen in the meantime.
   */
  async markSeen(
    namespace: string,
    source: string,
    naturalId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = `${namespace}:seen:${source}:${naturalId}`;
    try {
      return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (err) {
      this.logger.warn(`dedupe marker unavailable for ${key}: ${(err as Error).message}`);
      return true;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test -- src/modules/rankings/services/leaderboard-store.service.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Lint**

```bash
pnpm lint
```

Expected: exit 0.

- [ ] **Step 6: Report and stop**

Report file paths and passing test count. **Do not commit.**

---

## Task 3: Core — LeaderboardCache

**Files:**
- Create: `src/modules/rankings/services/leaderboard-cache.service.ts`
- Test: `src/modules/rankings/services/leaderboard-cache.service.spec.ts`

**Interfaces:**
- Consumes: `LeaderboardStore.version` (Task 2); `CacheService` from `src/infra/redis/cache.service`.
- Produces:
  - `interface CachedPage<T> { version: number; dateKey: string; payload: T }`
  - `class LeaderboardCache` with:
    - `read<T>(ns, scope, dimension, period, dateKey, page): Promise<T | null>`
    - `write<T>(ns, scope, dimension, period, dateKey, page, payload, ttlSeconds): Promise<void>`
    - `hits: number` / `misses: number` (readonly counters, reset by `snapshotCounters()`)
    - `snapshotCounters(): { hits: number; misses: number }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/rankings/services/leaderboard-cache.service.spec.ts`:

```ts
import { LeaderboardCache } from './leaderboard-cache.service';

describe('LeaderboardCache', () => {
  const cacheKey = 'vrank:cache:{g|hosts}:daily:20260722:1';
  let cache: { get: jest.Mock; set: jest.Mock };
  let store: { version: jest.Mock };
  let subject: LeaderboardCache;

  beforeEach(() => {
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    store = { version: jest.fn().mockResolvedValue(4) };
    subject = new LeaderboardCache(cache as never, store as never);
  });

  it('returns null and counts a miss when nothing is cached', async () => {
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(cache.get).toHaveBeenCalledWith(cacheKey);
    expect(subject.snapshotCounters()).toEqual({ hits: 1 - 1, misses: 1 });
  });

  it('returns the payload and counts a hit when the version stamp matches', async () => {
    cache.get.mockResolvedValue({ version: 4, dateKey: '20260722', payload: [{ rank: 1 }] });
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toEqual([
      { rank: 1 },
    ]);
    expect(subject.snapshotCounters()).toEqual({ hits: 1, misses: 0 });
  });

  it('treats a stale version stamp as a miss', async () => {
    cache.get.mockResolvedValue({ version: 3, dateKey: '20260722', payload: [{ rank: 1 }] });
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('treats a mismatched dateKey as a miss even at the right version', async () => {
    cache.get.mockResolvedValue({ version: 4, dateKey: '20260721', payload: [{ rank: 1 }] });
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
  });

  it('stamps the current version and dateKey on write', async () => {
    await subject.write('vrank', 'g', 'hosts', 'daily', '20260722', 1, [{ rank: 1 }], 30);
    expect(cache.set).toHaveBeenCalledWith(
      cacheKey,
      { version: 4, dateKey: '20260722', payload: [{ rank: 1 }] },
      30,
    );
  });

  it('degrades to a miss rather than throwing when Redis is down', async () => {
    cache.get.mockRejectedValue(new Error('CONNRESET'));
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
  });

  it('swallows write failures — a cache miss must never fail a request', async () => {
    cache.set.mockRejectedValue(new Error('OOM'));
    await expect(
      subject.write('vrank', 'g', 'hosts', 'daily', '20260722', 1, [], 30),
    ).resolves.toBeUndefined();
  });

  it('resets counters when snapshotted', () => {
    subject.snapshotCounters();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 0 });
  });
});
```

Note: the first test's `hits: 1 - 1` is written that way only to read as "zero hits"; simplify to `hits: 0` when implementing if preferred — the assertion value is 0 either way.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test -- src/modules/rankings/services/leaderboard-cache.service.spec.ts
```

Expected: FAIL — `Cannot find module './leaderboard-cache.service'`.

- [ ] **Step 3: Implement the cache**

Create `src/modules/rankings/services/leaderboard-cache.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';
import { leaderboardTag } from '../constants/ranking-keys';
import { LeaderboardStore } from './leaderboard-store.service';

/** A cached page carries the stamps that decide whether it is still valid. */
export interface CachedPage<T> {
  version: number;
  dateKey: string;
  payload: T;
}

/**
 * Read-through cache for HYDRATED leaderboard pages — the expensive artefact is
 * not the ZSET read but the user/room hydration that follows it (usernames,
 * avatars, levels, VIP tiers), which is what this stores.
 *
 * Validity is decided by a version stamp rather than a TTL alone, so a
 * recomputed ladder invalidates every one of its cached pages with a single
 * INCR instead of a key scan.
 *
 * Every failure path degrades to "miss". A cache exists to make the hot path
 * faster; it must never be the reason a request fails.
 */
@Injectable()
export class LeaderboardCache {
  private readonly logger = new Logger(LeaderboardCache.name);
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly cache: CacheService,
    private readonly store: LeaderboardStore,
  ) {}

  private cacheKey(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    page: number,
  ): string {
    return `${namespace}:cache:${leaderboardTag(scope, dimension)}:${period}:${dateKey}:${page}`;
  }

  async read<T>(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    page: number,
  ): Promise<T | null> {
    try {
      const [entry, version] = await Promise.all([
        this.cache.get<CachedPage<T>>(
          this.cacheKey(namespace, scope, dimension, period, dateKey, page),
        ),
        this.store.version(namespace, scope, dimension),
      ]);

      if (entry && entry.version === version && entry.dateKey === dateKey) {
        this.hits += 1;
        return entry.payload;
      }
    } catch (err) {
      this.logger.warn(`leaderboard cache read failed: ${(err as Error).message}`);
    }
    this.misses += 1;
    return null;
  }

  async write<T>(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    page: number,
    payload: T,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const version = await this.store.version(namespace, scope, dimension);
      await this.cache.set<CachedPage<T>>(
        this.cacheKey(namespace, scope, dimension, period, dateKey, page),
        { version, dateKey, payload },
        ttlSeconds,
      );
    } catch (err) {
      this.logger.warn(`leaderboard cache write failed: ${(err as Error).message}`);
    }
  }

  /** Read and reset the hit/miss counters — drained by the metrics listener. */
  snapshotCounters(): { hits: number; misses: number } {
    const snapshot = { hits: this.hits, misses: this.misses };
    this.hits = 0;
    this.misses = 0;
    return snapshot;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test -- src/modules/rankings/services/leaderboard-cache.service.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Report and stop**

**Do not commit.**

---

## Task 4: Core — wire the three services, refactor RankingsService, open the processor

This task is a **behaviour-preserving refactor plus one additive processor change**. Its acceptance criterion is that the existing `rankings.service.spec.ts` passes untouched.

**Files:**
- Modify: `src/modules/rankings/services/rankings.service.ts`
- Modify: `src/modules/rankings/processors/rankings.processor.ts`
- Modify: `src/modules/rankings/rankings.module.ts`
- Test: `src/modules/rankings/processors/rankings.processor.spec.ts` (create)

**Interfaces:**
- Consumes: `RankingPeriodResolver` (Task 1), `LeaderboardStore` (Task 2), `LeaderboardCache` (Task 3), `QueueJobRegistry` from `src/infra/queue/workers/queue-job.registry`.
- Produces: `RankingsModule` exporting `RankingPeriodResolver`, `LeaderboardStore`, `LeaderboardCache` for VR-13 to inject.

- [ ] **Step 1: Confirm the existing spec is green before touching anything**

```bash
pnpm test -- src/modules/rankings/services/rankings.service.spec.ts
```

Expected: PASS. Record the test count — it must be identical at the end of this task.

- [ ] **Step 2: Replace the private date math with the resolver**

In `src/modules/rankings/services/rankings.service.ts`:

Inject the resolver by adding to the constructor:

```ts
  constructor(
    private readonly repo: RankingsRepository,
    @Inject(FAMILIES_SERVICE) private readonly families: IFamiliesService,
    private readonly periods: RankingPeriodResolver,
  ) {}
```

Delete the private `getDateKeys` method entirely and replace its three call sites with resolver calls that **explicitly pass `'local'`**:

```ts
  /**
   * Legacy key derivation, preserved exactly.
   *
   * `'local'` is passed deliberately: the original `getDateKeys` built daily and
   * monthly keys from local calendar fields while computing the ISO week in UTC.
   * That is inconsistent, but these ladders are live — switching them to UTC
   * would move the day boundary under ladders already accumulating scores and
   * split one day's data across two keys on the deploy. VR-13's own ladders are
   * UTC throughout; this seam is not the place to correct history.
   */
  private getDateKeys(date: Date): { daily: string; weekly: string; monthly: string } {
    return {
      daily: this.periods.dateKeyFor('daily', date, 'local'),
      weekly: this.periods.dateKeyFor('weekly', date, 'local'),
      monthly: this.periods.dateKeyFor('monthly', date, 'local'),
    };
  }
```

Keeping `getDateKeys` as a thin delegator (rather than inlining the resolver at all three call sites) keeps the diff to one method and leaves the existing spec's expectations addressable.

Add the import:

```ts
import { RankingPeriodResolver } from './ranking-period.resolver';
```

- [ ] **Step 3: Verify the legacy behaviour is unchanged**

```bash
pnpm test -- src/modules/rankings/services/rankings.service.spec.ts
```

Expected: PASS with the **same test count as Step 1**. If any test now fails, the refactor changed behaviour — revert and reconcile before continuing.

- [ ] **Step 4: Write the failing processor test**

Create `src/modules/rankings/processors/rankings.processor.spec.ts`:

```ts
import { RankingsProcessor } from './rankings.processor';

describe('RankingsProcessor', () => {
  const support = { metrics: { observeDuration: jest.fn(), incCompleted: jest.fn(), incFailed: jest.fn() } };
  let rankings: { takeMidnightSnapshots: jest.Mock };
  let registry: { dispatch: jest.Mock };
  let processor: RankingsProcessor;

  beforeEach(() => {
    rankings = { takeMidnightSnapshots: jest.fn().mockResolvedValue(undefined) };
    registry = { dispatch: jest.fn().mockResolvedValue({ ok: true }) };
    processor = new RankingsProcessor(support as never, rankings as never, registry as never);
  });

  it('still runs the legacy snapshot job itself', async () => {
    await expect(processor.handle({ name: 'rankings.snapshot' } as never)).resolves.toEqual({
      snapshotTaken: true,
    });
    expect(rankings.takeMidnightSnapshots).toHaveBeenCalledTimes(1);
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it('routes any other job name to the domain registry', async () => {
    const job = { name: 'video-room.ranking.aggregate.daily' } as never;
    await expect(processor.handle(job)).resolves.toEqual({ ok: true });
    expect(registry.dispatch).toHaveBeenCalledWith('ranking-processing', job);
    expect(rankings.takeMidnightSnapshots).not.toHaveBeenCalled();
  });

  it('propagates a domain handler failure so BullMQ can retry it', async () => {
    registry.dispatch.mockRejectedValue(new Error('aggregation failed'));
    await expect(processor.handle({ name: 'video-room.ranking.cleanup' } as never)).rejects.toThrow(
      'aggregation failed',
    );
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

```bash
pnpm test -- src/modules/rankings/processors/rankings.processor.spec.ts
```

Expected: FAIL — the constructor takes two arguments, and unknown job names currently return `{ ok: true }` without consulting a registry.

- [ ] **Step 6: Add the registry fallthrough**

Replace the body of `src/modules/rankings/processors/rankings.processor.ts`:

```ts
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { RankingsService } from '../services/rankings.service';

/**
 * Domain-owned worker for the RANKING_PROCESSING queue (kept in the rankings
 * module so infra stays independent of domains).
 *
 * Two routing paths. `rankings.snapshot` — the platform daily snapshot — is
 * handled inline, exactly as before. Everything else is dispatched through
 * {@link QueueJobRegistry}, which is what lets a domain module (VR-13) own jobs
 * on this shared queue without editing this file again: BullMQ binds one
 * processor per queue name, so the registry is the only available seam. The
 * gift-processing queue already works this way for VR-12's PK timers.
 *
 * `dispatch` deliberately does not throw on an unregistered name — an unknown
 * job is a no-op, not a failure, so stray jobs cannot dead-letter themselves.
 */
@Processor(QUEUE_NAMES.RANKING_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class RankingsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly rankings: RankingsService,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.RANKING_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name === 'rankings.snapshot') {
      await this.rankings.takeMidnightSnapshots();
      return { snapshotTaken: true };
    }
    return this.registry.dispatch(QUEUE_NAMES.RANKING_PROCESSING, job);
  }
}
```

- [ ] **Step 7: Wire the module**

In `src/modules/rankings/rankings.module.ts`, add the three core services to both `providers` and `exports`:

```ts
import { LeaderboardCache } from './services/leaderboard-cache.service';
import { LeaderboardStore } from './services/leaderboard-store.service';
import { RankingPeriodResolver } from './services/ranking-period.resolver';
```

```ts
  providers: [
    // ---- generic ranking core (no domain knowledge; consumed by VR-13) ----
    RankingPeriodResolver,
    LeaderboardStore,
    LeaderboardCache,
    RankingsRepository,
    RankingsService,
    RankingsActivityListener,
    RankingsScheduler,
    RankingsProcessor,
    {
      provide: RANKINGS_SERVICE,
      useClass: RankingsService,
    },
  ],
  exports: [
    RankingsRepository,
    RankingsService,
    RANKINGS_SERVICE,
    RankingPeriodResolver,
    LeaderboardStore,
    LeaderboardCache,
  ],
```

- [ ] **Step 8: Run the whole rankings suite plus lint and boundaries**

```bash
pnpm test -- src/modules/rankings
pnpm lint
pnpm boundaries
```

Expected: all PASS, exit 0. The `rankings.service.spec.ts` count must still match Step 1.

- [ ] **Step 9: Report and stop**

Report the before/after test counts for `rankings.service.spec.ts` explicitly — that equality is this task's whole safety argument. **Do not commit.**

---

## Task 5: VR-13 — Prisma schema and migration

**Files:**
- Create: `prisma/schema/video_rooms_rankings.prisma`
- Create: `prisma/schema/migrations/20260722200000_video_rooms_phase13_rankings/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `VideoRoomRankingSnapshot`, `VideoRoomLeaderboardSnapshot`, `VideoRoomRankingAggregationLog`, and the enum-like string conventions used by Task 9's repository.

- [ ] **Step 1: Write the schema file**

Create `prisma/schema/video_rooms_rankings.prisma`:

```prisma
// ============================================================
// Video Room Rankings (VR-13) — historical snapshots, materialised
// leaderboards and the aggregation audit. Live ladders are Redis ZSETs
// (`vrank:{scope|dimension}:period:dateKey`); this file is the durable record.
//
// No cross-module relations — other domains are referenced by id, matching
// rankings.prisma and every other video_rooms_*.prisma file. `scope` is an
// opaque string ('g', 'r:<uuid>', 'c:IN', 'y:<uuid>') rather than a set of
// nullable FK columns, so adding a scope later is a constant, not a migration.
// ============================================================

/// One entity's position on one ladder at one period close. The per-user
/// "my ranking history" read model.
model VideoRoomRankingSnapshot {
  id        String   @id @default(uuid()) @db.Uuid
  /// 'g' | 'r:<roomId>' | 'c:<ISO2>' | 'y:<cityId>'
  scope     String
  /// 'hosts' | 'gifters' | 'receivers' | 'rooms' | 'pk' | 'treasure' | 'vip'
  dimension String
  /// 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'alltime'
  period    String
  /// '2026072214' | '20260722' | '2026W30' | '202607' | '2026Q3' | '2026' | 'alltime'
  dateKey   String
  /// User id or room id, depending on the dimension.
  targetId  String   @db.Uuid
  rank      Int
  /// The composite score, as produced by VideoRoomRankingScoreEngine.
  score     BigInt
  /// Authoritative per-metric breakdown from the recompute pass, e.g.
  /// { coins, gifts, watchSeconds, peakViewers, pkWins, treasureEvents }.
  /// Null for rows written before a recompute has run for that window.
  metrics   Json?
  createdAt DateTime @default(now())

  @@unique([scope, dimension, period, dateKey, targetId])
  @@index([scope, dimension, period, dateKey, rank])
  @@index([targetId, dimension, period])
  @@map("video_room_ranking_snapshots")
}

/// The whole top-N of one ladder as a single row. Serves a historical
/// leaderboard read and a cache warm-up in one query instead of N snapshot
/// rows, which is why it is worth denormalising alongside the table above.
model VideoRoomLeaderboardSnapshot {
  id           String   @id @default(uuid()) @db.Uuid
  scope        String
  dimension    String
  period       String
  dateKey      String
  /// Ordered top-N: [{ targetId, rank, score }]. Score is a string in JSON —
  /// BigInt has no JSON representation and coin totals can exceed 2^53.
  entries      Json
  /// Cardinality of the FULL ladder, not of `entries` — lets a paginated
  /// response report an honest total without re-reading Redis.
  totalEntries Int
  capturedAt   DateTime @default(now())

  @@unique([scope, dimension, period, dateKey])
  @@index([scope, dimension, period, capturedAt])
  @@map("video_room_leaderboard_snapshots")
}

/// One row per aggregation run. Doubles as the idempotency guard: a run that
/// finds a SUCCEEDED row for its key returns without work, which is what makes
/// the jobs safe under BullMQ redelivery.
model VideoRoomRankingAggregationLog {
  id             String    @id @default(uuid()) @db.Uuid
  scope          String
  dimension      String
  period         String
  dateKey        String
  /// 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  status         String
  windowStart    DateTime
  windowEnd      DateTime
  /// Source rows scanned during the recompute.
  sourceRows     Int       @default(0)
  /// Ladder entries written by the recompute.
  entriesWritten Int       @default(0)
  durationMs     Int       @default(0)
  error          String?
  startedAt      DateTime  @default(now())
  finishedAt     DateTime?

  @@unique([scope, dimension, period, dateKey])
  @@index([status, startedAt])
  @@map("video_room_ranking_aggregation_logs")
}
```

- [ ] **Step 2: Format and validate the schema**

```bash
pnpm prisma:format
pnpm prisma:generate
```

Expected: both exit 0; `prisma generate` reports the client written. If `prisma format` reindents the file, keep its output.

- [ ] **Step 3: Write the migration SQL**

Create `prisma/schema/migrations/20260722200000_video_rooms_phase13_rankings/migration.sql`:

```sql
-- VR-13: video room ranking snapshots, materialised leaderboards, aggregation log.

CREATE TABLE "video_room_ranking_snapshots" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" BIGINT NOT NULL,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_room_ranking_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "video_room_ranking_snapshots_scope_dimension_period_dateKey_targetId_key"
    ON "video_room_ranking_snapshots" ("scope", "dimension", "period", "dateKey", "targetId");
CREATE INDEX "video_room_ranking_snapshots_scope_dimension_period_dateKey_rank_idx"
    ON "video_room_ranking_snapshots" ("scope", "dimension", "period", "dateKey", "rank");
CREATE INDEX "video_room_ranking_snapshots_targetId_dimension_period_idx"
    ON "video_room_ranking_snapshots" ("targetId", "dimension", "period");

CREATE TABLE "video_room_leaderboard_snapshots" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "totalEntries" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_room_leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "video_room_leaderboard_snapshots_scope_dimension_period_dateKey_key"
    ON "video_room_leaderboard_snapshots" ("scope", "dimension", "period", "dateKey");
CREATE INDEX "video_room_leaderboard_snapshots_scope_dimension_period_capturedAt_idx"
    ON "video_room_leaderboard_snapshots" ("scope", "dimension", "period", "capturedAt");

CREATE TABLE "video_room_ranking_aggregation_logs" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sourceRows" INTEGER NOT NULL DEFAULT 0,
    "entriesWritten" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "video_room_ranking_aggregation_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "video_room_ranking_aggregation_logs_scope_dimension_period_dateKey_key"
    ON "video_room_ranking_aggregation_logs" ("scope", "dimension", "period", "dateKey");
CREATE INDEX "video_room_ranking_aggregation_logs_status_startedAt_idx"
    ON "video_room_ranking_aggregation_logs" ("status", "startedAt");
```

- [ ] **Step 4: Verify the generated client exposes the three models**

```bash
node -e "const{PrismaClient}=require('@prisma/client');const c=new PrismaClient();console.log(['videoRoomRankingSnapshot','videoRoomLeaderboardSnapshot','videoRoomRankingAggregationLog'].map(m=>m+':'+(typeof c[m])).join('\n'))"
```

Expected: three lines, each ending `:object`. If any reads `:undefined`, `prisma generate` did not pick up the schema file — re-run Step 2.

- [ ] **Step 5: Report and stop**

Do **not** run `prisma migrate dev` (it touches the user's database). Report that the migration SQL is written and awaiting their decision on when to apply it. **Do not commit.**

---

## Task 6: VR-13 — constants, config, error codes, exceptions

Scaffolding every later task imports. Grouped into one task because no reviewer would meaningfully accept the constants while rejecting the exceptions — they are one vocabulary.

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-ranking.constants.ts`
- Create: `src/modules/video-rooms/constants/video-room-ranking.constants.spec.ts`
- Create: `src/modules/video-rooms/config/video-room-ranking.config.ts`
- Create: `src/modules/video-rooms/config/video-room-ranking.config.spec.ts`
- Create: `src/modules/video-rooms/exceptions/video-room-ranking.exceptions.ts`
- Create: `src/modules/video-rooms/exceptions/video-room-ranking.exceptions.spec.ts`
- Modify: `src/common/exceptions/error-codes.ts`
- Modify: `src/config/configuration.ts`

**Interfaces:**
- Consumes: `RankingPeriodName` (Task 1); `BusinessException`, `ERROR_CODES`; `toBool` from `config/video-room-gift.config`.
- Produces:
  - `VIDEO_ROOM_RANKING_NAMESPACE = 'vrank'`
  - `enum VideoRoomRankingDimension { HOSTS, GIFTERS, RECEIVERS, ROOMS, PK, TREASURE, VIP }`
  - `scopeGlobal()`, `scopeRoom(roomId)`, `scopeCountry(code)`, `scopeCity(cityId)`, `parseScope(scope)`
  - `VIDEO_ROOM_RANKING_JOBS` (7 job names), `VIDEO_ROOM_RANKING_SOCKET_EVENTS` (7 names)
  - `VIDEO_ROOM_RANKING_GUEST_LIMIT = 10`
  - `interface VideoRoomRankingConfig`, `loadVideoRoomRankingConfig(config)`
  - `RankingException`, `LeaderboardException`, `AggregationException`, `RankingCacheException`, `RankingPeriodException`

- [ ] **Step 1: Add the five error codes**

In `src/common/exceptions/error-codes.ts`, immediately after the VR-12 block (the line `VIDEO_ROOM_PK_NOT_AUTHORIZED: 'VIDEO_ROOM_PK_NOT_AUTHORIZED',`), insert:

```ts
  // ---- VR-13 video room ranking & leaderboard engine ----
  VIDEO_ROOM_RANKING_INVALID: 'VIDEO_ROOM_RANKING_INVALID',
  VIDEO_ROOM_LEADERBOARD_INVALID: 'VIDEO_ROOM_LEADERBOARD_INVALID',
  VIDEO_ROOM_RANKING_AGGREGATION_FAILED: 'VIDEO_ROOM_RANKING_AGGREGATION_FAILED',
  VIDEO_ROOM_RANKING_CACHE_FAILED: 'VIDEO_ROOM_RANKING_CACHE_FAILED',
  VIDEO_ROOM_RANKING_PERIOD_INVALID: 'VIDEO_ROOM_RANKING_PERIOD_INVALID',
```

- [ ] **Step 2: Write the failing constants test**

Create `src/modules/video-rooms/constants/video-room-ranking.constants.spec.ts`:

```ts
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_GUEST_LIMIT,
  VIDEO_ROOM_RANKING_JOBS,
  VIDEO_ROOM_RANKING_NAMESPACE,
  VIDEO_ROOM_RANKING_SOCKET_EVENTS,
  isRankingDimension,
  parseScope,
  scopeCity,
  scopeCountry,
  scopeGlobal,
  scopeRoom,
} from './video-room-ranking.constants';

describe('video-room ranking constants', () => {
  it('namespaces every key under vrank so it can never collide with rankings:*', () => {
    expect(VIDEO_ROOM_RANKING_NAMESPACE).toBe('vrank');
  });

  describe('scope builders', () => {
    it('builds each scope form', () => {
      expect(scopeGlobal()).toBe('g');
      expect(scopeRoom('abc-123')).toBe('r:abc-123');
      expect(scopeCountry('in')).toBe('c:IN');
      expect(scopeCity('city-9')).toBe('y:city-9');
    });

    it('upper-cases country codes so c:in and c:IN are one ladder', () => {
      expect(scopeCountry('in')).toBe(scopeCountry('IN'));
    });
  });

  describe('parseScope', () => {
    it('round-trips every builder', () => {
      expect(parseScope(scopeGlobal())).toEqual({ kind: 'global' });
      expect(parseScope(scopeRoom('abc-123'))).toEqual({ kind: 'room', id: 'abc-123' });
      expect(parseScope(scopeCountry('IN'))).toEqual({ kind: 'country', id: 'IN' });
      expect(parseScope(scopeCity('city-9'))).toEqual({ kind: 'city', id: 'city-9' });
    });

    it('returns null for anything it did not build', () => {
      expect(parseScope('nonsense')).toBeNull();
      expect(parseScope('r:')).toBeNull();
      expect(parseScope('')).toBeNull();
    });
  });

  describe('isRankingDimension', () => {
    it('accepts known dimensions and rejects the rest', () => {
      expect(isRankingDimension('hosts')).toBe(true);
      expect(isRankingDimension(VideoRoomRankingDimension.TREASURE)).toBe(true);
      expect(isRankingDimension('families')).toBe(false);
      expect(isRankingDimension('')).toBe(false);
    });
  });

  it('names all seven jobs under one prefix', () => {
    const names = Object.values(VIDEO_ROOM_RANKING_JOBS);
    expect(names).toHaveLength(7);
    expect(names.every((n) => n.startsWith('video-room.ranking.'))).toBe(true);
    expect(new Set(names).size).toBe(7);
  });

  it('names all seven socket events under the video_room prefix', () => {
    const names = Object.values(VIDEO_ROOM_RANKING_SOCKET_EVENTS);
    expect(names).toHaveLength(7);
    expect(names.every((n) => n.startsWith('video_room.'))).toBe(true);
    expect(new Set(names).size).toBe(7);
  });

  it('caps guests at the top ten', () => {
    expect(VIDEO_ROOM_RANKING_GUEST_LIMIT).toBe(10);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/constants/video-room-ranking.constants.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the constants**

Create `src/modules/video-rooms/constants/video-room-ranking.constants.ts`:

```ts
import type { RankingPeriodName } from 'src/modules/rankings/services/ranking-period.resolver';

/**
 * VR-13 ranking constants: the Redis namespace, the scope/dimension vocabulary,
 * key builders, job names and client-facing socket events.
 *
 * The `vrank` namespace is load-bearing, not cosmetic. The platform rankings
 * module owns `rankings:*` and already counts video-room gifts via its own
 * `gift.sent` listener; writing into that namespace from here would double-count
 * real coins. Every key this module produces starts with `vrank`.
 */
export const VIDEO_ROOM_RANKING_NAMESPACE = 'vrank';

/** What is being ranked. Members are user ids except ROOMS, which is room ids. */
export enum VideoRoomRankingDimension {
  HOSTS = 'hosts',
  GIFTERS = 'gifters',
  RECEIVERS = 'receivers',
  ROOMS = 'rooms',
  PK = 'pk',
  TREASURE = 'treasure',
  VIP = 'vip',
}

const DIMENSIONS = new Set<string>(Object.values(VideoRoomRankingDimension));

export function isRankingDimension(value: string): value is VideoRoomRankingDimension {
  return DIMENSIONS.has(value);
}

/** The ranking universe a ladder covers. */
export type RankingScopeKind = 'global' | 'room' | 'country' | 'city';

export interface ParsedRankingScope {
  kind: RankingScopeKind;
  /** Absent for the global scope, which has no id. */
  id?: string;
}

export const scopeGlobal = (): string => 'g';
export const scopeRoom = (roomId: string): string => `r:${roomId}`;
/** Country codes are normalised so `c:in` and `c:IN` cannot become two ladders. */
export const scopeCountry = (code: string): string => `c:${code.toUpperCase()}`;
export const scopeCity = (cityId: string): string => `y:${cityId}`;

export function parseScope(scope: string): ParsedRankingScope | null {
  if (scope === 'g') return { kind: 'global' };
  const [prefix, ...rest] = scope.split(':');
  const id = rest.join(':');
  if (!id) return null;
  if (prefix === 'r') return { kind: 'room', id };
  if (prefix === 'c') return { kind: 'country', id };
  if (prefix === 'y') return { kind: 'city', id };
  return null;
}

/** Periods incremented inline on the write path. */
export const VIDEO_ROOM_RANKING_HOT_PERIODS: readonly RankingPeriodName[] = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'alltime',
];

/** Periods produced by ZUNIONSTORE in an aggregation job. */
export const VIDEO_ROOM_RANKING_DERIVED_PERIODS: readonly RankingPeriodName[] = [
  'quarterly',
  'yearly',
];

/** BullMQ job names on the shared RANKING_PROCESSING queue. */
export const VIDEO_ROOM_RANKING_JOBS = {
  AGGREGATE_HOURLY: 'video-room.ranking.aggregate.hourly',
  AGGREGATE_DAILY: 'video-room.ranking.aggregate.daily',
  AGGREGATE_WEEKLY: 'video-room.ranking.aggregate.weekly',
  AGGREGATE_MONTHLY: 'video-room.ranking.aggregate.monthly',
  AGGREGATE_YEARLY: 'video-room.ranking.aggregate.yearly',
  CACHE_REFRESH: 'video-room.ranking.cache-refresh',
  CLEANUP: 'video-room.ranking.cleanup',
} as const;

/**
 * Client-facing realtime events, emitted into the existing `/video-room`
 * namespace. Dotted `video_room.*` names, matching every shipped VR phase —
 * the phase brief writes these camelCase (`rankingUpdated`), but the wire
 * convention on this namespace is the dotted form and consistency wins.
 */
export const VIDEO_ROOM_RANKING_SOCKET_EVENTS = {
  RANKING_UPDATED: 'video_room.ranking.updated',
  LEADERBOARD_UPDATED: 'video_room.leaderboard.updated',
  HOST_RANK_UPDATED: 'video_room.ranking.host_updated',
  GIFTER_RANK_UPDATED: 'video_room.ranking.gifter_updated',
  ROOM_RANK_UPDATED: 'video_room.ranking.room_updated',
  PK_RANK_UPDATED: 'video_room.ranking.pk_updated',
  TREASURE_RANK_UPDATED: 'video_room.ranking.treasure_updated',
} as const;

/** Dimension → the socket event announcing its movement. */
export const DIMENSION_SOCKET_EVENT: Record<VideoRoomRankingDimension, string> = {
  [VideoRoomRankingDimension.HOSTS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.HOST_RANK_UPDATED,
  [VideoRoomRankingDimension.GIFTERS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.GIFTER_RANK_UPDATED,
  [VideoRoomRankingDimension.RECEIVERS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.RANKING_UPDATED,
  [VideoRoomRankingDimension.ROOMS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.ROOM_RANK_UPDATED,
  [VideoRoomRankingDimension.PK]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.PK_RANK_UPDATED,
  [VideoRoomRankingDimension.TREASURE]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.TREASURE_RANK_UPDATED,
  [VideoRoomRankingDimension.VIP]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.RANKING_UPDATED,
};

/** Ranks a guest may read. No pagination past this, no self-rank, no history. */
export const VIDEO_ROOM_RANKING_GUEST_LIMIT = 10;

/** Entries persisted per ladder at period close. */
export const VIDEO_ROOM_RANKING_SNAPSHOT_SIZE = 100;

/** Default and maximum page size for ranking reads. */
export const VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE = 20;
export const VIDEO_ROOM_RANKING_MAX_PAGE_SIZE = 100;

/** Fleet-wide lock so exactly one instance runs a given aggregation. */
export function videoRoomRankingAggregationLockKey(jobKey: string): string {
  return `vrank:agg:lock:${jobKey}`;
}

/** Per-room socket coalescing marker — one broadcast per window per room. */
export function videoRoomRankingCoalesceKey(roomId: string): string {
  return `vrank:coalesce:{r:${roomId}}`;
}
```

- [ ] **Step 5: Run the constants test to verify it passes**

```bash
pnpm test -- src/modules/video-rooms/constants/video-room-ranking.constants.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Write the failing config test**

Create `src/modules/video-rooms/config/video-room-ranking.config.spec.ts`:

```ts
import { loadVideoRoomRankingConfig } from './video-room-ranking.config';

const svc = (raw: unknown) => ({ get: () => raw }) as never;

describe('loadVideoRoomRankingConfig', () => {
  it('throws when the namespace is not registered', () => {
    expect(() => loadVideoRoomRankingConfig(svc(undefined))).toThrow(/videoRoomRanking/);
  });

  it('applies documented defaults for an empty namespace', () => {
    const cfg = loadVideoRoomRankingConfig(svc({}));
    expect(cfg.enabled).toBe(true);
    expect(cfg.cacheTtlSeconds).toBe(15);
    expect(cfg.dedupeTtlSeconds).toBe(172_800);
    expect(cfg.roomLadderTtlSeconds).toBe(604_800);
    expect(cfg.coalesceWindowMs).toBe(1_000);
    expect(cfg.weights.host.coins).toBe(1);
    expect(cfg.weights.host.pkWin).toBe(500);
    expect(cfg.weights.rooms.peakViewers).toBe(10);
    expect(cfg.weights.pk.win).toBe(1000);
    expect(cfg.retentionDays.hourly).toBe(90);
    expect(cfg.retentionDays.daily).toBe(400);
  });

  it('coerces numeric strings, since namespaced env values arrive as strings', () => {
    const cfg = loadVideoRoomRankingConfig(svc({ cacheTtlSeconds: '45', hostCoinWeight: '3' }));
    expect(cfg.cacheTtlSeconds).toBe(45);
    expect(cfg.weights.host.coins).toBe(3);
  });

  it('falls back rather than propagating NaN or empty strings', () => {
    const cfg = loadVideoRoomRankingConfig(svc({ cacheTtlSeconds: 'abc', coalesceWindowMs: '' }));
    expect(cfg.cacheTtlSeconds).toBe(15);
    expect(cfg.coalesceWindowMs).toBe(1_000);
  });

  it('reads the string "false" as false rather than truthy', () => {
    expect(loadVideoRoomRankingConfig(svc({ enabled: 'false' })).enabled).toBe(false);
  });
});
```

- [ ] **Step 7: Implement the config**

Create `src/modules/video-rooms/config/video-room-ranking.config.ts`:

```ts
import type { ConfigService } from '@nestjs/config';
import { toBool } from './video-room-gift.config';

/**
 * Typed view of the `videoRoomRanking` namespace.
 *
 * Weights are config rather than constants because they are the product
 * decision most likely to be retuned after launch — and because the SAME values
 * must drive both the incremental write path and the recompute pass. A weight
 * that lived in two places would let the two paths silently disagree, which is
 * exactly the drift the recompute exists to eliminate.
 *
 * `toBool` is reused for the same reason VR-10/11 do: the repo-wide
 * `z.coerce.boolean()` idiom turns the STRING "false" into `true`.
 */
export interface HostWeights {
  coins: number;
  gifts: number;
  watchSeconds: number;
  peakViewers: number;
  pkWin: number;
  treasureEvent: number;
}

export interface RoomWeights {
  giftCoins: number;
  peakViewers: number;
  avgWatchSeconds: number;
  pkCount: number;
  treasureCount: number;
}

export interface PkWeights {
  win: number;
  loss: number;
  score: number;
  giftCoins: number;
}

export interface VideoRoomRankingConfig {
  /** Master switch. When false the write path no-ops and reads serve snapshots. */
  enabled: boolean;
  /** TTL on a hydrated leaderboard page. */
  cacheTtlSeconds: number;
  /** How long a source event's dedupe marker survives. */
  dedupeTtlSeconds: number;
  /** TTL refreshed on every write to a room-scoped ladder, so dead rooms evict. */
  roomLadderTtlSeconds: number;
  /** TTL on a derived (quarterly/yearly) ladder. */
  derivedLadderTtlSeconds: number;
  /** Socket broadcast coalescing window per room. */
  coalesceWindowMs: number;
  /** Entries broadcast in a coalesced ranking update. */
  broadcastTopN: number;
  weights: { host: HostWeights; rooms: RoomWeights; pk: PkWeights };
  /** Snapshot retention. 0 means "never prune". */
  retentionDays: { hourly: number; daily: number; weekly: number };
  /** Ceiling on a custom range, in days. */
  maxCustomRangeDays: number;
}

interface RawConfig {
  enabled?: boolean | string;
  cacheTtlSeconds?: number | string;
  dedupeTtlSeconds?: number | string;
  roomLadderTtlSeconds?: number | string;
  derivedLadderTtlSeconds?: number | string;
  coalesceWindowMs?: number | string;
  broadcastTopN?: number | string;
  hostCoinWeight?: number | string;
  hostGiftWeight?: number | string;
  hostWatchSecondWeight?: number | string;
  hostPeakViewerWeight?: number | string;
  hostPkWinWeight?: number | string;
  hostTreasureEventWeight?: number | string;
  roomGiftCoinWeight?: number | string;
  roomPeakViewerWeight?: number | string;
  roomAvgWatchSecondWeight?: number | string;
  roomPkCountWeight?: number | string;
  roomTreasureCountWeight?: number | string;
  pkWinWeight?: number | string;
  pkLossWeight?: number | string;
  pkScoreWeight?: number | string;
  pkGiftCoinWeight?: number | string;
  retentionHourlyDays?: number | string;
  retentionDailyDays?: number | string;
  retentionWeeklyDays?: number | string;
  maxCustomRangeDays?: number | string;
}

/**
 * Coerce with a fallback. `Number('')` is 0 and `Number('abc')` is NaN — a 0
 * weight silently removes a signal from the composite and a NaN poisons every
 * score in the ladder, so anything non-finite falls back to the default.
 */
function num(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadVideoRoomRankingConfig(config: ConfigService): VideoRoomRankingConfig {
  const raw = config.get<RawConfig>('videoRoomRanking');
  if (!raw) {
    throw new Error('videoRoomRanking config namespace is not registered');
  }
  return {
    enabled: toBool(raw.enabled, true),
    cacheTtlSeconds: num(raw.cacheTtlSeconds, 15),
    dedupeTtlSeconds: num(raw.dedupeTtlSeconds, 172_800), // 48h
    roomLadderTtlSeconds: num(raw.roomLadderTtlSeconds, 604_800), // 7d
    derivedLadderTtlSeconds: num(raw.derivedLadderTtlSeconds, 86_400),
    coalesceWindowMs: num(raw.coalesceWindowMs, 1_000),
    broadcastTopN: num(raw.broadcastTopN, 10),
    weights: {
      host: {
        coins: num(raw.hostCoinWeight, 1),
        gifts: num(raw.hostGiftWeight, 5),
        watchSeconds: num(raw.hostWatchSecondWeight, 0.01),
        peakViewers: num(raw.hostPeakViewerWeight, 2),
        pkWin: num(raw.hostPkWinWeight, 500),
        treasureEvent: num(raw.hostTreasureEventWeight, 50),
      },
      rooms: {
        giftCoins: num(raw.roomGiftCoinWeight, 1),
        peakViewers: num(raw.roomPeakViewerWeight, 10),
        avgWatchSeconds: num(raw.roomAvgWatchSecondWeight, 0.05),
        pkCount: num(raw.roomPkCountWeight, 100),
        treasureCount: num(raw.roomTreasureCountWeight, 25),
      },
      pk: {
        win: num(raw.pkWinWeight, 1000),
        loss: num(raw.pkLossWeight, 0),
        score: num(raw.pkScoreWeight, 1),
        giftCoins: num(raw.pkGiftCoinWeight, 0.5),
      },
    },
    retentionDays: {
      hourly: num(raw.retentionHourlyDays, 90),
      daily: num(raw.retentionDailyDays, 400),
      weekly: num(raw.retentionWeeklyDays, 400),
    },
    maxCustomRangeDays: num(raw.maxCustomRangeDays, 366),
  };
}
```

- [ ] **Step 8: Register the namespace**

In `src/config/configuration.ts`, after `videoRoomPkConfig`, add:

```ts
export const videoRoomRankingConfig = registerAs('videoRoomRanking', () => ({
  enabled: process.env.VIDEO_ROOM_RANKING_ENABLED,
  cacheTtlSeconds: process.env.VIDEO_ROOM_RANKING_CACHE_TTL_SECONDS,
  dedupeTtlSeconds: process.env.VIDEO_ROOM_RANKING_DEDUPE_TTL_SECONDS,
  roomLadderTtlSeconds: process.env.VIDEO_ROOM_RANKING_ROOM_LADDER_TTL_SECONDS,
  derivedLadderTtlSeconds: process.env.VIDEO_ROOM_RANKING_DERIVED_LADDER_TTL_SECONDS,
  coalesceWindowMs: process.env.VIDEO_ROOM_RANKING_COALESCE_WINDOW_MS,
  broadcastTopN: process.env.VIDEO_ROOM_RANKING_BROADCAST_TOP_N,
  hostCoinWeight: process.env.VIDEO_ROOM_RANKING_HOST_COIN_WEIGHT,
  hostGiftWeight: process.env.VIDEO_ROOM_RANKING_HOST_GIFT_WEIGHT,
  hostWatchSecondWeight: process.env.VIDEO_ROOM_RANKING_HOST_WATCH_SECOND_WEIGHT,
  hostPeakViewerWeight: process.env.VIDEO_ROOM_RANKING_HOST_PEAK_VIEWER_WEIGHT,
  hostPkWinWeight: process.env.VIDEO_ROOM_RANKING_HOST_PK_WIN_WEIGHT,
  hostTreasureEventWeight: process.env.VIDEO_ROOM_RANKING_HOST_TREASURE_EVENT_WEIGHT,
  roomGiftCoinWeight: process.env.VIDEO_ROOM_RANKING_ROOM_GIFT_COIN_WEIGHT,
  roomPeakViewerWeight: process.env.VIDEO_ROOM_RANKING_ROOM_PEAK_VIEWER_WEIGHT,
  roomAvgWatchSecondWeight: process.env.VIDEO_ROOM_RANKING_ROOM_AVG_WATCH_SECOND_WEIGHT,
  roomPkCountWeight: process.env.VIDEO_ROOM_RANKING_ROOM_PK_COUNT_WEIGHT,
  roomTreasureCountWeight: process.env.VIDEO_ROOM_RANKING_ROOM_TREASURE_COUNT_WEIGHT,
  pkWinWeight: process.env.VIDEO_ROOM_RANKING_PK_WIN_WEIGHT,
  pkLossWeight: process.env.VIDEO_ROOM_RANKING_PK_LOSS_WEIGHT,
  pkScoreWeight: process.env.VIDEO_ROOM_RANKING_PK_SCORE_WEIGHT,
  pkGiftCoinWeight: process.env.VIDEO_ROOM_RANKING_PK_GIFT_COIN_WEIGHT,
  retentionHourlyDays: process.env.VIDEO_ROOM_RANKING_RETENTION_HOURLY_DAYS,
  retentionDailyDays: process.env.VIDEO_ROOM_RANKING_RETENTION_DAILY_DAYS,
  retentionWeeklyDays: process.env.VIDEO_ROOM_RANKING_RETENTION_WEEKLY_DAYS,
  maxCustomRangeDays: process.env.VIDEO_ROOM_RANKING_MAX_CUSTOM_RANGE_DAYS,
}));
```

and add `videoRoomRankingConfig` to the exported array that already contains `videoRoomTreasureConfig, videoRoomPkConfig`.

- [ ] **Step 9: Write the failing exceptions test**

Create `src/modules/video-rooms/exceptions/video-room-ranking.exceptions.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from 'src/common/exceptions';
import {
  AggregationException,
  LeaderboardException,
  RankingCacheException,
  RankingException,
  RankingPeriodException,
} from './video-room-ranking.exceptions';

describe('VR-13 exceptions', () => {
  it('binds each class to its own error code', () => {
    expect(new RankingException('x').errorCode).toBe(ERROR_CODES.VIDEO_ROOM_RANKING_INVALID);
    expect(new LeaderboardException('x').errorCode).toBe(ERROR_CODES.VIDEO_ROOM_LEADERBOARD_INVALID);
    expect(new AggregationException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_RANKING_AGGREGATION_FAILED,
    );
    expect(new RankingCacheException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_RANKING_CACHE_FAILED,
    );
    expect(new RankingPeriodException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_RANKING_PERIOD_INVALID,
    );
  });

  it('defaults state violations to 409 and a malformed period to 400', () => {
    expect(new RankingException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new LeaderboardException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new AggregationException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new RankingCacheException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    // A period/dateKey that will not parse IS a malformed request.
    expect(new RankingPeriodException('x').getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('accepts an explicit status override', () => {
    expect(new RankingException('x', HttpStatus.NOT_FOUND).getStatus()).toBe(HttpStatus.NOT_FOUND);
  });
});
```

- [ ] **Step 10: Implement the exceptions**

Create `src/modules/video-rooms/exceptions/video-room-ranking.exceptions.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

/**
 * VR-13 domain exceptions — thin `BusinessException` subclasses binding one
 * error code each, so callers get a named type to catch while the global
 * ERROR_CODES registry stays the single source of truth for clients. The VR-11
 * and VR-12 exception files are the pattern.
 *
 * Four default to 409 CONFLICT: they fire when the request was well-formed but
 * the engine's state disallowed it. RankingPeriodException is the exception —
 * an unparseable period or dateKey genuinely is a malformed request, and a 409
 * would tell the client to retry something that can never succeed.
 */

/** A ranking read or write was refused: unknown dimension, malformed scope. */
export class RankingException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_INVALID, message, status);
  }
}

/** A leaderboard could not be assembled: bad projection, missing snapshot. */
export class LeaderboardException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_LEADERBOARD_INVALID, message, status);
  }
}

/** A recompute could not run or complete. Retried by BullMQ before any client sees it. */
export class AggregationException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_AGGREGATION_FAILED, message, status);
  }
}

/** The leaderboard cache could not be read or written in a path that required it. */
export class RankingCacheException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_CACHE_FAILED, message, status);
  }
}

/** The requested period or dateKey is not valid — a 400, not a conflict. */
export class RankingPeriodException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_PERIOD_INVALID, message, status);
  }
}
```

- [ ] **Step 11: Run all three specs plus lint**

```bash
pnpm test -- src/modules/video-rooms/constants/video-room-ranking.constants.spec.ts src/modules/video-rooms/config/video-room-ranking.config.spec.ts src/modules/video-rooms/exceptions/video-room-ranking.exceptions.spec.ts
pnpm lint
```

Expected: all PASS, lint exit 0.

- [ ] **Step 12: Report and stop**

**Do not commit.**

---

## Task 7: VR-13 — RankingScoreEngine

The single place weights become a score. Both the incremental path and the recompute path call it, which is what makes the two agree.

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking-score.engine.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-score.engine.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomRankingConfig`, `loadVideoRoomRankingConfig` (Task 6); `VideoRoomRankingDimension` (Task 6); `ConfigService`.
- Produces:
  - `interface HostMetrics { coins: number; gifts: number; watchSeconds: number; peakViewers: number; pkWins: number; treasureEvents: number }`
  - `interface RoomMetrics { giftCoins: number; peakViewers: number; avgWatchSeconds: number; pkCount: number; treasureCount: number }`
  - `interface PkMetrics { wins: number; losses: number; score: number; giftCoins: number }`
  - `type RankingMetrics = Partial<HostMetrics & RoomMetrics & PkMetrics> & { coinsSpent?: number; coinsReceived?: number; treasureCoins?: number; vipOrdinal?: number }`
  - `class VideoRoomRankingScoreEngine` with `composite(dimension, metrics): number` and `deltaFor(dimension, metrics): number`

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-ranking-score.engine.spec.ts`:

```ts
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

const RAW = {}; // empty namespace → documented defaults
const config = { get: () => RAW } as never;

describe('VideoRoomRankingScoreEngine', () => {
  const engine = new VideoRoomRankingScoreEngine(config);

  describe('hosts', () => {
    it('sums every weighted signal', () => {
      // coins 100*1 + gifts 4*5 + watch 3600*0.01 + peak 12*2 + pkWin 1*500 + treasure 2*50
      // = 100 + 20 + 36 + 24 + 500 + 100 = 780
      expect(
        engine.composite(VideoRoomRankingDimension.HOSTS, {
          coins: 100,
          gifts: 4,
          watchSeconds: 3600,
          peakViewers: 12,
          pkWins: 1,
          treasureEvents: 2,
        }),
      ).toBe(780);
    });

    it('treats absent metrics as zero rather than NaN', () => {
      expect(engine.composite(VideoRoomRankingDimension.HOSTS, { coins: 50 })).toBe(50);
      expect(engine.composite(VideoRoomRankingDimension.HOSTS, {})).toBe(0);
    });

    it('rounds fractional contributions to an integer score', () => {
      // 55 * 0.01 = 0.55 → 1
      expect(engine.composite(VideoRoomRankingDimension.HOSTS, { watchSeconds: 55 })).toBe(1);
    });
  });

  describe('rooms', () => {
    it('weights engagement signals above raw coins', () => {
      // 1000*1 + 50*10 + 600*0.05 + 2*100 + 1*25 = 1000 + 500 + 30 + 200 + 25 = 1755
      expect(
        engine.composite(VideoRoomRankingDimension.ROOMS, {
          giftCoins: 1000,
          peakViewers: 50,
          avgWatchSeconds: 600,
          pkCount: 2,
          treasureCount: 1,
        }),
      ).toBe(1755);
    });
  });

  describe('pk', () => {
    it('makes a win dominate raw score', () => {
      // 1*1000 + 0*0 + 250*1 + 400*0.5 = 1000 + 250 + 200 = 1450
      expect(
        engine.composite(VideoRoomRankingDimension.PK, {
          wins: 1,
          losses: 0,
          score: 250,
          giftCoins: 400,
        }),
      ).toBe(1450);
    });

    it('scores a loss without a win at the loss weight only', () => {
      expect(engine.composite(VideoRoomRankingDimension.PK, { wins: 0, losses: 1 })).toBe(0);
    });
  });

  describe('pass-through dimensions', () => {
    it('scores gifters by coins spent and receivers by coins received', () => {
      expect(engine.composite(VideoRoomRankingDimension.GIFTERS, { coinsSpent: 900 })).toBe(900);
      expect(engine.composite(VideoRoomRankingDimension.RECEIVERS, { coinsReceived: 700 })).toBe(700);
    });

    it('scores treasure by coins won', () => {
      expect(engine.composite(VideoRoomRankingDimension.TREASURE, { treasureCoins: 250 })).toBe(250);
    });

    it('scores vip by ordinal, using coins spent only as a tiebreak', () => {
      const l5 = engine.composite(VideoRoomRankingDimension.VIP, { vipOrdinal: 5, coinsSpent: 10 });
      const l4 = engine.composite(VideoRoomRankingDimension.VIP, {
        vipOrdinal: 4,
        coinsSpent: 9_999_999,
      });
      // A higher VIP level must outrank any amount of spend at a lower level.
      expect(l5).toBeGreaterThan(l4);
    });
  });

  describe('deltaFor', () => {
    it('equals composite — the incremental and recompute paths must not diverge', () => {
      const metrics = { coins: 100, gifts: 4 };
      expect(engine.deltaFor(VideoRoomRankingDimension.HOSTS, metrics)).toBe(
        engine.composite(VideoRoomRankingDimension.HOSTS, metrics),
      );
    });
  });

  it('never returns NaN or a negative zero for empty input on any dimension', () => {
    for (const dim of Object.values(VideoRoomRankingDimension)) {
      const score = engine.composite(dim, {});
      expect(Number.isFinite(score)).toBe(true);
      expect(Object.is(score, -0)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-score.engine.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `src/modules/video-rooms/services/video-room-ranking-score.engine.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';

export interface HostMetrics {
  coins: number;
  gifts: number;
  watchSeconds: number;
  peakViewers: number;
  pkWins: number;
  treasureEvents: number;
}

export interface RoomMetrics {
  giftCoins: number;
  peakViewers: number;
  avgWatchSeconds: number;
  pkCount: number;
  treasureCount: number;
}

export interface PkMetrics {
  wins: number;
  losses: number;
  score: number;
  giftCoins: number;
}

/**
 * Every metric any dimension can carry. Partial by design: the incremental path
 * knows one signal at a time (a gift's coins), while the recompute path knows
 * all of them — and both must be able to call the same function.
 */
export type RankingMetrics = Partial<HostMetrics & RoomMetrics & PkMetrics> & {
  coinsSpent?: number;
  coinsReceived?: number;
  treasureCoins?: number;
  vipOrdinal?: number;
};

/** VIP level dominates spend: one level is worth more than any tiebreak can be. */
const VIP_LEVEL_STRIDE = 1_000_000_000;

/**
 * Turns a metric bag into the single number a ZSET can hold.
 *
 * This is the ONLY place weights are applied. The incremental write path calls
 * `deltaFor` with the one signal it just observed; the recompute pass calls
 * `composite` with every signal for a window. Because both land here, a ladder
 * rebuilt from source tables lands on the same number the live increments
 * produced — which is the entire premise of the lambda model. Any second
 * implementation of this arithmetic would reintroduce the drift it removes.
 */
@Injectable()
export class VideoRoomRankingScoreEngine {
  private readonly config: VideoRoomRankingConfig;

  constructor(config: ConfigService) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  /** Absent metrics count as zero, never NaN — a NaN poisons the whole ladder. */
  private n(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  composite(dimension: VideoRoomRankingDimension, metrics: RankingMetrics): number {
    const w = this.config.weights;

    switch (dimension) {
      case VideoRoomRankingDimension.HOSTS:
        return this.round(
          this.n(metrics.coins) * w.host.coins +
            this.n(metrics.gifts) * w.host.gifts +
            this.n(metrics.watchSeconds) * w.host.watchSeconds +
            this.n(metrics.peakViewers) * w.host.peakViewers +
            this.n(metrics.pkWins) * w.host.pkWin +
            this.n(metrics.treasureEvents) * w.host.treasureEvent,
        );

      case VideoRoomRankingDimension.ROOMS:
        return this.round(
          this.n(metrics.giftCoins) * w.rooms.giftCoins +
            this.n(metrics.peakViewers) * w.rooms.peakViewers +
            this.n(metrics.avgWatchSeconds) * w.rooms.avgWatchSeconds +
            this.n(metrics.pkCount) * w.rooms.pkCount +
            this.n(metrics.treasureCount) * w.rooms.treasureCount,
        );

      case VideoRoomRankingDimension.PK:
        return this.round(
          this.n(metrics.wins) * w.pk.win +
            this.n(metrics.losses) * w.pk.loss +
            this.n(metrics.score) * w.pk.score +
            this.n(metrics.giftCoins) * w.pk.giftCoins,
        );

      case VideoRoomRankingDimension.GIFTERS:
        return this.round(this.n(metrics.coinsSpent));

      case VideoRoomRankingDimension.RECEIVERS:
        return this.round(this.n(metrics.coinsReceived));

      case VideoRoomRankingDimension.TREASURE:
        return this.round(this.n(metrics.treasureCoins));

      case VideoRoomRankingDimension.VIP:
        // Level is the ranking; spend only orders users within a level. The
        // stride guarantees that, so a whale at VIP 4 can never outrank a
        // VIP 5 no matter how much they spend.
        return this.round(
          this.n(metrics.vipOrdinal) * VIP_LEVEL_STRIDE + this.n(metrics.coinsSpent),
        );
    }
  }

  /**
   * The increment for one observed signal. Identical to `composite` by
   * construction — a ZSET score is additive, so "the delta for these metrics"
   * and "the score of these metrics" are the same arithmetic. Kept as a named
   * method so call sites read as intent rather than coincidence.
   */
  deltaFor(dimension: VideoRoomRankingDimension, metrics: RankingMetrics): number {
    return this.composite(dimension, metrics);
  }

  /** `+ 0` normalises -0 to 0 so a ZSET member never carries a negative zero. */
  private round(value: number): number {
    return Math.round(value) + 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-score.engine.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Report and stop**

**Do not commit.**

---

## Remaining tasks

Tasks 8–19 continue in a second document to keep each file reviewable:

`docs/superpowers/plans/2026-07-22-vr13-ranking-engine-part2.md`

| Task | Deliverable |
|---|---|
| 8 | `VideoRoomRankingScopeResolver` — user → country/city, Redis-cached |
| 9 | `VideoRoomRankingRepository` — the 3 tables + source-table aggregate reads |
| 10 | `video-room-ranking.events.ts` — 9 domain events |
| 11 | `VideoRoomRankingService` — write path: dedupe, fan-out, version bump |
| 12 | `VideoRoomRankingActivityListener` — gift/PK/treasure/room → write path |
| 13 | `VideoRoomRankingAggregationService` — recompute a window from sources |
| 14 | `VideoRoomRankingSnapshotService` + `VideoRoomRankingRecoveryService` |
| 15 | `VideoRoomRankingJobsService` + `VideoRoomRankingScheduler` |
| 16 | `VideoRoomRankingQueryService` + `VideoRoomLeaderboardService` |
| 17 | DTOs + `VideoRoomsRankingsController` (11 routes, full Swagger) |
| 18 | Socket + metrics + audit listeners; `VideoRoomsMetrics` additions |
| 19 | Module wiring + `video-rooms-ranking.integration.spec.ts` |
