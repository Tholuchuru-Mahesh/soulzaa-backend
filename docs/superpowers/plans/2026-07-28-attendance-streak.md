# Attendance Streak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Game Coins their first earning path — a claimable 30-day login streak that pays FREE coins, EXP and milestone cosmetics.

**Architecture:** A dedicated `src/modules/attendance` NestJS module owning three Prisma models (a seeded reward ladder, per-user streak state, an immutable claim log). It consumes three existing public ports — `WALLET_SERVICE`, `EXP_SERVICE`, `COSMETICS_SERVICE` — so it adds no module-boundary violations. The day boundary is local midnight resolved from `User.country` via a canonical IANA map.

**Tech Stack:** NestJS 11, TypeScript (strict), Prisma + PostgreSQL, Redis (`LockService`), Jest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-attendance-streak-design.md`
- TDD is mandatory: write the failing test, watch it fail, then implement.
- Zero TypeScript errors (`npx tsc --noEmit -p tsconfig.json`) and zero new lint errors at every commit.
- No new module-boundary violations: import other modules only through their `interfaces/`. Verify with `npm run boundaries` (baseline is 215 violations — the count must not rise).
- Prisma schema is split per module under `prisma/schema/`. After editing, run `npx prisma generate` before typechecking, or the client is stale and produces phantom errors.
- Currency for all attendance payouts is `WalletCurrency.FREE`. Never `GOLD`.
- Wallet reason for coin credits is `WalletTxnReason.REWARD`.
- EXP source is `ExpSource.DAILY_LOGIN`.
- Every external payout call must be idempotent, keyed `attendance:{userId}:{dayKey}` plus a per-kind suffix.
- Do not commit unless the user asks. Leave work in the working directory.

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema/attendance.prisma` | The three models |
| `src/modules/attendance/constants/attendance.constants.ts` | Ladder seed data, config keys, idempotency-key builders |
| `src/modules/attendance/constants/country-timezone.map.ts` | Country → IANA zone map + resolver |
| `src/modules/attendance/services/attendance-day.service.ts` | Pure date maths: day keys, yesterday, next boundary |
| `src/modules/attendance/services/attendance-streak.service.ts` | Pure streak maths: what day does this claim land on |
| `src/modules/attendance/services/attendance-ladder.seeder.ts` | Seeds the 30 rungs on bootstrap |
| `src/modules/attendance/services/attendance.service.ts` | Orchestration: status + claim |
| `src/modules/attendance/repositories/attendance.repository.ts` | All Prisma access |
| `src/modules/attendance/controllers/attendance.controller.ts` | `GET /attendance`, `POST /attendance/claim` |
| `src/modules/attendance/dto/attendance.dto.ts` | Response DTOs |
| `src/modules/attendance/attendance.module.ts` | Wiring |

The two pure services exist so streak and calendar logic — where this class of feature actually breaks — are testable without Prisma, Redis or wallets.

---

### Task 1: Prisma models

**Files:**
- Create: `prisma/schema/attendance.prisma`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `AttendanceLadderRung`, `UserAttendance`, `AttendanceClaim`.

- [ ] **Step 1: Create the schema file**

```prisma
// ============================================================
// Attendance — daily login streak. A seeded 30-rung ladder, per-user
// streak state, and an immutable claim log. Owned by the "attendance"
// module. No cross-module relations: reference users by id.
// ============================================================

/// One day of the reward ladder. Seeded on bootstrap, tuned by operators.
model AttendanceLadderRung {
  id         String         @id @default(uuid()) @db.Uuid
  day        Int            @unique
  coins      Int
  currency   WalletCurrency @default(FREE)
  expAmount  Int?
  cosmeticId String?        @db.Uuid
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  @@map("attendance_ladder_rungs")
}

/// Per-user streak state. One row per user, created on first claim.
model UserAttendance {
  userId            String   @id @db.Uuid
  currentDay        Int      @default(0)
  cycleCount        Int      @default(0)
  lastClaimDayKey   String?
  lastClaimAt       DateTime?
  lastClaimTimezone String?
  totalClaims       Int      @default(0)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@map("user_attendance")
}

/// Immutable record of one claim. Never updated or deleted.
model AttendanceClaim {
  id         String         @id @default(uuid()) @db.Uuid
  userId     String         @db.Uuid
  day        Int
  cycle      Int
  dayKey     String
  coins      Int
  currency   WalletCurrency
  expAmount  Int?
  cosmeticId String?        @db.Uuid
  timezone   String
  claimedAt  DateTime       @default(now())

  @@unique([userId, dayKey])
  @@index([userId, claimedAt])
  @@map("attendance_claims")
}
```

The `@@unique([userId, dayKey])` is the database-level guarantee that one local day yields at most one claim, independent of application logic.

- [ ] **Step 2: Generate the client and verify it compiles**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. `prisma generate` must succeed and report the three new models.

- [ ] **Step 3: Create the migration**

Run: `npx prisma migrate dev --name add_attendance_streak`
Expected: a new folder under `prisma/schema/migrations/`. If no database is reachable, run `npx prisma migrate diff --from-schema-datasource prisma/schema/schema.prisma --to-schema-datamodel prisma/schema --script` and save the SQL manually; note it in the commit message.

---

### Task 2: Country → timezone resolution

**Files:**
- Create: `src/modules/attendance/constants/country-timezone.map.ts`
- Test: `src/modules/attendance/constants/country-timezone.map.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveTimezone(country: string | null | undefined): string` — returns an IANA zone name, `'UTC'` when unknown or unset.

- [ ] **Step 1: Write the failing test**

```typescript
import { resolveTimezone } from './country-timezone.map';

describe('resolveTimezone', () => {
  it('maps a known country to its canonical zone', () => {
    expect(resolveTimezone('IN')).toBe('Asia/Kolkata');
    expect(resolveTimezone('US')).toBe('America/New_York');
    expect(resolveTimezone('AE')).toBe('Asia/Dubai');
  });

  it('accepts lower-case and padded country codes', () => {
    expect(resolveTimezone(' in ')).toBe('Asia/Kolkata');
  });

  it('falls back to UTC for an unmapped country', () => {
    expect(resolveTimezone('ZZ')).toBe('UTC');
  });

  it('falls back to UTC when the user has no country', () => {
    // User.country is nullable — a profile may never have set one.
    expect(resolveTimezone(null)).toBe('UTC');
    expect(resolveTimezone(undefined)).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });

  it('only returns zones the runtime can actually format', () => {
    // A typo in the table would surface as a RangeError at claim time.
    for (const zone of Object.values(COUNTRY_TIMEZONES)) {
      expect(() =>
        new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(0)),
      ).not.toThrow();
    }
  });
});
```

Add `COUNTRY_TIMEZONES` to the import in the first line once it exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/attendance/constants/country-timezone.map.spec.ts`
Expected: FAIL — "Cannot find module './country-timezone.map'".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Country → canonical IANA zone. The platform stores only a country on the
 * profile, so a multi-zone country resolves to one representative zone; users
 * elsewhere in that country see a boundary offset from their wall clock. The
 * zone used is recorded on every claim, so correcting an entry here is
 * auditable rather than a silent rewrite of history.
 */
export const COUNTRY_TIMEZONES: Readonly<Record<string, string>> = {
  IN: 'Asia/Kolkata',
  US: 'America/New_York',
  GB: 'Europe/London',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu',
  ID: 'Asia/Jakarta',
  MY: 'Asia/Kuala_Lumpur',
  SG: 'Asia/Singapore',
  PH: 'Asia/Manila',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  CN: 'Asia/Shanghai',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
  CA: 'America/Toronto',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam',
  TR: 'Europe/Istanbul',
  RU: 'Europe/Moscow',
  EG: 'Africa/Cairo',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  ZA: 'Africa/Johannesburg',
};

/** IANA zone for a profile country; UTC when unmapped, empty or unset. */
export function resolveTimezone(country: string | null | undefined): string {
  if (!country) return 'UTC';
  return COUNTRY_TIMEZONES[country.trim().toUpperCase()] ?? 'UTC';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/attendance/constants/country-timezone.map.spec.ts`
Expected: PASS, 5 tests.

---

### Task 3: Calendar maths

**Files:**
- Create: `src/modules/attendance/services/attendance-day.service.ts`
- Test: `src/modules/attendance/services/attendance-day.service.spec.ts`

**Interfaces:**
- Consumes: `resolveTimezone` from Task 2.
- Produces: class `AttendanceDayService` with
  - `dayKey(at: Date, timezone: string): string` → `'YYYY-MM-DD'`
  - `previousDayKey(dayKey: string): string`
  - `nextBoundary(at: Date, timezone: string): Date` → the instant local midnight next occurs

- [ ] **Step 1: Write the failing test**

```typescript
import { AttendanceDayService } from './attendance-day.service';

describe('AttendanceDayService', () => {
  const svc = new AttendanceDayService();

  it('formats the local date for a zone ahead of UTC', () => {
    // 2026-07-27T20:00Z is 2026-07-28 01:30 in Kolkata (+05:30).
    const at = new Date('2026-07-27T20:00:00Z');
    expect(svc.dayKey(at, 'Asia/Kolkata')).toBe('2026-07-28');
    expect(svc.dayKey(at, 'UTC')).toBe('2026-07-27');
  });

  it('formats the local date for a zone behind UTC', () => {
    // 2026-07-27T02:00Z is 2026-07-26 22:00 in New York (-04:00).
    const at = new Date('2026-07-27T02:00:00Z');
    expect(svc.dayKey(at, 'America/New_York')).toBe('2026-07-26');
  });

  it('steps back one calendar day, including across a month boundary', () => {
    expect(svc.previousDayKey('2026-07-28')).toBe('2026-07-27');
    expect(svc.previousDayKey('2026-08-01')).toBe('2026-07-31');
    expect(svc.previousDayKey('2026-01-01')).toBe('2025-12-31');
    expect(svc.previousDayKey('2028-03-01')).toBe('2028-02-29'); // leap year
  });

  it('returns the next local midnight as an absolute instant', () => {
    const at = new Date('2026-07-27T20:00:00Z'); // 01:30 on the 28th in Kolkata
    const boundary = svc.nextBoundary(at, 'Asia/Kolkata');
    expect(boundary.getTime()).toBeGreaterThan(at.getTime());
    // The next boundary is local midnight starting 2026-07-29.
    expect(svc.dayKey(new Date(boundary.getTime() + 1000), 'Asia/Kolkata')).toBe('2026-07-29');
  });

  it('places the boundary within 24 hours', () => {
    const at = new Date('2026-07-27T20:00:00Z');
    const delta = svc.nextBoundary(at, 'Asia/Kolkata').getTime() - at.getTime();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/attendance/services/attendance-day.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { Injectable } from '@nestjs/common';

/**
 * Calendar arithmetic for the streak, kept free of Prisma and Redis so the
 * edge cases that actually break this feature — zone offsets, month and leap
 * boundaries — are testable in isolation.
 *
 * `en-CA` is used deliberately: it formats as YYYY-MM-DD, which is both the
 * storage format and lexicographically sortable.
 */
@Injectable()
export class AttendanceDayService {
  /** Local calendar date in `timezone` at instant `at`, as `YYYY-MM-DD`. */
  dayKey(at: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }

  /** The calendar date one day before `dayKey`. */
  previousDayKey(dayKey: string): string {
    const [y, m, d] = dayKey.split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d));
    utc.setUTCDate(utc.getUTCDate() - 1);
    return utc.toISOString().slice(0, 10);
  }

  /**
   * The instant at which `timezone` next enters a new calendar day. Found by
   * probing forward rather than computing an offset, so DST transitions need
   * no special handling.
   */
  nextBoundary(at: Date, timezone: string): Date {
    const today = this.dayKey(at, timezone);
    const hour = 60 * 60 * 1000;
    // Walk forward one hour at a time until the local date changes, then
    // narrow to the minute.
    let cursor = at.getTime();
    for (let i = 0; i < 26; i += 1) {
      cursor += hour;
      if (this.dayKey(new Date(cursor), timezone) !== today) break;
    }
    let lower = cursor - hour;
    while (lower < cursor) {
      const mid = lower + 60_000;
      if (this.dayKey(new Date(mid), timezone) !== today) {
        return new Date(mid);
      }
      lower = mid;
    }
    return new Date(cursor);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/attendance/services/attendance-day.service.spec.ts`
Expected: PASS, 5 tests.

---

### Task 4: Streak maths

**Files:**
- Create: `src/modules/attendance/services/attendance-streak.service.ts`
- Test: `src/modules/attendance/services/attendance-streak.service.spec.ts`

**Interfaces:**
- Consumes: `AttendanceDayService.previousDayKey` from Task 3.
- Produces: class `AttendanceStreakService` with

```typescript
export type StreakOutcome =
  | { kind: 'ALREADY_CLAIMED' }
  | { kind: 'CLAIMABLE'; day: number; cycle: number; reset: boolean };

resolve(input: {
  todayKey: string;
  lastClaimDayKey: string | null;
  currentDay: number;
  cycleCount: number;
}): StreakOutcome;
```

- [ ] **Step 1: Write the failing test**

```typescript
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceStreakService } from './attendance-streak.service';

describe('AttendanceStreakService', () => {
  const svc = new AttendanceStreakService(new AttendanceDayService());

  const resolve = (over: Partial<Parameters<AttendanceStreakService['resolve']>[0]> = {}) =>
    svc.resolve({
      todayKey: '2026-07-28',
      lastClaimDayKey: '2026-07-27',
      currentDay: 3,
      cycleCount: 0,
      ...over,
    });

  it('starts a first-time user on day 1', () => {
    expect(resolve({ lastClaimDayKey: null, currentDay: 0 })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: false,
    });
  });

  it('advances when the previous claim was yesterday', () => {
    expect(resolve()).toEqual({ kind: 'CLAIMABLE', day: 4, cycle: 0, reset: false });
  });

  it('reports an already-claimed day rather than failing', () => {
    expect(resolve({ lastClaimDayKey: '2026-07-28' })).toEqual({ kind: 'ALREADY_CLAIMED' });
  });

  it('resets to day 1 after a missed day', () => {
    expect(resolve({ lastClaimDayKey: '2026-07-26' })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: true,
    });
  });

  it('resets after a long absence', () => {
    expect(resolve({ lastClaimDayKey: '2026-01-01', currentDay: 29 })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: true,
    });
  });

  it('rolls day 30 into a new cycle at day 1', () => {
    expect(resolve({ currentDay: 30 })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 1,
      reset: false,
    });
  });

  it('does not increment the cycle when a streak breaks on day 30', () => {
    // A reset is not a completed cycle — only claiming day 30 then continuing is.
    expect(resolve({ currentDay: 30, lastClaimDayKey: '2026-07-20' })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/attendance/services/attendance-streak.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { Injectable } from '@nestjs/common';
import { AttendanceDayService } from './attendance-day.service';

export const ATTENDANCE_CYCLE_LENGTH = 30;

export type StreakOutcome =
  | { kind: 'ALREADY_CLAIMED' }
  | { kind: 'CLAIMABLE'; day: number; cycle: number; reset: boolean };

/**
 * Decides which rung a claim lands on. Pure: no clock, no storage — the caller
 * supplies today's key and the stored state.
 */
@Injectable()
export class AttendanceStreakService {
  constructor(private readonly days: AttendanceDayService) {}

  resolve(input: {
    todayKey: string;
    lastClaimDayKey: string | null;
    currentDay: number;
    cycleCount: number;
  }): StreakOutcome {
    const { todayKey, lastClaimDayKey, currentDay, cycleCount } = input;

    if (lastClaimDayKey === todayKey) return { kind: 'ALREADY_CLAIMED' };

    const continued = lastClaimDayKey === this.days.previousDayKey(todayKey);

    if (!continued) {
      return { kind: 'CLAIMABLE', day: 1, cycle: cycleCount, reset: true };
    }

    if (currentDay >= ATTENDANCE_CYCLE_LENGTH) {
      // Completing the ladder and continuing starts the next cycle.
      return { kind: 'CLAIMABLE', day: 1, cycle: cycleCount + 1, reset: false };
    }

    return { kind: 'CLAIMABLE', day: currentDay + 1, cycle: cycleCount, reset: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/attendance/services/attendance-streak.service.spec.ts`
Expected: PASS, 7 tests.

---

### Task 5: Ladder seed data and the seeder

**Files:**
- Create: `src/modules/attendance/constants/attendance.constants.ts`
- Create: `src/modules/attendance/services/attendance-ladder.seeder.ts`
- Test: `src/modules/attendance/constants/attendance.constants.spec.ts`

**Interfaces:**
- Consumes: `ATTENDANCE_CYCLE_LENGTH` from Task 4.
- Produces:
  - `ATTENDANCE_LADDER_SEED: readonly { day: number; coins: number; expAmount: number | null }[]`
  - `ATTENDANCE_CONFIG_KEYS` — `{ ENABLED: 'feature.attendance.enabled'; MIN_HOURS: 'attendance.min_hours_between_claims' }`
  - `attendanceIdempotencyKey(userId: string, dayKey: string, kind: 'coins' | 'exp' | 'cosmetic'): string`
  - class `AttendanceLadderSeeder implements OnApplicationBootstrap`

- [ ] **Step 1: Write the failing test**

```typescript
import { ATTENDANCE_LADDER_SEED, attendanceIdempotencyKey } from './attendance.constants';

describe('attendance ladder seed', () => {
  it('covers all 30 days exactly once', () => {
    const days = ATTENDANCE_LADDER_SEED.map((r) => r.day).sort((a, b) => a - b);
    expect(days).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('pays the approved cycle total', () => {
    const total = ATTENDANCE_LADDER_SEED.reduce((sum, r) => sum + r.coins, 0);
    expect(total).toBe(12_900);
  });

  it('matches the approved milestone values', () => {
    const rung = (day: number) => ATTENDANCE_LADDER_SEED.find((r) => r.day === day)!;
    expect(rung(1).coins).toBe(100);
    expect(rung(2).coins).toBe(150);
    expect(rung(3).coins).toBe(200);
    expect(rung(4).coins).toBe(250);
    expect(rung(7).coins).toBe(500);
    expect(rung(8).coins).toBe(300);
    expect(rung(15).coins).toBe(1000);
    expect(rung(16).coins).toBe(400);
    expect(rung(30).coins).toBe(2500);
  });

  it('awards EXP on milestone days only', () => {
    const withExp = ATTENDANCE_LADDER_SEED.filter((r) => r.expAmount !== null).map((r) => r.day);
    expect(withExp).toEqual([7, 15, 30]);
  });

  it('never pays a non-positive amount', () => {
    for (const rung of ATTENDANCE_LADDER_SEED) {
      expect(rung.coins).toBeGreaterThan(0);
    }
  });

  it('builds a distinct idempotency key per user, day and kind', () => {
    expect(attendanceIdempotencyKey('u1', '2026-07-28', 'coins')).toBe(
      'attendance:u1:2026-07-28:coins',
    );
    expect(attendanceIdempotencyKey('u1', '2026-07-28', 'exp')).not.toBe(
      attendanceIdempotencyKey('u1', '2026-07-28', 'coins'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/attendance/constants/attendance.constants.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the constants**

```typescript
/** Platform-configuration keys this module reads. */
export const ATTENDANCE_CONFIG_KEYS = {
  ENABLED: 'feature.attendance.enabled',
  MIN_HOURS: 'attendance.min_hours_between_claims',
} as const;

/** Fallbacks used when a setting is absent; mirror the seeded defaults. */
export const ATTENDANCE_DEFAULTS = {
  ENABLED: true,
  MIN_HOURS: 20,
} as const;

export interface AttendanceLadderSeedRung {
  day: number;
  coins: number;
  expAmount: number | null;
}

/**
 * The approved 30-day ladder: rising, with spikes on the PRD's milestone days.
 * Cosmetics are attached by operators afterwards — the seeder leaves
 * `cosmeticId` null so the ladder never hard-depends on catalog contents.
 * Cycle total: 12,900 Game Coins.
 */
function rung(day: number): AttendanceLadderSeedRung {
  if (day === 1) return { day, coins: 100, expAmount: null };
  if (day === 2) return { day, coins: 150, expAmount: null };
  if (day === 3) return { day, coins: 200, expAmount: null };
  if (day <= 6) return { day, coins: 250, expAmount: null };
  if (day === 7) return { day, coins: 500, expAmount: 100 };
  if (day <= 14) return { day, coins: 300, expAmount: null };
  if (day === 15) return { day, coins: 1000, expAmount: 250 };
  if (day <= 29) return { day, coins: 400, expAmount: null };
  return { day, coins: 2500, expAmount: 500 };
}

export const ATTENDANCE_LADDER_SEED: readonly AttendanceLadderSeedRung[] = Array.from(
  { length: 30 },
  (_, i) => rung(i + 1),
);

/** Payout idempotency key. A retry of the same day maps to the same rows. */
export function attendanceIdempotencyKey(
  userId: string,
  dayKey: string,
  kind: 'coins' | 'exp' | 'cosmetic',
): string {
  return `attendance:${userId}:${dayKey}:${kind}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/attendance/constants/attendance.constants.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the seeder**

```typescript
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ATTENDANCE_LADDER_SEED } from '../constants/attendance.constants';

/**
 * Seeds the 30-rung ladder on a fresh database. Idempotent by day and
 * create-only: operator edits to coins, EXP or the attached cosmetic survive a
 * restart. A claim cannot resolve without its rung, so this guarantees the
 * feature is usable out of the box.
 */
@Injectable()
export class AttendanceLadderSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttendanceLadderSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const seed of ATTENDANCE_LADDER_SEED) {
        const existing = await this.prisma.attendanceLadderRung.findUnique({
          where: { day: seed.day },
        });
        if (existing) continue;
        await this.prisma.attendanceLadderRung.create({
          data: { day: seed.day, coins: seed.coins, expAmount: seed.expAmount },
        });
        created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} attendance ladder rung(s).`);
    } catch (err) {
      this.logger.warn(`Attendance ladder seed skipped: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

---

### Task 6: Repository

**Files:**
- Create: `src/modules/attendance/repositories/attendance.repository.ts`

**Interfaces:**
- Consumes: Prisma models from Task 1.
- Produces: class `AttendanceRepository` with
  - `getState(userId: string): Promise<UserAttendance | null>`
  - `getLadder(): Promise<AttendanceLadderRung[]>` — ordered by day
  - `getRung(day: number): Promise<AttendanceLadderRung | null>`
  - `recordClaim(tx, input): Promise<AttendanceClaim>` — writes the claim row and upserts state

- [ ] **Step 1: Write the implementation**

No test of its own: it is a thin Prisma wrapper with no branching, and Task 7 covers it through the service. Adding a mock-Prisma test here would assert the mock, not the code.

```typescript
import { Injectable } from '@nestjs/common';
import type { Prisma, AttendanceClaim, AttendanceLadderRung, UserAttendance } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface RecordClaimInput {
  userId: string;
  day: number;
  cycle: number;
  dayKey: string;
  coins: number;
  currency: AttendanceLadderRung['currency'];
  expAmount: number | null;
  cosmeticId: string | null;
  timezone: string;
  claimedAt: Date;
}

@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  getState(userId: string): Promise<UserAttendance | null> {
    return this.prisma.userAttendance.findUnique({ where: { userId } });
  }

  getLadder(): Promise<AttendanceLadderRung[]> {
    return this.prisma.attendanceLadderRung.findMany({ orderBy: { day: 'asc' } });
  }

  getRung(day: number): Promise<AttendanceLadderRung | null> {
    return this.prisma.attendanceLadderRung.findUnique({ where: { day } });
  }

  /**
   * Writes the immutable claim row and advances the user's state. Runs inside
   * the caller's transaction so a failed payout leaves neither behind.
   */
  async recordClaim(tx: Prisma.TransactionClient, input: RecordClaimInput): Promise<AttendanceClaim> {
    const claim = await tx.attendanceClaim.create({
      data: {
        userId: input.userId,
        day: input.day,
        cycle: input.cycle,
        dayKey: input.dayKey,
        coins: input.coins,
        currency: input.currency,
        expAmount: input.expAmount,
        cosmeticId: input.cosmeticId,
        timezone: input.timezone,
        claimedAt: input.claimedAt,
      },
    });

    await tx.userAttendance.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        currentDay: input.day,
        cycleCount: input.cycle,
        lastClaimDayKey: input.dayKey,
        lastClaimAt: input.claimedAt,
        lastClaimTimezone: input.timezone,
        totalClaims: 1,
      },
      update: {
        currentDay: input.day,
        cycleCount: input.cycle,
        lastClaimDayKey: input.dayKey,
        lastClaimAt: input.claimedAt,
        lastClaimTimezone: input.timezone,
        totalClaims: { increment: 1 },
      },
    });

    return claim;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

---

### Task 7: Claim orchestration

**Files:**
- Create: `src/modules/attendance/services/attendance.service.ts`
- Test: `src/modules/attendance/services/attendance.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–6, plus `WALLET_SERVICE` (`IWalletService.credit`), `EXP_SERVICE` (`IExpService.award`), `COSMETICS_SERVICE` (`ICosmeticsService.grantToUser`), `PLATFORM_CONFIG` (`IPlatformConfiguration.get`), `LockService`, `PrismaService`, and `USERS_SERVICE` (`IUsersService.findById`) for the user's country.
- Produces: class `AttendanceService` with `getStatus(userId)` and `claim(userId)`.

The `claim` return shape, relied on by Task 8:

```typescript
export interface ClaimResult {
  claimed: boolean;      // false when today was already claimed
  day: number;
  cycle: number;
  coins: number;
  expAwarded: number | null;
  cosmeticId: string | null;
  streakReset: boolean;
  nextClaimAt: Date;
}
```

- [ ] **Step 1: Write the failing test**

```typescript
import { ForbiddenException, ConflictException } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceService } from './attendance.service';
import { AttendanceStreakService } from './attendance-streak.service';

describe('AttendanceService.claim', () => {
  let repo: Record<string, jest.Mock>;
  let wallet: Record<string, jest.Mock>;
  let exp: Record<string, jest.Mock>;
  let cosmetics: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let prisma: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let service: AttendanceService;

  const NOW = new Date('2026-07-28T06:00:00Z'); // 11:30 in Kolkata

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    repo = {
      getState: jest.fn().mockResolvedValue({
        userId: 'u1',
        currentDay: 3,
        cycleCount: 0,
        lastClaimDayKey: '2026-07-27',
        lastClaimAt: new Date('2026-07-27T06:00:00Z'),
        lastClaimTimezone: 'Asia/Kolkata',
      }),
      getRung: jest.fn().mockResolvedValue({
        day: 4,
        coins: 250,
        currency: WalletCurrency.FREE,
        expAmount: null,
        cosmeticId: null,
      }),
      getLadder: jest.fn().mockResolvedValue([]),
      recordClaim: jest.fn().mockResolvedValue({ id: 'claim-1' }),
    };
    wallet = { credit: jest.fn().mockResolvedValue({ transactionId: 'w1', duplicate: false }) };
    // ExpAwardResult is { totalExp, level, leveledUp } — one L.
    exp = { award: jest.fn().mockResolvedValue({ totalExp: 0, level: 1, leveledUp: false }) };
    cosmetics = { grantToUser: jest.fn().mockResolvedValue(null) };
    users = { findById: jest.fn().mockResolvedValue({ id: 'u1', country: 'IN' }) };
    config = { get: jest.fn().mockResolvedValue(null) };
    prisma = { $transaction: jest.fn().mockImplementation((cb) => cb(prisma)) };
    locks = { withLock: jest.fn().mockImplementation((_k, cb) => cb()) };

    service = new AttendanceService(
      repo as never,
      new AttendanceDayService(),
      new AttendanceStreakService(new AttendanceDayService()),
      wallet as never,
      exp as never,
      cosmetics as never,
      users as never,
      config as never,
      prisma as never,
      locks as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('credits FREE coins for the resolved rung', async () => {
    const res = await service.claim('u1');

    expect(res).toMatchObject({ claimed: true, day: 4, coins: 250 });
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        currency: WalletCurrency.FREE,
        amount: 250,
        idempotencyKey: 'attendance:u1:2026-07-28:coins',
      }),
      expect.anything(),
    );
  });

  it('never pays GOLD', async () => {
    await service.claim('u1');
    expect(wallet.credit).not.toHaveBeenCalledWith(
      expect.objectContaining({ currency: WalletCurrency.GOLD }),
      expect.anything(),
    );
  });

  it('awards EXP only when the rung carries it', async () => {
    await service.claim('u1');
    expect(exp.award).not.toHaveBeenCalled();

    repo.getRung.mockResolvedValue({
      day: 7,
      coins: 500,
      currency: WalletCurrency.FREE,
      expAmount: 100,
      cosmeticId: null,
    });
    await service.claim('u1');
    expect(exp.award).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', amount: 100 }),
    );
  });

  it('returns claimed:false without paying when today is already claimed', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 4,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-28',
      lastClaimAt: NOW,
      lastClaimTimezone: 'Asia/Kolkata',
    });

    const res = await service.claim('u1');

    expect(res.claimed).toBe(false);
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(repo.recordClaim).not.toHaveBeenCalled();
  });

  it('accepts a claim 1.5 hours after the last one when the zone is unchanged', async () => {
    // 23:00 then 00:30 local is a new day and must not trip the interval guard.
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 90 * 60 * 1000),
      lastClaimTimezone: 'Asia/Kolkata',
    });

    await expect(service.claim('u1')).resolves.toMatchObject({ claimed: true });
  });

  it('rejects a claim inside the interval when the country changed', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 90 * 60 * 1000),
      lastClaimTimezone: 'Pacific/Auckland',
    });

    await expect(service.claim('u1')).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('allows a country change once the interval has passed', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 21 * 60 * 60 * 1000),
      lastClaimTimezone: 'Pacific/Auckland',
    });

    await expect(service.claim('u1')).resolves.toMatchObject({ claimed: true });
  });

  it('still pays coins when the milestone cosmetic is missing', async () => {
    repo.getRung.mockResolvedValue({
      day: 15,
      coins: 1000,
      currency: WalletCurrency.FREE,
      expAmount: 250,
      cosmeticId: null,
    });

    const res = await service.claim('u1');

    expect(res.coins).toBe(1000);
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
  });

  it('refuses to pay when the feature flag is off', async () => {
    config.get.mockImplementation(async (key: string) =>
      key === 'feature.attendance.enabled' ? false : null,
    );

    await expect(service.claim('u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('takes the user lock so two concurrent claims cannot both advance', async () => {
    await service.claim('u1');
    expect(locks.withLock).toHaveBeenCalledWith('attendance:u1', expect.any(Function));
  });

  it('advances nothing when the wallet credit fails', async () => {
    // The claim row and the streak must not survive a failed payout, or the
    // user loses a day and is never paid for it.
    wallet.credit.mockRejectedValue(new Error('wallet down'));
    // Model the real transaction: a throw inside the callback aborts it.
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    await expect(service.claim('u1')).rejects.toThrow('wallet down');
    expect(repo.recordClaim).not.toHaveBeenCalled();
    expect(exp.award).not.toHaveBeenCalled();
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/attendance/services/attendance.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { BackpackItemSource, WalletTxnReason } from '@prisma/client';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { EXP_SERVICE, type IExpService } from 'src/modules/exp/interfaces/exp.service.interface';
import {
  PLATFORM_CONFIG,
  type IPlatformConfiguration,
} from 'src/modules/platform-configuration/interfaces/platform-configuration.interface';
import { USERS_SERVICE, type IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  ATTENDANCE_CONFIG_KEYS,
  ATTENDANCE_DEFAULTS,
  attendanceIdempotencyKey,
} from '../constants/attendance.constants';
import { resolveTimezone } from '../constants/country-timezone.map';
import { AttendanceRepository } from '../repositories/attendance.repository';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceStreakService } from './attendance-streak.service';

export interface ClaimResult {
  claimed: boolean;
  day: number;
  cycle: number;
  coins: number;
  expAwarded: number | null;
  cosmeticId: string | null;
  streakReset: boolean;
  nextClaimAt: Date;
}

/**
 * Daily-login streak. The claim is explicit: logging in advances nothing, the
 * user asks for the reward. Runs under a per-user lock inside one transaction,
 * so a failed payout leaves the streak untouched.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly repo: AttendanceRepository,
    private readonly days: AttendanceDayService,
    private readonly streak: AttendanceStreakService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(EXP_SERVICE) private readonly exp: IExpService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(PLATFORM_CONFIG) private readonly config: IPlatformConfiguration,
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
  ) {}

  async getStatus(userId: string) {
    const timezone = await this.timezoneFor(userId);
    const now = new Date();
    const todayKey = this.days.dayKey(now, timezone);
    const [state, ladder] = await Promise.all([this.repo.getState(userId), this.repo.getLadder()]);

    const outcome = this.streak.resolve({
      todayKey,
      lastClaimDayKey: state?.lastClaimDayKey ?? null,
      currentDay: state?.currentDay ?? 0,
      cycleCount: state?.cycleCount ?? 0,
    });

    return {
      currentDay: state?.currentDay ?? 0,
      cycleCount: state?.cycleCount ?? 0,
      claimableToday: outcome.kind === 'CLAIMABLE',
      nextDay: outcome.kind === 'CLAIMABLE' ? outcome.day : null,
      timezone,
      nextClaimAt: this.days.nextBoundary(now, timezone),
      ladder,
    };
  }

  async claim(userId: string): Promise<ClaimResult> {
    const enabled = await this.config.get<boolean>(ATTENDANCE_CONFIG_KEYS.ENABLED);
    if ((enabled ?? ATTENDANCE_DEFAULTS.ENABLED) === false) {
      throw new ForbiddenException('Attendance rewards are currently disabled.');
    }

    const timezone = await this.timezoneFor(userId);

    return this.locks.withLock(`attendance:${userId}`, async () => {
      const now = new Date();
      const todayKey = this.days.dayKey(now, timezone);
      const state = await this.repo.getState(userId);

      const outcome = this.streak.resolve({
        todayKey,
        lastClaimDayKey: state?.lastClaimDayKey ?? null,
        currentDay: state?.currentDay ?? 0,
        cycleCount: state?.cycleCount ?? 0,
      });

      if (outcome.kind === 'ALREADY_CLAIMED') {
        return {
          claimed: false,
          day: state?.currentDay ?? 0,
          cycle: state?.cycleCount ?? 0,
          coins: 0,
          expAwarded: null,
          cosmeticId: null,
          streakReset: false,
          nextClaimAt: this.days.nextBoundary(now, timezone),
        };
      }

      await this.assertIntervalElapsed(state, timezone, now);

      const rung = await this.repo.getRung(outcome.day);
      if (!rung) {
        // A gap in a seeded 30-row ladder is a defect, not a user condition.
        throw new InternalServerErrorException(
          `Attendance ladder is missing day ${outcome.day}.`,
        );
      }

      let cosmeticGranted: string | null = null;

      await this.prisma.$transaction(async (tx) => {
        await this.wallet.credit(
          {
            userId,
            currency: rung.currency,
            amount: rung.coins,
            reason: WalletTxnReason.REWARD,
            idempotencyKey: attendanceIdempotencyKey(userId, todayKey, 'coins'),
            referenceType: 'attendance_claim',
            referenceId: todayKey,
            metadata: { day: outcome.day, cycle: outcome.cycle },
          },
          tx,
        );

        await this.repo.recordClaim(tx, {
          userId,
          day: outcome.day,
          cycle: outcome.cycle,
          dayKey: todayKey,
          coins: rung.coins,
          currency: rung.currency,
          expAmount: rung.expAmount,
          cosmeticId: rung.cosmeticId,
          timezone,
          claimedAt: now,
        });
      });

      // Outside the transaction: EXP and cosmetics own their own idempotency and
      // must not roll back a paid claim if they fail.
      if (rung.expAmount && rung.expAmount > 0) {
        await this.exp.award({
          userId,
          amount: rung.expAmount,
          source: ExpSource.DAILY_LOGIN,
          idempotencyKey: attendanceIdempotencyKey(userId, todayKey, 'exp'),
          referenceType: 'attendance_claim',
          referenceId: todayKey,
        });
      }

      if (rung.cosmeticId) {
        const granted = await this.cosmetics.grantToUser({
          userId,
          cosmeticId: rung.cosmeticId,
          source: BackpackItemSource.EVENT,
          grantKey: attendanceIdempotencyKey(userId, todayKey, 'cosmetic'),
        });
        cosmeticGranted = granted?.cosmeticId ?? null;
      }

      return {
        claimed: true,
        day: outcome.day,
        cycle: outcome.cycle,
        coins: rung.coins,
        expAwarded: rung.expAmount,
        cosmeticId: cosmeticGranted,
        streakReset: outcome.reset,
        nextClaimAt: this.days.nextBoundary(now, timezone),
      };
    });
  }

  /**
   * Local midnight makes a country change exploitable: switch to a zone already
   * on tomorrow and claim twice within hours. Requiring a minimum interval
   * closes it — but only when the zone actually changed, because an
   * unconditional check would reject an honest 23:00-then-00:30 pair.
   */
  private async assertIntervalElapsed(
    state: { lastClaimAt: Date | null; lastClaimTimezone: string | null } | null,
    timezone: string,
    now: Date,
  ): Promise<void> {
    if (!state?.lastClaimAt || !state.lastClaimTimezone) return;
    if (state.lastClaimTimezone === timezone) return;

    const minHours =
      (await this.config.get<number>(ATTENDANCE_CONFIG_KEYS.MIN_HOURS)) ??
      ATTENDANCE_DEFAULTS.MIN_HOURS;
    const elapsedHours = (now.getTime() - state.lastClaimAt.getTime()) / 3_600_000;

    if (elapsedHours < minHours) {
      const opensAt = new Date(state.lastClaimAt.getTime() + minHours * 3_600_000);
      throw new ConflictException(
        `Next claim opens at ${opensAt.toISOString()} after a country change.`,
      );
    }
  }

  private async timezoneFor(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    return resolveTimezone(user?.country ?? null);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/attendance/services/attendance.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors. `IUsersService.findById(id): Promise<UserIdentity | null>` and `UserIdentity.country: string | null` were both verified against `src/modules/users/interfaces/users.service.interface.ts` while writing this plan, so no adaptation should be needed.

---

### Task 8: HTTP surface

**Files:**
- Create: `src/modules/attendance/dto/attendance.dto.ts`
- Create: `src/modules/attendance/controllers/attendance.controller.ts`
- Create: `src/modules/attendance/attendance.module.ts`
- Modify: `src/modules/index.ts` — register `AttendanceModule`

**Interfaces:**
- Consumes: `AttendanceService` from Task 7.
- Produces: `GET /attendance`, `POST /attendance/claim`.

- [ ] **Step 1: Write the DTOs**

```typescript
import { ApiProperty } from '@nestjs/swagger';

export class AttendanceLadderRungDto {
  @ApiProperty({ example: 7 }) day!: number;
  @ApiProperty({ example: 500 }) coins!: number;
  @ApiProperty({ example: 100, nullable: true }) expAmount!: number | null;
  @ApiProperty({ nullable: true }) cosmeticId!: string | null;
}

export class AttendanceStatusDto {
  @ApiProperty({ example: 3 }) currentDay!: number;
  @ApiProperty({ example: 0 }) cycleCount!: number;
  @ApiProperty({ example: true }) claimableToday!: boolean;
  @ApiProperty({ example: 4, nullable: true }) nextDay!: number | null;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
  @ApiProperty() nextClaimAt!: Date;
  @ApiProperty({ type: [AttendanceLadderRungDto] }) ladder!: AttendanceLadderRungDto[];
}

export class AttendanceClaimDto {
  @ApiProperty({ example: true, description: 'False when today was already claimed' })
  claimed!: boolean;
  @ApiProperty({ example: 4 }) day!: number;
  @ApiProperty({ example: 0 }) cycle!: number;
  @ApiProperty({ example: 250 }) coins!: number;
  @ApiProperty({ example: null, nullable: true }) expAwarded!: number | null;
  @ApiProperty({ nullable: true }) cosmeticId!: string | null;
  @ApiProperty({ example: false }) streakReset!: boolean;
  @ApiProperty() nextClaimAt!: Date;
}
```

- [ ] **Step 2: Write the controller**

```typescript
import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { AttendanceClaimDto, AttendanceStatusDto } from '../dto/attendance.dto';
import { AttendanceService } from '../services/attendance.service';

/**
 * Daily-login streak (base `attendance`). JWT-guarded globally. Claiming is
 * explicit — logging in does not pay.
 */
@ApiTags('attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @ApiOperation({ summary: 'Current streak, whether today is claimable, and the ladder' })
  @ApiResponse({ status: 200, type: AttendanceStatusDto })
  status(@CurrentUser('id') userId: string) {
    return this.attendance.getStatus(userId);
  }

  @Post('claim')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Claim today's reward" })
  @ApiResponse({ status: 200, type: AttendanceClaimDto })
  @ApiResponse({ status: 403, description: 'Attendance rewards are disabled' })
  @ApiResponse({ status: 409, description: 'Claim window not open after a country change' })
  claim(@CurrentUser('id') userId: string) {
    return this.attendance.claim(userId);
  }
}
```

`@NotGuest()` matches the PRD rule that guest accounts do not earn. The decorator exists at `src/common/decorators/not-guest.decorator.ts` — verified while writing this plan.

- [ ] **Step 3: Write the module**

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { AttendanceController } from './controllers/attendance.controller';
import { AttendanceRepository } from './repositories/attendance.repository';
import { AttendanceDayService } from './services/attendance-day.service';
import { AttendanceLadderSeeder } from './services/attendance-ladder.seeder';
import { AttendanceStreakService } from './services/attendance-streak.service';
import { AttendanceService } from './services/attendance.service';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceRepository,
    AttendanceDayService,
    AttendanceStreakService,
    AttendanceService,
    AttendanceLadderSeeder,
  ],
  exports: [AttendanceService],
})
export class AttendanceModule {}
```

- [ ] **Step 4: Register the module**

In `src/modules/index.ts`, import `AttendanceModule` alongside the other module imports and add it to the exported array, next to `BackpackModule`.

- [ ] **Step 5: Typecheck and run the module's tests**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest src/modules/attendance`
Expected: 0 type errors; all attendance tests pass.

---

### Task 9: Seed the configuration keys

**Files:**
- Modify: `src/modules/platform-configuration/services/platform-configuration-seeder.service.ts`

**Interfaces:**
- Consumes: `ATTENDANCE_CONFIG_KEYS` values from Task 5 (as literal strings — do not import across modules here; the seeder lists keys as data).
- Produces: two seeded settings.

`platform-configuration-seeder.spec.ts` already fails the build when a module reads a key that is not seeded, so this task is what keeps that guard green.

- [ ] **Step 1: Run the guard to watch it fail**

Run: `npx jest src/modules/platform-configuration/services/platform-configuration-seeder.spec.ts`
Expected: FAIL — "seeds every setting a module reads" lists `feature.attendance.enabled` and `attendance.min_hours_between_claims`.

- [ ] **Step 2: Add the settings**

Append to `DEFAULT_PLATFORM_SETTINGS`:

```typescript
  {
    key: 'feature.attendance.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables daily attendance rewards platform-wide',
    isFeatureFlag: true,
  },
  {
    key: 'attendance.min_hours_between_claims',
    category: 'ECONOMY',
    value: '20',
    valueType: SettingValueType.NUMBER,
    defaultValue: '20',
    description:
      'Minimum hours between attendance claims, enforced only when the user country (and so timezone) changed',
  },
```

- [ ] **Step 3: Run the guard to verify it passes**

Run: `npx jest src/modules/platform-configuration/services/platform-configuration-seeder.spec.ts`
Expected: PASS, 3 tests.

---

### Task 10: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Typecheck**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `npx jest --silent`
Expected: all suites pass. Baseline before this work was 378 suites / 4,318 tests; this plan adds roughly 28 tests across 5 new spec files.

- [ ] **Step 3: Lint**

Run: `npx eslint "{src,test}/**/*.ts"`
Expected: no errors in any `src/modules/attendance` file. The repository has 11 pre-existing errors in games and gift-registry files — that count must not rise.

- [ ] **Step 4: Boundaries**

Run: `npm run boundaries`
Expected: 215 violations, unchanged. If the count rose, the new module imported another module's internals instead of its `interfaces/`.

- [ ] **Step 5: Report**

Summarise: endpoints added, cycle total, the guard rule, and the fact that milestone cosmetics are unattached until an operator sets `cosmeticId` on days 15 and 30.

---

## Notes for the implementer

**The cosmetic gap is intentional, not an oversight.** The seeder leaves `cosmeticId` null on every rung, so days 15 and 30 pay coins and EXP but no frame until an operator attaches one. Wiring the ladder to specific catalog rows would make seeding fail on a database whose cosmetics catalog is empty.

**EXP and cosmetics deliberately sit outside the transaction.** Both own their idempotency. Holding a Postgres transaction open across them would widen the lock window for no benefit, and a cosmetics failure must not claw back coins the user has already been told they received.

**`getStatus` does not take the lock.** It only reads. A status call racing a claim may briefly show stale state, which is acceptable; paying twice is not, and that is what the lock and the `@@unique([userId, dayKey])` constraint prevent.
