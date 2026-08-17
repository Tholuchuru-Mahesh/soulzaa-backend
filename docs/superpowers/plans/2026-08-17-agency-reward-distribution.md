# Agency Reward Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three unwired agency reward screens backend-driven, and make the send actually send.

**Architecture:** Two backend endpoints gain fields, filters and pagination; one new stats endpoint is added; the existing `POST rewards/distribute` is left alone and finally called. On the mobile side a `Notifier`-held draft carries the recipient and reward across the three-screen wizard, which currently passes nothing between screens.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Jest (backend); Flutter, Riverpod, Dio, GoRouter (mobile).

**Spec:** `docs/superpowers/specs/2026-08-17-agency-reward-distribution-design.md`

## Global Constraints

- **Agency comes from the JWT.** No endpoint accepts an `agencyId`. Reward reads are scoped `where: { agencyId }`; member reads go through the existing `AgencyRelationship` scoping.
- **Null, never zero.** A value the platform cannot answer is `null` and renders as `—`. Exception, stated explicitly: `level` defaults to **1**, not 0 or null — `UserStatistics.level` is `@default(1)` and every account starts there.
- **Filter before paginate.** `filter=top` and `filter=active` must be applied to the member set *before* slicing the page, or page 2 of a filtered list is wrong.
- **`filter=top` in a small agency:** `topPercent` is null below 10 members, so "top 10%" matches nobody. Fall back to the single highest-ranked member.
- **Idempotency key is generated once per draft**, when the draft starts from the member card — never per send attempt. Regenerating it defeats the server's replay protection in exactly the case it exists for.
- **No Flutter codegen.** `build_runner` cannot run in this repo. Hand-written `fromJson` only; never add `@freezed` or `part` directives.
- **Coin/BigInt values are strings.** Not relevant to rewards (quantities are `Int`), but holds if any coin field is added.
- **Backend test command:** `npm test -- <path>` from `/Users/nasinaudaysankar/Downloads/soulzaa-backend`.
- **Backend lint must match CI:** `npx eslint "{src,test}/**/*.ts" --max-warnings 0` — the full glob, not a scoped path.
- **Flutter commands:** `export PATH="$PATH:/Users/nasinaudaysankar/development/flutter/bin"` first, then run from `/Users/nasinaudaysankar/Downloads/soulzaa-mobile`. Never pipe into `tail`.
- **Do not commit.** The user stages and commits. Where a step says commit, stop and report instead.

---

## File Structure

### Backend

| File | Responsibility |
|---|---|
| `services/agency-member.service.ts` | **Modify** — `level`, `filter` in `listMembers` |
| `services/agency-reward.service.ts` | **Modify** — distributions identity/paging/range, new `getStats` |
| `dto/agency-operations.dto.ts` | **Modify** — `AgencyDistributionQueryDto` |
| `dto/agency-member-query.dto.ts` | **Modify** — `filter` |
| `controllers/agency-operations.controller.ts` | **Modify** — query on distributions, new stats route |

### Mobile

| File | Responsibility |
|---|---|
| `data/models/agency_reward_distribution_models.dart` | **Create** — distribution row, page, stats |
| `presentation/providers/agency_reward_providers.dart` | **Modify** — stats + distributions providers, `distributeReward` |
| `presentation/controllers/agency_reward_draft_controller.dart` | **Create** — the wizard's state |
| `screens/agency_reward_distribution_screen.dart` | **Modify** — stats + member list |
| `screens/agency_send_reward_screen.dart` | **Modify** — reward selection |
| `screens/agency_send_reward_confirm_screen.dart` | **Modify** — draft + the distribute call |
| `screens/agency_send_reward_success_screen.dart` | **Modify** — accept the result |
| `screens/agency_distribution_history_screen.dart` | **Modify** — real rows, range, paging |
| `core/routing/app_router.dart` | **Modify** — pass the result to the success route |

---

## Task 1: Member list — `level` and `filter`

**Files:**
- Modify: `src/modules/agencies/services/agency-member.service.ts`
- Modify: `src/modules/agencies/dto/agency-member-query.dto.ts`
- Modify: `src/modules/agencies/controllers/agency-member.controller.ts`
- Test: `src/modules/agencies/services/agency-member.spec.ts`

**Interfaces:**
- Consumes: `AgencyMemberScoreService.rankAgency(agencyId): Promise<Map<string, MemberScore>>`
- Produces: `listMembers(agencyId, { search?, page?, limit?, filter? })` where `filter` is `'all' | 'active' | 'top'`; each item gains `level: number`

- [ ] **Step 1: Write the failing tests**

Extend the `build()` prisma mock in `agency-member.spec.ts` with:

```ts
      userStatistics: { findMany: jest.fn().mockResolvedValue([]) },
```

Then add inside `describe('listMembers')`:

```ts
    function threeMembers(prisma: any) {
      prisma.agencyRelationship.findMany.mockResolvedValue([
        { hostId: 'a', effectiveFrom: new Date('2026-01-03') },
        { hostId: 'b', effectiveFrom: new Date('2026-01-02') },
        { hostId: 'c', effectiveFrom: new Date('2026-01-01') },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'a', username: 'a', fullName: null, country: 'IN' },
        { id: 'b', username: 'b', fullName: null, country: 'IN' },
        { id: 'c', username: 'c', fullName: null, country: 'IN' },
      ]);
    }

    it('returns the real level from statistics', async () => {
      const { service, prisma } = build();
      threeMembers(prisma);
      prisma.userStatistics.findMany.mockResolvedValue([{ userId: 'a', level: 18 }]);

      const res = await service.listMembers(AGENCY);

      expect(res.items.find((m: any) => m.userId === 'a').level).toBe(18);
    });

    it('reports level 1 for a member with no statistics row', async () => {
      // Every account starts at level 1, so 1 is the true answer — not 0.
      const { service, prisma } = build();
      threeMembers(prisma);

      const res = await service.listMembers(AGENCY);

      expect(res.items[0].level).toBe(1);
    });

    it('filters to the top decile using the agency ranking', async () => {
      const { service, prisma, scores } = build();
      threeMembers(prisma);
      scores.rankAgency.mockResolvedValue(
        new Map([
          ['a', { userId: 'a', rank: 1, totalMembers: 30, topPercent: 4, score: 90 }],
          ['b', { userId: 'b', rank: 2, totalMembers: 30, topPercent: 7, score: 80 }],
          ['c', { userId: 'c', rank: 25, totalMembers: 30, topPercent: 84, score: 10 }],
        ]),
      );

      const res = await service.listMembers(AGENCY, { filter: 'top' });

      expect(res.items.map((m: any) => m.userId).sort()).toEqual(['a', 'b']);
      expect(res.total).toBe(2);
    });

    it('falls back to the single best member when the agency is too small for a percentile', async () => {
      // topPercent is null below 10 members, so "top 10%" would match nobody.
      const { service, prisma, scores } = build();
      threeMembers(prisma);
      scores.rankAgency.mockResolvedValue(
        new Map([
          ['a', { userId: 'a', rank: 2, totalMembers: 3, topPercent: null, score: 40 }],
          ['b', { userId: 'b', rank: 1, totalMembers: 3, topPercent: null, score: 70 }],
          ['c', { userId: 'c', rank: 3, totalMembers: 3, topPercent: null, score: 10 }],
        ]),
      );

      const res = await service.listMembers(AGENCY, { filter: 'top' });

      expect(res.items.map((m: any) => m.userId)).toEqual(['b']);
    });

    it('filters before paginating, so page 2 is the second page of matches', async () => {
      const { service, prisma, scores } = build();
      prisma.agencyRelationship.findMany.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          hostId: `m${i}`,
          effectiveFrom: new Date(2026, 0, 1 + i),
        })),
      );
      prisma.user.findMany.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          id: `m${i}`,
          username: `m${i}`,
          fullName: null,
          country: 'IN',
        })),
      );
      // Only the first four are in the top decile.
      scores.rankAgency.mockResolvedValue(
        new Map(
          Array.from({ length: 30 }, (_, i) => [
            `m${i}`,
            { userId: `m${i}`, rank: i + 1, totalMembers: 30, topPercent: i < 4 ? 5 : 50, score: 0 },
          ]),
        ),
      );

      const res = await service.listMembers(AGENCY, { filter: 'top', page: 2, limit: 3 });

      expect(res.total).toBe(4);
      expect(res.totalPages).toBe(2);
      expect(res.items).toHaveLength(1);
    });

    it('filters to recently active members', async () => {
      const { service, prisma } = build();
      threeMembers(prisma);
      prisma.userSession.findMany.mockResolvedValue([{ userId: 'b' }]);

      const res = await service.listMembers(AGENCY, { filter: 'active' });

      expect(res.items.map((m: any) => m.userId)).toEqual(['b']);
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-member.spec.ts`
Expected: FAIL — `level` is undefined, `filter` is ignored.

- [ ] **Step 3: Add `filter` to the DTO**

In `src/modules/agencies/dto/agency-member-query.dto.ts`:

```ts
  @ApiPropertyOptional({ enum: ['all', 'active', 'top'], default: 'all' })
  @IsOptional()
  @IsIn(['all', 'active', 'top'])
  filter?: 'all' | 'active' | 'top';
```

Add `IsIn` to the `class-validator` import. Pass `filter: query.filter` through in `agency-member.controller.ts`'s `list()`.

- [ ] **Step 4: Implement in `listMembers`**

`listMembers` currently sorts `users`, then slices the page, then reads wallets for the page. Insert filtering between the sort and the slice:

```ts
    // Applied to the whole member set before the page is cut. Filtering the
    // page instead would make page 2 the filtered subset of page 2's members
    // rather than the second page of matching members.
    const filter = options.filter ?? 'all';
    let filtered = users;

    if (filter === 'active') {
      const activeIds = await this.recentlyActiveIds(users.map((u) => u.id));
      filtered = users.filter((u) => activeIds.has(u.id));
    } else if (filter === 'top') {
      const ranked = await this.scores.rankAgency(agencyId);
      const inTopDecile = users.filter((u) => {
        const percent = ranked.get(u.id)?.topPercent;
        return percent !== null && percent !== undefined && percent <= TOP_DECILE;
      });
      // Below 10 members the scoring service withholds a percentile entirely,
      // so "top 10%" matches nobody. One best member is a truer answer than an
      // empty list.
      if (inTopDecile.length > 0) {
        filtered = inTopDecile;
      } else {
        const best = users
          .filter((u) => ranked.has(u.id))
          .sort((a, b) => ranked.get(a.id)!.rank - ranked.get(b.id)!.rank)[0];
        filtered = best ? [best] : [];
      }
    }

    const total = filtered.length;
    const pageUsers = filtered.slice((page - 1) * limit, page * limit);
```

Add `const TOP_DECILE = 10;` beside the other module constants.

Add the statistics read to the existing `Promise.all` for the page:

```ts
      this.prisma.userStatistics.findMany({
        where: { userId: { in: pageIds } },
        select: { userId: true, level: true },
      }),
```

and map it:

```ts
    const levelById = new Map(stats.map((s) => [s.userId, s.level]));
    // …in the item mapping:
        level: levelById.get(user.id) ?? DEFAULT_LEVEL,
```

with `const DEFAULT_LEVEL = 1;` beside the others.

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-member.spec.ts`
Expected: PASS, including the pre-existing isolation tests.

- [ ] **Step 6: Build and lint**

Run: `npm run build && npx eslint "{src,test}/**/*.ts" --max-warnings 0`

Report the task complete. Do not commit.

---

## Task 2: Distributions — identity, paging and range

**Files:**
- Modify: `src/modules/agencies/services/agency-reward.service.ts`
- Modify: `src/modules/agencies/dto/agency-operations.dto.ts`
- Modify: `src/modules/agencies/controllers/agency-operations.controller.ts`
- Test: `src/modules/agencies/services/agency-reward.spec.ts`

**Interfaces:**
- Consumes: `IProfileService.resolvePublicIdentities(ids: string[]): Promise<Map<string, { displayName: string | null; avatarUrl: string | null }>>`
- Produces: `listDistributions(agencyId, { page?, limit?, range? })` → `{ items, page, limit, total, totalPages }`, each item `{ id, recipientId, recipientName, recipientAvatarUrl, itemType, name, quantity, kind, note, occurredAt }`

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/agencies/services/agency-reward.spec.ts`. If `AgencyRewardService` does not currently take `PROFILE_SERVICE`, the constructor gains it as the last parameter, and the spec's builder passes a stub:

```ts
  const profiles = {
    resolvePublicIdentities: jest.fn().mockResolvedValue(
      new Map([['u1', { displayName: 'balayya', avatarUrl: 'https://cdn/a.png' }]]),
    ),
  };
```

```ts
  describe('listDistributions', () => {
    function rows(prisma: any, count: number) {
      prisma.agencyRewardDistribution.findMany.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({
          id: `r${i}`,
          recipientId: 'u1',
          itemType: 'MEDAL',
          name: 'Premium medal',
          quantity: 1,
          kind: 'ASSIGNED',
          note: null,
          createdAt: new Date('2026-06-20T00:00:00Z'),
        })),
      );
      prisma.agencyRewardDistribution.count.mockResolvedValue(count);
    }

    it('scopes to the calling agency', async () => {
      const { service, prisma } = build();
      rows(prisma, 1);

      await service.listDistributions(AGENCY);

      expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agencyId: AGENCY }) }),
      );
    });

    it('resolves the recipient identity in one bulk call', async () => {
      const { service, prisma, profiles } = build();
      rows(prisma, 3);

      const res = await service.listDistributions(AGENCY);

      expect(profiles.resolvePublicIdentities).toHaveBeenCalledTimes(1);
      expect(res.items[0].recipientName).toBe('balayya');
      expect(res.items[0].recipientAvatarUrl).toBe('https://cdn/a.png');
    });

    it('returns null identity rather than failing when the profile seam has nothing', async () => {
      const { service, prisma, profiles } = build();
      rows(prisma, 1);
      profiles.resolvePublicIdentities.mockResolvedValue(new Map());

      const res = await service.listDistributions(AGENCY);

      expect(res.items[0].recipientName).toBeNull();
      expect(res.items[0].recipientAvatarUrl).toBeNull();
    });

    it('pages', async () => {
      const { service, prisma } = build();
      rows(prisma, 20);
      prisma.agencyRewardDistribution.count.mockResolvedValue(45);

      const res = await service.listDistributions(AGENCY, { page: 2, limit: 20 });

      expect(res).toMatchObject({ page: 2, limit: 20, total: 45, totalPages: 3 });
      expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('applies no date bound for range=all', async () => {
      const { service, prisma } = build();
      rows(prisma, 1);

      await service.listDistributions(AGENCY, { range: 'all' });

      const where = prisma.agencyRewardDistribution.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toBeUndefined();
    });

    it.each([
      ['today', 1],
      ['week', 7],
      ['month', 30],
    ])('bounds range=%s', async (range, _days) => {
      const { service, prisma } = build();
      rows(prisma, 1);

      await service.listDistributions(AGENCY, { range: range as never });

      const where = prisma.agencyRewardDistribution.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(where.createdAt.gte.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('clamps an absurd page size', async () => {
      const { service, prisma } = build();
      rows(prisma, 1);

      await service.listDistributions(AGENCY, { limit: 100_000 });

      expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-reward.spec.ts`
Expected: FAIL — `recipientName` undefined, no `page`/`total`.

- [ ] **Step 3: Write the DTO**

In `src/modules/agencies/dto/agency-operations.dto.ts`:

```ts
const DISTRIBUTION_RANGES = ['all', 'today', 'week', 'month'] as const;

export class AgencyDistributionQueryDto {
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

  @ApiPropertyOptional({ enum: DISTRIBUTION_RANGES, default: 'all' })
  @IsOptional()
  @IsIn(DISTRIBUTION_RANGES)
  range?: (typeof DISTRIBUTION_RANGES)[number];
}
```

- [ ] **Step 4: Implement**

Replace `listDistributions` in `agency-reward.service.ts`:

```ts
  /** What the agency has sent, newest first. */
  async listDistributions(
    agencyId: string,
    options: { page?: number; limit?: number; range?: 'all' | 'today' | 'week' | 'month' } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);
    const where = { agencyId, ...this.rangeFilter(options.range ?? 'all') };

    const [rows, total] = await Promise.all([
      this.prisma.agencyRewardDistribution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.agencyRewardDistribution.count({ where }),
    ]);

    // One bulk call for the whole page. The history rows render a recipient
    // thumbnail, which a bare id cannot fill.
    const identities = await this.profiles.resolvePublicIdentities(
      [...new Set(rows.map((r) => r.recipientId))],
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        recipientId: row.recipientId,
        recipientName: identities.get(row.recipientId)?.displayName ?? null,
        recipientAvatarUrl: identities.get(row.recipientId)?.avatarUrl ?? null,
        itemType: row.itemType,
        name: row.name,
        quantity: row.quantity,
        kind: row.kind,
        note: row.note,
        occurredAt: row.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** `all` has no bound; the others are a lower bound on `createdAt`. */
  private rangeFilter(range: 'all' | 'today' | 'week' | 'month') {
    if (range === 'all') return {};
    const now = new Date();
    if (range === 'today') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { createdAt: { gte: start } };
    }
    const days = range === 'week' ? 7 : 30;
    return { createdAt: { gte: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) } };
  }
```

Inject `@Inject(PROFILE_SERVICE) private readonly profiles: IProfileService` into the constructor, importing from `src/modules/users/interfaces/profile.interface`.

- [ ] **Step 5: Wire the route**

In `agency-operations.controller.ts`:

```ts
  @Get('rewards/distributions')
  @ApiOperation({ summary: 'Rewards the agency has sent, newest first' })
  distributions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AgencyDistributionQueryDto,
  ) {
    return this.rewards.listDistributions(user.id, query);
  }
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -- src/modules/agencies/services/agency-reward.spec.ts`
Expected: PASS

- [ ] **Step 7: Build and lint**

Run: `npm run build && npx eslint "{src,test}/**/*.ts" --max-warnings 0`

Report the task complete. Do not commit.

---

## Task 3: Reward stats endpoint

**Files:**
- Modify: `src/modules/agencies/services/agency-reward.service.ts`
- Modify: `src/modules/agencies/controllers/agency-operations.controller.ts`
- Test: `src/modules/agencies/services/agency-reward.spec.ts`

**Interfaces:**
- Produces: `getStats(agencyId): Promise<{ totalSent: number; today: number; thisMonth: number }>`

- [ ] **Step 1: Write the failing test**

```ts
  describe('getStats', () => {
    it('counts all-time, today and this month, scoped to the agency', async () => {
      const { service, prisma } = build();
      prisma.agencyRewardDistribution.count
        .mockResolvedValueOnce(1248)
        .mockResolvedValueOnce(24)
        .mockResolvedValueOnce(378);

      const res = await service.getStats(AGENCY);

      expect(res).toEqual({ totalSent: 1248, today: 24, thisMonth: 378 });
      for (const call of prisma.agencyRewardDistribution.count.mock.calls) {
        expect(call[0].where.agencyId).toBe(AGENCY);
      }
    });

    it('reports real zeros for an agency that has sent nothing', async () => {
      // Zero is the true answer here, not a missing one.
      const { service, prisma } = build();
      prisma.agencyRewardDistribution.count.mockResolvedValue(0);

      const res = await service.getStats(AGENCY);

      expect(res).toEqual({ totalSent: 0, today: 0, thisMonth: 0 });
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/modules/agencies/services/agency-reward.spec.ts`
Expected: FAIL — `service.getStats is not a function`

- [ ] **Step 3: Implement**

```ts
  /**
   * The three figures above the distribution screen's member list.
   *
   * Its own method rather than a block on `listDistributions`: the screen that
   * needs these wants no rows at all, and the screen that wants rows needs no
   * stats.
   */
  async getStats(agencyId: string) {
    const [totalSent, today, thisMonth] = await Promise.all([
      this.prisma.agencyRewardDistribution.count({ where: { agencyId } }),
      this.prisma.agencyRewardDistribution.count({
        where: { agencyId, ...this.rangeFilter('today') },
      }),
      this.prisma.agencyRewardDistribution.count({
        where: { agencyId, ...this.rangeFilter('month') },
      }),
    ]);
    return { totalSent, today, thisMonth };
  }
```

- [ ] **Step 4: Wire the route**

```ts
  @Get('rewards/stats')
  @ApiOperation({ summary: 'How many rewards this agency has sent' })
  rewardStats(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.getStats(user.id);
  }
```

Declare it **above** any `@Get('rewards/:id')` route if one is ever added, so `stats` is not swallowed as an id.

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- src/modules/agencies && npm run build && npx eslint "{src,test}/**/*.ts" --max-warnings 0`
Expected: all green. Backend complete.

Report the task complete. Do not commit.

---

## Task 4: Mobile models and providers

**Files:**
- Create: `lib/features/profile/data/models/agency_reward_distribution_models.dart`
- Modify: `lib/features/profile/presentation/providers/agency_reward_providers.dart`
- Test: `test/features/profile/agency_reward_distribution_models_test.dart`

**Interfaces:**
- Produces:
  - `AgencyDistributionRow` — `{ id, recipientId, recipientName, recipientAvatarUrl, itemType, name, quantity, kind, note, occurredAt }`, with `AgencyDistributionRow.fromJson`
  - `AgencyDistributionPage` — `{ items, page, total, totalPages }`, `hasMore`, `appending(next)`
  - `AgencyRewardStats` — `{ totalSent, today, thisMonth }`
  - `agencyRewardStatsProvider` — `FutureProvider<AgencyRewardStats>`
  - `agencyDistributionsProvider` — `FutureProvider.family<AgencyDistributionPage, String>` keyed by range
  - `distributeReward(DioClient, {inventoryId, recipientId, quantity, kind, note, idempotencyKey}) → Future<(AgencyDistributionRow?, String?)>` — row on success, message on failure

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/profile/data/models/agency_reward_distribution_models.dart';

void main() {
  test('reads a distribution row', () {
    final AgencyDistributionRow row = AgencyDistributionRow.fromJson(<String, dynamic>{
      'id': 'r1',
      'recipientId': 'u1',
      'recipientName': 'balayya',
      'recipientAvatarUrl': 'https://cdn/a.png',
      'itemType': 'MEDAL',
      'name': 'Premium medal',
      'quantity': 2,
      'kind': 'ASSIGNED',
      'note': 'For top performance',
      'occurredAt': '2026-06-20T00:00:00Z',
    });

    expect(row.recipientName, 'balayya');
    expect(row.quantity, 2);
    expect(row.occurredAt, isNotNull);
  });

  test('survives a row with no resolved recipient identity', () {
    final AgencyDistributionRow row = AgencyDistributionRow.fromJson(<String, dynamic>{
      'id': 'r1',
      'recipientId': 'u1',
      'name': 'Premium medal',
    });

    expect(row.recipientName, isNull);
    expect(row.recipientAvatarUrl, isNull);
    expect(row.quantity, 1);
  });

  test('pages and appends', () {
    Map<String, dynamic> page(int p, int totalPages) => <String, dynamic>{
      'items': <dynamic>[
        <String, dynamic>{'id': 'r$p', 'recipientId': 'u1', 'name': 'Medal'},
      ],
      'page': p,
      'total': 4,
      'totalPages': totalPages,
    };

    final AgencyDistributionPage first = AgencyDistributionPage.fromJson(page(1, 2));
    expect(first.hasMore, isTrue);

    final AgencyDistributionPage merged = first.appending(
      AgencyDistributionPage.fromJson(page(2, 2)),
    );
    expect(merged.items.map((AgencyDistributionRow r) => r.id), <String>['r1', 'r2']);
    expect(merged.hasMore, isFalse);
  });

  test('reads stats, and real zeros stay zero', () {
    expect(
      AgencyRewardStats.fromJson(<String, dynamic>{
        'totalSent': 1248,
        'today': 24,
        'thisMonth': 378,
      }).totalSent,
      1248,
    );
    expect(AgencyRewardStats.fromJson(<String, dynamic>{}).today, 0);
  });
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$PATH:/Users/nasinaudaysankar/development/flutter/bin"
cd /Users/nasinaudaysankar/Downloads/soulzaa-mobile
flutter test test/features/profile/agency_reward_distribution_models_test.dart
```
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write the models**

Create `agency_reward_distribution_models.dart` with hand-written `fromJson`, matching the style of `agency_member_history_models.dart`: a private `_time` helper, `whereType<Map<String, dynamic>>()` when mapping lists, and `?? null` for every optional field. `appending` returns a new page carrying `[...items, ...next.items]` with the newer page's `page`/`total`/`totalPages`.

- [ ] **Step 4: Add the providers and the write**

In `agency_reward_providers.dart`:

```dart
final agencyRewardStatsProvider = FutureProvider<AgencyRewardStats>((Ref ref) async {
  final Response<dynamic> response =
      await ref.read(dioClientProvider).dio.get<dynamic>('/agencies/me/rewards/stats');
  return ResponseParser.parse<AgencyRewardStats>(response, AgencyRewardStats.fromJson);
});

final agencyDistributionsProvider =
    FutureProvider.family<AgencyDistributionPage, String>((Ref ref, String range) async {
  final Response<dynamic> response = await ref.read(dioClientProvider).dio.get<dynamic>(
    '/agencies/me/rewards/distributions',
    queryParameters: <String, dynamic>{'range': range, 'page': 1, 'limit': 20},
  );
  return ResponseParser.parse<AgencyDistributionPage>(
    response,
    AgencyDistributionPage.fromJson,
  );
}, isAutoDispose: true);
```

`distributeReward` follows the shape of `sendCoinsToMember` in
`agency_coin_providers.dart:73` — POST, catch `DioException`, dig the server's
`message` out of the body, and return it. On success parse the returned row.

- [ ] **Step 5: Run to verify it passes**

```bash
flutter test test/features/profile/agency_reward_distribution_models_test.dart
flutter analyze lib/features/profile
```
Expected: PASS, no issues.

Report the task complete. Do not commit.

---

## Task 5: The reward draft controller

**Files:**
- Create: `lib/features/profile/presentation/controllers/agency_reward_draft_controller.dart`
- Modify: `lib/features/profile/presentation/providers/agency_reward_providers.dart`
- Test: `test/features/profile/agency_reward_draft_test.dart`

**Interfaces:**
- Produces:
  - `AgencyRewardDraft` — `{ recipientId, recipientName, inventoryId, rewardName, rewardItemType, quantity, kind, note, idempotencyKey }`, `isReady`
  - `AgencyRewardDraftController` with `startFor({required String recipientId, required String recipientName})`, `chooseReward({required String inventoryId, required String name, required String itemType})`, `setQuantity(int)`, `setNote(String?)`, `clear()`
  - `agencyRewardDraftControllerProvider` — `NotifierProvider<AgencyRewardDraftController, AgencyRewardDraft>`

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/profile/presentation/controllers/agency_reward_draft_controller.dart';
import 'package:soulzaa_mobile/features/profile/presentation/providers/agency_reward_providers.dart';

void main() {
  late ProviderContainer container;

  setUp(() => container = ProviderContainer());
  tearDown(() => container.dispose());

  AgencyRewardDraftController controller() =>
      container.read(agencyRewardDraftControllerProvider.notifier);

  AgencyRewardDraft draft() => container.read(agencyRewardDraftControllerProvider);

  test('is not ready until both a recipient and a reward are chosen', () {
    expect(draft().isReady, isFalse);

    controller().startFor(recipientId: 'u1', recipientName: 'balayya');
    expect(draft().isReady, isFalse);

    controller().chooseReward(inventoryId: 'i1', name: 'Premium medal', itemType: 'MEDAL');
    expect(draft().isReady, isTrue);
  });

  test('keeps one idempotency key for the whole draft', () {
    // A key regenerated per attempt would defeat the server's replay
    // protection in exactly the case it exists for: a retry after a timeout.
    controller().startFor(recipientId: 'u1', recipientName: 'balayya');
    final String key = draft().idempotencyKey;

    controller().chooseReward(inventoryId: 'i1', name: 'Medal', itemType: 'MEDAL');
    controller().setQuantity(3);
    controller().setNote('well done');

    expect(draft().idempotencyKey, key);
  });

  test('a new draft gets a new key', () {
    controller().startFor(recipientId: 'u1', recipientName: 'a');
    final String first = draft().idempotencyKey;

    controller().startFor(recipientId: 'u2', recipientName: 'b');

    expect(draft().idempotencyKey, isNot(first));
  });

  test('changing the reward keeps the recipient', () {
    // The confirm screen can send the user back to swap the reward; that must
    // not lose who it is for.
    controller().startFor(recipientId: 'u1', recipientName: 'balayya');
    controller().chooseReward(inventoryId: 'i1', name: 'Medal', itemType: 'MEDAL');
    controller().chooseReward(inventoryId: 'i2', name: 'Frame', itemType: 'FRAME');

    expect(draft().recipientId, 'u1');
    expect(draft().inventoryId, 'i2');
  });

  test('quantity is at least 1', () {
    controller().startFor(recipientId: 'u1', recipientName: 'a');
    controller().setQuantity(0);

    expect(draft().quantity, 1);
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `flutter test test/features/profile/agency_reward_draft_test.dart`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement**

`AgencyRewardDraft` is immutable with a `copyWith`. `startFor` replaces the
whole draft, generating `const Uuid().v4()` once; every other mutator uses
`copyWith` and leaves `idempotencyKey` alone. `setQuantity` clamps to a minimum
of 1. `kind` defaults to `'ASSIGNED'`, matching the server default.

Register in `agency_reward_providers.dart`:

```dart
final agencyRewardDraftControllerProvider =
    NotifierProvider<AgencyRewardDraftController, AgencyRewardDraft>(
      AgencyRewardDraftController.new,
    );
```

Not auto-disposed: the draft has to survive the three screens of the wizard.

- [ ] **Step 4: Run to verify it passes**

Run: `flutter test test/features/profile/agency_reward_draft_test.dart && flutter analyze lib/features/profile`
Expected: PASS, no issues.

Report the task complete. Do not commit.

---

## Task 6: Reward Distribution screen

**Files:**
- Modify: `lib/features/profile/presentation/screens/agency_reward_distribution_screen.dart`

- [ ] **Step 1: Convert to a Consumer and delete the fake data**

Change to `ConsumerStatefulWidget`. Delete the `_Member` class and the
`_members` list at lines 37-43 entirely.

- [ ] **Step 2: Wire the three stat cards**

Watch `agencyRewardStatsProvider`. Replace `'1,248'`, `'24'` and `'378'` with
`stats.totalSent`, `stats.today` and `stats.thisMonth`, each formatted with
`NumberFormat.decimalPattern('en_IN')`. While loading show `—`; on error show
`—` and leave the card in place rather than collapsing the row.

- [ ] **Step 3: Give the member controller a filter**

`AgencyMemberListController` has `setSearch` but no filter. Add the mirror of
it in `agency_member_controller.dart`:

```dart
  String _filter = 'all';

  String get filter => _filter;

  /// Re-queries rather than filtering in memory, for the same reason as
  /// `setSearch`: the list is paginated, so an in-memory filter would only
  /// filter the page already on screen.
  Future<void> setFilter(String value) async {
    if (_filter == value) return;
    _filter = value;
    await refresh();
  }
```

and pass `filter: _filter` through `repository.fetchMembers(...)`, which needs
the parameter threaded through the repository and data source alongside
`search`.

- [ ] **Step 4: Wire the member list**

Watch `agencyMemberListControllerProvider`. Map the filter chips to the API:

| Chip | `filter` |
|---|---|
| All members | `all` |
| Active | `active` |
| Top performers | `top` |

Selecting a chip calls `setFilter` and refetches. The search box drives the
controller's existing `setSearch`, which already queries the server.

Each member card renders `displayName`, `userId` (first segment, uppercased,
matching the member profile header), `level` and the active dot.

- [ ] **Step 5: Start the draft on send**

The card's send action becomes:

```dart
ref.read(agencyRewardDraftControllerProvider.notifier).startFor(
      recipientId: member.userId,
      recipientName: member.displayName,
    );
context.push(RoutePaths.agencySendReward);
```

- [ ] **Step 6: Empty and error states**

`No members match this filter.` when the list is empty; the pink
`CircularProgressIndicator` while loading; error text with a retry — all
matching `member_list_screen.dart:223`.

- [ ] **Step 7: Verify**

Run: `flutter analyze lib/features/profile`
Expected: no issues. Then confirm by eye that no `Ananya_21` remains:

```bash
grep -n "Ananya\|1,248\|'24'\|'378'" lib/features/profile/presentation/screens/agency_reward_distribution_screen.dart
```
Expected: no matches.

Report the task complete. Do not commit.

---

## Task 7: Send Reward — real selection

**Files:**
- Modify: `lib/features/profile/presentation/screens/agency_send_reward_screen.dart`

- [ ] **Step 1: Record the chosen reward**

The screen already lists real inventory. Tapping a reward card calls:

```dart
ref.read(agencyRewardDraftControllerProvider.notifier).chooseReward(
      inventoryId: item.id,
      name: item.name,
      itemType: item.itemType,
    );
```

and marks that card selected.

- [ ] **Step 2: Gate the continue button**

The button at line 271 currently pushes unconditionally. It becomes disabled
(50% opacity, no `onTap`) until `draft.inventoryId != null`, then pushes to
`RoutePaths.agencySendRewardConfirm`.

- [ ] **Step 3: Guard a direct entry**

If `draft.recipientId == null` — the user reached this screen without a
recipient, e.g. by deep link — show `Choose a member to reward first.` with a
button back to the distribution screen, rather than a picker that leads to a
send with no recipient.

- [ ] **Step 4: Verify**

Run: `flutter analyze lib/features/profile`

Report the task complete. Do not commit.

---

## Task 8: Confirm screen — the actual send

**Files:**
- Modify: `lib/features/profile/presentation/screens/agency_send_reward_confirm_screen.dart`
- Modify: `lib/features/profile/presentation/screens/agency_send_reward_success_screen.dart`
- Modify: `lib/core/routing/app_router.dart`

- [ ] **Step 1: Read the draft**

Delete `static const String _recipient = 'Ananya_21'` at line 43. Both uses
(lines 160 and 164) read `draft.recipientName`. The reward name, item type and
quantity come from the draft too.

- [ ] **Step 2: Bind quantity and note**

The draft exposes `setQuantity` and `setNote`; nothing has used them yet. Bind
them here so the API is not dead code:

- if the confirm screen has a quantity stepper, its `+`/`−` call
  `setQuantity(draft.quantity ± 1)` — the controller clamps to a minimum of 1
- if it has a message field, its `onChanged` calls `setNote`, passing `null`
  when the trimmed text is empty so the server stores no note rather than an
  empty string

If neither control exists on the screen, leave the defaults (quantity 1, no
note) and say so in the task report — do **not** add controls the design does
not have.

- [ ] **Step 3: Call distribute on slide-commit**

```dart
Future<void> _send() async {
  if (_sending) return;              // a second slide must not race the first
  setState(() { _sending = true; _error = null; });

  final AgencyRewardDraft draft = ref.read(agencyRewardDraftControllerProvider);
  final (AgencyDistributionRow? row, String? message) = await distributeReward(
    ref.read(dioClientProvider),
    inventoryId: draft.inventoryId!,
    recipientId: draft.recipientId!,
    quantity: draft.quantity,
    kind: draft.kind,
    note: draft.note,
    idempotencyKey: draft.idempotencyKey,   // one key for the whole draft
  );

  if (!mounted) return;

  if (row == null) {
    // Stay put so the user can retry with the same key.
    setState(() { _sending = false; _error = message; });
    return;
  }

  ref.invalidate(agencyRewardInventoryProvider);
  ref.invalidate(agencyRewardStatsProvider);
  for (final String range in <String>['all', 'today', 'week', 'month']) {
    ref.invalidate(agencyDistributionsProvider(range));
  }
  ref.read(agencyRewardDraftControllerProvider.notifier).clear();
  context.pushReplacement(RoutePaths.agencySendRewardSuccess, extra: row);
}
```

- [ ] **Step 4: Reflect state in the slider**

While `_sending`, the knob shows a small spinner and the gesture is ignored.
On failure the slider animates back to its start and `_error` renders beneath
it in red.

- [ ] **Step 5: Accept the result on the success screen**

`AgencySendRewardSuccessScreen` gains `final AgencyDistributionRow? result;`.
It states what the server returned — `'${result.quantity} × ${result.name} sent
to ${result.recipientName}'` — falling back to its current generic copy when
`result` is null. In `app_router.dart`:

```dart
    pageBuilder: (BuildContext context, GoRouterState state) => _page(
      AgencySendRewardSuccessScreen(
        result: state.extra is AgencyDistributionRow
            ? state.extra as AgencyDistributionRow
            : null,
      ),
      state,
    ),
```

- [ ] **Step 6: Verify**

Run: `flutter analyze lib && flutter test`
Expected: no issues, all tests pass.

Report the task complete. Do not commit.

---

## Task 9: Distribution History screen

**Files:**
- Modify: `lib/features/profile/presentation/screens/agency_distribution_history_screen.dart`

- [ ] **Step 1: Delete the fake data**

Remove the `_Distribution` class and the `_rows` list at lines 48-113.

- [ ] **Step 2: Wire the rows**

Convert to `ConsumerStatefulWidget` watching
`agencyDistributionsProvider(range)`, where `range` maps from the chips:

| Chip | `range` |
|---|---|
| All | `all` |
| Today | `today` |
| This week | `week` |
| This month | `month` |

Each row renders `recipientAvatarUrl` (falling back to the existing colour
block keyed on `recipientName`), `name`, `quantity`, and `occurredAt` via
`DateFormat('d MMM yyyy')`.

The design's `alsoSent` count ("how many further rewards went out in the same
send") has no server equivalent — distributions are one row per item, with no
batch id. Drop the field rather than invent it.

- [ ] **Step 3: Empty, loading and error states**

`No rewards sent yet.` when empty. This is the expected state on day one and
must read as calm rather than broken.

- [ ] **Step 4: Verify**

```bash
flutter analyze lib && flutter test
grep -rn "Ananya\|sukhanya\|ramakrishna\|hamsinap" lib/features/profile/presentation/screens/
```
Expected: no issues, all tests pass, and the only remaining matches are in
screens outside this plan's scope (`agency_notifications_screen.dart`).

Report the task complete. Do not commit.

---

## Verification

Done when all of these hold:

1. `npm test -- src/modules/agencies` — green
2. `npm run build` — no TypeScript errors
3. `npx eslint "{src,test}/**/*.ts" --max-warnings 0` — exit 0 (the full glob, matching CI)
4. `flutter analyze lib` — no new issues
5. `flutter test` — green
6. On device: choose a member → choose a reward → slide to send → the success
   screen names the real reward and recipient; the history screen shows the new
   row; the inventory count has dropped by the quantity sent
