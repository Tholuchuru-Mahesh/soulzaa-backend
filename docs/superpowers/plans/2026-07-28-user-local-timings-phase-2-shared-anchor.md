# User-Local Timings — Phase 2: Shared Surfaces onto the Anchor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every shared/competitive timing off hardcoded UTC and server-local arithmetic onto the configurable platform anchor, with no observable behaviour change.

**Architecture:** Each of ~23 call sites replaces its hand-rolled date maths with `await this.zones.platform()` plus a `TimeService` call. Because `platform.timezone` seeds to `'UTC'`, every output is byte-identical to today — which makes the existing test suite the regression proof.

**Tech Stack:** NestJS 11, Prisma 6, Jest, luxon, `TimeService`/`ZoneResolverService` from Phase 1.

## Global Constraints

- **Depends on Phase 1** (`docs/superpowers/plans/2026-07-28-user-local-timings-phase-1-foundation.md`). Do not start until it has merged.
- Spec: `docs/superpowers/specs/2026-07-28-user-local-timings-design.md`
- **Zero behaviour change while the anchor is `'UTC'`.** Existing tests must pass *unmodified*. A test that needs editing is a signal the refactor changed semantics — stop and re-read the original code.
- **Never change a persisted key's format.** `yyyyMMdd`, `yyyy-MM-dd` and `yyyyMMddHH` all exist in production data behind unique constraints. Preserving each exactly is the point of Task 1.
- `TimeModule` is `@Global()`, so services only need constructor injection — no module `imports` edits.
- This phase has no deploy-timing constraint and can ship any hour of any day.
- Do not commit unless a step says to. Never `git push`.

---

### Task 1: `TimeService.format()` — preserve the three existing key formats

**Files:**
- Modify: `src/common/time/time.service.ts`
- Test: `src/common/time/time.service.spec.ts`

**Interfaces:**
- Consumes: `TimeService` (Phase 1)
- Produces: `TimeService.format(at: Date, zone: string, fmt: string): string` — a zone-aware pass-through to luxon's `toFormat`.

- [ ] **Step 1: Write the failing test**

Append to `src/common/time/time.service.spec.ts`:

```ts
describe('TimeService.format', () => {
  const time = new TimeService();
  const at = new Date('2026-07-27T19:00:00.000Z'); // 00:30 Jul 28 IST

  it('reproduces the yyyyMMdd key format in the given zone', () => {
    expect(time.format(at, 'UTC', 'yyyyMMdd')).toBe('20260727');
    expect(time.format(at, 'Asia/Kolkata', 'yyyyMMdd')).toBe('20260728');
  });

  it('reproduces the dashed ISO date format used by the statistics tables', () => {
    expect(time.format(at, 'UTC', 'yyyy-MM-dd')).toBe('2026-07-27');
    expect(time.format(at, 'Asia/Kolkata', 'yyyy-MM-dd')).toBe('2026-07-28');
  });

  it('reproduces the hourly key format', () => {
    expect(time.format(at, 'UTC', 'yyyyMMddHH')).toBe('2026072719');
    expect(time.format(at, 'Asia/Kolkata', 'yyyyMMddHH')).toBe('2026072800');
  });

  it('matches the exact output of the code it replaces, under UTC', () => {
    const now = new Date('2026-02-03T04:05:06.000Z');
    // Old: new Date().toISOString().split('T')[0]
    expect(time.format(now, 'UTC', 'yyyy-MM-dd')).toBe(now.toISOString().split('T')[0]);
    // Old: `${y}${m}${d}` from getUTC* parts
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    expect(time.format(now, 'UTC', 'yyyyMMdd')).toBe(`${y}${m}${d}`);
  });

  it('throws on an invalid zone', () => {
    expect(() => time.format(at, 'Not/AZone', 'yyyyMMdd')).toThrow(/Not\/AZone/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: FAIL — `time.format is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `TimeService`:

```ts
  /**
   * Zone-aware formatting, for call sites that must keep a persisted key's
   * exact shape. Three formats exist in live data behind unique constraints
   * (`yyyyMMdd`, `yyyy-MM-dd`, `yyyyMMddHH`); changing any of them would
   * orphan every existing row, so those sites format explicitly rather than
   * adopting periodKey's canonical shape.
   */
  format(at: Date, zone: string, fmt: string): string {
    return this.inZone(at, zone).toFormat(fmt);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/time/
git commit -m "feat(time): add zone-aware format for legacy key shapes"
```

---

### Task 2: Treasure boxes — 8 sites plus the reset scheduler

**Files:**
- Modify: `src/modules/treasure-boxes/services/treasure-box.service.ts:33,114`
- Modify: `src/modules/treasure-boxes/services/treasure-progress.service.ts:68`
- Modify: `src/modules/treasure-boxes/services/treasure.service.ts:110,252,444`
- Modify: `src/modules/treasure-boxes/services/treasure-reset.service.ts:29-57,66`
- Test: `src/modules/treasure-boxes/services/treasure-reset.service.spec.ts` (create)

**Interfaces:**
- Consumes: `TimeService.window`, `TimeService.nextMidnight`, `ZoneResolverService.platform`
- Produces: no new public API — behaviour is unchanged under a UTC anchor.

- [ ] **Step 1: Replace the six `todayStart` computations**

In each of `treasure-box.service.ts` (lines 33 and 114), `treasure-progress.service.ts` (line 68), and `treasure.service.ts` (lines 110, 252, 444), replace:

```ts
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
```

with:

```ts
    const zone = await this.zones.platform();
    const todayStart = this.time.window('daily', new Date(), zone).start;
```

Inject both services into each constructor:

```ts
    private readonly time: TimeService,
    private readonly zones: ZoneResolverService,
```

importing from `src/common/time`. Every enclosing method is already `async`, so no signature changes.

- [ ] **Step 2: Write the failing scheduler test**

Create `src/modules/treasure-boxes/services/treasure-reset.service.spec.ts`:

```ts
import { TimeService, ZoneResolverService } from 'src/common/time';
import { TreasureResetService } from './treasure-reset.service';

describe('TreasureResetService scheduling', () => {
  const time = new TimeService();
  let zones: { platform: jest.Mock };
  let prisma: any;
  let service: TreasureResetService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T19:00:00.000Z'));
    zones = { platform: jest.fn().mockResolvedValue('UTC') };
    prisma = { treasureSession: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() } };
    service = new TreasureResetService(
      prisma,
      {} as any,
      {} as any,
      time,
      zones as unknown as ZoneResolverService,
    );
  });

  afterEach(() => {
    service.onApplicationShutdown();
    jest.useRealTimers();
  });

  it('archives sessions created before the anchor day start', async () => {
    await service.archiveStaleActiveSessions();
    expect(prisma.treasureSession.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        createdAt: { lt: new Date('2026-07-27T00:00:00.000Z') },
      }),
    });
  });

  it('uses the anchor day start, not UTC, when the anchor moves', async () => {
    zones.platform.mockResolvedValue('Asia/Kolkata');
    await service.archiveStaleActiveSessions();
    expect(prisma.treasureSession.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        // 00:00 Jul 28 IST — the current IST day started 30 minutes ago.
        createdAt: { lt: new Date('2026-07-27T18:30:00.000Z') },
      }),
    });
  });

  it('re-arms from the next anchor midnight instead of a fixed 24h interval', async () => {
    zones.platform.mockResolvedValue('America/New_York');
    await service.scheduleDailyReset();
    // 19:00Z Jul 27 is 15:00 EDT; next local midnight is 04:00Z Jul 28 — 9h away, not 24h.
    expect(jest.getTimerCount()).toBe(1);
    expect(service.nextRunAt?.toISOString()).toBe('2026-07-28T04:00:00.000Z');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/modules/treasure-boxes/services/treasure-reset.service.spec.ts`
Expected: FAIL — `service.scheduleDailyReset is not a function`.

- [ ] **Step 4: Rewrite the scheduler**

Replace `_scheduleDailyReset` and the `archiveStaleActiveSessions` day-start in `treasure-reset.service.ts`. The `setTimeout`-then-`setInterval(24h)` pattern is replaced by a self-rearming `setTimeout`, because on a DST day the next local midnight is 23 or 25 hours away and a fixed 24-hour interval would drift permanently:

```ts
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { TimeService, ZoneResolverService } from 'src/common/time';

@Injectable()
export class TreasureResetService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasureResetService.name);
  private _dailyTimer: NodeJS.Timeout | null = null;

  /** Exposed for tests and ops visibility. */
  nextRunAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly boxService: TreasureBoxService,
    private readonly auditService: TreasureAuditService,
    private readonly time: TimeService,
    private readonly zones: ZoneResolverService,
  ) {}

  onApplicationBootstrap() {
    void this.scheduleDailyReset();
  }

  onApplicationShutdown() {
    if (this._dailyTimer) clearTimeout(this._dailyTimer);
    this._dailyTimer = null;
  }

  /**
   * Arms a one-shot timer for the next midnight on the platform anchor, then
   * re-arms itself after each run. Deliberately not setInterval(24h): a DST
   * day is 23 or 25 hours long, so a fixed interval would drift off midnight
   * permanently after the first transition.
   */
  async scheduleDailyReset(): Promise<void> {
    if (this._dailyTimer) clearTimeout(this._dailyTimer);

    const zone = await this.zones.platform();
    const next = this.time.nextMidnight(zone);
    this.nextRunAt = next;
    const delay = Math.max(0, next.getTime() - Date.now());

    this.logger.log(
      `Treasure daily reset scheduled for ${next.toISOString()} (${zone}), in ${Math.round(delay / 60000)} minutes.`,
    );

    this._dailyTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.archiveStaleActiveSessions();
        } catch (err) {
          this.logger.error(`Daily stale-session archive error: ${(err as Error).message}`);
        } finally {
          await this.scheduleDailyReset();
        }
      })();
    }, delay);
  }
```

And in `archiveStaleActiveSessions`, replace the two `todayStart` lines with:

```ts
    const zone = await this.zones.platform();
    const todayStart = this.time.window('daily', new Date(), zone).start;
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/treasure-boxes`
Expected: PASS — the new spec plus every pre-existing treasure spec, **unmodified**.

- [ ] **Step 6: Commit**

```bash
git add src/modules/treasure-boxes/
git commit -m "refactor(treasure): anchor daily boundaries and reset job to platform timezone"
```

---

### Task 3: `RankingPeriodResolver` — replace the `utc | local` toggle with an explicit zone

**Files:**
- Modify: `src/modules/rankings/services/ranking-period.resolver.ts:16,49-93`
- Modify: `src/modules/rankings/services/rankings.service.ts:434-436`
- Test: `src/modules/rankings/services/ranking-period.resolver.spec.ts:48`

**Interfaces:**
- Consumes: `TimeService.format`, `ZoneResolverService.platform`
- Produces: `dateKeyFor(period: RankingPeriodName, date: Date, zone?: string): string` — `zone` defaults to `'UTC'`. The `RankingTimezone` type and the `'local'` mode are deleted.

- [ ] **Step 1: Replace the toggle with a zone parameter**

In `ranking-period.resolver.ts`, delete the `RankingTimezone` type and its docblock, then change `dateKeyFor` and `isoWeekKey` to take `zone: string = 'UTC'`, deriving parts through the injected `TimeService`:

```ts
  dateKeyFor(period: RankingPeriodName, date: Date, zone: string = 'UTC'): string {
    if (period === 'alltime') return 'alltime';
    if (period === 'custom') {
      throw new Error('dateKeyFor: "custom" has no derivable date key — supply one explicitly');
    }

    switch (period) {
      case 'hourly':
        return this.time.format(date, zone, 'yyyyMMddHH');
      case 'daily':
        return this.time.format(date, zone, 'yyyyMMdd');
      case 'monthly':
        return this.time.format(date, zone, 'yyyyMM');
      case 'quarterly':
        return `${this.time.format(date, zone, 'yyyy')}Q${this.time.format(date, zone, 'q')}`;
      case 'yearly':
        return this.time.format(date, zone, 'yyyy');
      case 'weekly':
        return this.time.periodKey('weekly', date, zone);
    }
  }
```

Delete the now-unused private `isoWeekKey` method — `TimeService.periodKey('weekly', ...)` already produces the identical ISO-week key, and Phase 1 Task 1 tests it against the same `2026W53` / `2025W01` cases this file's spec asserts.

Leave `windowFor`, `isoWeekStart`, `constituentsOf`, `isValidDateKey` and `isoWeeksInYear` untouched: they parse a key back into a UTC range and are not zone-dependent.

- [ ] **Step 2: Update the legacy `'local'` caller**

`rankings.service.ts:434-436` is the only `'local'` caller. Its `'local'` meant *server*-local, which in the production container is UTC. Replace:

```ts
      daily: this.periods.dateKeyFor('daily', date, 'local'),
      weekly: this.periods.dateKeyFor('weekly', date, 'local'),
      monthly: this.periods.dateKeyFor('monthly', date, 'local'),
```

with:

```ts
      // Was 'local' — i.e. the server's zone, which is UTC in the production
      // container. Now explicitly the platform anchor, which seeds to UTC, so
      // production keys are unchanged while dev machines stop drifting.
      daily: this.periods.dateKeyFor('daily', date, zone),
      weekly: this.periods.dateKeyFor('weekly', date, zone),
      monthly: this.periods.dateKeyFor('monthly', date, zone),
```

Resolve `const zone = await this.zones.platform();` at the top of the enclosing method and inject `ZoneResolverService`.

- [ ] **Step 3: Update the one spec line that asserts the deleted mode**

`ranking-period.resolver.spec.ts:48` calls `dateKeyFor('daily', d, 'local')`. Replace that test with one that pins zone behaviour:

```ts
    it('derives the key in the supplied zone, defaulting to UTC', () => {
      const d = new Date('2026-07-27T19:00:00.000Z');
      expect(resolver.dateKeyFor('daily', d)).toBe('20260727');
      expect(resolver.dateKeyFor('daily', d, 'Asia/Kolkata')).toBe('20260728');
    });
```

Construct the resolver with `new RankingPeriodResolver(new TimeService())` in that spec's setup.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/rankings src/modules/video-rooms`
Expected: PASS. Every other `dateKeyFor` assertion — including the `2026W53`, `2025W01` and quarterly boundary cases — passes unchanged, proving the luxon-backed keys match the hand-rolled ones exactly.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rankings/
git commit -m "refactor(rankings): replace utc|local toggle with an explicit timezone"
```

---

### Task 4: Enterprise rankings — five day-key helpers

**Files:**
- Modify: `src/modules/enterprise-rankings/services/ranking-statistics.service.ts:10-16`
- Modify: `src/modules/enterprise-rankings/services/ranking.service.ts:110-114`
- Modify: `src/modules/enterprise-rankings/services/leaderboard.service.ts:132-136`
- Modify: `src/modules/enterprise-rankings/services/ranking-snapshot.service.ts:97-101`
- Modify: `src/modules/enterprise-rankings/services/ranking-calculation.service.ts:288,318`

**Interfaces:**
- Consumes: `TimeService.format`, `TimeService.periodKey`, `ZoneResolverService.platform`
- Produces: no public API change. All five keep emitting `yyyyMMdd` / `yyyyMMddHH`.

- [ ] **Step 1: Convert the two `todayKey` getters**

`ranking-statistics.service.ts:10-16` currently reads:

```ts
  private get todayKey() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
```

A getter cannot await, so it becomes a method:

```ts
  private async todayKey(): Promise<string> {
    const zone = await this.zones.platform();
    return this.time.format(new Date(), zone, 'yyyyMMdd');
  }
```

Update every `this.todayKey` reference in the file to `await this.todayKey()`, and inject `TimeService` + `ZoneResolverService`. All callers are already `async`.

- [ ] **Step 2: Convert the two `buildCurrentDateKey` methods**

`ranking.service.ts:110-128` and `leaderboard.service.ts:132-150` are byte-identical. Replace the body of **both** with exactly this:

```ts
  private async buildCurrentDateKey(timeWindow: string): Promise<string> {
    const zone = await this.zones.platform();
    const now = new Date();

    switch (timeWindow) {
      case 'HOURLY':
        return this.time.format(now, zone, 'yyyyMMddHH');
      case 'DAILY':
        return this.time.format(now, zone, 'yyyyMMdd');
      case 'MONTHLY':
        return this.time.format(now, zone, 'yyyyMM');
      case 'YEARLY':
        return this.time.format(now, zone, 'yyyy');
      default:
        return 'alltime';
    }
  }
```

Each arm emits the same string as the template it replaces: `yyyyMMddHH` matches `` `${y}${m}${d}${HH}` ``, `yyyyMMdd` matches `` `${y}${m}${d}` ``, `yyyyMM` matches `` `${y}${m}` ``, `yyyy` matches `` `${y}` ``. Await both call sites.

- [ ] **Step 3: Convert the snapshot day key**

`ranking-snapshot.service.ts:97-101` — replace the four lines building `dailyKey` with:

```ts
    const zone = await this.zones.platform();
    const dailyKey = this.time.format(new Date(), zone, 'yyyyMMdd');
```

- [ ] **Step 4: Convert the calculation service**

`ranking-calculation.service.ts:288` uses the same `getUTC*` day-key shape — apply the Step 3 replacement. Line 318 is the hand-rolled ISO-week helper; replace the whole helper body with `return this.time.periodKey('weekly', date, zone)` and delete the Thursday arithmetic.

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/enterprise-rankings && npx tsc --noEmit`
Expected: PASS, unmodified.

- [ ] **Step 6: Commit**

```bash
git add src/modules/enterprise-rankings/
git commit -m "refactor(enterprise-rankings): anchor date keys to platform timezone"
```

---

### Task 5: Gift leaderboard and video-room analytics

**Files:**
- Modify: `src/modules/gifts/services/gift-leaderboard.service.ts:133,138-140`
- Modify: `src/modules/video-rooms/listeners/video-room-analytics.listener.ts:19`
- Modify: `src/modules/video-rooms/services/video-room-analytics-aggregation.service.ts:29`

**Interfaces:**
- Consumes: `TimeService.format`, `TimeService.periodKey`, `ZoneResolverService.platform`
- Produces: no public API change; the gift leaderboard keeps its `yyyy-MM-dd` day key.

- [ ] **Step 1: Convert the gift leaderboard**

`gift-leaderboard.service.ts:133` builds a dashed day key from `getUTC*` parts. Replace with:

```ts
    return this.time.format(d, zone, 'yyyy-MM-dd');
```

Lines 138-140 are the hand-rolled ISO-week helper; replace the body with `return this.time.periodKey('weekly', date, zone)` and delete the Thursday arithmetic. Thread `zone` in from `await this.zones.platform()` at the top of each public caller, and delete the now-unused private `pad` helper if nothing else uses it.

- [ ] **Step 2: Convert the two video-room analytics day keys**

Both `video-room-analytics.listener.ts:19` and `video-room-analytics-aggregation.service.ts:29` build a `dd` part via `getUTCDate()`. Replace each helper body with:

```ts
    const zone = await this.zones.platform();
    return this.time.format(date, zone, 'yyyyMMdd');
```

matching whatever separator the existing template emits — read the surrounding lines and keep the output byte-identical.

- [ ] **Step 3: Pass the anchor at every `dateKeyFor` call site**

`RankingPeriodResolver.dateKeyFor` defaults its `zone` to `'UTC'` (Task 3), because the resolver is pure and cannot await the anchor itself. That default means any caller which omits the argument stays pinned to UTC and will **not** follow the anchor when it moves — silently defeating this phase for video-room rankings.

Update all eight call sites to pass `await this.zones.platform()`:

- `video-room-ranking-jobs.service.ts:83,123`
- `video-room-leaderboard.service.ts:70`
- `video-room-ranking.service.ts:333,400`
- `video-room-ranking-query.service.ts:150,193,334`

Each becomes, for example:

```ts
    const zone = await this.zones.platform();
    const dateKey = query.dateKey ?? this.periods.dateKeyFor(query.period, new Date(), zone);
```

Resolve `zone` once at the top of each enclosing method rather than per call, and inject `ZoneResolverService` into each of the four services.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/gifts src/modules/video-rooms`
Expected: PASS, unmodified. `video-room-ranking-jobs.service.spec.ts:98-118` compares against `periods.dateKeyFor(...)` computed the same way, so it stays green under a UTC anchor.

- [ ] **Step 5: Commit**

```bash
git add src/modules/gifts/ src/modules/video-rooms/
git commit -m "refactor(gifts,video-rooms): anchor leaderboard, analytics and ranking keys"
```

---

### Task 6: Statistics day buckets — achievements, EXP, enterprise events

**Files:**
- Modify: `src/modules/achievements/services/achievement-statistics.service.ts:8-10`
- Modify: `src/modules/exp/services/level-statistics.service.ts:9`
- Modify: `src/modules/enterprise-events/services/event-statistics.service.ts:10-16`

**Interfaces:**
- Consumes: `TimeService.format`, `ZoneResolverService.platform`
- Produces: no public API change. Achievements and EXP keep `yyyy-MM-dd`; enterprise events keeps `yyyyMMdd`.

- [ ] **Step 1: Convert the achievements getter**

Replace:

```ts
  private get todayKey() {
    return new Date().toISOString().split('T')[0];
  }
```

with:

```ts
  private async todayKey(): Promise<string> {
    const zone = await this.zones.platform();
    return this.time.format(new Date(), zone, 'yyyy-MM-dd');
  }
```

and change each `const dateKey = this.todayKey;` to `const dateKey = await this.todayKey();`. Note the dashed format is deliberate — `achievement_statistics` has a `period_dateKey` unique constraint over existing dashed keys.

- [ ] **Step 2: Convert the EXP statistics key**

In `level-statistics.service.ts:9`, replace:

```ts
    const todayStr = new Date().toISOString().split('T')[0];
```

with:

```ts
    const zone = await this.zones.platform();
    const todayStr = this.time.format(new Date(), zone, 'yyyy-MM-dd');
```

- [ ] **Step 3: Convert the enterprise-events getter**

`event-statistics.service.ts:10-16` is the same `getUTC*` shape as Task 4 Step 1, emitting `yyyyMMdd`. Apply the identical getter-to-method conversion, keeping the undashed format.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/achievements src/modules/exp src/modules/enterprise-events && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/achievements/ src/modules/exp/ src/modules/enterprise-events/
git commit -m "refactor(stats): anchor statistics day buckets to platform timezone"
```

---

### Task 7: The two server-local bugs — broadcast quota and withdrawal cap

**Files:**
- Modify: `src/modules/notification/services/notification-validation.service.ts:43-45`
- Modify: `src/modules/withdrawals/services/withdrawal-validation.service.ts:62-64`
- Test: `src/modules/withdrawals/services/withdrawal-validation.service.spec.ts` (**create** — no spec exists for this service; mirror the mock-construction style of the sibling `src/modules/withdrawals/services/withdrawal-engine.spec.ts`)

**Interfaces:**
- Consumes: `TimeService.window`, `ZoneResolverService.platform`
- Produces: no public API change.

Both sites use `setHours(0,0,0,0)` — the *server's* zone. No `TZ` is set in the `Dockerfile` or either compose file, so production runs UTC and these are accidentally correct there while being wrong on every developer machine. Moving them to the anchor fixes the latent bug and preserves production behaviour.

Per spec decision 5, the withdrawal cap stays on the **anchor**, not the user's zone: it is a risk control, and a user-local window would let a device-timezone change unlock two caps inside 24 hours.

- [ ] **Step 1: Write the failing withdrawal test**

No spec exists for this service — create `src/modules/withdrawals/services/withdrawal-validation.service.spec.ts`. Read `withdrawal-engine.spec.ts` first to copy its Prisma-mock idiom, then read `withdrawal-validation.service.ts`'s constructor to get the collaborator order:

```ts
import { TimeService, ZoneResolverService } from 'src/common/time';
import { WithdrawalValidationService } from './withdrawal-validation.service';

describe('WithdrawalValidationService daily cap window', () => {
  let prisma: any;
  let zones: { platform: jest.Mock };
  let service: WithdrawalValidationService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T19:00:00.000Z'));
    prisma = {
      withdrawalRequest: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountCoins: BigInt(0) } }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    zones = { platform: jest.fn().mockResolvedValue('Asia/Kolkata') };
    // Construct with the real constructor signature, appending the two new
    // collaborators; stub the other dependencies as the engine spec does.
    service = new WithdrawalValidationService(
      prisma,
      /* ...existing collaborators, stubbed... */ {} as any,
      new TimeService(),
      zones as unknown as ZoneResolverService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('aggregates from the anchor day start, not the server day start', async () => {
    await runTheValidationPathThatChecksTheDailyCap(service, prisma);

    expect(prisma.withdrawalRequest.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          // 00:00 Jul 28 IST, i.e. 30 minutes ago — not 00:00 UTC Jul 27.
          createdAt: { gte: new Date('2026-07-27T18:30:00.000Z') },
        }),
      }),
    );
  });
});
```

Replace `runTheValidationPathThatChecksTheDailyCap` with a direct call to the public validation method that reaches the cap check (read the service to find it), supplying a balance and amount that pass checks 1–4 so execution reaches check 5. The load-bearing assertion is the `createdAt: { gte: ... }` bound.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/withdrawals`
Expected: FAIL — the aggregate receives the server-local day start.

- [ ] **Step 3: Apply both replacements**

In `withdrawal-validation.service.ts`, replace:

```ts
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
```

with:

```ts
    // The platform anchor, deliberately not the user's zone: a daily cap is a
    // risk control, and a user-local window would let a device-timezone change
    // unlock two caps inside 24 hours.
    const zone = await this.zones.platform();
    const startOfDay = this.time.window('daily', new Date(), zone).start;
```

In `notification-validation.service.ts`, replace:

```ts
    const today = new Date();
    today.setHours(0, 0, 0, 0);
```

with:

```ts
    const zone = await this.zones.platform();
    const today = this.time.window('daily', new Date(), zone).start;
```

`assertBroadcastLimitNotExceeded` is already `async`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/withdrawals src/modules/notification`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/withdrawals/ src/modules/notification/
git commit -m "fix(withdrawals,notification): replace server-local day boundaries with the anchor"
```

---

### Task 8: Pin the anchor default and verify the whole phase

**Files:**
- Test: `src/common/time/zone-resolver.service.spec.ts` (append)

- [ ] **Step 1: Write the regression test**

Append to `src/common/time/zone-resolver.service.spec.ts`:

```ts
import { DEFAULT_PLATFORM_TIMEZONE } from './zone-resolver.service';
import { DEFAULT_PLATFORM_SETTINGS } from 'src/modules/platform-configuration/services/platform-configuration-seeder.service';

describe('platform anchor default', () => {
  // Guards every global ladder, room treasure session and event window. Moving
  // this silently shifts boundaries for data already in production, so the
  // default is pinned and any change must be deliberate enough to edit a test.
  it('is UTC in code', () => {
    expect(DEFAULT_PLATFORM_TIMEZONE).toBe('UTC');
  });

  it('is UTC in the seed', () => {
    const seed = DEFAULT_PLATFORM_SETTINGS.find((s) => s.key === 'platform.timezone');
    expect(seed).toBeDefined();
    expect(seed!.value).toBe('UTC');
    expect(seed!.defaultValue).toBe('UTC');
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS. Exactly two pre-existing test edits are legitimate in this phase — the `ranking-period.resolver.spec.ts:48` `'local'` case (Task 3) and the added withdrawal test. **Any other pre-existing test requiring a change means the refactor altered behaviour — stop and re-read the original code.**

- [ ] **Step 3: Lint, typecheck, boundaries, build**

```bash
npm run lint && npx tsc --noEmit && npm run boundaries && npm run build
```

Expected: all pass.

- [ ] **Step 4: Prove the anchor actually moves behaviour**

In a staging database, set `platform.timezone` to `Asia/Kolkata`, wait out the 60-second config cache, and confirm a room's treasure status reports a day boundary at 18:30 UTC. Then set it back to `UTC` and confirm the boundary returns to 00:00 UTC.

- [ ] **Step 5: Grep for stragglers**

```bash
grep -rnE "setUTCHours\(0|setHours\(0|toISOString\(\)\.split" src --include="*.ts" | grep -v "\.spec\.ts"
```

Expected: no results outside `src/common/time/`. Anything remaining is a missed shared surface — convert it before closing the phase.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(time): pin the platform anchor default to UTC"
```

---

## Phase exit criteria

- [ ] The full suite passes with only the two legitimate test edits named in Task 8 Step 2.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm run boundaries`, `npm run build` all pass.
- [ ] The straggler grep returns nothing outside `src/common/time/`.
- [ ] Flipping the anchor in staging visibly moves the treasure day boundary, and restoring `UTC` restores it.
- [ ] Production behaviour is unchanged, because the anchor is still `'UTC'`.
