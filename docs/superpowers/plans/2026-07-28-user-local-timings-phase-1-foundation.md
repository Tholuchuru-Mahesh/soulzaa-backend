# User-Local Timings — Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the timezone primitives (`TimeService`, `ZoneResolverService`) and start collecting each user's IANA timezone from their device — without changing any existing timing behaviour.

**Architecture:** A new `src/common/time/` module splits timezone work into a pure `TimeService` (zone is always a parameter, no I/O, so it tests with zero mocks) and an I/O `ZoneResolverService` that resolves a zone per user through a fallback chain. Nothing consumes these for timing decisions in this phase — Phase 1 only *collects* timezones and makes the primitives available.

**Tech Stack:** NestJS 11, Prisma 6, Jest + ts-jest, luxon (new), class-validator.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-user-local-timings-design.md`
- **Zero behaviour change.** No existing test may be modified. If an existing test fails, the change is wrong.
- Timezones are IANA identifiers (e.g. `Asia/Kolkata`). Never fixed offsets, never abbreviations like `IST`.
- The platform anchor default is the literal string `'UTC'`.
- Test files are `*.spec.ts` co-located beside the source file (repo convention). `rootDir` is `src`; `src/...` imports resolve via the `^src/(.*)$` moduleNameMapper.
- Run a single test file with `npx jest <path>`; run everything with `npm test`.
- `ZoneResolverService` reads `platformSetting` through `PrismaService` directly rather than importing `PlatformConfigurationModule`, to avoid a module cycle (the seeder uses the same direct-Prisma approach).
- Do not commit unless the plan step says to. Never `git push`.

---

### Task 1: Add luxon and the pure `TimeService` period keys

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/common/time/time.service.ts`
- Test: `src/common/time/time.service.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `export type PeriodName = 'daily' | 'weekly' | 'monthly'` and `TimeService.periodKey(period: PeriodName, at: Date, zone: string): string`, returning `'20260728'` (daily), `'2026W31'` (weekly, ISO), `'202607'` (monthly).

- [ ] **Step 1: Install luxon**

```bash
npm install luxon && npm install --save-dev @types/luxon
```

- [ ] **Step 2: Write the failing test**

Create `src/common/time/time.service.spec.ts`:

```ts
import { TimeService } from './time.service';

describe('TimeService.periodKey', () => {
  const time = new TimeService();

  it('derives the daily key from the zone, not UTC', () => {
    // 19:00Z on Jul 27 is already 00:30 on Jul 28 in Asia/Kolkata (+5:30).
    const at = new Date('2026-07-27T19:00:00.000Z');
    expect(time.periodKey('daily', at, 'UTC')).toBe('20260727');
    expect(time.periodKey('daily', at, 'Asia/Kolkata')).toBe('20260728');
  });

  it('derives a key behind UTC for western zones', () => {
    // 02:00Z on Jul 28 is still 22:00 on Jul 27 in America/New_York (EDT, -4).
    const at = new Date('2026-07-28T02:00:00.000Z');
    expect(time.periodKey('daily', at, 'UTC')).toBe('20260728');
    expect(time.periodKey('daily', at, 'America/New_York')).toBe('20260727');
  });

  it('handles 45-minute offsets', () => {
    // 18:20Z on Jul 27 is 00:05 on Jul 28 in Asia/Kathmandu (+5:45).
    const at = new Date('2026-07-27T18:20:00.000Z');
    expect(time.periodKey('daily', at, 'Asia/Kathmandu')).toBe('20260728');
  });

  it('produces ISO week keys where the week belongs to the year of its Thursday', () => {
    expect(time.periodKey('weekly', new Date('2027-01-01T12:00:00.000Z'), 'UTC')).toBe('2026W53');
    expect(time.periodKey('weekly', new Date('2024-12-31T12:00:00.000Z'), 'UTC')).toBe('2025W01');
  });

  it('produces monthly keys in the target zone', () => {
    // 19:00Z on Jul 31 is Aug 1 in Asia/Kolkata.
    const at = new Date('2026-07-31T19:00:00.000Z');
    expect(time.periodKey('monthly', at, 'UTC')).toBe('202607');
    expect(time.periodKey('monthly', at, 'Asia/Kolkata')).toBe('202608');
  });

  it('throws on an unknown zone rather than silently using UTC', () => {
    expect(() => time.periodKey('daily', new Date(), 'Not/AZone')).toThrow(/Not\/AZone/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: FAIL — `Cannot find module './time.service'`.

- [ ] **Step 4: Write the minimal implementation**

Create `src/common/time/time.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

/** Calendar periods that reset. Interval-based sweeps are not periods. */
export type PeriodName = 'daily' | 'weekly' | 'monthly';

/**
 * Pure calendar arithmetic in an explicit IANA zone. Holds no state and does
 * no I/O — the zone is always a parameter — so every DST and offset edge case
 * is testable without a single mock. Resolving *which* zone a caller should
 * pass is ZoneResolverService's job, deliberately kept separate.
 */
@Injectable()
export class TimeService {
  periodKey(period: PeriodName, at: Date, zone: string): string {
    const dt = this.inZone(at, zone);
    switch (period) {
      case 'daily':
        return dt.toFormat('yyyyMMdd');
      case 'weekly':
        return `${dt.weekYear}W${String(dt.weekNumber).padStart(2, '0')}`;
      case 'monthly':
        return dt.toFormat('yyyyMM');
    }
  }

  private inZone(at: Date, zone: string): DateTime {
    const dt = DateTime.fromJSDate(at, { zone });
    if (!dt.isValid) {
      throw new Error(`TimeService: invalid timezone "${zone}" (${dt.invalidReason})`);
    }
    return dt;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/common/time/
git commit -m "feat(time): add TimeService period keys with luxon"
```

---

### Task 2: `window()` and `nextMidnight()`, including DST-irregular days

**Files:**
- Modify: `src/common/time/time.service.ts`
- Test: `src/common/time/time.service.spec.ts`

**Interfaces:**
- Consumes: `TimeService`, `PeriodName` from Task 1
- Produces: `TimeService.window(period, at, zone): { start: Date; end: Date }` (half-open, UTC instants) and `TimeService.nextMidnight(zone: string, from?: Date): Date`.

- [ ] **Step 1: Confirm the DST transition dates from the installed tzdata**

Do not trust the dates below blindly — print them first:

```bash
npx ts-node -e "
const {DateTime}=require('luxon');
for (const [z,d] of [['America/New_York','2026-03-08'],['America/New_York','2026-11-01'],['America/Santiago','2026-09-06']]) {
  const s=DateTime.fromISO(d,{zone:z}).startOf('day');
  console.log(z,d,'startOf(day) local:',s.toISO(),'day length h:',s.plus({days:1}).diff(s,'hours').hours);
}"
```

Expected: New York 2026-03-08 → 23h, 2026-11-01 → 25h, Santiago 2026-09-06 → `startOf('day')` lands at 01:00 local with a 23h day. If any value differs, use the printed values in the assertions below — the tzdata in your Node build is the authority.

- [ ] **Step 2: Write the failing test**

Append to `src/common/time/time.service.spec.ts`:

```ts
describe('TimeService.window', () => {
  const time = new TimeService();
  const hours = (w: { start: Date; end: Date }) =>
    (w.end.getTime() - w.start.getTime()) / 3_600_000;

  it('returns the half-open day window containing the instant', () => {
    const at = new Date('2026-07-27T19:00:00.000Z'); // 00:30 Jul 28 IST
    const w = time.window('daily', at, 'Asia/Kolkata');
    expect(w.start.toISOString()).toBe('2026-07-27T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-07-28T18:30:00.000Z');
    expect(w.start.getTime()).toBeLessThanOrEqual(at.getTime());
    expect(w.end.getTime()).toBeGreaterThan(at.getTime());
  });

  it('produces a 23-hour day on spring-forward and 25 on fall-back', () => {
    expect(hours(time.window('daily', new Date('2026-03-08T12:00:00.000Z'), 'America/New_York')))
      .toBe(23);
    expect(hours(time.window('daily', new Date('2026-11-01T12:00:00.000Z'), 'America/New_York')))
      .toBe(25);
  });

  it('handles a zone whose local midnight does not exist', () => {
    // Chile springs forward at 00:00, so 2026-09-06T00:00 local is skipped.
    const w = time.window('daily', new Date('2026-09-06T12:00:00.000Z'), 'America/Santiago');
    expect(hours(w)).toBe(23);
    expect(w.end.getTime()).toBeGreaterThan(w.start.getTime());
  });

  it('starts weekly windows on Monday', () => {
    // 2026-07-28 is a Tuesday; its ISO week starts Monday 2026-07-27.
    const w = time.window('weekly', new Date('2026-07-28T12:00:00.000Z'), 'UTC');
    expect(w.start.toISOString()).toBe('2026-07-27T00:00:00.000Z');
    expect(hours(w)).toBe(168);
  });

  it('returns calendar-month windows', () => {
    const w = time.window('monthly', new Date('2026-07-15T12:00:00.000Z'), 'UTC');
    expect(w.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('TimeService.nextMidnight', () => {
  const time = new TimeService();

  it('returns the next local midnight as a UTC instant', () => {
    const from = new Date('2026-07-27T19:00:00.000Z'); // 00:30 Jul 28 IST
    expect(time.nextMidnight('Asia/Kolkata', from).toISOString())
      .toBe('2026-07-28T18:30:00.000Z'); // 00:00 Jul 29 IST
  });

  it('is strictly in the future and never a blind +24h', () => {
    const from = new Date('2026-03-07T12:00:00.000Z');
    const next = time.nextMidnight('America/New_York', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).not.toBe(86_400_000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: FAIL — `time.window is not a function`.

- [ ] **Step 4: Write the implementation**

Add to `TimeService` in `src/common/time/time.service.ts`:

```ts
  /**
   * Half-open [start, end) as UTC instants. Derived by adding one calendar
   * unit to the period start rather than a fixed number of milliseconds, so a
   * DST day is correctly 23 or 25 hours long.
   */
  window(period: PeriodName, at: Date, zone: string): { start: Date; end: Date } {
    const unit = this.unitFor(period);
    const start = this.inZone(at, zone).startOf(unit);
    return {
      start: start.toJSDate(),
      end: start.plus({ [unit]: 1 }).toJSDate(),
    };
  }

  /**
   * Start of the next local day, as a UTC instant. Never "now + 24h": on a DST
   * boundary the next midnight is 23 or 25 hours away, and in zones that skip
   * midnight entirely luxon resolves the start of day forward past the gap.
   */
  nextMidnight(zone: string, from: Date = new Date()): Date {
    return this.inZone(from, zone).startOf('day').plus({ days: 1 }).toJSDate();
  }

  private unitFor(period: PeriodName): 'day' | 'week' | 'month' {
    return period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month';
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/common/time/
git commit -m "feat(time): add DST-correct window and nextMidnight"
```

---

### Task 3: `isValidZone()` plus the cross-zone property test

**Files:**
- Modify: `src/common/time/time.service.ts`
- Test: `src/common/time/time.service.spec.ts`

**Interfaces:**
- Consumes: `TimeService` from Tasks 1–2
- Produces: `TimeService.isValidZone(zone: string): boolean`

- [ ] **Step 1: Write the failing test**

Append to `src/common/time/time.service.spec.ts`:

```ts
describe('TimeService.isValidZone', () => {
  const time = new TimeService();

  it.each(['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Niue'])(
    'accepts %s',
    (zone) => expect(time.isValidZone(zone)).toBe(true),
  );

  it.each(['Not/AZone', 'IST', '+05:30', '', 'Mars/Olympus'])(
    'rejects %s',
    (zone) => expect(time.isValidZone(zone)).toBe(false),
  );
});

describe('TimeService invariants across zones', () => {
  const time = new TimeService();
  const ZONES = [
    'UTC',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'America/New_York',
    'Australia/Lord_Howe',
    'America/Santiago',
    'Pacific/Kiritimati', // +14
    'Pacific/Niue', // -11
  ];
  const PERIODS = ['daily', 'weekly', 'monthly'] as const;
  // Instants spread across a year, deliberately including DST edges.
  const INSTANTS = [
    '2026-01-01T00:00:00.000Z',
    '2026-03-08T06:30:00.000Z',
    '2026-07-27T18:30:00.000Z',
    '2026-09-06T03:00:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-12-31T23:59:59.999Z',
  ].map((s) => new Date(s));

  it('always contains the instant it was derived from', () => {
    for (const zone of ZONES) {
      for (const period of PERIODS) {
        for (const at of INSTANTS) {
          const w = time.window(period, at, zone);
          expect(w.start.getTime()).toBeLessThanOrEqual(at.getTime());
          expect(w.end.getTime()).toBeGreaterThan(at.getTime());
        }
      }
    }
  });

  it('gives one key per window and a different key in the next', () => {
    for (const zone of ZONES) {
      for (const period of PERIODS) {
        for (const at of INSTANTS) {
          const w = time.window(period, at, zone);
          const key = time.periodKey(period, at, zone);
          expect(time.periodKey(period, w.start, zone)).toBe(key);
          expect(time.periodKey(period, new Date(w.end.getTime() - 1), zone)).toBe(key);
          expect(time.periodKey(period, w.end, zone)).not.toBe(key);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: FAIL — `time.isValidZone is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `TimeService`:

```ts
  /** True only for IANA zone identifiers. Offsets and abbreviations are rejected. */
  isValidZone(zone: string): boolean {
    if (!zone || !zone.includes('/')) return zone === 'UTC';
    return DateTime.local().setZone(zone).isValid;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/time/time.service.spec.ts`
Expected: PASS. The invariant tests cover 8 zones × 3 periods × 6 instants.

- [ ] **Step 5: Commit**

```bash
git add src/common/time/
git commit -m "feat(time): add isValidZone and cross-zone invariant tests"
```

---

### Task 4: The `platform.timezone` setting and `ZoneResolverService.platform()`

**Files:**
- Modify: `src/modules/platform-configuration/services/platform-configuration-seeder.service.ts` (append to `DEFAULT_PLATFORM_SETTINGS`)
- Create: `src/common/time/zone-resolver.service.ts`
- Test: `src/common/time/zone-resolver.service.spec.ts`

**Interfaces:**
- Consumes: `TimeService.isValidZone` from Task 3
- Produces: `PLATFORM_TIMEZONE_KEY = 'platform.timezone'` and `ZoneResolverService.platform(): Promise<string>`

- [ ] **Step 1: Add the seed entry**

In `DEFAULT_PLATFORM_SETTINGS` in `platform-configuration-seeder.service.ts`, append:

```ts
  {
    key: 'platform.timezone',
    category: 'GENERAL',
    value: 'UTC',
    valueType: SettingValueType.STRING,
    defaultValue: 'UTC',
    description:
      'IANA timezone anchoring all shared/competitive timings (room treasure boxes, leaderboards, event windows). Personal timings follow each user’s own zone and ignore this.',
  },
```

- [ ] **Step 2: Write the failing test**

Create `src/common/time/zone-resolver.service.spec.ts`:

```ts
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TimeService } from './time.service';
import { ZoneResolverService } from './zone-resolver.service';

const prismaMock = () =>
  ({
    platformSetting: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    userDevice: { findFirst: jest.fn() },
  }) as unknown as jest.Mocked<PrismaService>;

describe('ZoneResolverService.platform', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let resolver: ZoneResolverService;

  beforeEach(() => {
    prisma = prismaMock();
    resolver = new ZoneResolverService(prisma, new TimeService());
  });

  it('defaults to UTC when the setting row is absent', async () => {
    (prisma.platformSetting.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(resolver.platform()).resolves.toBe('UTC');
  });

  it('returns the configured zone', async () => {
    (prisma.platformSetting.findUnique as jest.Mock).mockResolvedValue({ value: 'Asia/Kolkata' });
    await expect(resolver.platform()).resolves.toBe('Asia/Kolkata');
  });

  it('falls back to UTC when the configured value is not a real zone', async () => {
    (prisma.platformSetting.findUnique as jest.Mock).mockResolvedValue({ value: 'Not/AZone' });
    await expect(resolver.platform()).resolves.toBe('UTC');
  });

  it('caches so a hot path does not hit the database every call', async () => {
    (prisma.platformSetting.findUnique as jest.Mock).mockResolvedValue({ value: 'Asia/Kolkata' });
    await resolver.platform();
    await resolver.platform();
    expect(prisma.platformSetting.findUnique).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/common/time/zone-resolver.service.spec.ts`
Expected: FAIL — `Cannot find module './zone-resolver.service'`.

- [ ] **Step 4: Write the implementation**

Create `src/common/time/zone-resolver.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TimeService } from './time.service';

export const PLATFORM_TIMEZONE_KEY = 'platform.timezone';
export const DEFAULT_PLATFORM_TIMEZONE = 'UTC';

/** Matches the reload cadence used by the other config-backed services. */
const PLATFORM_CACHE_MS = 60_000;

/**
 * Resolves which IANA zone a timing decision should use. Shared/competitive
 * timings use platform(); personal timings use forUser().
 *
 * Reads platform_settings through Prisma directly rather than importing
 * PlatformConfigurationModule — that module already depends on common code,
 * so injecting its services here would close a cycle.
 */
@Injectable()
export class ZoneResolverService {
  private readonly logger = new Logger(ZoneResolverService.name);
  private platformCache: { zone: string; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  async platform(): Promise<string> {
    const now = Date.now();
    if (this.platformCache && now - this.platformCache.at < PLATFORM_CACHE_MS) {
      return this.platformCache.zone;
    }

    const row = await this.prisma.platformSetting.findUnique({
      where: { key: PLATFORM_TIMEZONE_KEY },
      select: { value: true },
    });

    let zone = row?.value ?? DEFAULT_PLATFORM_TIMEZONE;
    if (!this.time.isValidZone(zone)) {
      this.logger.error(
        `${PLATFORM_TIMEZONE_KEY} is "${zone}", which is not a valid IANA zone. Falling back to ${DEFAULT_PLATFORM_TIMEZONE}.`,
      );
      zone = DEFAULT_PLATFORM_TIMEZONE;
    }

    this.platformCache = { zone, at: now };
    return zone;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/common/time/zone-resolver.service.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the seeder test still passes**

Run: `npx jest src/modules/platform-configuration`
Expected: PASS. If a test asserts an exact settings count, update that number — it is the one legitimate existing-test edit in this phase.

- [ ] **Step 7: Commit**

```bash
git add src/common/time/ src/modules/platform-configuration/
git commit -m "feat(time): add platform.timezone setting and anchor resolution"
```

---

### Task 5: Persist a timezone on `User` and `UserDevice`

**Files:**
- Modify: `prisma/schema/users.prisma` (model `User`)
- Modify: `prisma/schema/device.prisma` (model `UserDevice`)

**Interfaces:**
- Consumes: nothing
- Produces: `User.timezone: string | null` and `UserDevice.timezone: string | null` on the generated Prisma client.

- [ ] **Step 1: Add the field to `User`**

In `prisma/schema/users.prisma`, directly below `preferredLanguage`:

```prisma
  preferredLanguage String?
  /// IANA zone (e.g. "Asia/Kolkata"), last reported by one of the user's
  /// devices. Null means "unknown" — ZoneResolverService falls back rather
  /// than assuming UTC at the call site.
  timezone          String?
```

- [ ] **Step 2: Add the field to `UserDevice`**

In `prisma/schema/device.prisma`, directly below `country`:

```prisma
  country          String?
  /// Last IANA zone this specific device reported.
  timezone         String?
```

- [ ] **Step 3: Generate the migration**

```bash
npx prisma migrate dev --name add_user_and_device_timezone
```

Expected: a new folder under `prisma/migrations/` containing two `ALTER TABLE ... ADD COLUMN "timezone" TEXT;` statements. Both columns are nullable, so this is additive and safe on a populated database.

- [ ] **Step 4: Verify the client regenerated**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat(time): add timezone columns to users and user_devices"
```

---

### Task 6: The single-timezone country map

**Files:**
- Create: `src/common/time/country-zones.ts`
- Test: `src/common/time/country-zones.spec.ts`

**Interfaces:**
- Consumes: `TimeService.isValidZone` from Task 3
- Produces: `COUNTRY_ZONES: Readonly<Record<string, string>>` keyed by uppercase ISO-3166 alpha-2.

- [ ] **Step 1: Write the failing test**

Create `src/common/time/country-zones.spec.ts`:

```ts
import { COUNTRY_ZONES } from './country-zones';
import { TimeService } from './time.service';

describe('COUNTRY_ZONES', () => {
  const time = new TimeService();

  it('maps single-timezone countries', () => {
    expect(COUNTRY_ZONES.IN).toBe('Asia/Kolkata');
    expect(COUNTRY_ZONES.GB).toBe('Europe/London');
    expect(COUNTRY_ZONES.AE).toBe('Asia/Dubai');
  });

  it('omits multi-timezone countries so they fall through to the anchor', () => {
    // A "representative" zone for these is wrong for most of their users, and
    // wrong silently — absence is the correct signal.
    for (const code of ['US', 'RU', 'BR', 'AU', 'CA', 'MX', 'ID', 'KZ']) {
      expect(COUNTRY_ZONES[code]).toBeUndefined();
    }
  });

  it('only contains valid IANA zones', () => {
    for (const [code, zone] of Object.entries(COUNTRY_ZONES)) {
      expect(time.isValidZone(zone)).toBe(true);
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/time/country-zones.spec.ts`
Expected: FAIL — `Cannot find module './country-zones'`.

- [ ] **Step 3: Write the implementation**

Create `src/common/time/country-zones.ts`:

```ts
/**
 * ISO-3166 alpha-2 → IANA zone, for countries that have exactly ONE zone.
 *
 * Multi-timezone countries (US, RU, BR, AU, CA, MX, ID, KZ, ...) are
 * deliberately absent. Mapping them to a "representative" zone would be wrong
 * for most of their users and wrong without any signal that it was a guess —
 * so they fall through to the platform anchor instead. A country is either
 * unambiguous or it is not evidence.
 */
export const COUNTRY_ZONES: Readonly<Record<string, string>> = Object.freeze({
  IN: 'Asia/Kolkata',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait',
  BH: 'Asia/Bahrain',
  OM: 'Asia/Muscat',
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  PH: 'Asia/Manila',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  CN: 'Asia/Shanghai', // one official zone despite its width
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid', // Canary Islands differ; mainland dominates the user base
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  CH: 'Europe/Zurich',
  AT: 'Europe/Vienna',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw',
  TR: 'Europe/Istanbul',
  GR: 'Europe/Athens',
  RO: 'Europe/Bucharest',
  UA: 'Europe/Kyiv',
  EG: 'Africa/Cairo',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  GH: 'Africa/Accra',
  MA: 'Africa/Casablanca',
  IL: 'Asia/Jerusalem',
  NZ: 'Pacific/Auckland',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago', // continental; Easter Island differs
  PE: 'America/Lima',
  CO: 'America/Bogota',
  VE: 'America/Caracas',
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/time/country-zones.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/common/time/
git commit -m "feat(time): add single-timezone country map"
```

---

### Task 7: `ZoneResolverService.forUser()` — the fallback chain and cache

**Files:**
- Modify: `src/common/time/zone-resolver.service.ts`
- Test: `src/common/time/zone-resolver.service.spec.ts`

**Interfaces:**
- Consumes: `platform()` (Task 4), `COUNTRY_ZONES` (Task 6), `TimeService.isValidZone` (Task 3)
- Produces: `ZoneResolverService.forUser(userId: string): Promise<string>` and `ZoneResolverService.invalidateUser(userId: string): void`

- [ ] **Step 1: Write the failing test**

Append to `src/common/time/zone-resolver.service.spec.ts`:

```ts
describe('ZoneResolverService.forUser', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let resolver: ZoneResolverService;

  beforeEach(() => {
    prisma = prismaMock();
    (prisma.platformSetting.findUnique as jest.Mock).mockResolvedValue({ value: 'UTC' });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ timezone: null, country: null });
    (prisma.userDevice.findFirst as jest.Mock).mockResolvedValue(null);
    resolver = new ZoneResolverService(prisma, new TimeService());
  });

  it('rung 1: prefers User.timezone', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      timezone: 'Asia/Kolkata',
      country: 'US',
    });
    await expect(resolver.forUser('u1')).resolves.toBe('Asia/Kolkata');
    expect(prisma.userDevice.findFirst).not.toHaveBeenCalled();
  });

  it('rung 2: falls to the most-recently-active device', async () => {
    (prisma.userDevice.findFirst as jest.Mock).mockResolvedValue({ timezone: 'Europe/London' });
    await expect(resolver.forUser('u1')).resolves.toBe('Europe/London');
  });

  it('rung 3: falls to the country map', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ timezone: null, country: 'in' });
    await expect(resolver.forUser('u1')).resolves.toBe('Asia/Kolkata');
  });

  it('rung 3 is skipped for multi-timezone countries', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ timezone: null, country: 'US' });
    await expect(resolver.forUser('u1')).resolves.toBe('UTC');
  });

  it('rung 4: falls to the platform anchor for an unknown user', async () => {
    (prisma.platformSetting.findUnique as jest.Mock).mockResolvedValue({ value: 'Asia/Kolkata' });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(resolver.forUser('ghost')).resolves.toBe('Asia/Kolkata');
  });

  it('skips a stored zone that is no longer a valid IANA zone', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      timezone: 'Not/AZone',
      country: 'IN',
    });
    await expect(resolver.forUser('u1')).resolves.toBe('Asia/Kolkata');
  });

  it('caches per user, and invalidateUser clears it', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      timezone: 'Asia/Kolkata',
      country: null,
    });
    await resolver.forUser('u1');
    await resolver.forUser('u1');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);

    resolver.invalidateUser('u1');
    await resolver.forUser('u1');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/time/zone-resolver.service.spec.ts`
Expected: FAIL — `resolver.forUser is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `zone-resolver.service.ts` — import `COUNTRY_ZONES` from `./country-zones`, add the constant, then the methods:

```ts
const USER_CACHE_MS = 15 * 60_000;
```

```ts
  private readonly userCache = new Map<string, { zone: string; at: number }>();

  /**
   * The user's zone, first hit wins:
   *   1. User.timezone
   *   2. most-recently-active device's timezone
   *   3. single-timezone country map
   *   4. the platform anchor
   *
   * Every rung is re-validated: a zone stored months ago can be dropped from
   * the IANA database, and this runs on gift/task hot paths where throwing
   * would be worse than falling through.
   */
  async forUser(userId: string): Promise<string> {
    const now = Date.now();
    const hit = this.userCache.get(userId);
    if (hit && now - hit.at < USER_CACHE_MS) return hit.zone;

    const zone = await this.resolveUncached(userId);
    this.userCache.set(userId, { zone, at: now });
    return zone;
  }

  /** Called when a device reports a new zone, so the next read is not stale. */
  invalidateUser(userId: string): void {
    this.userCache.delete(userId);
  }

  private async resolveUncached(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true, country: true },
    });

    if (user?.timezone && this.time.isValidZone(user.timezone)) return user.timezone;

    const device = await this.prisma.userDevice.findFirst({
      where: { userId, deletedAt: null, timezone: { not: null } },
      orderBy: { lastActiveAt: 'desc' },
      select: { timezone: true },
    });
    if (device?.timezone && this.time.isValidZone(device.timezone)) return device.timezone;

    const fromCountry = user?.country ? COUNTRY_ZONES[user.country.toUpperCase()] : undefined;
    if (fromCountry) return fromCountry;

    return this.platform();
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/time/zone-resolver.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/common/time/
git commit -m "feat(time): resolve per-user timezone with fallback chain and cache"
```

---

### Task 8: The `TimeModule`

**Files:**
- Create: `src/common/time/time.module.ts`
- Create: `src/common/time/index.ts`

**Interfaces:**
- Consumes: `TimeService`, `ZoneResolverService`
- Produces: `TimeModule` (a `@Global()` module exporting both services) and barrel exports of `TimeService`, `ZoneResolverService`, `PeriodName`, `PLATFORM_TIMEZONE_KEY`, `COUNTRY_ZONES`.

- [ ] **Step 1: Create the module**

`src/common/time/time.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { TimeService } from './time.service';
import { ZoneResolverService } from './zone-resolver.service';

/**
 * Global because Phases 2 and 3 inject these into ~13 feature modules; adding
 * an import line to each would be noise with no isolation benefit.
 */
@Global()
@Module({
  providers: [TimeService, ZoneResolverService],
  exports: [TimeService, ZoneResolverService],
})
export class TimeModule {}
```

- [ ] **Step 2: Create the barrel**

`src/common/time/index.ts`:

```ts
export * from './country-zones';
export * from './time.module';
export * from './time.service';
export * from './zone-resolver.service';
```

- [ ] **Step 3: Register the module**

Add `TimeModule` to the `imports` array of the root `AppModule` (`src/app.module.ts`), next to the other infrastructure modules.

- [ ] **Step 4: Verify the application still boots**

```bash
npx tsc --noEmit && npm run build
```

Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/common/time/ src/app.module.ts
git commit -m "feat(time): wire TimeModule into the application"
```

---

### Task 9: Accept a timezone from the client and persist it

**Files:**
- Create: `src/common/validators/is-iana-timezone.validator.ts`
- Modify: `src/modules/device/dto/device.dto.ts` (`RegisterDeviceDto`)
- Modify: `src/modules/device/interfaces/device.interface.ts` (`DeviceInfo`)
- Modify: `src/modules/device/repositories/device.repository.ts` (`upsert`)
- Modify: `src/modules/device/services/device.service.ts` (`registerDevice`)
- Test: `src/common/validators/is-iana-timezone.validator.spec.ts`
- Test: `src/modules/device/services/device.service.spec.ts` (append)

**Interfaces:**
- Consumes: `TimeService.isValidZone` (Task 3), `ZoneResolverService.invalidateUser` (Task 7)
- Produces: `@IsIanaTimeZone()` decorator; `DeviceInfo.timezone?: string`; `registerDevice` persists the zone to `UserDevice.timezone` and writes through to `User.timezone`.

- [ ] **Step 1: Write the failing validator test**

Create `src/common/validators/is-iana-timezone.validator.spec.ts`:

```ts
import { validate } from 'class-validator';
import { IsIanaTimeZone } from './is-iana-timezone.validator';

class Probe {
  @IsIanaTimeZone()
  zone!: string;
}

const check = async (zone: string) => {
  const p = new Probe();
  p.zone = zone;
  return validate(p);
};

describe('IsIanaTimeZone', () => {
  it.each(['UTC', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires'])(
    'accepts %s',
    async (z) => expect(await check(z)).toHaveLength(0),
  );

  it.each(['IST', '+05:30', 'Not/AZone', ''])('rejects %s', async (z) => {
    const errors = await check(z);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints?.isIanaTimeZone).toMatch(/IANA/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/validators/is-iana-timezone.validator.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the validator**

Create `src/common/validators/is-iana-timezone.validator.ts`:

```ts
import { registerDecorator, ValidationOptions } from 'class-validator';
import { TimeService } from 'src/common/time/time.service';

const time = new TimeService();

/** Rejects offsets and abbreviations — only real IANA identifiers pass. */
export function IsIanaTimeZone(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && time.isValidZone(value),
        defaultMessage: () =>
          `${propertyName} must be an IANA timezone identifier, e.g. "Asia/Kolkata"`,
      },
    });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/validators/is-iana-timezone.validator.spec.ts`
Expected: PASS.

- [ ] **Step 5: Thread the field through the DTO and interface**

In `src/modules/device/dto/device.dto.ts`, add to `RegisterDeviceDto` after `country`:

```ts
  @ApiPropertyOptional({
    example: 'Asia/Kolkata',
    description: 'IANA timezone from the device, e.g. Intl.DateTimeFormat().resolvedOptions().timeZone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsIanaTimeZone()
  timezone?: string;
```

Import the decorator: `import { IsIanaTimeZone } from 'src/common/validators/is-iana-timezone.validator';`

In `src/modules/device/interfaces/device.interface.ts`, add to `DeviceInfo` after `country?: string;`:

```ts
  /** IANA zone reported by the device, e.g. "Asia/Kolkata". */
  timezone?: string;
```

In `src/modules/device/repositories/device.repository.ts`, add `timezone?: string | null;` to the `upsert` input type and `timezone: input.timezone ?? undefined,` to the `common` object.

- [ ] **Step 6: Write the failing service test**

Append to `src/modules/device/services/device.service.spec.ts`, inside the existing `describe('registerDevice')`:

```ts
    it('persists the reported timezone and writes it through to the user', async () => {
      await service.registerDevice('u1', { ...INFO, timezone: 'Asia/Kolkata' }, { ip: '1.2.3.4' });
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'Asia/Kolkata' }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { timezone: 'Asia/Kolkata' },
      });
      expect(zones.invalidateUser).toHaveBeenCalledWith('u1');
    });

    it('leaves the user row alone when no timezone is reported', async () => {
      await service.registerDevice('u1', INFO, { ip: '1.2.3.4' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
```

Add the two new collaborators to the module setup at the top of that file — a `prisma` mock exposing `user.update: jest.fn()`, and a `zones` mock exposing `invalidateUser: jest.fn()` — following the existing mock style in the file.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx jest src/modules/device/services/device.service.spec.ts`
Expected: FAIL — `timezone` is not passed to `upsert`.

- [ ] **Step 8: Write the implementation**

In `device.service.ts`, inject `PrismaService` and `ZoneResolverService` in the constructor. Add `timezone: info.timezone ?? null,` to the `this.repo.upsert({...})` call, then after the upsert:

```ts
    // Write through to the user row so ZoneResolverService's first rung hits
    // without a device lookup. Only on change, to avoid a write per login.
    if (info.timezone) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      if (user && user.timezone !== info.timezone) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { timezone: info.timezone },
        });
        this.zones.invalidateUser(userId);
      }
    }
```

Note the test above mocks `user.findUnique` to return `{ timezone: null }` so the update fires; add that to the `beforeEach`.

Finally, pass `timezone: dto.timezone` wherever the controller maps `RegisterDeviceDto` into `DeviceInfo`.

- [ ] **Step 9: Run the device tests**

Run: `npx jest src/modules/device`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 10: Commit**

```bash
git add src/common/validators/ src/modules/device/
git commit -m "feat(time): accept and persist device-reported IANA timezone"
```

---

### Task 10: Full verification

**Files:** none

- [ ] **Step 1: Run the entire suite**

Run: `npm test`
Expected: PASS. Only `platform-configuration`'s settings-count assertion may have changed (Task 4, Step 6). Any other pre-existing test that changed behaviour means something in this phase was not behaviour-neutral — stop and fix it.

- [ ] **Step 2: Lint, typecheck, and module boundaries**

```bash
npm run lint && npx tsc --noEmit && npm run boundaries
```

Expected: all pass. If `boundaries` objects to `src/common/time` importing `src/infra/prisma`, add the allowance to `.dependency-cruiser.cjs` alongside the existing `src/common` rules.

- [ ] **Step 3: Confirm zone collection works end to end**

Start the app, register a device with `"timezone": "Asia/Kolkata"` in the body, and confirm both `user_devices.timezone` and `users.timezone` hold the value.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore(time): phase 1 verification fixes"
```

---

### Task 11: Mobile — report the device timezone

**Files:**
- Modify: `soulzaa-mobile` — the device-registration call site and the app-foreground handler

**Interfaces:**
- Consumes: the `timezone` field on the device-register request body (Task 9)
- Produces: nothing consumed by the backend beyond that field

- [ ] **Step 1: Add the zone to the register payload**

Wherever the app builds the device-register body, add:

```ts
timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
```

React Native's Hermes exposes this with full ICU on both platforms. It returns an IANA identifier such as `Asia/Kolkata`.

- [ ] **Step 2: Re-report on app foreground**

In the existing `AppState` `'active'` handler, re-issue device registration when the resolved zone differs from the one sent last. Store the last-sent value in the app's existing local storage so a traveller's zone reaches the backend without waiting for a fresh login.

- [ ] **Step 3: Verify from the device**

Register from a device, change the OS timezone, foreground the app, and confirm `user_devices.timezone` and `users.timezone` both update.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(time): report device IANA timezone on register and foreground"
```

---

## Phase exit criteria

- [ ] `TimeService` and `ZoneResolverService` suites pass; the pre-existing suite passes untouched (except the settings-count assertion).
- [ ] `npm run lint`, `npx tsc --noEmit`, and `npm run boundaries` all pass.
- [ ] Timezones are observably landing on `user_devices.timezone` and `users.timezone` in staging.
- [ ] **No timing behaviour has changed anywhere.** Nothing yet calls `forUser()` or `platform()` for a timing decision.

**Bake requirement:** let this phase run for at least one app release cycle before Phase 3, so the active user base has real zones on record rather than falling through to the anchor. Phase 2 has no such constraint and can start immediately.
