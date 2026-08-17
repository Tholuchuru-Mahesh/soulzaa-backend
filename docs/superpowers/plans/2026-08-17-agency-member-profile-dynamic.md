# Agency Member Profile — Backend-Driven Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every value on all three tabs of the agency Member Profile screen comes from the API, with no hard-coded figures, names, or asset-based charts left in the widget tree.

**Architecture:** A new scoring service ranks all of an agency's members in one cached pass and feeds both the Overview and Performance tabs. Four new paged endpoints hang off the existing `/agencies/me/members/:userId` route. On the Flutter side the 1398-line screen is split into per-card widgets, each fed by its own Riverpod provider keyed by `userId`.

**Tech Stack:** NestJS, Prisma, PostgreSQL, ioredis, Jest (backend); Flutter, Riverpod, Dio (mobile).

**Spec:** `docs/superpowers/specs/2026-08-17-agency-member-profile-dynamic-design.md`

## Global Constraints

- **Coin values are always strings.** Coin figures are `BigInt` in Postgres; serialise with `.toString()`, never as a JSON number. Dart parses them with the existing `_coins` helper, never `as int`.
- **Null, never zero.** A value the platform cannot answer is `null`; the client renders `—`. A zero is only returned when zero is the true measurement.
- **Agency comes from the JWT.** No endpoint accepts an `agencyId` parameter. Every new endpoint calls `assertMember(agencyId, userId)` before reading anything.
- **No Flutter codegen.** `build_runner` cannot run in this repo (`dart_style` too old for Dart 3.10.7). All models are hand-written `fromJson`. Never add `@freezed` or `part` directives.
- **Score window:** `SCORE_WINDOW_DAYS = 30`.
- **Score weights (verbatim):** `loginDays` 0.30 cap 30, `roomsJoined` 0.25 cap 30, `giftsSent` 0.25 cap 50, `giftsReceived` 0.20 cap 50.
- **Grade bands (verbatim):** `>=80 EXCELLENT "Excellent" / "keep it up!"`, `>=60 GOOD "Good" / "nearly there"`, `>=40 FAIR "Fair" / "room to grow"`, `>=0 NEEDS_WORK "Needs work" / "let us help"`.
- **Percentile floor:** `topPercent` is `null` when the agency has fewer than 10 members (`MIN_MEMBERS_FOR_PERCENTILE = 10`).
- **Rank cache:** Redis key `agency:member-rank:{agencyId}`, TTL 300 seconds.
- **Backend test command:** `npm test -- <path>` from `/Users/nasinaudaysankar/Downloads/soulzaa-backend`.
- **Flutter test command:** `export PATH="$PATH:/Users/nasinaudaysankar/development/flutter/bin"` first, then `flutter test <path>` from `/Users/nasinaudaysankar/Downloads/soulzaa-mobile`. Never pipe the command into `tail` — it masks "command not found".
- **Do not commit.** The user stages and commits themselves. Where a task says "Commit", stop and report the task complete instead.

---

## File Structure

### Backend (`soulzaa-backend`)

| File | Responsibility |
|---|---|
| `src/modules/agencies/constants/member-score.constants.ts` | **Create** — weights, bands, pure `scoreMember` / `gradeFor` / `topPercentFor` |
| `src/modules/agencies/interfaces/agency-member.interface.ts` | **Create** — read-model types for all five endpoints |
| `src/modules/agencies/services/agency-member-score.service.ts` | **Create** — `rankAgency`, bulk queries, Redis cache |
| `src/modules/agencies/services/agency-member-activity.service.ts` | **Create** — counters + paged six-source timeline |
| `src/modules/agencies/services/agency-member-performance.service.ts` | **Create** — rank/grade/chart/metrics |
| `src/modules/agencies/services/agency-member-history.service.ts` | **Create** — paged rewards and events |
| `src/modules/agencies/services/agency-member.service.ts` | **Modify** — extended Overview payload, extracted `assertMember` |
| `src/modules/agencies/dto/agency-member-activity-query.dto.ts` | **Create** — page/limit/from/to/sort |
| `src/modules/agencies/dto/agency-member-performance-query.dto.ts` | **Create** — range |
| `src/modules/agencies/dto/agency-member-page-query.dto.ts` | **Create** — page/limit for rewards and events |
| `src/modules/agencies/controllers/agency-member.controller.ts` | **Modify** — four new routes |
| `src/modules/agencies/agencies.module.ts` | **Modify** — register four new services |

### Mobile (`soulzaa-mobile`)

| File | Responsibility |
|---|---|
| `lib/features/profile/data/models/agency_member_models.dart` | **Modify** — extended `AgencyMemberDetail`, `MemberBadge`, `MetricDelta` |
| `lib/features/profile/data/models/agency_member_performance_models.dart` | **Create** |
| `lib/features/profile/data/models/agency_member_history_models.dart` | **Create** — rewards, events, activity page |
| `lib/features/profile/data/datasources/agency_member_remote_data_source.dart` | **Modify** — four methods |
| `lib/features/profile/data/repositories/agency_member_repository.dart` | **Modify** — four methods |
| `lib/features/profile/presentation/providers/agency_member_providers.dart` | **Modify** — four providers |
| `lib/features/profile/presentation/controllers/agency_member_activity_controller.dart` | **Create** — paging + filter state |
| `lib/features/profile/presentation/screens/member_profile_screen.dart` | **Modify** — shrinks to app bar + tabs + dispatch |
| `lib/features/profile/presentation/widgets/member_profile/*.dart` | **Create** — ten widget files (see Task 9) |

---

## Task 1: Scoring constants and pure functions

**Files:**
- Create: `src/modules/agencies/constants/member-score.constants.ts`
- Test: `src/modules/agencies/constants/member-score.constants.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SCORE_WINDOW_DAYS: number`
  - `MIN_MEMBERS_FOR_PERCENTILE: number`
  - `interface ScoreInputs { loginDays: number; roomsJoined: number; giftsSent: number; giftsReceived: number }`
  - `interface GradeBand { min: number; code: string; label: string; caption: string }`
  - `scoreMember(inputs: ScoreInputs, windowDays?: number): number`
  - `gradeFor(score: number): GradeBand`
  - `topPercentFor(rank: number, totalMembers: number): number | null`

- [ ] **Step 1: Write the failing test**

Create `src/modules/agencies/constants/member-score.constants.spec.ts`:

```ts
import {
  GRADE_BANDS,
  SCORE_WEIGHTS,
  gradeFor,
  scoreMember,
  topPercentFor,
  type ScoreInputs,
} from './member-score.constants';

const NOTHING: ScoreInputs = { loginDays: 0, roomsJoined: 0, giftsSent: 0, giftsReceived: 0 };

describe('member score', () => {
  it('sums its weights to exactly 1', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('scores a member with no activity as 0', () => {
    expect(scoreMember(NOTHING)).toBe(0);
  });

  it('scores a member at every cap as 100', () => {
    expect(
      scoreMember({ loginDays: 30, roomsJoined: 30, giftsSent: 50, giftsReceived: 50 }),
    ).toBe(100);
  });

  it('caps each input, so one runaway figure cannot exceed 100', () => {
    expect(
      scoreMember({ loginDays: 900, roomsJoined: 900, giftsSent: 9000, giftsReceived: 9000 }),
    ).toBe(100);
  });

  it("reproduces the spec's worked example", () => {
    // 0.30*(12/30) + 0.25*(18/30) + 0.25*1 + 0.20*1 = 0.72
    expect(
      scoreMember({ loginDays: 12, roomsJoined: 18, giftsSent: 50, giftsReceived: 50 }),
    ).toBe(72);
  });

  it('scales every cap with the window, so a 7-day score stays on the 0-100 axis', () => {
    // Caps become 7, 7, 11.67, 11.67 — all met, so a full 7-day week is 100.
    expect(
      scoreMember({ loginDays: 7, roomsJoined: 7, giftsSent: 12, giftsReceived: 12 }, 7),
    ).toBe(100);
  });
});

describe('gradeFor', () => {
  it.each([
    [100, 'EXCELLENT'],
    [80, 'EXCELLENT'],
    [79, 'GOOD'],
    [60, 'GOOD'],
    [59, 'FAIR'],
    [40, 'FAIR'],
    [39, 'NEEDS_WORK'],
    [0, 'NEEDS_WORK'],
  ])('grades %i as %s', (score, code) => {
    expect(gradeFor(score).code).toBe(code);
  });

  it('orders its bands high to low, so the first match is the right one', () => {
    const mins = GRADE_BANDS.map((b) => b.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });
});

describe('topPercentFor', () => {
  it('places the 7th of 7541 members in the top 1%', () => {
    expect(topPercentFor(7, 7541)).toBe(1);
  });

  it('places the 754th of 7541 members in the top 10%', () => {
    expect(topPercentFor(754, 7541)).toBe(10);
  });

  it('never reports top 0%, because rank 1 is still inside the population', () => {
    expect(topPercentFor(1, 7541)).toBe(1);
  });

  it('declines to rank a group too small for a percentile to mean anything', () => {
    // Telling the 2nd of 3 members they are "top 67%" is noise, not a fact.
    expect(topPercentFor(2, 3)).toBeNull();
    expect(topPercentFor(1, 9)).toBeNull();
    expect(topPercentFor(1, 10)).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agencies/constants/member-score.constants.spec.ts`
Expected: FAIL — `Cannot find module './member-score.constants'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/agencies/constants/member-score.constants.ts`:

```ts
/**
 * The engagement model behind the member profile's score, grade and rank.
 *
 * Everything tunable lives here rather than inside a query, so the model can
 * be retuned against real platform volumes without touching Prisma code. The
 * weights are asserted to sum to 1 by the spec, which is what bounds the score
 * to 0-100 without a clamp.
 */

/** The rolling window every headline figure is measured over. */
export const SCORE_WINDOW_DAYS = 30;

/**
 * Below this, a percentile is noise: in a 3-member agency, second place is
 * "top 67%", which reads as an insult rather than a measurement.
 */
export const MIN_MEMBERS_FOR_PERCENTILE = 10;

export interface ScoreInputs {
  /** Distinct calendar days with a login. */
  loginDays: number;
  /** Audio + video room joins. */
  roomsJoined: number;
  giftsSent: number;
  giftsReceived: number;
}

export interface ScoreWeight {
  weight: number;
  /** The value at which this input contributes its full weight. */
  cap: number;
}

export const SCORE_WEIGHTS: Record<keyof ScoreInputs, ScoreWeight> = {
  loginDays: { weight: 0.3, cap: 30 },
  roomsJoined: { weight: 0.25, cap: 30 },
  giftsSent: { weight: 0.25, cap: 50 },
  giftsReceived: { weight: 0.2, cap: 50 },
};

export interface GradeBand {
  min: number;
  code: string;
  label: string;
  caption: string;
}

/** Ordered high to low: `gradeFor` returns the first band the score reaches. */
export const GRADE_BANDS: readonly GradeBand[] = [
  { min: 80, code: 'EXCELLENT', label: 'Excellent', caption: 'keep it up!' },
  { min: 60, code: 'GOOD', label: 'Good', caption: 'nearly there' },
  { min: 40, code: 'FAIR', label: 'Fair', caption: 'room to grow' },
  { min: 0, code: 'NEEDS_WORK', label: 'Needs work', caption: 'let us help' },
];

/**
 * The 0-100 engagement score for one member.
 *
 * [windowDays] scales every cap, so the chart's 7-day rolling points land on
 * the same axis as the 30-day headline figure and the two stay comparable.
 */
export function scoreMember(inputs: ScoreInputs, windowDays: number = SCORE_WINDOW_DAYS): number {
  const scale = windowDays / SCORE_WINDOW_DAYS;
  let total = 0;

  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof ScoreInputs)[]) {
    const { weight, cap } = SCORE_WEIGHTS[key];
    const scaledCap = cap * scale;
    // A zero-length window has no cap to divide by; it contributes nothing
    // rather than producing NaN and poisoning the whole sum.
    const ratio = scaledCap <= 0 ? 0 : Math.min(inputs[key] / scaledCap, 1);
    total += weight * ratio;
  }

  return Math.round(total * 100);
}

export function gradeFor(score: number): GradeBand {
  return GRADE_BANDS.find((band) => score >= band.min) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
}

/**
 * "Top X%" for a member at [rank] of [totalMembers].
 *
 * Null below [MIN_MEMBERS_FOR_PERCENTILE]. Floored at 1 because rank 1 is
 * still a member of the population — "top 0%" would describe nobody.
 */
export function topPercentFor(rank: number, totalMembers: number): number | null {
  if (totalMembers < MIN_MEMBERS_FOR_PERCENTILE) return null;
  return Math.max(1, Math.ceil((rank / totalMembers) * 100));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/agencies/constants/member-score.constants.spec.ts`
Expected: PASS, 19 tests

- [ ] **Step 5: Lint**

Run: `npx eslint src/modules/agencies/constants/member-score.constants.ts --max-warnings 0`
Expected: no output

Report the task complete. Do not commit.

---

## Task 2: `AgencyMemberScoreService` — ranking with a Redis cache

**Files:**
- Create: `src/modules/agencies/services/agency-member-score.service.ts`
- Create: `src/modules/agencies/interfaces/agency-member.interface.ts`
- Test: `src/modules/agencies/services/agency-member-score.spec.ts`
- Modify: `src/modules/agencies/agencies.module.ts`
- Modify: `src/modules/agencies/services/index.ts`

**Interfaces:**
- Consumes: `scoreMember`, `gradeFor`, `topPercentFor`, `SCORE_WINDOW_DAYS`, `ScoreInputs`, `GradeBand` from Task 1
- Produces:
  - `interface MemberScore { userId: string; score: number; rank: number; totalMembers: number; topPercent: number | null; grade: GradeBand; inputs: ScoreInputs }`
  - `AgencyMemberScoreService.rankAgency(agencyId: string): Promise<Map<string, MemberScore>>`
  - `AgencyMemberScoreService.scoreInputsFor(userIds: string[], from: Date, to: Date): Promise<Map<string, ScoreInputs>>`

`scoreInputsFor` is public so a caller can measure an arbitrary window — Task 5 does **not** use it (it needs per-day buckets, not window totals, so it does its own bucketing), but it is the seam any future window-based caller should reach for rather than duplicating the five queries.

- [ ] **Step 1: Write the failing test**

Create `src/modules/agencies/services/agency-member-score.spec.ts`:

```ts
import { AgencyMemberScoreService } from './agency-member-score.service';

/**
 * The rules these cover: a ranking must cost a fixed number of queries no
 * matter how large the agency, and it must be stable between two page loads.
 */
describe('AgencyMemberScoreService', () => {
  const AGENCY = 'agency-1';

  function build(
    rows: {
      logins?: { userId: string; createdAt: Date }[];
      audio?: { userId: string }[];
      video?: { userId: string }[];
      sent?: { senderId: string; _count: number }[];
      received?: { receiverId: string; _count: number }[];
      members?: string[];
    } = {},
  ) {
    const prisma: any = {
      sessionHistory: { findMany: jest.fn().mockResolvedValue(rows.logins ?? []) },
      roomMember: { findMany: jest.fn().mockResolvedValue(rows.audio ?? []) },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue(rows.video ?? []) },
      giftTransaction: {
        groupBy: jest
          .fn()
          .mockImplementation(({ by }: { by: string[] }) =>
            Promise.resolve(by[0] === 'senderId' ? (rows.sent ?? []) : (rows.received ?? [])),
          ),
      },
    };
    const store = new Map<string, string>();
    const redis: any = {
      client: {
        get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
        set: jest.fn((key: string, value: string) => {
          store.set(key, value);
          return Promise.resolve('OK');
        }),
      },
    };
    const community: any = {
      getActiveHostIds: jest.fn().mockResolvedValue(rows.members ?? []),
    };
    const service = new AgencyMemberScoreService(prisma, redis, community);
    return { service, prisma, redis, community, store };
  }

  function day(n: number): Date {
    return new Date(Date.UTC(2026, 7, n));
  }

  it('returns an empty ranking for an agency with no members, without querying', async () => {
    const { service, prisma } = build({ members: [] });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.size).toBe(0);
    expect(prisma.giftTransaction.groupBy).not.toHaveBeenCalled();
  });

  it('costs a fixed number of queries regardless of member count', async () => {
    // 200 members must not mean 800 queries.
    const members = Array.from({ length: 200 }, (_, i) => `m${i}`);
    const { service, prisma } = build({ members });

    await service.rankAgency(AGENCY);

    expect(prisma.sessionHistory.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.roomMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.giftTransaction.groupBy).toHaveBeenCalledTimes(2);
  });

  it('counts distinct login days, not login events', async () => {
    // Three logins on one day is one active day, not three.
    const { service } = build({
      members: ['a'],
      logins: [
        { userId: 'a', createdAt: day(1) },
        { userId: 'a', createdAt: new Date(day(1).getTime() + 3600_000) },
        { userId: 'a', createdAt: day(2) },
      ],
    });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a')!.inputs.loginDays).toBe(2);
  });

  it('adds audio and video joins into one rooms figure', async () => {
    const { service } = build({
      members: ['a'],
      audio: [{ userId: 'a' }, { userId: 'a' }],
      video: [{ userId: 'a' }],
    });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a')!.inputs.roomsJoined).toBe(3);
  });

  it('ranks the higher score first', async () => {
    const { service } = build({
      members: ['low', 'high'],
      sent: [
        { senderId: 'high', _count: 50 },
        { senderId: 'low', _count: 1 },
      ],
    });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('high')!.rank).toBe(1);
    expect(ranked.get('low')!.rank).toBe(2);
    expect(ranked.get('high')!.totalMembers).toBe(2);
  });

  it('breaks ties by user id, so two equal members never swap between loads', async () => {
    const { service } = build({ members: ['b-user', 'a-user'] });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a-user')!.rank).toBe(1);
    expect(ranked.get('b-user')!.rank).toBe(2);
  });

  it('withholds a percentile from an agency too small to have one', async () => {
    const { service } = build({ members: ['a', 'b'] });

    const ranked = await service.rankAgency(AGENCY);

    expect(ranked.get('a')!.topPercent).toBeNull();
  });

  it('serves a second call from cache instead of recomputing', async () => {
    const members = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const { service, prisma } = build({ members });

    await service.rankAgency(AGENCY);
    const second = await service.rankAgency(AGENCY);

    expect(prisma.giftTransaction.groupBy).toHaveBeenCalledTimes(2); // from the first call only
    expect(second.get('m0')!.rank).toBeGreaterThan(0);
  });

  it('caches under a key scoped to the agency, so agencies cannot read each other', async () => {
    const { service, redis } = build({ members: ['a'] });

    await service.rankAgency(AGENCY);

    expect(redis.client.set).toHaveBeenCalledWith(
      `agency:member-rank:${AGENCY}`,
      expect.any(String),
      'EX',
      300,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-member-score.spec.ts`
Expected: FAIL — `Cannot find module './agency-member-score.service'`

- [ ] **Step 3: Write the read-model interfaces**

Create `src/modules/agencies/interfaces/agency-member.interface.ts`:

```ts
import type { GradeBand, ScoreInputs } from '../constants/member-score.constants';

/** One member's place in their agency's engagement ranking. */
export interface MemberScore {
  userId: string;
  /** 0-100. */
  score: number;
  rank: number;
  totalMembers: number;
  /** Null when the agency is too small for a percentile to mean anything. */
  topPercent: number | null;
  grade: GradeBand;
  /** The raw figures the score was built from, so a caller can show its parts. */
  inputs: ScoreInputs;
}

/** A whole-number figure alongside its period-over-period change. */
export interface MemberMetricDelta {
  value: number;
  /** Null when the baseline window was zero — a change from nothing is not a percentage. */
  changePercent: number | null;
  comparedTo: 'LAST_MONTH';
}

/** The same, for a coin figure — BigInt, so the value is a string. */
export interface MemberCoinMetricDelta {
  value: string;
  changePercent: number | null;
  comparedTo: 'LAST_MONTH';
}

export type TimelineKind =
  | 'LOGIN'
  | 'GIFT_SENT'
  | 'GIFT_RECEIVED'
  | 'ROOM_JOINED'
  | 'VIDEO_ROOM_JOINED'
  | 'EVENT_JOINED';

export interface MemberTimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  occurredAt: Date;
}

export interface MemberActivityCounters {
  totalActivities: number;
  loginDays: number;
  giftsSent: number;
  giftsReceived: number;
  roomsJoined: number;
  eventsJoined: number;
}

export type PerformanceRange = 'week' | 'month' | 'quarter';

export interface MemberChartPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Rolling 7-day engagement score, 0-100. */
  value: number;
}

export interface MemberDetailMetric {
  key: 'ENGAGEMENT_RATE' | 'VIDEO_ROOM' | 'AUDIO_ROOM' | 'DAYS_ACTIVE';
  label: string;
  percent: number;
  changePercent: number | null;
}
```

- [ ] **Step 4: Write the service**

Create `src/modules/agencies/services/agency-member-score.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';
import {
  SCORE_WINDOW_DAYS,
  gradeFor,
  scoreMember,
  topPercentFor,
  type ScoreInputs,
} from '../constants/member-score.constants';
import type { MemberScore } from '../interfaces/agency-member.interface';
import { AgencyCommunityService } from './agency-community.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 300;

/**
 * Scores and ranks an agency's members on engagement.
 *
 * Ranking is whole-agency by nature — one member's position cannot be known
 * without scoring everyone else — so this deliberately computes the entire
 * agency at once and caches the result, rather than offering a cheap-looking
 * per-member call that would quietly do the same work on every profile open.
 */
@Injectable()
export class AgencyMemberScoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly community: AgencyCommunityService,
  ) {}

  /** Every active member of [agencyId], scored and ranked, keyed by user id. */
  async rankAgency(agencyId: string): Promise<Map<string, MemberScore>> {
    const cached = await this.readCache(agencyId);
    if (cached) return cached;

    const memberIds = await this.community.getActiveHostIds(agencyId);
    if (memberIds.length === 0) return new Map();

    const to = new Date();
    const from = new Date(to.getTime() - SCORE_WINDOW_DAYS * DAY_MS);
    const inputs = await this.scoreInputsFor(memberIds, from, to);
    const ranked = this.rank(memberIds, inputs);

    await this.writeCache(agencyId, ranked);
    return ranked;
  }

  /**
   * The raw score inputs for [userIds] over `[from, to)`.
   *
   * Five queries total, never one per member: the whole set is fetched and
   * bucketed in memory, the same way `AgencyCommunityService.getGrowth` avoids
   * one COUNT per day. A 7,000-member agency costs the same five round-trips
   * as a 7-member one.
   */
  async scoreInputsFor(
    userIds: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, ScoreInputs>> {
    const empty = (): ScoreInputs => ({
      loginDays: 0,
      roomsJoined: 0,
      giftsSent: 0,
      giftsReceived: 0,
    });
    const result = new Map<string, ScoreInputs>(userIds.map((id) => [id, empty()]));
    if (userIds.length === 0) return result;

    const window = { gte: from, lt: to };
    const [logins, audioJoins, videoJoins, sent, received] = await Promise.all([
      this.prisma.sessionHistory.findMany({
        where: { userId: { in: userIds }, event: 'CREATED', createdAt: window },
        select: { userId: true, createdAt: true },
      }),
      this.prisma.roomMember.findMany({
        where: { userId: { in: userIds }, joinedAt: window },
        select: { userId: true },
      }),
      this.prisma.videoRoomMember.findMany({
        where: { userId: { in: userIds }, joinedAt: window },
        select: { userId: true },
      }),
      this.prisma.giftTransaction.groupBy({
        by: ['senderId'],
        where: { senderId: { in: userIds }, createdAt: window },
        _count: true,
      }),
      this.prisma.giftTransaction.groupBy({
        by: ['receiverId'],
        where: { receiverId: { in: userIds }, createdAt: window },
        _count: true,
      }),
    ]);

    // Distinct calendar days, not login events: signing in three times before
    // lunch is one active day, and counting it as three would let a single
    // restless afternoon outscore a month of steady use.
    const loginDaysByUser = new Map<string, Set<string>>();
    for (const row of logins) {
      const days = loginDaysByUser.get(row.userId) ?? new Set<string>();
      days.add(row.createdAt.toISOString().slice(0, 10));
      loginDaysByUser.set(row.userId, days);
    }
    for (const [userId, days] of loginDaysByUser) {
      const entry = result.get(userId);
      if (entry) entry.loginDays = days.size;
    }

    for (const row of [...audioJoins, ...videoJoins]) {
      const entry = result.get(row.userId);
      if (entry) entry.roomsJoined += 1;
    }

    for (const row of sent) {
      const entry = result.get(row.senderId);
      if (entry) entry.giftsSent = this.countOf(row);
    }
    for (const row of received) {
      const entry = result.get(row.receiverId);
      if (entry) entry.giftsReceived = this.countOf(row);
    }

    return result;
  }

  /** Prisma types `_count` as a number here, but guards against the object form. */
  private countOf(row: { _count?: unknown }): number {
    const count = row._count;
    if (typeof count === 'number') return count;
    if (count && typeof count === 'object' && '_all' in count) {
      return Number((count as { _all: number })._all) || 0;
    }
    return 0;
  }

  private rank(memberIds: string[], inputs: Map<string, ScoreInputs>): Map<string, MemberScore> {
    const scored = memberIds.map((userId) => ({
      userId,
      inputs: inputs.get(userId) ?? {
        loginDays: 0,
        roomsJoined: 0,
        giftsSent: 0,
        giftsReceived: 0,
      },
    }));

    const withScores = scored.map((row) => ({ ...row, score: scoreMember(row.inputs) }));

    // Ties break on user id so the ordering is total and stable. Without this,
    // two members on the same score could swap positions between two loads of
    // the same screen.
    withScores.sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));

    const totalMembers = withScores.length;
    return new Map(
      withScores.map((row, index) => {
        const rank = index + 1;
        return [
          row.userId,
          {
            userId: row.userId,
            score: row.score,
            rank,
            totalMembers,
            topPercent: topPercentFor(rank, totalMembers),
            grade: gradeFor(row.score),
            inputs: row.inputs,
          },
        ];
      }),
    );
  }

  private cacheKey(agencyId: string): string {
    return `agency:member-rank:${agencyId}`;
  }

  private async readCache(agencyId: string): Promise<Map<string, MemberScore> | null> {
    try {
      const raw = await this.redis.client.get(this.cacheKey(agencyId));
      if (!raw) return null;
      return new Map(JSON.parse(raw) as [string, MemberScore][]);
    } catch {
      // A cache that cannot be read is a slow request, not a failed one.
      return null;
    }
  }

  private async writeCache(agencyId: string, ranked: Map<string, MemberScore>): Promise<void> {
    try {
      await this.redis.client.set(
        this.cacheKey(agencyId),
        JSON.stringify([...ranked.entries()]),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // Same reasoning: failing to cache must not fail the request.
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-member-score.spec.ts`
Expected: PASS, 9 tests

- [ ] **Step 6: Register the service**

In `src/modules/agencies/services/index.ts`, add:

```ts
export * from './agency-member-score.service';
```

In `src/modules/agencies/agencies.module.ts`, import `AgencyMemberScoreService` alongside `AgencyMemberService` and add it to the `providers` array. Also add it to `exports` if `AgencyMemberService` is exported there.

- [ ] **Step 7: Verify the app still boots**

Run: `npm run build`
Expected: no TypeScript errors.

If `RedisService` is not resolvable inside `AgenciesModule`, import `RedisModule` in the module's `imports` array. Check whether `RedisModule` is `@Global()` first — if it is, no import is needed.

Report the task complete. Do not commit.

---

## Task 3: Extended Overview payload

**Files:**
- Modify: `src/modules/agencies/services/agency-member.service.ts`
- Test: `src/modules/agencies/services/agency-member.spec.ts:41` (extend the existing `getMember` describe)

**Interfaces:**
- Consumes: `AgencyMemberScoreService.rankAgency` (Task 2), `MemberMetricDelta`, `MemberCoinMetricDelta` (Task 2)
- Produces:
  - `AgencyMemberService.assertMember(agencyId: string, userId: string): Promise<{ effectiveFrom: Date }>` — public, reused by Tasks 4-6
  - `getMember` returns `{ profile, badge, stats, summary }` (shapes in the spec)

- [ ] **Step 1: Write the failing test**

Append to `src/modules/agencies/services/agency-member.spec.ts` inside the existing `describe('AgencyMemberService')` block. First extend the `build()` helper's prisma mock with the models this task queries:

```ts
      badgeInventory: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      roomMember: { count: jest.fn().mockResolvedValue(0) },
      videoRoomMember: { count: jest.fn().mockResolvedValue(0) },
```

and add a fourth constructor argument to the service under test:

```ts
    const scores = {
      rankAgency: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new AgencyMemberService(
      prisma,
      community as never,
      profiles as never,
      scores as never,
    );
    return { service, prisma, profiles, scores };
```

Then add:

```ts
  describe('getMember profile fields', () => {
    function activeMember(prisma: any, user: Record<string, unknown> = {}) {
      prisma.agencyRelationship.findUnique.mockResolvedValue({
        effectiveFrom: new Date('2026-05-10T00:00:00Z'),
        status: 'ACTIVE',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: MEMBER,
        username: 'balayya',
        fullName: 'Balayya Naidu',
        email: 'balayya@example.com',
        gender: 'MALE',
        preferredLanguage: 'Telugu',
        country: 'IN',
        createdAt: new Date('2026-04-02T00:00:00Z'),
        ...user,
      });
    }

    it("returns the member's own email, name and username", async () => {
      // The screen showed one hard-coded address for every member; these three
      // fields are the whole point of the change.
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.profile.email).toBe('balayya@example.com');
      expect(result.profile.fullName).toBe('Balayya Naidu');
      expect(result.profile.username).toBe('balayya');
    });

    it('reports an unset gender and language as null rather than guessing', async () => {
      const { service, prisma } = build();
      activeMember(prisma, { gender: null, preferredLanguage: null });

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.profile.gender).toBeNull();
      expect(result.profile.language).toBeNull();
    });

    it('returns no badge rather than an empty one when nothing is equipped', async () => {
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.badge).toBeNull();
    });

    it("carries the member's equipped badge with the agency percentile", async () => {
      const { service, prisma, scores } = build();
      activeMember(prisma);
      prisma.badgeInventory.findFirst.mockResolvedValue({
        badgeCode: 'AGENCY_STAR',
        badge: { name: 'Agency star', iconUrl: 'https://cdn/star.png', tier: 'GOLD' },
      });
      prisma.badgeInventory.count.mockResolvedValue(7);
      scores.rankAgency.mockResolvedValue(
        new Map([[MEMBER, { score: 72, rank: 7, totalMembers: 7541, topPercent: 1,
          grade: { code: 'GOOD', label: 'Good', caption: 'nearly there' }, inputs: {} }]]),
      );

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.badge).toEqual({
        code: 'AGENCY_STAR',
        name: 'Agency star',
        iconUrl: 'https://cdn/star.png',
        tier: 'GOLD',
        topPercent: 1,
        totalBadges: 7,
      });
    });

    it('carries rank, score and grade from the ranking service', async () => {
      const { service, prisma, scores } = build();
      activeMember(prisma);
      scores.rankAgency.mockResolvedValue(
        new Map([[MEMBER, { score: 72, rank: 7, totalMembers: 7541, topPercent: 1,
          grade: { code: 'GOOD', label: 'Good', caption: 'nearly there' }, inputs: {} }]]),
      );

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.summary).toEqual({
        rank: 7,
        totalMembers: 7541,
        engagementScore: 72,
        grade: { code: 'GOOD', label: 'Good', caption: 'nearly there' },
      });
    });

    it('reports a null trend when the baseline window was empty', async () => {
      // Growth from nothing is not a percentage; both "∞%" and "100%" lie.
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.stats.giftsSent.changePercent).toBeNull();
      expect(result.stats.giftsSent.comparedTo).toBe('LAST_MONTH');
    });

    it('keeps coin figures as strings', async () => {
      const { service, prisma } = build();
      activeMember(prisma);
      prisma.wallet.findUnique.mockResolvedValue({
        goldBalance: BigInt('9007199254740993'),
        diamondBalance: BigInt(0),
      });

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.profile.coins).toBe('9007199254740993');
      expect(typeof result.stats.coinsSent.value).toBe('string');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-member.spec.ts`
Expected: FAIL — `result.profile.email` is `undefined`

- [ ] **Step 3: Extract `assertMember` and extend `getMember`**

In `agency-member.service.ts`:

1. Add `AgencyMemberScoreService` as a fourth constructor parameter.
2. Replace the inline membership check in `getMember` with a public method:

```ts
  /**
   * Proves [userId] is an active member of [agencyId], or throws.
   *
   * Public and shared by every member sub-resource. One implementation means a
   * new endpoint cannot forget the check — the check is the only thing standing
   * between a guessed uuid and another agency's user.
   */
  async assertMember(agencyId: string, userId: string): Promise<{ effectiveFrom: Date }> {
    const relationship = await this.prisma.agencyRelationship.findUnique({
      where: { agencyId_hostId: { agencyId, hostId: userId } },
      select: { effectiveFrom: true, status: true },
    });
    if (!relationship || relationship.status !== 'ACTIVE') {
      throw new NotFoundException('This user is not a member of your agency');
    }
    return { effectiveFrom: relationship.effectiveFrom };
  }
```

3. Add the user columns to the existing `user.findUnique` select:

```ts
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          gender: true,
          preferredLanguage: true,
          country: true,
          createdAt: true,
        },
```

4. Add these private helpers:

```ts
  /** Percentage change against the previous same-length window. */
  private percentChange(before: number, after: number): number | null {
    if (before === 0) return null;
    return Math.round(((after - before) / before) * 1000) / 10;
  }

  private delta(value: number, baseline: number): MemberMetricDelta {
    return {
      value,
      changePercent: this.percentChange(baseline, value),
      comparedTo: 'LAST_MONTH',
    };
  }

  private coinDelta(value: bigint, baseline: bigint): MemberCoinMetricDelta {
    return {
      value: value.toString(),
      changePercent: this.percentChange(Number(baseline), Number(value)),
      comparedTo: 'LAST_MONTH',
    };
  }

  /** The member's equipped badge, or null when they have none. */
  private async loadBadge(userId: string, topPercent: number | null) {
    const [equipped, totalBadges] = await Promise.all([
      this.prisma.badgeInventory.findFirst({
        where: { userId, equipped: true },
        select: { badgeCode: true, badge: { select: { name: true, iconUrl: true, tier: true } } },
      }),
      this.prisma.badgeInventory.count({ where: { userId } }),
    ]);
    if (!equipped) return null;
    return {
      code: equipped.badgeCode,
      name: equipped.badge.name,
      iconUrl: equipped.badge.iconUrl,
      tier: equipped.badge.tier,
      topPercent,
      totalBadges,
    };
  }
```

5. Rebuild the return value. The current/prior aggregates run the existing `giftTransaction.aggregate` twice per direction with `createdAt: { gte: from, lt: to }` for `[now-30d, now)` and `[now-60d, now-30d)`, and `roomMember.count` + `videoRoomMember.count` for the same two windows.

```ts
    const score = (await this.scores.rankAgency(agencyId)).get(userId) ?? null;

    return {
      profile: {
        userId: user.id,
        username: user.username,
        displayName: identity?.displayName ?? user.fullName ?? user.username,
        fullName: user.fullName,
        avatarUrl: identity?.avatarUrl ?? null,
        email: user.email,
        gender: user.gender,
        language: user.preferredLanguage,
        country: user.country,
        joinedAgencyAt: relationship.effectiveFrom,
        registeredAt: user.createdAt,
        isActive: activeIds.has(userId),
        coins: (wallet?.goldBalance ?? BigInt(0)).toString(),
        earnings: (wallet?.diamondBalance ?? BigInt(0)).toString(),
      },
      badge: await this.loadBadge(userId, score?.topPercent ?? null),
      stats: {
        giftsSent: this.delta(sentNow._count, sentBefore._count),
        coinsSent: this.coinDelta(
          sentNow._sum.totalCoinValue ?? BigInt(0),
          sentBefore._sum.totalCoinValue ?? BigInt(0),
        ),
        giftsReceived: this.delta(receivedNow._count, receivedBefore._count),
        coinsReceived: this.coinDelta(
          receivedNow._sum.totalCoinValue ?? BigInt(0),
          receivedBefore._sum.totalCoinValue ?? BigInt(0),
        ),
        roomsJoined: this.delta(roomsNow, roomsBefore),
      },
      // Null rather than 0: a member missing from the ranking has no rank, and
      // "#0 of 0" would state something untrue.
      summary: {
        rank: score?.rank ?? null,
        totalMembers: score?.totalMembers ?? null,
        engagementScore: score?.score ?? null,
        grade: score
          ? { code: score.grade.code, label: score.grade.label, caption: score.grade.caption }
          : null,
      },
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-member.spec.ts`
Expected: PASS — the seven new tests plus all pre-existing isolation tests still green.

- [ ] **Step 5: Verify the build**

Run: `npm run build && npx eslint src/modules/agencies --max-warnings 0`

Report the task complete. Do not commit.

---

## Task 4: Activity endpoint — counters and paged six-source timeline

**Files:**
- Create: `src/modules/agencies/services/agency-member-activity.service.ts`
- Create: `src/modules/agencies/dto/agency-member-activity-query.dto.ts`
- Test: `src/modules/agencies/services/agency-member-activity.spec.ts`
- Modify: `src/modules/agencies/controllers/agency-member.controller.ts`
- Modify: `src/modules/agencies/agencies.module.ts`, `src/modules/agencies/services/index.ts`, `src/modules/agencies/dto/index.ts`

**Interfaces:**
- Consumes: `AgencyMemberService.assertMember` (Task 3), `MemberTimelineEntry`, `MemberActivityCounters`, `TimelineKind` (Task 2)
- Produces: `AgencyMemberActivityService.getActivity(agencyId, userId, options: { page?: number; limit?: number; from?: Date; to?: Date; sort?: 'newest' | 'oldest' })` returning `{ range, counters, timeline: { items, page, limit, total, totalPages } }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/agencies/services/agency-member-activity.spec.ts`:

```ts
import { AgencyMemberActivityService } from './agency-member-activity.service';

describe('AgencyMemberActivityService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  function at(day: number, hour = 0): Date {
    return new Date(Date.UTC(2026, 7, day, hour));
  }

  function build(
    rows: {
      logins?: any[];
      sent?: any[];
      received?: any[];
      audio?: any[];
      video?: any[];
      events?: any[];
    } = {},
  ) {
    const prisma: any = {
      sessionHistory: { findMany: jest.fn().mockResolvedValue(rows.logins ?? []) },
      giftTransaction: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(where.senderId ? (rows.sent ?? []) : (rows.received ?? [])),
        ),
      },
      roomMember: { findMany: jest.fn().mockResolvedValue(rows.audio ?? []) },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue(rows.video ?? []) },
      eventParticipant: { findMany: jest.fn().mockResolvedValue(rows.events ?? []) },
    };
    const members = { assertMember: jest.fn().mockResolvedValue({ effectiveFrom: at(1) }) };
    const service = new AgencyMemberActivityService(prisma, members as never);
    return { service, prisma, members };
  }

  it('proves membership before reading any activity', async () => {
    const { service, prisma, members } = build();
    members.assertMember.mockRejectedValue(new Error('not a member'));

    await expect(service.getActivity(AGENCY, MEMBER)).rejects.toThrow('not a member');
    expect(prisma.sessionHistory.findMany).not.toHaveBeenCalled();
  });

  it('merges all six sources into one timeline, newest first', async () => {
    const { service } = build({
      logins: [{ id: 'l1', createdAt: at(3, 9) }],
      sent: [{ id: 'g1', createdAt: at(3, 11), totalCoinValue: BigInt(500) }],
      audio: [{ id: 'a1', joinedAt: at(3, 10) }],
      video: [{ id: 'v1', joinedAt: at(3, 12) }],
      received: [{ id: 'g2', createdAt: at(3, 8), totalCoinValue: BigInt(100) }],
      events: [{ id: 'e1', joinedAt: at(3, 7), event: { name: 'Quiz challenge' } }],
    });

    const result = await service.getActivity(AGENCY, MEMBER);

    expect(result.timeline.items.map((i) => i.kind)).toEqual([
      'VIDEO_ROOM_JOINED',
      'GIFT_SENT',
      'ROOM_JOINED',
      'LOGIN',
      'GIFT_RECEIVED',
      'EVENT_JOINED',
    ]);
  });

  it('reverses the order on sort=oldest', async () => {
    const { service } = build({
      logins: [{ id: 'l1', createdAt: at(1) }],
      sent: [{ id: 'g1', createdAt: at(5), totalCoinValue: BigInt(1) }],
    });

    const result = await service.getActivity(AGENCY, MEMBER, { sort: 'oldest' });

    expect(result.timeline.items.map((i) => i.id)).toEqual(['l1', 'g1']);
  });

  it('pages the merged list, not each source separately', async () => {
    // Trimming per source before merging would drop the newest entries of a
    // busy source in favour of older entries of a quiet one.
    const { service } = build({
      logins: Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, createdAt: at(i + 1) })),
      sent: Array.from({ length: 5 }, (_, i) => ({
        id: `g${i}`,
        createdAt: at(i + 10),
        totalCoinValue: BigInt(1),
      })),
    });

    const result = await service.getActivity(AGENCY, MEMBER, { page: 1, limit: 3 });

    expect(result.timeline.items.map((i) => i.id)).toEqual(['g4', 'g3', 'g2']);
    expect(result.timeline.total).toBe(10);
    expect(result.timeline.totalPages).toBe(4);
  });

  it('counts distinct login days and totals the five counters', async () => {
    const { service } = build({
      logins: [
        { id: 'l1', createdAt: at(3, 9) },
        { id: 'l2', createdAt: at(3, 18) },
        { id: 'l3', createdAt: at(4, 9) },
      ],
      sent: [{ id: 'g1', createdAt: at(3), totalCoinValue: BigInt(1) }],
      events: [{ id: 'e1', joinedAt: at(3), event: { name: 'Quiz' } }],
    });

    const result = await service.getActivity(AGENCY, MEMBER);

    expect(result.counters.loginDays).toBe(2);
    expect(result.counters.giftsSent).toBe(1);
    expect(result.counters.eventsJoined).toBe(1);
    // 2 login days + 1 sent + 0 received + 0 rooms + 1 event
    expect(result.counters.totalActivities).toBe(4);
  });

  it('defaults to the last 30 days and passes the window to every source', async () => {
    const { service, prisma } = build();

    const result = await service.getActivity(AGENCY, MEMBER);

    const spanMs = result.range.to.getTime() - result.range.from.getTime();
    expect(Math.round(spanMs / 86_400_000)).toBe(30);
    expect(prisma.sessionHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: result.range.from, lt: result.range.to },
        }),
      }),
    );
  });

  it('honours an explicit date range', async () => {
    const { service } = build();

    const result = await service.getActivity(AGENCY, MEMBER, { from: at(1), to: at(3) });

    expect(result.range.from).toEqual(at(1));
    expect(result.range.to).toEqual(at(3));
  });

  it('describes a gift with its coin value, as a string', async () => {
    const { service } = build({
      sent: [{ id: 'g1', createdAt: at(3), totalCoinValue: BigInt('9007199254740993') }],
    });

    const result = await service.getActivity(AGENCY, MEMBER);

    expect(result.timeline.items[0].detail).toContain('9007199254740993');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-member-activity.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the DTO**

Create `src/modules/agencies/dto/agency-member-activity-query.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class AgencyMemberActivityQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Start of the activity window (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'End of the activity window (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({ enum: ['newest', 'oldest'], default: 'newest' })
  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort?: 'newest' | 'oldest';
}
```

- [ ] **Step 4: Write the service**

Create `src/modules/agencies/services/agency-member-activity.service.ts`. It must:

- call `this.members.assertMember(agencyId, userId)` **first**, before any read
- default `to` to now and `from` to `to - 30 days`
- fetch all six sources in one `Promise.all`, each filtered to `{ gte: from, lt: to }` and each capped at `MAX_SOURCE_ROWS = 200` ordered by its own time column descending
- map each into `MemberTimelineEntry` with these titles and details:

| Source | `kind` | `title` | `detail` |
|---|---|---|---|
| `sessionHistory` (`event: 'CREATED'`) | `LOGIN` | `Login` | `user logged in to the application` |
| `giftTransaction` by `senderId` | `GIFT_SENT` | `Gift Sent` | `Sent a gift worth ${coins} coins` |
| `giftTransaction` by `receiverId` | `GIFT_RECEIVED` | `Gift Received` | `Received a gift worth ${coins} coins` |
| `roomMember` | `ROOM_JOINED` | `Joined Audio Room` | `null` |
| `videoRoomMember` | `VIDEO_ROOM_JOINED` | `Joined the video room` | `null` |
| `eventParticipant` (include `event: { select: { name: true } }`) | `EVENT_JOINED` | `Event Joined` | `Joined the event "${name}"` |

- concatenate, sort by `occurredAt` (descending for `newest`, ascending for `oldest`), **then** slice the page — never trim per source before merging
- build `counters` from the same fetched rows: `loginDays` is the size of a `Set` of `YYYY-MM-DD` strings; `totalActivities` is the sum of the other five
- return `{ range: { from, to }, counters, timeline: { items, page, limit, total, totalPages } }` where `total` is the merged length

Coin values in `detail` use `.toString()`, never `Number()`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-member-activity.spec.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Add the route**

In `agency-member.controller.ts`:

```ts
  @Get(':userId/activity')
  @ApiOperation({ summary: "One member's activity counters and timeline" })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  activity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberActivityQueryDto,
  ) {
    return this.activityService.getActivity(user.id, userId, query);
  }
```

Inject `private readonly activityService: AgencyMemberActivityService` into the constructor. Register the service in `agencies.module.ts` and export it from `services/index.ts`; export the DTO from `dto/index.ts`.

- [ ] **Step 7: Verify the build**

Run: `npm run build && npx eslint src/modules/agencies --max-warnings 0`

Report the task complete. Do not commit.

---

## Task 5: Performance endpoint — rank, chart series, detail metrics

**Files:**
- Create: `src/modules/agencies/services/agency-member-performance.service.ts`
- Create: `src/modules/agencies/dto/agency-member-performance-query.dto.ts`
- Test: `src/modules/agencies/services/agency-member-performance.spec.ts`
- Modify: controller, module, `services/index.ts`, `dto/index.ts`

**Interfaces:**
- Consumes: `AgencyMemberService.assertMember`, `AgencyMemberScoreService.rankAgency`, `scoreMember` and `gradeFor` (Task 1), `MemberChartPoint`, `MemberDetailMetric`, `PerformanceRange` (Task 2). It does its own day-bucketed queries rather than calling `scoreInputsFor`, which returns window totals.
- Produces: `AgencyMemberPerformanceService.getPerformance(agencyId, userId, range: PerformanceRange)` returning `{ rank, grade, engagement, chart, metrics }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/agencies/services/agency-member-performance.spec.ts`:

```ts
import { AgencyMemberPerformanceService } from './agency-member-performance.service';

describe('AgencyMemberPerformanceService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  const RANKED = new Map([
    [
      MEMBER,
      {
        userId: MEMBER,
        score: 72,
        rank: 7,
        totalMembers: 7541,
        topPercent: 1,
        grade: { min: 60, code: 'GOOD', label: 'Good', caption: 'nearly there' },
        inputs: { loginDays: 12, roomsJoined: 18, giftsSent: 50, giftsReceived: 50 },
      },
    ],
  ]);

  function build(overrides: Record<string, unknown> = {}) {
    const prisma: any = {
      sessionHistory: { findMany: jest.fn().mockResolvedValue([]) },
      roomMember: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue([]) },
      giftTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    const members = { assertMember: jest.fn().mockResolvedValue({ effectiveFrom: new Date() }) };
    const scores = {
      rankAgency: jest.fn().mockResolvedValue(RANKED),
      scoreInputsFor: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new AgencyMemberPerformanceService(prisma, members as never, scores as never);
    return { service, prisma, members, scores };
  }

  it('proves membership before reading anything', async () => {
    const { service, prisma, members } = build();
    members.assertMember.mockRejectedValue(new Error('not a member'));

    await expect(service.getPerformance(AGENCY, MEMBER, 'month')).rejects.toThrow('not a member');
    expect(prisma.sessionHistory.findMany).not.toHaveBeenCalled();
  });

  it('carries rank, grade and engagement from the ranking', async () => {
    const { service } = build();

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.rank).toEqual({ position: 7, totalMembers: 7541, topPercent: 1 });
    expect(result.grade.code).toBe('GOOD');
    expect(result.engagement).toEqual({ score: 72, outOf: 100, topPercent: 1 });
  });

  it('plots one point per day for each range', async () => {
    const { service } = build();

    expect((await service.getPerformance(AGENCY, MEMBER, 'week')).chart.points).toHaveLength(7);
    expect((await service.getPerformance(AGENCY, MEMBER, 'month')).chart.points).toHaveLength(30);
    expect((await service.getPerformance(AGENCY, MEMBER, 'quarter')).chart.points).toHaveLength(90);
  });

  it('keeps every chart point on the 0-100 axis', async () => {
    const { service } = build();

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    for (const point of result.chart.points) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(100);
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('fetches six extra days so the first rolling points have a full window', async () => {
    const { service, prisma } = build();

    await service.getPerformance(AGENCY, MEMBER, 'week');

    const where = prisma.sessionHistory.findMany.mock.calls[0][0].where;
    const spanDays = Math.round(
      (where.createdAt.lt.getTime() - where.createdAt.gte.getTime()) / 86_400_000,
    );
    expect(spanDays).toBe(13); // 7 range days + 6 warm-up days
  });

  it('returns the four detail metrics as whole percentages of the window', async () => {
    const { service } = build();

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.metrics.map((m) => m.key)).toEqual([
      'ENGAGEMENT_RATE',
      'VIDEO_ROOM',
      'AUDIO_ROOM',
      'DAYS_ACTIVE',
    ]);
    // Engagement rate is the score itself, so the two can never disagree.
    expect(result.metrics[0].percent).toBe(72);
    for (const metric of result.metrics) {
      expect(metric.percent).toBeGreaterThanOrEqual(0);
      expect(metric.percent).toBeLessThanOrEqual(100);
    }
  });

  it('derives days-active from distinct login days over the 30-day window', async () => {
    // 12 distinct days of 30 is 40%.
    const logins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((d) => ({
      userId: MEMBER,
      createdAt: new Date(Date.UTC(2026, 7, d)),
    }));
    const { service } = build({ sessionHistory: { findMany: jest.fn().mockResolvedValue(logins) } });

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.metrics.find((m) => m.key === 'DAYS_ACTIVE')!.percent).toBe(40);
  });

  it('returns nulls rather than inventing a rank for an unranked member', async () => {
    const { service, scores } = build();
    scores.rankAgency.mockResolvedValue(new Map());

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.rank).toBeNull();
    expect(result.engagement.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-member-performance.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the DTO**

Create `src/modules/agencies/dto/agency-member-performance-query.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class AgencyMemberPerformanceQueryDto {
  @ApiPropertyOptional({ enum: ['week', 'month', 'quarter'], default: 'month' })
  @IsOptional()
  @IsIn(['week', 'month', 'quarter'])
  range?: 'week' | 'month' | 'quarter';
}
```

- [ ] **Step 4: Write the service**

Create `src/modules/agencies/services/agency-member-performance.service.ts`. It must:

- call `assertMember` first
- define `RANGE_DAYS = { week: 7, month: 30, quarter: 90 }` and `ROLLING_DAYS = 7`
- read `rankAgency(agencyId).get(userId)`; when absent, return `rank: null`, `engagement.score: 0`, `grade: gradeFor(0)`
- fetch logins, audio joins, video joins, gifts sent and gifts received once over `[rangeStart - 6 days, now)` and bucket them by `YYYY-MM-DD` in memory
- for each of the `RANGE_DAYS[range]` days, build `ScoreInputs` from the 7 days ending on that day and call `scoreMember(inputs, ROLLING_DAYS)`
- build the four metrics:

| key | label | percent |
|---|---|---|
| `ENGAGEMENT_RATE` | `Engagement rate` | the member's `score` |
| `VIDEO_ROOM` | `Video room participation` | `round(distinct days with a video join / 30 * 100)` |
| `AUDIO_ROOM` | `Audio room participation` | `round(distinct days with an audio join / 30 * 100)` |
| `DAYS_ACTIVE` | `Days active` | `round(distinct login days / 30 * 100)` |

- each metric's `changePercent` compares its own percent against the same measure over the preceding 30 days, `null` when that baseline was 0

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-member-performance.spec.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Add the route**

```ts
  @Get(':userId/performance')
  @ApiOperation({ summary: "One member's rank, engagement chart and detail metrics" })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  performance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberPerformanceQueryDto,
  ) {
    return this.performanceService.getPerformance(user.id, userId, query.range ?? 'month');
  }
```

Inject the service, register it in the module, export from the barrels.

- [ ] **Step 7: Verify the build**

Run: `npm run build && npx eslint src/modules/agencies --max-warnings 0`

Report the task complete. Do not commit.

---

## Task 6: Rewards and events endpoints

**Files:**
- Create: `src/modules/agencies/services/agency-member-history.service.ts`
- Create: `src/modules/agencies/dto/agency-member-page-query.dto.ts`
- Test: `src/modules/agencies/services/agency-member-history.spec.ts`
- Modify: controller, module, barrels

**Interfaces:**
- Consumes: `AgencyMemberService.assertMember`
- Produces:
  - `getRewards(agencyId, userId, { page?, limit? })` → `{ items, page, limit, total, totalPages }`
  - `getEvents(agencyId, userId, { page?, limit? })` → `{ items, page, limit, total, totalPages }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/agencies/services/agency-member-history.spec.ts`:

```ts
import { AgencyMemberHistoryService } from './agency-member-history.service';

describe('AgencyMemberHistoryService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  function build(rewards: any[] = [], events: any[] = []) {
    const prisma: any = {
      agencyRewardDistribution: {
        findMany: jest.fn().mockResolvedValue(rewards),
        count: jest.fn().mockResolvedValue(rewards.length),
      },
      eventParticipant: {
        findMany: jest.fn().mockResolvedValue(events),
        count: jest.fn().mockResolvedValue(events.length),
      },
    };
    const members = { assertMember: jest.fn().mockResolvedValue({ effectiveFrom: new Date() }) };
    const service = new AgencyMemberHistoryService(prisma, members as never);
    return { service, prisma, members };
  }

  it('proves membership before reading rewards', async () => {
    const { service, prisma, members } = build();
    members.assertMember.mockRejectedValue(new Error('not a member'));

    await expect(service.getRewards(AGENCY, MEMBER)).rejects.toThrow('not a member');
    expect(prisma.agencyRewardDistribution.findMany).not.toHaveBeenCalled();
  });

  it('shows only the rewards this agency sent, never another agency\'s', async () => {
    // An agency must not learn what a rival gave the same member.
    const { service, prisma } = build();

    await service.getRewards(AGENCY, MEMBER);

    expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agencyId: AGENCY, recipientId: MEMBER },
      }),
    );
  });

  it('maps a reward to its screen shape', async () => {
    const { service } = build([
      {
        id: 'r1',
        name: 'Premium medal',
        itemType: 'MEDAL',
        kind: 'ASSIGNED',
        note: 'For top performance',
        quantity: 1,
        createdAt: new Date('2026-06-20T00:00:00Z'),
      },
    ]);

    const result = await service.getRewards(AGENCY, MEMBER);

    expect(result.items[0]).toEqual({
      id: 'r1',
      name: 'Premium medal',
      itemType: 'MEDAL',
      kind: 'ASSIGNED',
      note: 'For top performance',
      quantity: 1,
      receivedAt: new Date('2026-06-20T00:00:00Z'),
    });
  });

  it('reports an event as completed only when it actually completed', async () => {
    const { service } = build(
      [],
      [
        {
          eventId: 'e1',
          status: 'PARTICIPATING',
          completedAt: null,
          event: { name: 'Quiz challenge', thumbnail: 'q.png', startTime: new Date('2026-05-21T18:10:00Z') },
        },
        {
          eventId: 'e2',
          status: 'PARTICIPATING',
          completedAt: new Date('2026-05-20T14:00:00Z'),
          event: { name: 'Singing battle', thumbnail: null, startTime: new Date('2026-05-20T14:00:00Z') },
        },
      ],
    );

    const result = await service.getEvents(AGENCY, MEMBER);

    expect(result.items[0].status).toBe('PARTICIPATING');
    expect(result.items[1].status).toBe('COMPLETED');
  });

  it('pages both lists', async () => {
    const { service, prisma } = build();
    prisma.agencyRewardDistribution.count.mockResolvedValue(45);

    const result = await service.getRewards(AGENCY, MEMBER, { page: 2, limit: 20 });

    expect(result.page).toBe(2);
    expect(result.total).toBe(45);
    expect(result.totalPages).toBe(3);
    expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
  });

  it('clamps an absurd page size', async () => {
    const { service, prisma } = build();

    await service.getRewards(AGENCY, MEMBER, { limit: 100_000 });

    expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-member-history.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the DTO**

Create `src/modules/agencies/dto/agency-member-page-query.dto.ts` with `page` and `limit` only — the same two properties, decorators and bounds as `AgencyMemberQueryDto` in `agency-member-query.dto.ts:15-27`, minus `search`.

- [ ] **Step 4: Write the service**

Create `src/modules/agencies/services/agency-member-history.service.ts` with `MAX_PAGE_SIZE = 100`, clamping `limit` to `[1, 100]` and `page` to `>= 1`, exactly as `AgencyMemberService.listMembers` does at `agency-member.service.ts:43-44`.

`getRewards` queries `agencyRewardDistribution` with `where: { agencyId, recipientId: userId }`, `orderBy: { createdAt: 'desc' }`, mapping `createdAt` → `receivedAt`.

`getEvents` queries `eventParticipant` with `where: { userId }`, `include: { event: { select: { name: true, thumbnail: true, startTime: true } } }`, `orderBy: { joinedAt: 'desc' }`, and derives `status` as `completedAt ? 'COMPLETED' : row.status`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-member-history.spec.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Add both routes**

```ts
  @Get(':userId/rewards')
  @ApiOperation({ summary: 'Rewards this agency has sent to this member' })
  rewards(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberPageQueryDto,
  ) {
    return this.historyService.getRewards(user.id, userId, query);
  }

  @Get(':userId/events')
  @ApiOperation({ summary: 'Platform events this member has joined' })
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberPageQueryDto,
  ) {
    return this.historyService.getEvents(user.id, userId, query);
  }
```

- [ ] **Step 7: Run the whole agencies suite**

Run: `npm test -- src/modules/agencies && npm run build && npx eslint src/modules/agencies --max-warnings 0`
Expected: all green. The backend is now complete.

Report the task complete. Do not commit.

---

## Task 7: Flutter models

**Files:**
- Modify: `lib/features/profile/data/models/agency_member_models.dart`
- Create: `lib/features/profile/data/models/agency_member_performance_models.dart`
- Create: `lib/features/profile/data/models/agency_member_history_models.dart`
- Test: `test/features/profile/agency_member_models_test.dart`

**Interfaces:**
- Consumes: the five JSON payloads from Tasks 3-6
- Produces:
  - `MemberMetricDelta` — `{ num? value, String? coinValue, double? changePercent }` with `MemberMetricDelta.fromJson`
  - `MemberBadge` — `{ code, name, iconUrl, tier, topPercent, totalBadges }`
  - `AgencyMemberDetail` — adds `email`, `fullName`, `gender`, `language`, `badge`, `stats`, `rank`, `totalMembers`, `engagementScore`, `gradeLabel`, `gradeCaption`
  - `MemberPerformance` — `{ rank, totalMembers, topPercent, gradeLabel, gradeCaption, score, chartPoints: List<EngagementPoint>, metrics: List<MemberDetailMetric> }`
  - `MemberActivityPage`, `MemberRewardsPage`, `MemberEventsPage`, `MemberReward`, `MemberEvent`, `MemberActivityCounters`

**Reminder:** hand-written `fromJson` only. No `@freezed`, no `part` directives — `build_runner` cannot run here.

- [ ] **Step 1: Write the failing test**

Create `test/features/profile/agency_member_models_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/profile/data/models/agency_member_models.dart';
import 'package:soulzaa_mobile/features/profile/data/models/agency_member_history_models.dart';
import 'package:soulzaa_mobile/features/profile/data/models/agency_member_performance_models.dart';

void main() {
  group('AgencyMemberDetail', () {
    test('reads the profile fields the screen used to hard-code', () {
      final AgencyMemberDetail detail = AgencyMemberDetail.fromJson(<String, dynamic>{
        'profile': <String, dynamic>{
          'userId': 'u1',
          'username': 'balayya',
          'displayName': 'Balayya',
          'fullName': 'Balayya Naidu',
          'email': 'balayya@example.com',
          'gender': 'MALE',
          'language': 'Telugu',
          'country': 'IN',
          'coins': '9007199254740993',
        },
      });

      expect(detail.email, 'balayya@example.com');
      expect(detail.fullName, 'Balayya Naidu');
      expect(detail.gender, 'MALE');
      expect(detail.language, 'Telugu');
      // Past 2^53 — proof it never round-trips through a double.
      expect(detail.coins, 9007199254740993);
    });

    test('leaves every unknown field null rather than inventing a value', () {
      final AgencyMemberDetail detail =
          AgencyMemberDetail.fromJson(<String, dynamic>{'profile': <String, dynamic>{}});

      expect(detail.email, isNull);
      expect(detail.gender, isNull);
      expect(detail.language, isNull);
      expect(detail.badge, isNull);
      expect(detail.rank, isNull);
      expect(detail.engagementScore, isNull);
    });

    test('reads the badge and the summary', () {
      final AgencyMemberDetail detail = AgencyMemberDetail.fromJson(<String, dynamic>{
        'profile': <String, dynamic>{'userId': 'u1'},
        'badge': <String, dynamic>{
          'code': 'AGENCY_STAR',
          'name': 'Agency star',
          'iconUrl': 'https://cdn/star.png',
          'tier': 'GOLD',
          'topPercent': 1,
          'totalBadges': 7,
        },
        'summary': <String, dynamic>{
          'rank': 7,
          'totalMembers': 7541,
          'engagementScore': 72,
          'grade': <String, dynamic>{'label': 'Good', 'caption': 'nearly there'},
        },
      });

      expect(detail.badge!.name, 'Agency star');
      expect(detail.badge!.topPercent, 1);
      expect(detail.rank, 7);
      expect(detail.totalMembers, 7541);
      expect(detail.engagementScore, 72);
      expect(detail.gradeLabel, 'Good');
    });

    test('keeps a null trend null instead of collapsing it to zero', () {
      final AgencyMemberDetail detail = AgencyMemberDetail.fromJson(<String, dynamic>{
        'profile': <String, dynamic>{'userId': 'u1'},
        'stats': <String, dynamic>{
          'giftsSent': <String, dynamic>{'value': 50, 'changePercent': null},
          'coinsSent': <String, dynamic>{'value': '45200', 'changePercent': -3.4},
        },
      });

      expect(detail.stats['giftsSent']!.value, 50);
      expect(detail.stats['giftsSent']!.changePercent, isNull);
      expect(detail.stats['coinsSent']!.coinValue, '45200');
      expect(detail.stats['coinsSent']!.changePercent, -3.4);
    });
  });

  group('MemberPerformance', () {
    test('reads rank, engagement, chart and metrics', () {
      final MemberPerformance perf = MemberPerformance.fromJson(<String, dynamic>{
        'rank': <String, dynamic>{'position': 7, 'totalMembers': 7541, 'topPercent': 1},
        'grade': <String, dynamic>{'label': 'Good', 'caption': 'nearly there'},
        'engagement': <String, dynamic>{'score': 72, 'outOf': 100, 'topPercent': 1},
        'chart': <String, dynamic>{
          'range': 'month',
          'points': <dynamic>[
            <String, dynamic>{'date': '2026-07-19', 'value': 61},
            <String, dynamic>{'date': '2026-07-20', 'value': 64},
          ],
        },
        'metrics': <dynamic>[
          <String, dynamic>{
            'key': 'ENGAGEMENT_RATE',
            'label': 'Engagement rate',
            'percent': 72,
            'changePercent': 10.1,
          },
        ],
      });

      expect(perf.rank, 7);
      expect(perf.totalMembers, 7541);
      expect(perf.score, 72);
      expect(perf.gradeLabel, 'Good');
      expect(perf.chartPoints, hasLength(2));
      expect(perf.chartPoints.first.value, 61);
      expect(perf.chartPoints.first.date, DateTime(2026, 7, 19));
      expect(perf.metrics.single.label, 'Engagement rate');
      expect(perf.metrics.single.percent, 72);
    });

    test('survives an unranked member with an empty chart', () {
      final MemberPerformance perf = MemberPerformance.fromJson(<String, dynamic>{
        'rank': null,
        'engagement': <String, dynamic>{'score': 0, 'outOf': 100, 'topPercent': null},
      });

      expect(perf.rank, isNull);
      expect(perf.topPercent, isNull);
      expect(perf.chartPoints, isEmpty);
      expect(perf.metrics, isEmpty);
    });
  });

  group('history models', () {
    test('reads a rewards page', () {
      final MemberRewardsPage page = MemberRewardsPage.fromJson(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'id': 'r1',
            'name': 'Premium medal',
            'note': 'For top performance',
            'itemType': 'MEDAL',
            'receivedAt': '2026-06-20T00:00:00Z',
          },
        ],
        'page': 1,
        'total': 12,
        'totalPages': 1,
      });

      expect(page.items.single.name, 'Premium medal');
      expect(page.items.single.note, 'For top performance');
      expect(page.hasMore, isFalse);
    });

    test('reads an events page and its completed flag', () {
      final MemberEventsPage page = MemberEventsPage.fromJson(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'eventId': 'e1',
            'name': 'Quiz challenge',
            'thumbnailUrl': null,
            'startTime': '2026-05-21T18:10:00Z',
            'status': 'COMPLETED',
          },
        ],
        'page': 1,
        'total': 5,
        'totalPages': 1,
      });

      expect(page.items.single.name, 'Quiz challenge');
      expect(page.items.single.isCompleted, isTrue);
      expect(page.items.single.thumbnailUrl, isNull);
    });

    test('reads activity counters and timeline together', () {
      final MemberActivityPage page = MemberActivityPage.fromJson(<String, dynamic>{
        'counters': <String, dynamic>{
          'totalActivities': 135,
          'loginDays': 12,
          'giftsSent': 50,
          'giftsReceived': 50,
          'roomsJoined': 18,
          'eventsJoined': 5,
        },
        'timeline': <String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'id': 't1',
              'kind': 'LOGIN',
              'title': 'Login',
              'detail': 'user logged in to the application',
              'occurredAt': '2026-08-17T11:45:00Z',
            },
          ],
          'page': 1,
          'total': 135,
          'totalPages': 7,
        },
      });

      expect(page.counters.loginDays, 12);
      expect(page.counters.totalActivities, 135);
      expect(page.timeline.single.kind, 'LOGIN');
      expect(page.hasMore, isTrue);
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$PATH:/Users/nasinaudaysankar/development/flutter/bin"
cd /Users/nasinaudaysankar/Downloads/soulzaa-mobile
flutter test test/features/profile/agency_member_models_test.dart
```
Expected: FAIL — the new model files do not exist.

- [ ] **Step 3: Write the models**

Add to `agency_member_models.dart` (keeping the existing `_coins` and `_time` helpers):

```dart
/// A figure alongside its change against the previous period.
///
/// Two value slots because coin figures arrive as strings (BigInt in Postgres)
/// and counts arrive as numbers; a single `num` slot would silently truncate
/// the former.
class MemberMetricDelta {
  const MemberMetricDelta({this.value, this.coinValue, this.changePercent});

  final num? value;
  final String? coinValue;

  /// Null when the baseline window was zero — rendered as a dash, not `0%`.
  final double? changePercent;

  static MemberMetricDelta fromJson(Map<String, dynamic> json) {
    final Object? raw = json['value'];
    final Object? change = json['changePercent'];
    return MemberMetricDelta(
      value: raw is num ? raw : null,
      coinValue: raw is String ? raw : null,
      changePercent: change is num ? change.toDouble() : null,
    );
  }
}

/// The member's equipped badge — the "Agency star" panel.
class MemberBadge {
  const MemberBadge({
    required this.code,
    required this.name,
    required this.iconUrl,
    required this.tier,
    required this.topPercent,
    required this.totalBadges,
  });

  final String code;
  final String name;
  final String? iconUrl;
  final String? tier;

  /// Null when the agency is too small for a percentile to mean anything.
  final int? topPercent;
  final int totalBadges;

  static MemberBadge fromJson(Map<String, dynamic> json) => MemberBadge(
        code: json['code'] as String? ?? '',
        name: json['name'] as String? ?? '',
        iconUrl: json['iconUrl'] as String?,
        tier: json['tier'] as String?,
        topPercent: json['topPercent'] as int?,
        totalBadges: json['totalBadges'] as int? ?? 0,
      );
}
```

Extend `AgencyMemberDetail` with `email`, `fullName`, `gender`, `language` (all `String?`), `badge` (`MemberBadge?`), `stats` (`Map<String, MemberMetricDelta>`), and `rank`, `totalMembers`, `engagementScore` (`int?`), `gradeLabel`, `gradeCaption` (`String?`). Parse `badge` only when `json['badge']` is a `Map`, and read the summary block the same defensive way the existing `fromJson` reads `profile`.

Create the other two model files following the same conventions. `MemberPerformance.chartPoints` must produce `List<EngagementPoint>` from `engagement_overview_chart.dart` so the existing chart widget takes it unchanged — import that file rather than declaring a second point type.

- [ ] **Step 4: Run test to verify it passes**

```bash
flutter test test/features/profile/agency_member_models_test.dart
```
Expected: PASS, 9 tests

- [ ] **Step 5: Analyze**

Run: `flutter analyze lib/features/profile`
Expected: no issues.

Report the task complete. Do not commit.

---

## Task 8: Data source, repository and providers

**Files:**
- Modify: `lib/features/profile/data/datasources/agency_member_remote_data_source.dart`
- Modify: `lib/features/profile/data/repositories/agency_member_repository.dart`
- Modify: `lib/features/profile/presentation/providers/agency_member_providers.dart`
- Create: `lib/features/profile/presentation/controllers/agency_member_activity_controller.dart`

**Interfaces:**
- Consumes: models from Task 7
- Produces:
  - `AgencyMemberRemoteDataSource.fetchPerformance(String userId, {String range})`
  - `.fetchActivity(String userId, {int page, int limit, DateTime? from, DateTime? to, String sort})`
  - `.fetchRewards(String userId, {int page, int limit})`
  - `.fetchEvents(String userId, {int page, int limit})`
  - `agencyMemberPerformanceProvider(MemberPerformanceArgs)` where `MemberPerformanceArgs` is a value class over `(userId, range)` with `==`/`hashCode`
  - `agencyMemberRewardsProvider(String userId)`, `agencyMemberEventsProvider(String userId)`
  - `agencyMemberActivityControllerProvider(String userId)` — a `NotifierProvider.family` exposing `AsyncValue<MemberActivityPage>` plus:
    - `setRange(DateTimeRange?)`, `setSort(String)`, `loadMore()`
    - `DateTimeRange? get range` and `String get sort` — so the chip and dropdown can render their live values
    - `int get animationEpoch` — incremented by `setRange` and `setSort`, **not** by `loadMore`. Task 12 keys the timeline entrance animation on it, so a filter change re-animates the list while appending a page does not.

- [ ] **Step 1: Add the four data source methods**

Each mirrors the existing `fetchMember` at `agency_member_remote_data_source.dart:34` — build the path from `_base`, pass query parameters, and hand the response to `ResponseParser.parse`. Omit `from`/`to` from the query map when null, following the existing `search` precedent at line 28: an empty value would be a real filter rather than no filter. Send dates as `toUtc().toIso8601String()`.

- [ ] **Step 2: Add the four repository methods**

One-line pass-throughs, matching the existing style in `agency_member_repository.dart`.

- [ ] **Step 3: Add the providers**

Follow the existing `agencyMemberDetailProvider` family pattern at `agency_member_providers.dart:36`. All new providers are auto-disposed.

`MemberPerformanceArgs` needs value equality — without it, a `FutureProvider.family` keyed on a record would refetch on every rebuild.

- [ ] **Step 4: Write the activity controller**

`AgencyMemberActivityController extends FamilyNotifier<AsyncValue<MemberActivityPage>, String>`, holding `_page`, `_range` and `_sort`. `loadMore` appends to the existing timeline list rather than replacing it, and does nothing when `!state.value!.hasMore`. `setRange` and `setSort` reset `_page` to 1 and refetch. Error handling uses `ErrorMapper.toException(err, stack).message`, matching `agency_member_controller.dart:36`.

- [ ] **Step 5: Analyze**

Run: `flutter analyze lib/features/profile`
Expected: no issues.

Report the task complete. Do not commit.

---

## Task 9: Split the screen into widget files

This task is a pure refactor — **no behaviour changes, no data wiring**. Doing it separately means the next four tasks each touch one small file, and any bug they introduce is obvious.

**Files:**
- Modify: `lib/features/profile/presentation/screens/member_profile_screen.dart`
- Create: ten files under `lib/features/profile/presentation/widgets/member_profile/`

- [ ] **Step 1: Move each `_build*` method into its own widget**

| New file | From |
|---|---|
| `member_profile_header_card.dart` | `_buildTopCard` (`:410-561`) |
| `member_basic_information_card.dart` | `_buildBasicInformation`, `_buildInfoItem` (`:678-805`) |
| `member_performance_summary_card.dart` | `_buildPerformanceSummary` (`:807-942`) |
| `member_rewards_card.dart` | the rewards half of `_buildBottomSection`, `_buildRewardItem` (`:944-1042`) |
| `member_events_card.dart` | the events half of `_buildBottomSection`, `_buildEventItem` (`:944-1073`) |
| `member_overview_stats_row.dart` | `_buildStatsList`, `_buildStatCard` (`:614-676`) |
| `member_activity_tab.dart` | `_buildActivityTab`, `_buildActivityStatCard` (`:125-328`) |
| `member_activity_timeline.dart` | `_buildTimelineItem`, `_DottedLinePainter` (`:330-408`, `:1365-1398`) |
| `member_performance_tab.dart` | `_buildPerformanceTab` (`:1074-1321`) |
| `member_detail_metrics_card.dart` | `_buildPerformanceMetricRow` (`:1323-1362`) |

Each becomes a `StatelessWidget` (or `ConsumerWidget` where the next tasks will need `ref`) taking exactly the values it renders as constructor parameters. Keep the hard-coded strings **as they are** for now — this task must not change a single pixel.

- [ ] **Step 2: Verify nothing changed**

Run: `flutter analyze lib/features/profile`
Expected: no issues.

Then build and open the member profile:
```bash
flutter run -t lib/main_production.dart
```
Expected: the screen looks byte-identical to the screenshots — same fake email, same `#7`, same everything. If anything moved, the refactor is wrong.

The screen file should now be roughly 150 lines.

Report the task complete. Do not commit.

---

## Task 10: Wire the header card and Basic information

**Files:**
- Modify: `member_profile_header_card.dart`, `member_basic_information_card.dart`
- Modify: `member_profile_screen.dart` (pass the detail through)

- [ ] **Step 1: Replace the header's hard-coded values**

- Avatar: `Image.network(detail.avatarUrl!)` when `avatarUrl` is non-null, wrapped in `ClipOval`, with the existing grey `Icons.person` container as both the null case and the `errorBuilder`. Delete the `assets/member_profile/ChatGPT Image Aug 10, 2026, 05_40_45 PM 15.png` reference — that asset is a coin, which is why the screenshot shows a coin where a face belongs.
- Email: `detail.email ?? '—'` replacing the literal `'ananya@gmail.com'`.
- Joined date: `DateFormat('d MMM yyyy').format(detail.joinedAgencyAt!)` prefixed with `Joined on `, or `—` when null. Replaces the literal `'Joined on 10 May 2026'`.
- Active badge: keep, it already reads `isActive`.

- [ ] **Step 2: Replace Basic information's hard-coded values**

| Field | Was | Becomes |
|---|---|---|
| Full name | `'Ananya sharma'` | `detail.fullName ?? '—'` |
| Username | `'@ananya_21'` | `detail.username.isEmpty ? '—' : '@${detail.username}'` |
| Gender | `'Female'` | title-cased `detail.gender ?? '—'` |
| Language | `'English, Hindi'` | `detail.language ?? '—'` |
| Country | already dynamic | unchanged |

Agency star panel: render from `detail.badge`. Hide the whole panel when `badge` is null and let the info grid take the full width. The sub-label is `Top ${badge.topPercent}% Active` when `topPercent` is non-null, and omitted otherwise. `View all Badges` reads `View all ${badge.totalBadges} badges`. Use `Image.network(badge.iconUrl!)` with the existing `errorBuilder` fallback.

- [ ] **Step 3: Verify on device**

Run the app, open a member profile.
Expected: Balayya's own email, name and username — not Ananya's. A member with no gender set shows `—`.

- [ ] **Step 4: Analyze**

Run: `flutter analyze lib/features/profile`

Report the task complete. Do not commit.

---

## Task 11: Wire the Overview tab's stats, summary, rewards and events

**Files:**
- Modify: `member_overview_stats_row.dart`, `member_performance_summary_card.dart`, `member_rewards_card.dart`, `member_events_card.dart`

- [ ] **Step 1: Stat cards**

Each card takes a `MemberMetricDelta?`. The trend row replaces the hard-coded `'10.1%'` / green up-arrow with:
- `changePercent == null` → render `—` in grey and omit the arrow entirely
- `changePercent < 0` → `Icons.arrow_downward` in red
- otherwise → the existing green up-arrow

Format as `${changePercent.abs().toStringAsFixed(1)}%`. This is why the screenshot shows `↑10.1%` beside a `0` on all four cards — one literal, repeated.

- [ ] **Step 2: Performance summary**

- `Rank in Agency` → `#${detail.rank}` / `of ${NumberFormat.decimalPattern('en_IN').format(detail.totalMembers)} members`, both `—` when null
- `Engagement score` → `detail.engagementScore` with the `/100` suffix kept
- `Performance grade` → `detail.gradeLabel` and `detail.gradeCaption`, with the colour chosen from the grade code rather than hard-coded green: `EXCELLENT`/`GOOD` green, `FAIR` amber, `NEEDS_WORK` grey

- [ ] **Step 3: Rewards card**

Watch `agencyMemberRewardsProvider(userId)`. Render the first four items in the existing 2×2 grid. Title is `name`, subtitle is `note ?? itemType`, date is `DateFormat('d MMM yyyy').format(receivedAt)`. Empty state: `No rewards yet.` centred in the card.

`View all` **expands the card in place** to show every fetched item, and its label toggles to `Show less`. It is hidden entirely when `total <= 4`. It does not navigate — there is no rewards-detail screen in this app, and this plan does not build one.

Reward icons: the API sends no icon for a distribution, so map `itemType` to one of the existing `assets/member_profile/` images with a default fallback. Keep this map in the widget file — it is presentation, not data.

- [ ] **Step 4: Events card**

Watch `agencyMemberEventsProvider(userId)`. Thumbnail is `Image.network(thumbnailUrl!)` with the existing grey placeholder as null case and `errorBuilder`. Title is `name`, subtitle is `DateFormat('d MMM yyyy - hh:mm a').format(startTime)`. The green `Completed` chip renders only when `isCompleted`; otherwise show the raw status in grey. Empty state: `No events joined yet.`

`View all` behaves exactly as on the rewards card — expand in place, toggle to `Show less`, hidden when `total <= 4`.

- [ ] **Step 5: Verify on device**

Expected: real rewards and events, or honest empty states. No `Premium medal` unless the agency actually sent one.

- [ ] **Step 6: Analyze**

Run: `flutter analyze lib/features/profile`

Report the task complete. Do not commit.

---

## Task 12: Wire the Activity tab, its filters and the animated timeline

**Files:**
- Modify: `member_activity_tab.dart`, `member_activity_timeline.dart`

- [ ] **Step 1: Counters**

Watch `agencyMemberActivityControllerProvider(userId)`. The six cards read from `counters`. Delete the `'7'` literal on Login days and the `'5'` on Events joined.

- [ ] **Step 2: Date range chip**

`onTap` opens `showDateRangePicker` with `firstDate: DateTime(2020)`, `lastDate: DateTime.now()`, and the current range as `initialDateRange`. On selection call `controller.setRange(picked)`. The label renders the live range as `d MMM yyyy - d MMM yyyy`, replacing the fixed `'13 May 2026 - 15 May 2026'`.

- [ ] **Step 3: Sort dropdown**

`Newest first` / `Oldest first`, calling `controller.setSort('newest' | 'oldest')`.

- [ ] **Step 4: Timeline**

Render from `page.timeline` instead of the six hard-coded `_buildTimelineItem` calls. Map `kind` to icon and colour in the widget:

| `kind` | icon | colour |
|---|---|---|
| `LOGIN` | `Icons.login` | `Colors.pink.shade300` |
| `VIDEO_ROOM_JOINED` | `Icons.videocam` | `Colors.pink.shade300` |
| `GIFT_SENT` | `Icons.card_giftcard` | `Colors.purple.shade300` |
| `ROOM_JOINED` | `Icons.mic` | `Colors.purple.shade300` |
| `GIFT_RECEIVED` | `Icons.card_giftcard` | `Colors.lime.shade600` |
| `EVENT_JOINED` | `Icons.event` | `Colors.lime.shade600` |

`isFirst` and `isLast` come from the index, so `_DottedLinePainter` keeps working. Time renders via `DateFormat` with a `Today`/`Yesterday` prefix when the date matches.

- [ ] **Step 5: The entrance animation**

Wrap each card:

```dart
TweenAnimationBuilder<double>(
  key: ValueKey<String>('${animationEpoch}_${entry.id}'),
  tween: Tween<double>(begin: 0, end: 1),
  duration: const Duration(milliseconds: 300),
  curve: Curves.easeOut,
  builder: (BuildContext context, double t, Widget? child) => Opacity(
    opacity: t,
    child: Transform.translate(offset: Offset(0, 12 * (1 - t)), child: child),
  ),
  child: card,
)
```

Stagger via a per-index delay, capped at index 11 so appending page 3 does not cascade for a second and a half:

```dart
final int staggerIndex = index.clamp(0, 11);
final Duration delay = Duration(milliseconds: 60 * staggerIndex);
```

`animationEpoch` is an int the controller bumps whenever the range or sort changes, so changing a filter visibly redraws the list. Appending a page must **not** bump it — otherwise the whole list re-animates on every `Load more`.

- [ ] **Step 6: Load more**

Calls `controller.loadMore()`. Hidden when `!page.hasMore`. Shows a small spinner in place of the label while the next page is in flight.

- [ ] **Step 7: Verify on device**

Expected: the timeline animates in on open and on every filter change; the date chip opens a picker and the counters change with it; `Load more` appends without re-animating everything.

- [ ] **Step 8: Analyze**

Run: `flutter analyze lib/features/profile`

Report the task complete. Do not commit.

---

## Task 13: Wire the Performance tab

**Files:**
- Modify: `member_performance_tab.dart`, `member_detail_metrics_card.dart`
- Create: `lib/features/profile/presentation/widgets/member_profile/metric_bar.dart`

- [ ] **Step 1: Rank and grade cards**

From `agencyMemberPerformanceProvider`. Replaces `#7`, `of 7,152 members`, `Excellent` and `keep it up!`. Note the screen currently shows `7,152` here and `7,541` on the Overview tab — two different fake numbers for the same figure; both become the one real `totalMembers`.

- [ ] **Step 2: Engagement score banner**

- score and `/100` from `performance.score`
- the progress bar's `widthFactor` becomes `performance.score / 100`, replacing the hard-coded `0.72`
- the percentage label becomes `${performance.score}%`
- the headline replaces `'Great job, Ananya! 🌟'` with `'Great job, ${detail.displayName}! 🌟'`
- the body: when `topPercent != null`, `You are among the top ${topPercent}% most active members in your agency. Keep up the amazing work!`; when null, fall back to a grade-keyed sentence so the banner is never blank

- [ ] **Step 3: Chart**

`EngagementOverviewChart(points: performance.chartPoints)` replacing the `_engagementSeries` static list. Delete `_engagementSeries` and its comment from the screen.

The `This month` dropdown becomes week / month / quarter, re-reading `agencyMemberPerformanceProvider` with the new range. Label the options `This week` / `This month` / `This quarter`.

- [ ] **Step 4: Metric bar**

Create `metric_bar.dart` — a `StatelessWidget` taking `percent` (0-100) and `color`, drawing a rounded track with a `FractionallySizedBox` fill. This replaces `Image.asset('assets/memberperformanecy/Line 60.png', height: 6, width: double.infinity, fit: BoxFit.fill)`: a fixed-width PNG cannot represent a variable percentage, and `BoxFit.fill` stretches it differently on every screen width.

- [ ] **Step 5: Detail metrics**

Render `performance.metrics` as a list rather than four hard-coded rows. Keep the existing per-metric icon and colour, keyed off `metric.key`. Value is `${metric.percent}%`; the trend follows the same null / negative / positive rules as Task 11 Step 1.

- [ ] **Step 6: Verify on device**

Expected: the chart draws the member's real series; the four bars move with their real percentages; the range dropdown changes the chart.

- [ ] **Step 7: Final check**

```bash
flutter analyze lib
flutter test
```
Expected: no issues, all tests pass.

Then grep for anything left behind:

```bash
grep -rn "ananya\|Ananya\|7,541\|7,152\|10\.1%" lib/features/profile/
```
Expected: no matches. If any remain, they are hard-coded values this plan missed — fix them.

Report the task complete. Do not commit.

---

## Verification

The whole feature is done when all of these hold:

1. `npm test -- src/modules/agencies` — all green
2. `npm run build` — no TypeScript errors
3. `npx eslint src/modules/agencies --max-warnings 0` — clean
4. `flutter analyze lib` — no issues
5. `flutter test` — all green
6. `grep -rn "ananya\|Ananya\|7,541\|7,152\|10\.1%" lib/features/profile/` — no matches
7. On device: opening two different members shows two different emails, names, scores and timelines
