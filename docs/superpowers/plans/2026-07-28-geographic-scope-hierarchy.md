# Geographic Scope Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the normalised `Country → State → Region` hierarchy the single authoritative source for every geographic decision — scope filtering, event eligibility, and analytics categorisation — so an Official scoped to a state sees exactly that state, and no authorisation or routing path ever reads free text again.

**Architecture:** Add nullable FK columns to `User`, `RankingDefinition` and `EventDefinition` pointing at the existing `Country`/`State`/`Region` tables, alongside the current free-text fields which stay for profile display and timezone resolution. `WorkforceScopeService` stops resolving scopes to country codes and builds a Prisma `OR` of exact scope predicates. `EventEligibilityService` stops string-matching profile country. Users whose location has not yet been normalised keep matching through a country-level bridge clause, so no operator loses access mid-migration.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL, Jest.

## Global Constraints

- **Free-text geography is for display only.** `User.country` and the `country`/`region` strings on `RankingDefinition`/`EventDefinition` may be read for profile display, attendance/timezone resolution, localisation and search discovery. They must **never** be read for RBAC, approval routing, workforce filtering, eligibility, analytics or any authorisation decision. Task 9 enforces this with a test.
- `User.country` is **not** removed, renamed or repurposed. `AttendanceService.resolveTimezone` reads it and must keep working unchanged.
- All new columns are **nullable**. No `NOT NULL`, no default, no backfill inside a migration transaction — the tables are large and a rewrite would lock them.
- Existing `RoleScope` rows are **not** modified. Their meaning changes only in how they are read.
- An operational role with **no scope assignment sees nothing**, never everything.
- **ADMIN does not gain geography management.** ADMIN keeps `organization.hierarchy.view` (read-only) and gains only `user.location.view` + `user.location.assign`. Creating, editing and deactivating countries/states/regions stays SUPER_ADMIN, because deactivating a country changes what every operator beneath it can see.
- **The Role Approval Engine is out of scope.** `role_requests.prisma` defines the schema but no module, migration or code exists (0 references in `src/`, 0 migrations). Its schema already uses `regionId`/`stateId`/`countryId`, so it will route on the normalised hierarchy by construction. Task 9 adds a test locking that guarantee in.
- Run `npx tsc --noEmit -p tsconfig.json` and `npx jest` after every task. Both must be clean before committing.
- Baseline before starting: **400 suites / 4540 tests passing, tsc clean.**

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema/users.prisma` | Add `countryId`/`stateId`/`regionId` + relations + indexes to `User` |
| `prisma/schema/rbac.prisma` | Add back-relations on `Country`/`State`/`Region` |
| `prisma/schema/migrations/20260729000000_user_location_hierarchy/migration.sql` | Nullable columns, FKs, indexes |
| `src/modules/organization/services/user-location.service.ts` | **New.** Resolve/assign a user's location; the backfill routine |
| `src/modules/organization/services/user-location.service.spec.ts` | **New.** Resolution + backfill tests |
| `src/modules/organization/controllers/user-location.controller.ts` | **New.** Admin APIs to read/set a user's location |
| `src/modules/organization/dto/user-location.dto.ts` | **New.** Request/response DTOs |
| `src/modules/organization/organization.module.ts` | Register the new service + controller |
| `src/modules/mobile-workforce/services/workforce-scope.service.ts` | Replace country-code resolution with exact scope predicates |
| `src/modules/mobile-workforce/services/workforce-scope.service.spec.ts` | Rewrite for exact matching + fallback |
| `src/modules/mobile-workforce/services/mobile-workforce.service.ts` | Consume the new filter shape |
| `src/modules/authorization/constants/rbac-permissions.constants.ts` | Add `user.location.view` / `user.location.assign` |
| `prisma/seed-rbac.ts` | Call the location backfill |
| `prisma/schema/enterprise_rankings.prisma` | Add `countryId`/`regionId` to `RankingDefinition` |
| `prisma/schema/enterprise_events.prisma` | Add `countryId`/`regionId` to `EventDefinition` |
| `prisma/schema/migrations/20260729010000_normalised_domain_geography/migration.sql` | Nullable columns, FKs, indexes for both |
| `src/modules/enterprise-events/services/event-eligibility.service.ts` | Stop matching free-text country; compare `countryId` |
| `src/modules/enterprise-events/services/event-eligibility.service.spec.ts` | **New.** Eligibility tests incl. the `"India"` vs `"IN"` bug |
| `src/modules/authorization/geography-source-of-truth.spec.ts` | **New.** Guard: no authorisation path reads free text |
| `test/geographic-scope.e2e-spec.ts` | **New.** End-to-end scope workflow |

---

## Task 1: Schema and migration for user location

**Files:**
- Modify: `prisma/schema/users.prisma` (User model)
- Modify: `prisma/schema/rbac.prisma` (Country, State, Region back-relations)
- Create: `prisma/schema/migrations/20260729000000_user_location_hierarchy/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `User.countryId`, `User.stateId`, `User.regionId` — all `String? @db.Uuid`. Prisma relation names `locationCountry`, `locationState`, `locationRegion`.

- [ ] **Step 1: Add the columns to the User model**

In `prisma/schema/users.prisma`, inside `model User`, immediately after the existing `country` line:

```prisma
  country           String?
  // Normalised location. `country` above stays as the free-text profile value
  // (AttendanceService resolves a timezone from it); these three are the
  // authoritative reference used for geographic scope filtering. Nullable
  // because a user may not have been normalised yet, or may sit above the
  // granularity we hold — a country with no states still has a null stateId.
  countryId         String?        @db.Uuid
  stateId           String?        @db.Uuid
  regionId          String?        @db.Uuid
```

Then in the relations block of `model User` (after the existing relation fields, before the `@@index` lines):

```prisma
  locationCountry Country? @relation("UserLocationCountry", fields: [countryId], references: [id], onDelete: SetNull)
  locationState   State?   @relation("UserLocationState", fields: [stateId], references: [id], onDelete: SetNull)
  locationRegion  Region?  @relation("UserLocationRegion", fields: [regionId], references: [id], onDelete: SetNull)
```

And add these indexes alongside the model's existing ones:

```prisma
  @@index([countryId])
  @@index([stateId])
  @@index([regionId])
```

- [ ] **Step 2: Add back-relations to the geography models**

In `prisma/schema/rbac.prisma`, add one line to each model's relation block:

`model Country` — after `roleScopes RoleScope[]`:
```prisma
  locatedUsers User[] @relation("UserLocationCountry")
```

`model State` — after `roleScopes RoleScope[]`:
```prisma
  locatedUsers User[] @relation("UserLocationState")
```

`model Region` — after `roleScopes RoleScope[]`:
```prisma
  locatedUsers User[] @relation("UserLocationRegion")
```

- [ ] **Step 3: Write the migration SQL**

Create `prisma/schema/migrations/20260729000000_user_location_hierarchy/migration.sql`:

```sql
-- Normalised user location for geographic scope filtering.
-- Nullable with no default: adding a nullable column without a default is a
-- catalogue-only change in Postgres, so this does not rewrite or long-lock the
-- users table. Backfill runs separately (see UserLocationService.backfill).
ALTER TABLE "users" ADD COLUMN "countryId" UUID;
ALTER TABLE "users" ADD COLUMN "stateId" UUID;
ALTER TABLE "users" ADD COLUMN "regionId" UUID;

-- ON DELETE SET NULL: removing a region must not delete the people in it.
ALTER TABLE "users" ADD CONSTRAINT "users_countryId_fkey"
  FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_stateId_fkey"
  FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Scope filters query these directly; without indexes every scoped list is a
-- full scan of users.
CREATE INDEX "users_countryId_idx" ON "users"("countryId");
CREATE INDEX "users_stateId_idx" ON "users"("stateId");
CREATE INDEX "users_regionId_idx" ON "users"("regionId");
```

- [ ] **Step 4: Regenerate the client and verify it compiles**

Run:
```bash
npx prisma generate && npx tsc --noEmit -p tsconfig.json
```
Expected: generate succeeds, tsc prints nothing.

- [ ] **Step 5: Verify the full suite is still green**

Run: `npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"`
Expected: `400 passed, 400 total` / `4540 passed, 4540 total`. The schema change alone must break nothing.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema/users.prisma prisma/schema/rbac.prisma prisma/schema/migrations/20260729000000_user_location_hierarchy
git commit -m "feat(rbac): add normalised user location columns for geographic scope"
```

---

## Task 2: UserLocationService — resolution and backfill

**Files:**
- Create: `src/modules/organization/services/user-location.service.ts`
- Create: `src/modules/organization/services/user-location.service.spec.ts`
- Modify: `src/modules/organization/organization.module.ts`

**Interfaces:**
- Consumes: `User.countryId/stateId/regionId` from Task 1.
- Produces:
  - `UserLocationService.assignLocation(userId: string, input: { countryId?: string | null; stateId?: string | null; regionId?: string | null }): Promise<{ userId: string; countryId: string | null; stateId: string | null; regionId: string | null }>`
  - `UserLocationService.getLocation(userId: string): Promise<{ userId: string; countryId: string | null; countryCode: string | null; stateId: string | null; stateCode: string | null; regionId: string | null; regionCode: string | null }>`
  - `UserLocationService.backfillFromProfileCountry(): Promise<{ scanned: number; matched: number; skipped: number }>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/organization/services/user-location.service.spec.ts`:

```typescript
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { UserLocationService } from './user-location.service';

describe('UserLocationService', () => {
  let service: UserLocationService;

  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    country: { findUnique: jest.fn(), findMany: jest.fn() },
    state: { findUnique: jest.fn() },
    region: { findUnique: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserLocationService(prisma as unknown as PrismaService);
  });

  describe('assignLocation', () => {
    it('stores a full country/state/region assignment', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.region.findUnique.mockResolvedValue({ id: 'r-1', stateId: 's-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });

      const result = await service.assignLocation('u-1', {
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });

      expect(result).toEqual({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });
    });

    it('rejects a state that does not belong to the given country', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-OTHER' });

      await expect(
        service.assignLocation('u-1', { countryId: 'c-1', stateId: 's-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a region that does not belong to the given state', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.country.findUnique.mockResolvedValue({ id: 'c-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.region.findUnique.mockResolvedValue({ id: 'r-1', stateId: 's-OTHER' });

      await expect(
        service.assignLocation('u-1', { countryId: 'c-1', stateId: 's-1', regionId: 'r-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('derives the country from the state when only a state is given', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.state.findUnique.mockResolvedValue({ id: 's-1', countryId: 'c-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: null,
      });

      const result = await service.assignLocation('u-1', { stateId: 's-1' });

      // A state implies its country; storing it saves every country-scoped
      // query from having to join upward.
      expect(result.countryId).toBe('c-1');
    });

    it('clears the location when all three are explicitly null', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        countryId: null,
        stateId: null,
        regionId: null,
      });

      const result = await service.assignLocation('u-1', {
        countryId: null,
        stateId: null,
        regionId: null,
      });

      expect(result).toEqual({
        userId: 'u-1',
        countryId: null,
        stateId: null,
        regionId: null,
      });
    });

    it('rejects an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.assignLocation('ghost', { countryId: 'c-1' })).rejects.toThrow();
    });
  });

  describe('backfillFromProfileCountry', () => {
    it('matches a profile country by ISO code', async () => {
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1', country: 'IN' }]);
      prisma.user.update.mockResolvedValue({});

      const result = await service.backfillFromProfileCountry();

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { countryId: 'c-1' },
      });
      expect(result).toEqual({ scanned: 1, matched: 1, skipped: 0 });
    });

    it('matches a profile country by full name, case-insensitively', async () => {
      // `User.country` is free text — clients send "India" as often as "IN".
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1', country: 'india' }]);
      prisma.user.update.mockResolvedValue({});

      const result = await service.backfillFromProfileCountry();

      expect(result.matched).toBe(1);
    });

    it('skips a profile country it cannot match rather than guessing', async () => {
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-1', country: 'Atlantis' }]);

      const result = await service.backfillFromProfileCountry();

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(result).toEqual({ scanned: 1, matched: 0, skipped: 1 });
    });

    it('never overwrites a location that has already been set', async () => {
      prisma.country.findMany.mockResolvedValue([{ id: 'c-1', code: 'IN', name: 'India' }]);
      // The query filters on countryId: null, so an assigned user is never read.
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.backfillFromProfileCountry();

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { countryId: null, country: { not: null } } }),
      );
      expect(result.matched).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/organization/services/user-location.service.spec.ts`
Expected: FAIL — `Cannot find module './user-location.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/organization/services/user-location.service.ts`:

```typescript
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface AssignLocationInput {
  countryId?: string | null;
  stateId?: string | null;
  regionId?: string | null;
}

export interface UserLocation {
  userId: string;
  countryId: string | null;
  stateId: string | null;
  regionId: string | null;
}

export interface UserLocationDetail extends UserLocation {
  countryCode: string | null;
  stateCode: string | null;
  regionCode: string | null;
}

/**
 * Owns a user's normalised location — the reference geographic scope filtering
 * reads.
 *
 * Kept separate from the free-text `User.country` profile field, which stays a
 * self-reported value used for timezone resolution. Conflating the two would
 * mean a user editing their profile could move themselves out of an official's
 * territory.
 */
@Injectable()
export class UserLocationService {
  private readonly logger = new Logger(UserLocationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sets a user's location, validating that the hierarchy is internally
   * consistent — a region must sit in the given state, a state in the given
   * country. An inconsistent assignment would make a user visible to one scope
   * and invisible to its parent.
   */
  async assignLocation(userId: string, input: AssignLocationInput): Promise<UserLocation> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found`);
    }

    let countryId = input.countryId ?? null;
    let stateId = input.stateId ?? null;
    const regionId = input.regionId ?? null;

    if (regionId) {
      const region = await this.prisma.region.findUnique({ where: { id: regionId } });
      if (!region) {
        throw new BadRequestException(`Region '${regionId}' not found`);
      }
      if (stateId && region.stateId !== stateId) {
        throw new BadRequestException(
          `Region '${regionId}' does not belong to state '${stateId}'`,
        );
      }
      stateId = stateId ?? region.stateId;
    }

    if (stateId) {
      const state = await this.prisma.state.findUnique({ where: { id: stateId } });
      if (!state) {
        throw new BadRequestException(`State '${stateId}' not found`);
      }
      if (countryId && state.countryId !== countryId) {
        throw new BadRequestException(
          `State '${stateId}' does not belong to country '${countryId}'`,
        );
      }
      // A state implies its country; storing it saves every country-scoped query
      // from having to join upward.
      countryId = countryId ?? state.countryId;
    }

    if (countryId) {
      const country = await this.prisma.country.findUnique({ where: { id: countryId } });
      if (!country) {
        throw new BadRequestException(`Country '${countryId}' not found`);
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { countryId, stateId, regionId },
    });

    return {
      userId: updated.id,
      countryId: updated.countryId,
      stateId: updated.stateId,
      regionId: updated.regionId,
    };
  }

  /** A user's location with human-readable codes for display. */
  async getLocation(userId: string): Promise<UserLocationDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { locationCountry: true, locationState: true, locationRegion: true },
    });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found`);
    }

    return {
      userId: user.id,
      countryId: user.countryId,
      countryCode: user.locationCountry?.code ?? null,
      stateId: user.stateId,
      stateCode: user.locationState?.code ?? null,
      regionId: user.regionId,
      regionCode: user.locationRegion?.code ?? null,
    };
  }

  /**
   * Seeds `countryId` from the free-text `User.country` profile value.
   *
   * Country is the only level recoverable this way — nothing in the existing
   * data records a user's state or region, so those stay null until set
   * explicitly. Additive and idempotent: it only touches users whose countryId
   * is still null, so re-running it can never overwrite a curated assignment.
   *
   * Unmatched values are skipped rather than guessed. A wrong country here puts
   * a user in the wrong official's territory, which is worse than leaving them
   * unassigned and visible through the migration fallback.
   */
  async backfillFromProfileCountry(): Promise<{
    scanned: number;
    matched: number;
    skipped: number;
  }> {
    const countries = await this.prisma.country.findMany({
      select: { id: true, code: true, name: true },
    });

    const byKey = new Map<string, string>();
    for (const country of countries) {
      byKey.set(country.code.trim().toUpperCase(), country.id);
      byKey.set(country.name.trim().toUpperCase(), country.id);
    }

    const users = await this.prisma.user.findMany({
      where: { countryId: null, country: { not: null } },
      select: { id: true, country: true },
    });

    let matched = 0;
    let skipped = 0;

    for (const user of users) {
      const key = (user.country ?? '').trim().toUpperCase();
      const countryId = byKey.get(key);
      if (!countryId) {
        skipped++;
        continue;
      }
      await this.prisma.user.update({ where: { id: user.id }, data: { countryId } });
      matched++;
    }

    this.logger.log(
      `User location backfill: scanned ${users.length}, matched ${matched}, skipped ${skipped}`,
    );
    return { scanned: users.length, matched, skipped };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/organization/services/user-location.service.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Register the service**

In `src/modules/organization/organization.module.ts`, add the import and put `UserLocationService` in both `providers` and `exports`:

```typescript
import { UserLocationService } from './services/user-location.service';
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"`
Expected: tsc silent; `401 passed, 401 total` suites.

```bash
git add src/modules/organization
git commit -m "feat(organization): add UserLocationService with validation and country backfill"
```

---

## Task 3: Exact scope filtering in WorkforceScopeService

**Files:**
- Modify: `src/modules/mobile-workforce/services/workforce-scope.service.ts` (full rewrite of the resolution logic)
- Modify: `src/modules/mobile-workforce/services/workforce-scope.service.spec.ts` (full rewrite)
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts` (consume the new filter)

**Interfaces:**
- Consumes: `UserLocationService` columns from Task 1; `GeographicScopeResolver.getUserScopes` (unchanged).
- Produces:
  - `WorkforceScopeService.userScopeFilter(userId: string): Promise<UserScopeFilter>` where `type UserScopeFilter = Record<string, never> | { OR: Array<Record<string, unknown>> }`
  - `WorkforceScopeService.describeScope(userId: string): Promise<{ isUnrestricted: boolean; predicates: Array<{ scopeType: string; targetId: string }> }>`
  - `resolveCountryCodes` is **removed**. Task 4 updates its only other caller.

- [ ] **Step 1: Rewrite the test**

Replace the whole body of `src/modules/mobile-workforce/services/workforce-scope.service.spec.ts`:

```typescript
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { WorkforceScopeService } from './workforce-scope.service';

/**
 * Geographic scope decides what an operational role can see. Too wide leaks
 * another territory's users; too narrow leaves a manager unable to work.
 */
describe('WorkforceScopeService.userScopeFilter', () => {
  let service: WorkforceScopeService;

  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks resets calls but keeps implementations, so the default has
    // to be re-established here or a role set from one test leaks into the next.
    roles.getRoleNames.mockResolvedValue(['COUNTRY_MANAGER']);
    service = new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
    );
  });

  it('matches a region scope on regionId exactly', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: 'r-1' }]);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({
      OR: [{ regionId: 'r-1' }],
    });
  });

  it('matches a state scope on stateId, and on its country for un-normalised users', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'STATE', stateId: 's-1', countryId: 'c-1' },
    ]);

    // The second clause is the migration bridge: a user with no stateId yet is
    // still visible to the official responsible for their country, so nobody
    // loses access while location data is being filled in.
    await expect(service.userScopeFilter('official-1')).resolves.toEqual({
      OR: [{ stateId: 's-1' }, { stateId: null, countryId: 'c-1' }],
    });
  });

  it('matches a country scope on countryId', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-1' }]);

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-1' }],
    });
  });

  it('unions several scopes', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'COUNTRY', countryId: 'c-1' },
      { scopeType: 'REGION', regionId: 'r-9' },
    ]);

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-1' }, { regionId: 'r-9' }],
    });
  });

  it('de-duplicates identical predicates', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'COUNTRY', countryId: 'c-1' },
      { scopeType: 'COUNTRY', countryId: 'c-1' },
    ]);

    const filter = await service.userScopeFilter('cm-1');

    expect(filter).toEqual({ OR: [{ countryId: 'c-1' }] });
  });

  it('returns an unrestricted filter for a GLOBAL scope', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'GLOBAL' }]);

    await expect(service.userScopeFilter('bd-1')).resolves.toEqual({});
  });

  it('returns an unrestricted filter for platform staff', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-1' }]);

    await expect(service.userScopeFilter('admin-1')).resolves.toEqual({});
  });

  it('matches nothing when no scope is assigned', async () => {
    scopes.getUserScopes.mockResolvedValue([]);

    // An empty OR matches no rows. Returning {} here would hand an unscoped
    // operator the entire platform.
    await expect(service.userScopeFilter('unscoped-1')).resolves.toEqual({ OR: [] });
  });

  it('ignores a scope row missing the id its type requires', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: null }]);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({ OR: [] });
  });
});

describe('WorkforceScopeService.describeScope', () => {
  let service: WorkforceScopeService;
  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRoleNames.mockResolvedValue(['OFFICIAL']);
    service = new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
    );
  });

  it('reports the exact predicates in force', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'STATE', stateId: 's-1' }]);

    await expect(service.describeScope('official-1')).resolves.toEqual({
      isUnrestricted: false,
      predicates: [{ scopeType: 'STATE', targetId: 's-1' }],
    });
  });

  it('reports unrestricted for platform staff', async () => {
    roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    scopes.getUserScopes.mockResolvedValue([]);

    await expect(service.describeScope('sa-1')).resolves.toEqual({
      isUnrestricted: true,
      predicates: [],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/mobile-workforce/services/workforce-scope.service.spec.ts`
Expected: FAIL — the constructor still takes three arguments and `userScopeFilter` returns the old `{ country: { in: [...] } }` shape.

- [ ] **Step 3: Rewrite the service**

Replace `src/modules/mobile-workforce/services/workforce-scope.service.ts` entirely:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';

/** Roles that see the whole platform regardless of any scope rows they hold. */
const UNRESTRICTED_ROLES = ['SUPER_ADMIN', 'ADMIN'];

/** `{}` matches every row; `{ OR: [] }` matches none. */
export type UserScopeFilter = Record<string, never> | { OR: Array<Record<string, unknown>> };

/**
 * Turns a user's geographic scope assignments into an exact Prisma filter.
 *
 * A scope matches on the id at its own level — a region scope on `regionId`, a
 * state scope on `stateId` — so an Official sees their state and not the
 * country around it.
 *
 * **Migration bridge.** A state or region scope also matches users who have no
 * value at that level but do sit in the right country. Location is backfilled
 * to country granularity only (nothing in the old data records a state), so
 * without this clause every official would see nobody the moment this shipped.
 * The clause narrows itself automatically: once a user is assigned a state they
 * stop matching it and match the exact predicate instead. Remove it when
 * `stateId` coverage is complete.
 */
@Injectable()
export class WorkforceScopeService {
  private readonly logger = new Logger(WorkforceScopeService.name);

  constructor(
    private readonly scopes: GeographicScopeResolver,
    private readonly roles: RoleResolver,
  ) {}

  private async isUnrestricted(userId: string): Promise<boolean> {
    const roleNames = await this.roles.getRoleNames(userId);
    if (roleNames.some((name) => UNRESTRICTED_ROLES.includes(name))) return true;

    const assignments = await this.scopes.getUserScopes(userId);
    return assignments.some((scope) => scope.scopeType === 'GLOBAL');
  }

  /**
   * A Prisma `where` fragment for user queries.
   *
   * `{}` means unrestricted. `{ OR: [] }` means *nothing* — an operational role
   * with no scope assigned sees no data, which is the safe reading. Returning
   * `{}` there would silently hand them the entire platform.
   */
  async userScopeFilter(userId: string): Promise<UserScopeFilter> {
    if (await this.isUnrestricted(userId)) return {};

    const assignments = await this.scopes.getUserScopes(userId);
    const clauses: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    const push = (clause: Record<string, unknown>) => {
      const key = JSON.stringify(clause);
      if (seen.has(key)) return;
      seen.add(key);
      clauses.push(clause);
    };

    for (const scope of assignments) {
      if (scope.scopeType === 'COUNTRY' && scope.countryId) {
        push({ countryId: scope.countryId });
      } else if (scope.scopeType === 'STATE' && scope.stateId) {
        push({ stateId: scope.stateId });
        // Migration bridge — see the class comment.
        if (scope.countryId) push({ stateId: null, countryId: scope.countryId });
      } else if (scope.scopeType === 'REGION' && scope.regionId) {
        push({ regionId: scope.regionId });
      }
    }

    return { OR: clauses };
  }

  /** The predicates in force, for display in the mobile console header. */
  async describeScope(userId: string): Promise<{
    isUnrestricted: boolean;
    predicates: Array<{ scopeType: string; targetId: string }>;
  }> {
    if (await this.isUnrestricted(userId)) {
      return { isUnrestricted: true, predicates: [] };
    }

    const assignments = await this.scopes.getUserScopes(userId);
    const predicates: Array<{ scopeType: string; targetId: string }> = [];

    for (const scope of assignments) {
      const targetId =
        scope.scopeType === 'COUNTRY'
          ? scope.countryId
          : scope.scopeType === 'STATE'
            ? scope.stateId
            : scope.scopeType === 'REGION'
              ? scope.regionId
              : null;
      if (targetId) predicates.push({ scopeType: scope.scopeType, targetId });
    }

    return { isUnrestricted: false, predicates };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/mobile-workforce/services/workforce-scope.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce/services/workforce-scope.service.ts src/modules/mobile-workforce/services/workforce-scope.service.spec.ts
git commit -m "feat(mobile): filter workforce queries by exact geographic scope"
```

---

## Task 4: Wire the new filter through MobileWorkforceService

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Modify: `src/modules/mobile-workforce/mobile-workforce.module.ts` (no dependency change; verify only)

**Interfaces:**
- Consumes: `WorkforceScopeService.userScopeFilter` and `describeScope` from Task 3. `resolveCountryCodes` no longer exists.
- Produces: no signature changes to `MobileWorkforceService`.

- [ ] **Step 1: Replace the scope call in `myScope`**

In `src/modules/mobile-workforce/services/mobile-workforce.service.ts`, replace the whole `myScope` method:

```typescript
  /** What geography am I responsible for? Drives the client's header and filters. */
  async myScope(userId: string) {
    const [assignments, described] = await Promise.all([
      this.scopes.getUserScopes(userId),
      this.scope.describeScope(userId),
    ]);

    return {
      assignments: assignments.map((s) => ({
        role: s.roleName,
        scopeType: s.scopeType,
        countryCode: s.countryCode ?? null,
        stateCode: s.stateCode ?? null,
        regionCode: s.regionCode ?? null,
      })),
      isUnrestricted: described.isUnrestricted,
      predicates: described.predicates,
    };
  }
```

- [ ] **Step 2: Replace the moderation queue's country lookup**

The old implementation resolved country codes, then loaded every matching user id to filter reports. Replace the whole `moderationQueue` method:

```typescript
  /**
   * Moderation queue for my scope.
   *
   * Reports carry no geography, so they are narrowed by the reporter's location
   * — the closest honest proxy available. The reporter set is resolved through
   * the same scope filter as every other query, so the queue and the user list
   * can never disagree about who is in territory.
   */
  async moderationQueue(userId: string, limit = 25) {
    const scopeWhere = await this.scope.userScopeFilter(userId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    let reporterFilter: Record<string, unknown> = {};
    if (!isUnrestricted) {
      const inScope = await this.prisma.user.findMany({
        where: scopeWhere,
        select: { id: true },
      });
      reporterFilter = { reporterId: { in: inScope.map((u) => u.id) } };
    }

    const where = { status: 'PENDING' as const, ...reporterFilter };

    const [audioReports, videoReports] = await Promise.all([
      this.prisma.roomReport.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 100),
      }),
      this.prisma.videoRoomReport.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 100),
      }),
    ]);

    return { audioRoomReports: audioReports, videoRoomReports: videoReports };
  }
```

- [ ] **Step 3: Add the location fields to the scoped user list**

In the same file, in `users()`, extend the `select` so the console can show where each user sits:

```typescript
        select: {
          id: true,
          username: true,
          email: true,
          status: true,
          country: true,
          countryId: true,
          stateId: true,
          regionId: true,
          createdAt: true,
        },
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"`
Expected: tsc silent, all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce
git commit -m "feat(mobile): consume exact scope filter in workforce read models"
```

---

## Task 5: Location APIs and permissions

**Files:**
- Create: `src/modules/organization/dto/user-location.dto.ts`
- Create: `src/modules/organization/controllers/user-location.controller.ts`
- Modify: `src/modules/organization/organization.module.ts`
- Modify: `src/modules/authorization/constants/rbac-permissions.constants.ts`

**Interfaces:**
- Consumes: `UserLocationService` from Task 2.
- Produces: `GET /organization/users/:userId/location`, `PUT /organization/users/:userId/location`, `POST /organization/users/location/backfill`.

- [ ] **Step 1: Write the DTOs**

Create `src/modules/organization/dto/user-location.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class AssignUserLocationDto {
  @ApiPropertyOptional({ description: 'Country id; null clears it' })
  @IsOptional()
  @IsUUID()
  countryId?: string | null;

  @ApiPropertyOptional({ description: 'State id; must belong to the country' })
  @IsOptional()
  @IsUUID()
  stateId?: string | null;

  @ApiPropertyOptional({ description: 'Region id; must belong to the state' })
  @IsOptional()
  @IsUUID()
  regionId?: string | null;
}
```

- [ ] **Step 2: Add the permissions**

In `src/modules/authorization/constants/rbac-permissions.constants.ts`, add two entries to `DEFAULT_PERMISSIONS` immediately before the `// Mobile operational surfaces` comment:

```typescript
  {
    code: 'user.location.view',
    module: 'organization',
    action: 'view',
    category: 'USER',
    displayName: 'View User Location',
    description: "Read a user's assigned country, state and region",
  },
  {
    code: 'user.location.assign',
    module: 'organization',
    action: 'assign',
    category: 'USER',
    displayName: 'Assign User Location',
    description: "Set a user's country, state and region for geographic scoping",
  },
```

Then grant both to `ADMIN` by adding them next to the existing `'user.role.assign',` line in `DEFAULT_ROLE_PERMISSIONS.ADMIN`:

```typescript
    'user.location.view',
    'user.location.assign',
```

Grant read-only to the workforce roles — add `'user.location.view',` to `COUNTRY_MANAGER`, `OFFICIAL` and `MODERATOR` next to their existing `'mobile.workforce.view',` line. They must **not** get `user.location.assign`: moving a user between territories is an ADMIN decision, and letting an official reassign people would let them edit their own workload.

- [ ] **Step 3: Write the controller**

Create `src/modules/organization/controllers/user-location.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AssignUserLocationDto } from '../dto/user-location.dto';
import { UserLocationService } from '../services/user-location.service';

/**
 * Assigns users to the geographic hierarchy that scope filtering reads.
 *
 * Assignment is ADMIN-only: an official who could move users between territories
 * could edit their own workload, and could pull an account out of a peer's view.
 */
@ApiTags('Organization — User Location')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('organization/users')
export class UserLocationController {
  constructor(private readonly service: UserLocationService) {}

  @ApiOperation({ summary: "Read a user's assigned location" })
  @ApiResponse({ status: 200, description: 'Country, state and region with codes' })
  @RequirePermissions('user.location.view')
  @Get(':userId/location')
  get(@Param('userId') userId: string) {
    return this.service.getLocation(userId);
  }

  @ApiOperation({ summary: "Set a user's location" })
  @ApiResponse({ status: 200, description: 'Updated location' })
  @ApiResponse({ status: 400, description: 'Hierarchy is inconsistent' })
  @RequirePermissions('user.location.assign')
  @Put(':userId/location')
  assign(@Param('userId') userId: string, @Body() dto: AssignUserLocationDto) {
    return this.service.assignLocation(userId, dto);
  }

  @ApiOperation({ summary: 'Backfill countryId from the free-text profile country' })
  @ApiResponse({ status: 200, description: 'Scanned, matched and skipped counts' })
  @RequirePermissions('user.location.assign')
  @Post('location/backfill')
  backfill() {
    return this.service.backfillFromProfileCountry();
  }
}
```

- [ ] **Step 4: Register the controller**

In `src/modules/organization/organization.module.ts`, import `UserLocationController` and add it to the `controllers` array.

- [ ] **Step 5: Write the access test**

Create `src/modules/organization/user-location-access.spec.ts`:

```typescript
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  type SystemRoleType,
} from 'src/modules/authorization/constants/rbac-permissions.constants';
import { UserLocationController } from './controllers/user-location.controller';

const reflector = new Reflector();

describe('user location access', () => {
  it('defines both location permissions', () => {
    const codes = DEFAULT_PERMISSIONS.map((p) => p.code);
    expect(codes).toContain('user.location.view');
    expect(codes).toContain('user.location.assign');
  });

  it('gates reads on user.location.view', () => {
    expect(
      reflector.get<string[]>(PERMISSIONS_KEY, UserLocationController.prototype.get),
    ).toEqual(['user.location.view']);
  });

  it('gates assignment on user.location.assign', () => {
    expect(
      reflector.get<string[]>(PERMISSIONS_KEY, UserLocationController.prototype.assign),
    ).toEqual(['user.location.assign']);
  });

  it('gates the backfill on user.location.assign', () => {
    expect(
      reflector.get<string[]>(PERMISSIONS_KEY, UserLocationController.prototype.backfill),
    ).toEqual(['user.location.assign']);
  });

  it('grants ADMIN both view and assign', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('user.location.view');
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('user.location.assign');
  });

  it.each(['COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR'])(
    'gives %s read access but never assignment',
    (role) => {
      const granted = DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType];
      expect(granted).toContain('user.location.view');
      // Reassigning users would let an official edit their own territory.
      expect(granted).not.toContain('user.location.assign');
    },
  );
});
```

- [ ] **Step 6: Run and commit**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"`
Expected: tsc silent, all suites pass.

```bash
git add src/modules/organization src/modules/authorization/constants/rbac-permissions.constants.ts
git commit -m "feat(organization): add user location APIs and permissions"
```

---

## Task 6: Wire the backfill into the seed script

**Files:**
- Modify: `prisma/seed-rbac.ts`

**Interfaces:**
- Consumes: `UserLocationService.backfillFromProfileCountry` from Task 2.
- Produces: nothing.

- [ ] **Step 1: Call the backfill from the seed**

In `prisma/seed-rbac.ts`, immediately after the existing legacy-role backfill block, add:

```typescript
  // Seed countryId from the free-text profile country. Additive and idempotent —
  // only touches users whose countryId is still null. Pass --skip-backfill to
  // seed without it.
  if (!process.argv.includes('--skip-backfill')) {
    const locations = new UserLocationService(prisma as unknown as PrismaService);
    const { scanned, matched, skipped } = await locations.backfillFromProfileCountry();
    console.log(
      `User location backfill: scanned ${scanned}, matched ${matched}, skipped ${skipped}.`,
    );
  }
```

And add the import at the top:

```typescript
import { UserLocationService } from '../src/modules/organization/services/user-location.service';
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: silent.

```bash
git add prisma/seed-rbac.ts
git commit -m "feat(prisma): run user location backfill from the RBAC seed"
```

---

## Task 7: Normalised geography on ranking and event definitions

**Files:**
- Modify: `prisma/schema/enterprise_rankings.prisma` (RankingDefinition)
- Modify: `prisma/schema/enterprise_events.prisma` (EventDefinition)
- Modify: `prisma/schema/rbac.prisma` (Country/Region back-relations)
- Create: `prisma/schema/migrations/20260729010000_normalised_domain_geography/migration.sql`

**Interfaces:**
- Consumes: `Country`/`Region` tables.
- Produces: `RankingDefinition.countryId`, `RankingDefinition.regionId`, `EventDefinition.countryId`, `EventDefinition.regionId` — all `String? @db.Uuid`.

- [ ] **Step 1: Add columns to RankingDefinition**

In `prisma/schema/enterprise_rankings.prisma`, inside `model RankingDefinition`, after the existing `region String?` line:

```prisma
  // Normalised geography. The `country`/`region` strings above stay for display
  // labels; these are what categorisation and filtering read.
  countryId       String?  @db.Uuid
  regionId        String?  @db.Uuid
```

Add relations before the `@@index` block:

```prisma
  scopeCountry Country? @relation("RankingScopeCountry", fields: [countryId], references: [id], onDelete: SetNull)
  scopeRegion  Region?  @relation("RankingScopeRegion", fields: [regionId], references: [id], onDelete: SetNull)
```

Add indexes:

```prisma
  @@index([countryId])
  @@index([regionId])
```

- [ ] **Step 2: Add the same columns to EventDefinition**

In `prisma/schema/enterprise_events.prisma`, inside `model EventDefinition`, after the existing `region String?` line:

```prisma
  // Normalised geography — read by eligibility and routing. The strings above
  // are display labels only.
  countryId          String?  @db.Uuid
  regionId           String?  @db.Uuid
```

Relations before the `@@index` block:

```prisma
  scopeCountry Country? @relation("EventScopeCountry", fields: [countryId], references: [id], onDelete: SetNull)
  scopeRegion  Region?  @relation("EventScopeRegion", fields: [regionId], references: [id], onDelete: SetNull)
```

Indexes:

```prisma
  @@index([countryId])
  @@index([regionId])
```

- [ ] **Step 3: Add back-relations**

In `prisma/schema/rbac.prisma`, add to `model Country`:

```prisma
  scopedRankings RankingDefinition[] @relation("RankingScopeCountry")
  scopedEvents   EventDefinition[]   @relation("EventScopeCountry")
```

And to `model Region`:

```prisma
  scopedRankings RankingDefinition[] @relation("RankingScopeRegion")
  scopedEvents   EventDefinition[]   @relation("EventScopeRegion")
```

- [ ] **Step 4: Write the migration**

Create `prisma/schema/migrations/20260729010000_normalised_domain_geography/migration.sql`:

```sql
-- Normalised geography for ranking and event definitions. Free-text country and
-- region columns stay for display labels.
ALTER TABLE "ranking_definitions" ADD COLUMN "countryId" UUID;
ALTER TABLE "ranking_definitions" ADD COLUMN "regionId" UUID;
ALTER TABLE "event_definitions" ADD COLUMN "countryId" UUID;
ALTER TABLE "event_definitions" ADD COLUMN "regionId" UUID;

ALTER TABLE "ranking_definitions" ADD CONSTRAINT "ranking_definitions_countryId_fkey"
  FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ranking_definitions" ADD CONSTRAINT "ranking_definitions_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "event_definitions" ADD CONSTRAINT "event_definitions_countryId_fkey"
  FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "event_definitions" ADD CONSTRAINT "event_definitions_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ranking_definitions_countryId_idx" ON "ranking_definitions"("countryId");
CREATE INDEX "ranking_definitions_regionId_idx" ON "ranking_definitions"("regionId");
CREATE INDEX "event_definitions_countryId_idx" ON "event_definitions"("countryId");
CREATE INDEX "event_definitions_regionId_idx" ON "event_definitions"("regionId");
```

- [ ] **Step 5: Verify and commit**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"`
Expected: generate succeeds, tsc silent, all suites pass unchanged.

```bash
git add prisma/schema
git commit -m "feat(schema): normalise geography on ranking and event definitions"
```

---

## Task 8: Event eligibility reads normalised country

**Files:**
- Modify: `src/modules/enterprise-events/services/event-eligibility.service.ts:47-54`
- Create: `src/modules/enterprise-events/services/event-eligibility.service.spec.ts`

**Interfaces:**
- Consumes: `User.countryId` from Task 1.
- Produces: no signature change to `checkEligibility`.

**Why this is a bug fix, not just a migration.** The current check compares free-text `user.country` against a JSON `allowedCountries` array. A user whose profile says `"India"` fails an event that allows `"IN"`, and a user with no country set fails every geo-restricted event. Matching on `countryId` — resolved through the `Country` table — makes the comparison exact.

- [ ] **Step 1: Write the failing test**

Create `src/modules/enterprise-events/services/event-eligibility.service.spec.ts`:

```typescript
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventEligibilityService } from './event-eligibility.service';

describe('EventEligibilityService country restriction', () => {
  let service: EventEligibilityService;

  const prisma = {
    user: { findUnique: jest.fn() },
    country: { findMany: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EventEligibilityService(prisma as unknown as PrismaService);
  });

  it('admits a user whose normalised country is allowed, whatever their profile text says', async () => {
    // Profile says "India"; the allow-list says "IN". Matching on countryId makes
    // the two agree — string matching silently rejected this user.
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      country: 'India',
      countryId: 'c-in',
    });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-in', code: 'IN' }]);

    const result = await service.checkCountryEligibility('u-1', { allowedCountries: ['IN'] });

    expect(result.eligible).toBe(true);
  });

  it('rejects a user whose normalised country is not on the list', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', country: 'IN', countryId: 'c-in' });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-ae', code: 'AE' }]);

    const result = await service.checkCountryEligibility('u-1', { allowedCountries: ['AE'] });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('not eligible');
  });

  it('rejects a user with no normalised country rather than guessing from profile text', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', country: 'India', countryId: null });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-in', code: 'IN' }]);

    const result = await service.checkCountryEligibility('u-1', { allowedCountries: ['IN'] });

    // Fail closed: an unnormalised user is not silently admitted to a
    // geo-restricted event on the strength of a free-text field.
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('location has not been set');
  });

  it('admits everyone when the event sets no country restriction', async () => {
    const result = await service.checkCountryEligibility('u-1', {});

    expect(result.eligible).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('never reads the free-text country field', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', country: 'IN', countryId: 'c-in' });
    prisma.country.findMany.mockResolvedValue([{ id: 'c-in', code: 'IN' }]);

    await service.checkCountryEligibility('u-1', { allowedCountries: ['IN'] });

    const select = prisma.user.findUnique.mock.calls[0][0].select;
    expect(select).toEqual({ countryId: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/enterprise-events/services/event-eligibility.service.spec.ts`
Expected: FAIL — `checkCountryEligibility` is not a function.

- [ ] **Step 3: Extract and rewrite the check**

In `src/modules/enterprise-events/services/event-eligibility.service.ts`, add this public method to the class:

```typescript
  /**
   * Country restriction, matched on normalised `countryId`.
   *
   * The allow-list is authored as ISO codes, so codes are resolved to ids once
   * and compared by id. Free-text `user.country` is deliberately not read: it is
   * self-reported and unnormalised ("India" vs "IN"), which made this check
   * reject legitimate users and is why it now fails closed instead.
   */
  async checkCountryEligibility(
    userId: string,
    rules: { allowedCountries?: unknown },
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (!rules.allowedCountries || !Array.isArray(rules.allowedCountries)) {
      return { eligible: true };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryId: true },
    });

    if (!user?.countryId) {
      return {
        eligible: false,
        reason: 'Your location has not been set, so country eligibility cannot be confirmed',
      };
    }

    const allowed = await this.prisma.country.findMany({
      where: { code: { in: rules.allowedCountries as string[] } },
      select: { id: true, code: true },
    });

    if (allowed.some((country) => country.id === user.countryId)) {
      return { eligible: true };
    }

    return { eligible: false, reason: 'Your country is not eligible for this event' };
  }
```

Then replace the old inline block (the `// 3. Country / Region restriction` section) with a call to it:

```typescript
    // 3. Country / Region restriction — normalised ids, never profile text.
    const countryCheck = await this.checkCountryEligibility(userId, rules);
    if (!countryCheck.eligible && countryCheck.reason) {
      reasons.push(countryCheck.reason);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/enterprise-events/services/event-eligibility.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/enterprise-events/services/event-eligibility.service.ts src/modules/enterprise-events/services/event-eligibility.service.spec.ts
git commit -m "fix(events): match country eligibility on normalised id, not profile text"
```

---

## Task 9: Lock the single source of truth

**Files:**
- Create: `src/modules/authorization/geography-source-of-truth.spec.ts`

**Interfaces:**
- Consumes: nothing at runtime — this is a static guard over the source tree.
- Produces: nothing.

**Why a source-scanning test.** The rule "free text is never used for authorisation" cannot be enforced by types — `user.country` is a legal string everywhere. A test that reads the source of the authorisation-critical files and fails on a free-text geography reference is the only thing that stops this regressing the next time someone adds a filter.

- [ ] **Step 1: Write the guard test**

Create `src/modules/authorization/geography-source-of-truth.spec.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoleRequestScalarFieldEnum } from '@prisma/client';

const SRC = join(__dirname, '..', '..');

/**
 * Files that make authorisation, routing or scope decisions. None of them may
 * read the free-text geography fields — those are for profile display,
 * timezone resolution and localisation only.
 */
const AUTHORISATION_CRITICAL_FILES = [
  'modules/mobile-workforce/services/workforce-scope.service.ts',
  'modules/mobile-workforce/services/mobile-workforce.service.ts',
  'modules/mobile-partner/services/mobile-partner.service.ts',
  'modules/authorization/services/geographic-scope-resolver.service.ts',
  'modules/authorization/services/permission-resolver.service.ts',
  'modules/authorization/services/role-resolver.service.ts',
  'modules/authorization/services/policy-engine.service.ts',
  'modules/enterprise-events/services/event-eligibility.service.ts',
  'modules/super-admin/services/role-assignment.service.ts',
  'modules/super-admin/services/account-lifecycle.service.ts',
  'modules/organization/services/user-location.service.ts',
  'modules/dashboard-financial/services/dashboard-financial.service.ts',
  'modules/dashboard-operations/services/dashboard-operations.service.ts',
  'modules/dashboard-engagement/services/dashboard-engagement.service.ts',
  'modules/dashboard-moderation/services/dashboard-moderation.service.ts',
  'modules/analytics/services/aggregation.service.ts',
];

/** `user.country`, `.country =`, `country:` — but not `countryId`/`countryCode`. */
const FREE_TEXT_GEOGRAPHY = /\bcountry\b(?!Id|Code|_)/;

describe('normalised geography is the single source of truth', () => {
  it.each(AUTHORISATION_CRITICAL_FILES)('%s does not read free-text geography', (relative) => {
    const source = readFileSync(join(SRC, relative), 'utf8');

    const offending = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // Comments explain why free text is avoided; they are not reads.
      .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//'))
      .filter(({ line }) => FREE_TEXT_GEOGRAPHY.test(line));

    expect(offending).toEqual([]);
  });
});

describe('Role Approval Engine will route on normalised geography', () => {
  it('RoleRequest carries normalised location ids', () => {
    // The module is not built yet. This asserts the schema it will be built on
    // already uses the hierarchy, so approval routing cannot be written against
    // free text later.
    const fields = Object.keys(RoleRequestScalarFieldEnum);

    expect(fields).toEqual(expect.arrayContaining(['countryId', 'stateId', 'regionId']));
    expect(fields).not.toContain('country');
    expect(fields).not.toContain('region');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx jest src/modules/authorization/geography-source-of-truth.spec.ts`
Expected: PASS. If `workforce-scope.service.ts` or `event-eligibility.service.ts` still reference free-text country, Tasks 3 and 8 are incomplete — fix them rather than relaxing the regex.

- [ ] **Step 3: Commit**

```bash
git add src/modules/authorization/geography-source-of-truth.spec.ts
git commit -m "test(rbac): guard normalised geography as the single source of truth"
```

---

## Task 10: Integration and regression verification

**Files:**
- Create: `test/geographic-scope.e2e-spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: nothing.

- [ ] **Step 1: Write the end-to-end workflow test**

Create `test/geographic-scope.e2e-spec.ts`:

```typescript
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

/**
 * The full scope workflow, wired end to end with the real service graph and a
 * stubbed data layer: assign geography → resolve scope → filter a query.
 *
 * Each case is a visibility guarantee an operator depends on, so a regression
 * here is someone either losing their territory or seeing another's.
 */
describe('geographic scope workflow', () => {
  const buildService = (scopeRows: unknown[], roleNames: string[]) => {
    const scopes = { getUserScopes: jest.fn().mockResolvedValue(scopeRows) };
    const roles = { getRoleNames: jest.fn().mockResolvedValue(roleNames) };
    return new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
    );
  };

  it('an Official scoped to a state sees that state, not the whole country', async () => {
    const service = buildService(
      [{ scopeType: 'STATE', stateId: 's-ka', countryId: 'c-in' }],
      ['OFFICIAL'],
    );

    const filter = await service.userScopeFilter('official-1');

    expect(filter).toEqual({
      OR: [{ stateId: 's-ka' }, { stateId: null, countryId: 'c-in' }],
    });
  });

  it('a Moderator scoped to a region sees only that region', async () => {
    const service = buildService([{ scopeType: 'REGION', regionId: 'r-blr' }], ['MODERATOR']);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({
      OR: [{ regionId: 'r-blr' }],
    });
  });

  it('two officials in different states never share a predicate', async () => {
    const ka = buildService([{ scopeType: 'STATE', stateId: 's-ka', countryId: 'c-in' }], [
      'OFFICIAL',
    ]);
    const mh = buildService([{ scopeType: 'STATE', stateId: 's-mh', countryId: 'c-in' }], [
      'OFFICIAL',
    ]);

    const [a, b] = await Promise.all([ka.userScopeFilter('a'), mh.userScopeFilter('b')]);

    expect(a).not.toEqual(b);
    expect(JSON.stringify(a)).toContain('s-ka');
    expect(JSON.stringify(a)).not.toContain('s-mh');
  });

  it('an existing country assignment keeps working unchanged after migration', async () => {
    // Backward compatibility: a COUNTRY scope assigned before this change still
    // resolves to the same visibility it always had.
    const service = buildService(
      [{ scopeType: 'COUNTRY', countryId: 'c-in' }],
      ['COUNTRY_MANAGER'],
    );

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-in' }],
    });
  });

  it('platform staff remain unrestricted', async () => {
    const service = buildService([], ['ADMIN']);

    await expect(service.userScopeFilter('admin-1')).resolves.toEqual({});
  });

  it('an unscoped operational role sees nothing', async () => {
    const service = buildService([], ['MODERATOR']);

    await expect(service.userScopeFilter('mod-2')).resolves.toEqual({ OR: [] });
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx jest test/geographic-scope.e2e-spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 3: Full regression sweep**

Run:
```bash
npx tsc --noEmit -p tsconfig.json && npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"
```
Expected: tsc silent. Suites at **405+**, tests at **4590+**, zero failures. Any failure in `analytics`, `dashboard-*`, `mobile-*`, `super-admin` or `authorization` is a real regression in visibility or permissions — investigate before proceeding, do not adjust the test to pass.

- [ ] **Step 4: Verify the migrations apply cleanly**

Run:
```bash
npx prisma migrate diff --from-migrations prisma/schema/migrations --to-schema-datamodel prisma/schema --shadow-database-url "$SHADOW_DATABASE_URL"
```
Expected: `No difference detected` — the two migrations fully express the schema changes. If it reports a drift, the migration SQL is missing something from the Prisma models.

- [ ] **Step 5: Commit**

```bash
git add test/geographic-scope.e2e-spec.ts
git commit -m "test(rbac): end-to-end geographic scope workflow and regression sweep"
```

---

## Task 11: Frontend-ready lookup and hierarchy contracts

**Files:**
- Create: `src/modules/organization/controllers/geography-lookup.controller.ts`
- Create: `src/modules/organization/dto/geography-lookup.dto.ts`
- Modify: `src/modules/organization/services/organization-hierarchy.service.ts`
- Modify: `src/modules/organization/organization.module.ts`

**Interfaces:**
- Consumes: `CountryService`, `StateService`, `RegionService`, `OrganizationHierarchyService`.
- Produces: `GET /organization/geography/countries`, `GET /organization/geography/countries/:countryId/states`, `GET /organization/geography/states/:stateId/regions`, `GET /organization/geography/tree`.

**Why separate from the SUPER_ADMIN CRUD controller.** The existing 19 routes are management operations gated on `organization.*.manage`, which stays SUPER_ADMIN. The dashboards need *read* lookups to populate cascading Country → State → Region selectors, and ADMIN must be able to use them to assign a user's location. Splitting read from write keeps that permission boundary clean.

- [ ] **Step 1: Write the response DTOs**

Create `src/modules/organization/dto/geography-lookup.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';

/**
 * One selectable geography node. Deliberately flat and stable — the dashboards
 * bind selectors to this shape, so fields may be added but never removed or
 * renamed.
 */
export class GeographyOptionDto {
  @ApiProperty({ description: 'Stable identifier used for assignment' })
  id!: string;

  @ApiProperty({ description: 'Short code, e.g. IN or KA' })
  code!: string;

  @ApiProperty({ description: 'Display name' })
  name!: string;

  @ApiProperty({ description: 'Inactive nodes are shown but not selectable' })
  isActive!: boolean;
}

export class GeographyTreeRegionDto extends GeographyOptionDto {}

export class GeographyTreeStateDto extends GeographyOptionDto {
  @ApiProperty({ type: [GeographyTreeRegionDto] })
  regions!: GeographyTreeRegionDto[];
}

export class GeographyTreeCountryDto extends GeographyOptionDto {
  @ApiProperty({ type: [GeographyTreeStateDto] })
  states!: GeographyTreeStateDto[];
}
```

- [ ] **Step 2: Write the lookup controller**

Create `src/modules/organization/controllers/geography-lookup.controller.ts`:

```typescript
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import {
  GeographyOptionDto,
  GeographyTreeCountryDto,
} from '../dto/geography-lookup.dto';
import { CountryService } from '../services/country.service';
import { OrganizationHierarchyService } from '../services/organization-hierarchy.service';
import { RegionService } from '../services/region.service';
import { StateService } from '../services/state.service';

/**
 * Read-only geography lookups for cascading selectors in the admin consoles.
 *
 * Gated on `organization.hierarchy.view`, which ADMIN already holds — management
 * of the hierarchy stays on the SUPER_ADMIN CRUD routes.
 */
@ApiTags('Organization — Geography Lookup')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('organization.hierarchy.view')
@Controller('organization/geography')
export class GeographyLookupController {
  constructor(
    private readonly countries: CountryService,
    private readonly states: StateService,
    private readonly regions: RegionService,
    private readonly hierarchy: OrganizationHierarchyService,
  ) {}

  @ApiOperation({ summary: 'List countries for a selector' })
  @ApiQuery({ name: 'activeOnly', required: false, description: 'Default true' })
  @ApiResponse({ status: 200, type: [GeographyOptionDto] })
  @Get('countries')
  async listCountries(@Query('activeOnly') activeOnly?: string) {
    const rows = await this.countries.getAllCountries(activeOnly !== 'false');
    return rows.map((c) => ({ id: c.id, code: c.code, name: c.name, isActive: c.isActive }));
  }

  @ApiOperation({ summary: 'List the states of a country' })
  @ApiResponse({ status: 200, type: [GeographyOptionDto] })
  @Get('countries/:countryId/states')
  async listStates(@Param('countryId') countryId: string) {
    const rows = await this.states.getStatesByCountry(countryId);
    return rows.map((s) => ({ id: s.id, code: s.code, name: s.name, isActive: s.isActive }));
  }

  @ApiOperation({ summary: 'List the regions of a state' })
  @ApiResponse({ status: 200, type: [GeographyOptionDto] })
  @Get('states/:stateId/regions')
  async listRegions(@Param('stateId') stateId: string) {
    const rows = await this.regions.getRegionsByState(stateId);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, isActive: r.isActive }));
  }

  @ApiOperation({ summary: 'Full Country → State → Region tree' })
  @ApiResponse({ status: 200, type: [GeographyTreeCountryDto] })
  @Get('tree')
  tree() {
    return this.hierarchy.getFullHierarchy();
  }
}
```

**Note for the implementer:** `StateService.getStatesByCountry`, `RegionService.getRegionsByState` and `OrganizationHierarchyService.getFullHierarchy` may be named differently in the codebase. Open each service, use its real method name, and adjust the mapping to its real return shape. Do not add new service methods if an equivalent already exists.

- [ ] **Step 3: Register the controller**

In `src/modules/organization/organization.module.ts`, import `GeographyLookupController` and add it to `controllers`.

- [ ] **Step 4: Write the contract test**

Create `src/modules/organization/geography-lookup.spec.ts`:

```typescript
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import { GeographyLookupController } from './controllers/geography-lookup.controller';

const reflector = new Reflector();

describe('geography lookup contract', () => {
  it('is gated on hierarchy view, which ADMIN holds', () => {
    expect(reflector.get<string[]>(PERMISSIONS_KEY, GeographyLookupController)).toEqual([
      'organization.hierarchy.view',
    ]);
  });

  it('exposes the four lookups the dashboards bind to', () => {
    const handlers = Object.getOwnPropertyNames(GeographyLookupController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(new Set(handlers)).toEqual(
      new Set(['listCountries', 'listStates', 'listRegions', 'tree']),
    );
  });
});
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest src/modules/organization`
Expected: tsc silent, organization suites pass.

```bash
git add src/modules/organization
git commit -m "feat(organization): add geography lookup contracts for the admin dashboards"
```

---

## Task 12: Final repository-wide verification

**Files:** none created. This is a verification gate.

- [ ] **Step 1: Confirm no authorisation path reads free-text geography**

Run:
```bash
grep -rnP "\buser\??\.(country|region)\b(?!Id|Code)" src/ --include="*.ts" | grep -v "\.spec\.ts"
```

Expected — exactly these three lines, each a permitted use:
- `attendance/services/attendance.service.ts` — timezone resolution
- `super-admin/services/user-query.service.ts` — profile display
- `super-admin/services/workforce-query.service.ts` — profile display

Any other hit is a violation. `enterprise-events/services/event-eligibility.service.ts` must **not** appear — if it does, Task 8 is incomplete.

- [ ] **Step 2: Confirm no query filters on free-text geography for authorisation**

Run:
```bash
grep -rnP "where[^\n]*\bcountry\b(?!Id|Code)" src/ --include="*.ts" | grep -v "\.spec\.ts"
```

Expected — exactly one hit: `payments/services/coin-package.service.ts`, filtering the storefront catalogue by a **client-supplied** country. That is localisation, not authorisation: it never reads the user record, so it cannot grant or deny anyone access to anything. Leave it.

- [ ] **Step 3: Confirm the normalised columns are the ones doing the work**

Run:
```bash
grep -rn "countryId\|stateId\|regionId" src/modules/mobile-workforce src/modules/enterprise-events/services/event-eligibility.service.ts --include="*.ts" | grep -v "\.spec\.ts" | wc -l
```
Expected: a non-zero count, proving the scope and eligibility paths now read normalised ids.

- [ ] **Step 4: Full suite and typecheck**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest --silent 2>&1 | grep -E "Tests:|Test Suites:"`
Expected: tsc silent, **407+ suites / 4600+ tests**, zero failures.

- [ ] **Step 5: Confirm Swagger documents every new surface**

Run: `npm run start:dev` and open `/api/docs`. Confirm these tags are present and every route documents its parameters and responses:
- `Organization — User Location` (3 routes)
- `Organization — Geography Lookup` (4 routes)
- `Mobile — Workforce` (4 routes, scope-narrowed)

- [ ] **Step 6: Commit the verification record**

```bash
git commit --allow-empty -m "chore(rbac): verify normalised geography is the single source of truth"
```

---

## Rollout Order

The migration is safe to deploy ahead of the code, and the code is safe to deploy before the backfill runs. That gives four independent steps, each reversible on its own:

1. **`npx prisma migrate deploy`** — adds three nullable columns and three indexes. No table rewrite, no lock of consequence. Old code ignores the columns entirely.
2. **Deploy the application.** With every `countryId` still null, `{ OR: [{ countryId: 'c-1' }] }` matches nobody, so scoped operators temporarily see an empty list. Deploy during a quiet window, or run step 3 first.
3. **Run the backfill** — `npx ts-node prisma/seed-rbac.ts`, or `POST /organization/users/location/backfill`. Country-scoped operators regain their full view; state and region operators see their country through the migration bridge.
4. **Assign states and regions** via `PUT /organization/users/:userId/location`. Each user assigned narrows automatically from the bridge clause to their exact predicate.

Once `stateId` coverage is complete, delete the bridge clause in `userScopeFilter` (the two lines under "Migration bridge") and its test. Until then, keep it — removing it early silently empties every official's console.

**One behaviour change lands immediately at step 2, before any backfill:** geo-restricted events start failing closed for users with no `countryId` (Task 8). That is deliberate — the old behaviour admitted or rejected people by string-matching self-reported text — but if any live event carries `allowedCountries`, run the backfill first so those users keep qualifying.

## Verified Non-Regression Surface

These consume geographic scope or user location and must behave identically after migration. Task 10's sweep covers them; investigate any failure rather than adjusting the test.

| Surface | Why it is at risk | Expected after migration |
|---|---|---|
| `AttendanceService` | Reads free-text `country` for timezone | Unchanged — that column is untouched |
| `UsersService` profile + search | Reads/writes free-text `country` | Unchanged — display and discovery only |
| `MobileWorkforceService` | Consumes the scope filter | Narrower and exact; country scopes identical |
| `super-admin-organization.controller` | 19 Country/State/Region CRUD routes | Unchanged; still SUPER_ADMIN-gated |
| `dashboard-*` modules | Read-only aggregates, no geography | Unchanged — confirmed by grep, they never read country |
| `analytics` aggregations | No geography predicate | Unchanged |
| `RankingAggregationService` | Uses free-text `country` label | Unchanged this pass; `countryId` added alongside for future use |
| RBAC guards + `/authorization/me` | No geography | Unchanged |

## Self-Review

**Spec coverage.** Normalised `countryId`/`stateId`/`regionId` on users → Task 1. Exact filtering instead of country fallback → Task 3. Prisma migrations → Tasks 1 and 7. Backfill strategy → Tasks 2 and 6 plus rollout. APIs + Swagger → Task 5. RBAC permission validation → Task 5's access spec. Organization module integration → Tasks 2 and 5 (service and controller live in `organization`). Mobile Workforce consistency → Task 4. Role Approval Engine → deferred by decision; Task 9 locks its schema guarantee. Single source of truth → Tasks 7, 8, 9. Migration verification → Task 10 step 4. Integration and E2E tests → Task 10. No-regression verification → Task 10 step 3 plus the surface table above.

**Type consistency.** `userScopeFilter` returns `UserScopeFilter` in Task 3, consumed as a Prisma `where` in Tasks 4 and 10. `describeScope` returns `{ isUnrestricted, predicates }` in Task 3, destructured identically in Task 4. `backfillFromProfileCountry` returns `{ scanned, matched, skipped }` in Task 2, destructured with those names in Task 6. `checkCountryEligibility` returns `{ eligible, reason? }` in Task 8, consumed with those names in the same task.

**Two deliberate breaking changes.** `resolveCountryCodes` is removed in Task 3 — its only caller is `MobileWorkforceService`, updated in Task 4, and grep confirms no other consumer. Event country eligibility fails closed for unnormalised users in Task 8 — flagged in the rollout above.

**Scope explicitly excluded.** The role-requests module (schema exists, no code). `UsersService.search(country)` stays free text as a discovery filter. `RankingDefinition.country` keeps its display label; only the normalised column is added.
