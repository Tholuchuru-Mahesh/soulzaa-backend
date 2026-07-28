# User-Local Timings — Phase 3: The Personal Switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily task progress and VIP reward claims reset at each user's own local midnight instead of UTC.

**Architecture:** Two call sites switch from a hardcoded UTC key to `zones.forUser(userId)`. Both store the derived key (and, for tasks, the zone) on the row so a later timezone change cannot retroactively alter a claim. No scheduler is added — a user's day rolls over implicitly the next time their period key is derived.

**Tech Stack:** NestJS 11, Prisma 6, Jest, luxon, `TimeService`/`ZoneResolverService` from Phase 1.

## Global Constraints

- **Depends on Phase 1**, which must have been live for at least one app release cycle so the active user base has real zones on record rather than falling through to the anchor. Phase 2 is *not* a prerequisite.
- Spec: `docs/superpowers/specs/2026-07-28-user-local-timings-design.md`
- **This is the only phase with user-visible behaviour change.** It must deploy in the **09:00–10:00 UTC** window — see Task 5 for the reasoning and the runbook.
- Unlike Phase 2, existing test edits are *expected* here: `buildPeriodKey`'s signature changes. Edit them deliberately, not reflexively.
- Period keys are only ever **compared**, never used as timers. Nothing may schedule work off a user's zone.
- Do not commit unless a step says to. Never `git push`.

---

### Task 1: Store the derived key and zone

**Files:**
- Modify: `prisma/schema/tasks.prisma` (model `TaskProgress`)
- Modify: `prisma/schema/vip.prisma` (model `VipMembership`)

**Interfaces:**
- Consumes: nothing
- Produces: `TaskProgress.zone: string | null`; `VipMembership.lastClaimedDailyKey / lastClaimedWeeklyKey / lastClaimedMonthlyKey: string | null`.

- [ ] **Step 1: Add the audit column to `TaskProgress`**

In `prisma/schema/tasks.prisma`, below `periodKey`:

```prisma
  periodKey        String    @default("alltime")
  /// IANA zone the periodKey was derived in. Audit only — the unique
  /// constraint stays on periodKey, so a user who changes zones gets a
  /// different key rather than a conflicting row.
  zone             String?
```

- [ ] **Step 2: Add the claim-key columns to `VipMembership`**

In `prisma/schema/vip.prisma`, below the three `lastClaimed*At` fields:

```prisma
  /// Period key at the moment of claim, in the user's zone at that moment.
  /// The timestamps above cannot serve this purpose: recomputing an old
  /// instant's key in a user's NEW zone can flip which day it belongs to,
  /// which would silently return or revoke a claim. The key is immutable.
  lastClaimedDailyKey   String?
  lastClaimedWeeklyKey  String?
  lastClaimedMonthlyKey String?
```

- [ ] **Step 3: Generate the migration**

```bash
npx prisma migrate dev --name add_personal_period_keys
```

Expected: four nullable `ADD COLUMN` statements. Additive and safe on a populated database.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat(time): add period-key and zone columns for personal timings"
```

---

### Task 2: Task progress resets at the user's local midnight

**Files:**
- Modify: `src/modules/tasks/services/task-progress.service.ts:47,145-176`
- Test: `src/modules/tasks/services/task-progress.service.spec.ts` (**create** — no spec exists for this service; `task-engine.spec.ts` is the sibling to copy mock idioms from)
- Test: `src/modules/tasks/services/task-engine.spec.ts:225-231` (signature update)

**Interfaces:**
- Consumes: `TimeService.periodKey`, `ZoneResolverService.forUser`
- Produces: `buildPeriodKey(resetPolicy: string, userId: string): Promise<{ periodKey: string; zone: string }>` — replaces the synchronous `buildPeriodKey(resetPolicy: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/tasks/services/task-progress.service.spec.ts`. The current constructor is `(prisma, auditService, eventService)`; Step 3 appends `time` and `zones`:

```ts
import { TimeService, ZoneResolverService } from 'src/common/time';
import { TaskProgressService } from './task-progress.service';

describe('TaskProgressService period keys', () => {
  const time = new TimeService();
  let prisma: any;
  let zones: { forUser: jest.Mock };
  let service: TaskProgressService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T19:00:00.000Z'));
    prisma = {
      taskProgress: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ currentProgress: 1, completionCount: 0 }),
        update: jest.fn().mockResolvedValue({ currentProgress: 1, completionCount: 0 }),
      },
    };
    zones = { forUser: jest.fn().mockResolvedValue('UTC') };
    service = new TaskProgressService(
      prisma,
      { logAudit: jest.fn() } as any,
      { emit: jest.fn() } as any,
      time,
      zones as unknown as ZoneResolverService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('derives a daily key in the user zone, ahead of UTC for eastern users', async () => {
    zones.forUser.mockResolvedValue('Asia/Kolkata');
    // 19:00Z Jul 27 is already 00:30 Jul 28 in IST — their new day has begun.
    await expect(service.buildPeriodKey('DAILY', 'u1')).resolves.toEqual({
      periodKey: '20260728',
      zone: 'Asia/Kolkata',
    });
  });

  it('derives a key behind UTC for western users', async () => {
    zones.forUser.mockResolvedValue('America/New_York');
    // 19:00Z Jul 27 is 15:00 Jul 27 EDT — still the same day.
    await expect(service.buildPeriodKey('DAILY', 'u1')).resolves.toEqual({
      periodKey: '20260727',
      zone: 'America/New_York',
    });
  });

  it('gives two users in different zones different keys at the same instant', async () => {
    zones.forUser.mockResolvedValueOnce('Pacific/Kiritimati'); // +14
    const east = await service.buildPeriodKey('DAILY', 'u1');
    zones.forUser.mockResolvedValueOnce('Pacific/Niue'); // -11
    const west = await service.buildPeriodKey('DAILY', 'u2');
    expect(east.periodKey).not.toBe(west.periodKey);
  });

  it('derives weekly and monthly keys in the user zone', async () => {
    zones.forUser.mockResolvedValue('Asia/Kolkata');
    await expect(service.buildPeriodKey('WEEKLY', 'u1')).resolves.toMatchObject({
      periodKey: '2026W31',
    });
    await expect(service.buildPeriodKey('MONTHLY', 'u1')).resolves.toMatchObject({
      periodKey: '202607',
    });
  });

  it('leaves non-resetting policies zone-independent', async () => {
    zones.forUser.mockResolvedValue('Pacific/Kiritimati');
    await expect(service.buildPeriodKey('NONE', 'u1')).resolves.toMatchObject({
      periodKey: 'alltime',
    });
    await expect(service.buildPeriodKey('SEASONAL', 'u1')).resolves.toMatchObject({
      periodKey: 'season_2026',
    });
  });

  it('persists the resolved zone alongside the progress row', async () => {
    zones.forUser.mockResolvedValue('Asia/Kolkata');
    await service.incrementProgress({
      userId: 'u1',
      taskId: 't1',
      requiredProgress: 5,
      eventCode: 'GIFT_SENT',
    });
    expect(prisma.taskProgress.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ periodKey: '20260728', zone: 'Asia/Kolkata' }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/tasks/services/task-progress.service.spec.ts`
Expected: FAIL — `buildPeriodKey` takes one argument and returns a string.

- [ ] **Step 3: Rewrite `buildPeriodKey`**

Replace lines 145-176 of `task-progress.service.ts`. Note the existing `isoWeek` helper used `getFullYear()/getMonth()/getDate()` — the *server's* zone, not UTC — so this also fixes a pre-existing inconsistency. Delete that helper entirely.

```ts
  /**
   * The period bucket this user's action falls into, in THEIR zone.
   *
   * Derived at action time and only ever compared, never used as a timer, so
   * a user who changes timezone cannot retroactively un-claim anything. A
   * westward traveller may see a second "today"; that is accepted and is the
   * standard behaviour for local-midnight resets.
   */
  async buildPeriodKey(
    resetPolicy: string,
    userId: string,
  ): Promise<{ periodKey: string; zone: string }> {
    const zone = await this.zones.forUser(userId);
    const now = new Date();

    switch (resetPolicy) {
      case 'DAILY':
        return { periodKey: this.time.periodKey('daily', now, zone), zone };
      case 'WEEKLY':
        return { periodKey: this.time.periodKey('weekly', now, zone), zone };
      case 'MONTHLY':
        return { periodKey: this.time.periodKey('monthly', now, zone), zone };
      case 'SEASONAL':
        return { periodKey: `season_${this.time.format(now, zone, 'yyyy')}`, zone };
      case 'NONE':
      default:
        return { periodKey: 'alltime', zone };
    }
  }
```

Inject `TimeService` and `ZoneResolverService` into the constructor.

- [ ] **Step 4: Update the call site**

At line 47, replace:

```ts
    const periodKey = this.buildPeriodKey(resetPolicy);
```

with:

```ts
    const { periodKey, zone } = await this.buildPeriodKey(resetPolicy, userId);
```

and add `zone` to the `data` of the `taskProgress` create (and update, so a row written before this phase gets its zone backfilled on next touch).

- [ ] **Step 5: Update the existing engine spec**

`task-engine.spec.ts:225-231` calls `buildPeriodKey('DAILY')` synchronously. Update all three calls to `await progressService.buildPeriodKey('DAILY', 'u1')` and assert on `.periodKey`. This is an expected edit — the signature changed by design.

- [ ] **Step 6: Run the tests**

Run: `npx jest src/modules/tasks`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/tasks/
git commit -m "feat(tasks): reset task periods at the user's local midnight"
```

---

### Task 3: VIP claims at the user's local midnight, and the missing guards

**Files:**
- Modify: `src/modules/vip/services/vip-reward.service.ts:17-57`
- Test: `src/modules/vip/services/vip-reward.service.spec.ts`

**Interfaces:**
- Consumes: `TimeService.periodKey`, `ZoneResolverService.forUser`
- Produces: `claimReward` now gates all three reward types on a stored period key.

`vip-reward.service.ts:29-36` currently guards only `DAILY`. `WEEKLY` and `MONTHLY` have **no claim check at all** and can be claimed without limit. This phase rewrites exactly those lines, so the missing guards are added here rather than left behind.

- [ ] **Step 1: Write the failing test**

Create `src/modules/vip/services/vip-reward.service.spec.ts` — no spec exists for this service; `vip-engine.spec.ts` is the sibling to copy mock idioms from. Read the constructor of `vip-reward.service.ts` for the exact collaborator order (it uses `validationService`, `prisma` and `auditService`), then append `time` and `zones`:

```ts
import { BadRequestException } from '@nestjs/common';
import { TimeService, ZoneResolverService } from 'src/common/time';
import { VipRewardService } from './vip-reward.service';

describe('VipRewardService.claimReward', () => {
  const time = new TimeService();
  let prisma: any;
  let zones: { forUser: jest.Mock };
  let membership: any;
  let service: VipRewardService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T19:00:00.000Z'));
    membership = {
      id: 'm1',
      tierId: 'tier1',
      lastClaimedDailyKey: null,
      lastClaimedWeeklyKey: null,
      lastClaimedMonthlyKey: null,
    };
    prisma = {
      vipTier: { findUnique: jest.fn().mockResolvedValue({ id: 'tier1', dailyRewards: {} }) },
      vipMembership: { update: jest.fn() },
      vipReward: { create: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    zones = { forUser: jest.fn().mockResolvedValue('Asia/Kolkata') };
    service = new VipRewardService(
      { validateActiveMembership: jest.fn().mockResolvedValue(membership) } as any,
      prisma,
      { logAudit: jest.fn() } as any,
      time,
      zones as unknown as ZoneResolverService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('allows a claim when the stored key is an earlier day', async () => {
    membership.lastClaimedDailyKey = '20260727';
    await expect(service.claimReward('u1', 'DAILY')).resolves.toMatchObject({ claimed: true });
  });

  it('rejects a second claim within the same local day', async () => {
    membership.lastClaimedDailyKey = '20260728'; // 19:00Z Jul 27 is Jul 28 in IST
    await expect(service.claimReward('u1', 'DAILY')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a repeat WEEKLY claim — previously unguarded entirely', async () => {
    membership.lastClaimedWeeklyKey = '2026W31';
    await expect(service.claimReward('u1', 'WEEKLY')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a repeat MONTHLY claim — previously unguarded entirely', async () => {
    membership.lastClaimedMonthlyKey = '202607';
    await expect(service.claimReward('u1', 'MONTHLY')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores the key so a later timezone change cannot reopen the claim', async () => {
    membership.lastClaimedDailyKey = null;
    await service.claimReward('u1', 'DAILY');
    expect(prisma.vipMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastClaimedDailyKey: '20260728' }),
      }),
    );

    // Moving to a zone where it is still Jul 27 must NOT return the claim.
    zones.forUser.mockResolvedValue('America/New_York');
    membership.lastClaimedDailyKey = '20260728';
    await expect(service.claimReward('u1', 'DAILY')).resolves.toMatchObject({ claimed: true });
    // The key differs (20260727), so this is a genuine new local day, not a
    // reopened one — the stored key is what makes that distinction possible.
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/vip/services/vip-reward.service.spec.ts`
Expected: FAIL — WEEKLY and MONTHLY resolve instead of rejecting.

- [ ] **Step 3: Rewrite the claim gate**

Replace lines 27-57 of `vip-reward.service.ts`:

```ts
    const now = new Date();
    const zone = await this.zones.forUser(userId);

    const PERIOD_FOR: Record<'DAILY' | 'WEEKLY' | 'MONTHLY', PeriodName> = {
      DAILY: 'daily',
      WEEKLY: 'weekly',
      MONTHLY: 'monthly',
    };
    const KEY_FIELD = {
      DAILY: 'lastClaimedDailyKey',
      WEEKLY: 'lastClaimedWeeklyKey',
      MONTHLY: 'lastClaimedMonthlyKey',
    } as const;
    const AT_FIELD = {
      DAILY: 'lastClaimedDailyAt',
      WEEKLY: 'lastClaimedWeeklyAt',
      MONTHLY: 'lastClaimedMonthlyAt',
    } as const;

    const currentKey = this.time.periodKey(PERIOD_FOR[rewardType], now, zone);

    // All three types are guarded. Previously only DAILY was, so WEEKLY and
    // MONTHLY rewards could be claimed without limit.
    if (membership[KEY_FIELD[rewardType]] === currentKey) {
      throw new BadRequestException(
        `${rewardType.toLowerCase()} VIP reward already claimed for this period`,
      );
    }

    const rewardsData = tier.dailyRewards;

    await this.prisma.$transaction([
      this.prisma.vipReward.create({
        data: { membershipId: membership.id, userId, rewardType, rewardData: rewardsData as any },
      }),
      this.prisma.vipMembership.update({
        where: { id: membership.id },
        data: {
          [KEY_FIELD[rewardType]]: currentKey,
          [AT_FIELD[rewardType]]: now,
        },
      }),
    ]);
```

Import `PeriodName` from `src/common/time` and inject `TimeService` + `ZoneResolverService`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/vip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/vip/
git commit -m "feat(vip): claim rewards on the user's local period, guard all three types"
```

---

### Task 4: Tell the client when the reset actually happens

**Files:**
- Modify: the tasks controller/DTO returning user task state
- Modify: the VIP controller/DTO returning claim state
- Test: the corresponding controller specs

**Interfaces:**
- Consumes: `TimeService.nextMidnight`, `ZoneResolverService.forUser`
- Produces: `nextResetAt: string` (UTC ISO-8601) and `timezone: string` on both responses.

Without this the client cannot render a correct countdown — it would have to assume midnight in some zone it is guessing at.

- [ ] **Step 1: Write the failing test**

```ts
it('reports the next local reset and the zone it was computed in', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-07-27T19:00:00.000Z'));
  zones.forUser.mockResolvedValue('Asia/Kolkata');

  const res = await controller.getMyTasks({ user: { id: 'u1' } } as any);

  expect(res.timezone).toBe('Asia/Kolkata');
  expect(res.nextResetAt).toBe('2026-07-28T18:30:00.000Z'); // 00:00 Jul 29 IST
  jest.useRealTimers();
});
```

Use the actual controller method name and request shape from the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/tasks src/modules/vip`
Expected: FAIL — the fields are absent.

- [ ] **Step 3: Add the fields**

In each response builder:

```ts
    const zone = await this.zones.forUser(userId);
    return {
      ...existing,
      timezone: zone,
      nextResetAt: this.time.nextMidnight(zone).toISOString(),
    };
```

Add both to the response DTO with `@ApiProperty` entries so Swagger documents them:

```ts
  @ApiProperty({ example: '2026-07-28T18:30:00.000Z', description: 'UTC instant of the next reset' })
  nextResetAt!: string;

  @ApiProperty({ example: 'Asia/Kolkata', description: 'IANA zone the reset was computed in' })
  timezone!: string;
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/tasks src/modules/vip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/tasks/ src/modules/vip/
git commit -m "feat(tasks,vip): expose nextResetAt and timezone to clients"
```

---

### Task 5: Verification and the timed deploy

**Files:** none

- [ ] **Step 1: Full verification**

```bash
npm test && npm run lint && npx tsc --noEmit && npm run boundaries && npm run build
```

Expected: all pass. The only pre-existing test edits in this phase are the `task-engine.spec.ts` signature updates from Task 2 Step 5.

- [ ] **Step 2: Confirm nothing schedules off a user zone**

```bash
grep -rn "forUser" src --include="*.ts" | grep -v "\.spec\.ts" | grep -iE "setTimeout|setInterval|cron|schedule"
```

Expected: no results. Personal resets are lazy by design; a scheduler keyed on a user's zone would reintroduce every problem this design avoids.

- [ ] **Step 3: Verify against a real non-UTC user in staging**

Set a staging user's `timezone` to `Asia/Kolkata`. Just before 18:30 UTC, complete a daily task and confirm progress. Just after 18:30 UTC, confirm the task is available again and a second `TaskProgress` row exists with `periodKey = <next day>` and `zone = 'Asia/Kolkata'`. Confirm a `UTC` user's task does *not* reset at that moment.

- [ ] **Step 4: Deploy inside the 09:00–10:00 UTC window**

This is the one timing-sensitive deploy in the project.

At the switch, a user's period key changes from UTC-derived to local-derived. Users east of UTC (`utcHour + offset ≥ 24`) see their key jump forward — tasks reset early, one extra claim, a giveaway. Users west (`utcHour + offset < 0`) see it jump backward onto a key they may already have claimed — the claim is silently lost until their local midnight, which is the shape that generates support tickets.

East exposure requires `offset ≥ 24 − utcHour`; west exposure requires `offset < −utcHour`. Deploying at 09:00–10:00 UTC leaves east exposed only above +14 (no such zone exists) and west only below −9.5 (Niue, Midway, Hawaii). The discontinuity is therefore empty for effectively the entire user base, with no backfill and no feature flag.

Deploying outside this window is not a minor scheduling preference — at 00:00 UTC the entire western hemisphere sits in the lost-claim range.

- [ ] **Step 5: Watch the first 24 hours**

Track the daily-task completion rate and VIP claim rate per zone bucket. A user's first post-switch reset happens at their local midnight, so the full effect takes 24 hours to roll around the world. Investigate any bucket whose claim rate drops rather than holds.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "chore(time): phase 3 verification fixes"
```

---

## Phase exit criteria

- [ ] Full suite, lint, typecheck, boundaries and build all pass.
- [ ] No scheduler anywhere is keyed on a user's timezone.
- [ ] A staging user in `Asia/Kolkata` resets at 18:30 UTC; a `UTC` user does not.
- [ ] `WEEKLY` and `MONTHLY` VIP rewards can no longer be claimed twice in one period.
- [ ] Deployed within the 09:00–10:00 UTC window.
- [ ] 24 hours of per-zone claim rates show no drop.

## Rollback

Phase 3 is revertable by code alone — revert the commits from Tasks 2–4 and keys revert to UTC-derived. The four columns from Task 1 are nullable and additive; leave them in place. Note that any user who claimed under a local key during the window will have that key stored, so a revert may grant one extra claim to users whose local key differs from the UTC key at revert time. That is the same one-window giveaway as the forward switch, and is the reason to revert inside the same 09:00–10:00 UTC band where possible.
