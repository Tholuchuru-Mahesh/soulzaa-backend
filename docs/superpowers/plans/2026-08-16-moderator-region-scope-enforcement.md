# Moderator Region Scope Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `RoleScope` the sole, fully-enforced authorization boundary for Moderator operational access — support one-or-more assigned regions, close every gap where a moderation write action currently skips the region check, fix the dashboard's report-count scoping, and prove all of it with real e2e tests.

**Architecture:** Reuse the existing `WorkforceScopeService.assertModeratorInScope(actorId, regionId)` primitive everywhere a gap exists, converting its injection from `@Optional()` to required in every module that gates a Moderator-reachable action (so a wiring mistake fails the app's boot, not silently permits everyone). Region assignment goes through one new reconciliation method, `setModeratorRegions`, used by both provisioning and later edits. No new tables, no new guard type — every addition matches the existing imperative-check-inside-a-shared-prereq-method convention already used by kick/ban/mute/warn.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Jest (unit specs + new e2e suite), React (soulzaa-superadmins admin panel), supertest.

**Spec:** `docs/superpowers/specs/2026-08-16-moderator-region-scope-enforcement-design.md`

## Global Constraints

- `RoleScope` is the sole Moderator operational-authorization source. Never read or write `User.countryId`/`User.stateId`/`User.regionId` for Moderator authorization purposes.
- Moderator region assignment never touches `User.country` either — no profile field is written as a side effect of operational region assignment.
- No new database tables/models. Reuse `Country → State → Region` + `RoleScope` exactly as they exist.
- No declarative `RegionScopeGuard`. Every new check is an imperative `assertModeratorInScope` call inside the same service method that already performs the room/stream/report mutation, matching the existing convention.
- `WorkforceScopeService` becomes a **required** (non-`@Optional()`) constructor dependency everywhere it gates a Moderator-reachable action (audio-rooms, video-rooms, live-streaming, moderation-approval, investigation-recording). ADMIN/SUPER_ADMIN/GLOBAL-scope behavior is unaffected — that bypass lives inside `assertModeratorInScope`/`isUnrestricted` itself, not in the optionality of the injection.
- The pre-existing "target resource has no region snapshot → permit" safety valve (`if (!regionId) return` inside `assertModeratorInScope`) is **not** changed by this plan. Every new call site must throw `NotFoundException` (or reuse whatever the surrounding method already throws) when its parent room/stream/report can't be resolved — never let a failed lookup look identical to a legitimately unscoped resource.
- `soulzaa_e2e` is a dedicated local Postgres (port 5433, `.env.e2e`) + Redis, confirmed running. Never point any script at the primary `soulzaa` dev database.

---

## File Structure

**Backend (`soulzaa-backend`):**

| File | Responsibility |
|---|---|
| `src/modules/admin-identity/dto/set-moderator-regions.dto.ts` | New — `{ regionIds: string[] }` request body |
| `src/modules/admin-identity/dto/create-moderator.dto.ts` | Modify — `regionId` → `regionIds: string[]` |
| `src/modules/admin-identity/services/moderator-provisioning.service.ts` | Modify — `setModeratorRegions`, `getModeratorRegions`, rewritten `createModerator` |
| `src/modules/admin-identity/controllers/moderator-provisioning-admin.controller.ts` | Modify — `PUT`/`GET :id/regions` |
| `src/modules/audio-rooms/services/moderation.service.ts` | Modify — required `scopeService`, scope checks on 8 previously-unguarded methods |
| `src/modules/video-rooms/services/video-room-moderation.service.ts` | Modify — required `scopeService`, scope checks on `unblacklist`/`unmute` |
| `src/modules/video-rooms/services/video-room-report.service.ts` | Modify — new required `scopeService`, scope checks on 4 report methods |
| `src/modules/live-streaming/services/live-stream.service.ts` | Modify — required `scopeService` (no new checks; `moderateUser`/`escalateViolation` already check) |
| `src/modules/live-streaming/services/live-stream-report.service.ts` | Modify — required `scopeService`, scope checks on `reviewReport`/`addNotes` |
| `src/modules/moderation-approval/services/moderation-approval.service.ts` | Modify — required `scopeService`, region resolution + scope check in `decide()` |
| `src/modules/investigation-recording/investigation-recording.module.ts` | Modify — import `MobileWorkforceModule` |
| `src/modules/investigation-recording/services/investigation-recording.service.ts` | Modify — required `scopeService`, defense-in-depth check in `beginRecording` |
| `src/modules/mobile-workforce/services/mobile-workforce.service.ts` | Modify — `regionalDailyActivity()` report counts scoped by target resource, not reporter |
| `prisma/seed-rbac.ts` | Modify — Vijayawada/AP + Chennai/TN geography |
| `prisma/seed-e2e-fixtures.ts` | Modify — rooms/streams per region, moderator scope extended to 2 regions |
| `package.json` | Modify — `seed:e2e` script, `dotenv-cli` devDependency |
| `test/moderator-region-scope.e2e-spec.ts` | New — the 12 required scenarios against the real `soulzaa_e2e` app |

**Frontend (`soulzaa-superadmins`):**

| File | Responsibility |
|---|---|
| `packages/shared/src/api/endpoints.ts` | Modify — `moderators.setRegions`/`getRegions` |
| `packages/shared/src/modules/ModeratorManagementModule.tsx` | Modify — multi-select region picker (create + edit) |

Every corresponding `*.spec.ts` file gets updated alongside its service (listed per-task below).

---

### Task 1: `SetModeratorRegionsDto` + `setModeratorRegions()`/`getModeratorRegions()`

**Files:**
- Create: `src/modules/admin-identity/dto/set-moderator-regions.dto.ts`
- Modify: `src/modules/admin-identity/services/moderator-provisioning.service.ts`
- Test: `src/modules/admin-identity/services/moderator-provisioning.service.spec.ts`

**Interfaces:**
- Produces: `ModeratorProvisioningService.setModeratorRegions(userId: string, regionIds: string[], actorId: string): Promise<{ regionIds: string[] }>`
- Produces: `ModeratorProvisioningService.getModeratorRegions(actorId: string, targetId: string): Promise<{ regionIds: string[] }>`
- Consumes: `RoleService.assignRoleByName`, `RoleService.assignRoleScope`, `RoleService.removeRoleScope` (existing, `src/modules/authorization/services/role.service.ts`)

- [ ] **Step 1: Create the DTO**

```ts
// src/modules/admin-identity/dto/set-moderator-regions.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Reconciles a Moderator's operational RoleScope regions to exactly this set. */
export class SetModeratorRegionsDto {
  @ApiProperty({
    type: [String],
    example: ['123e4567-e89b-12d3-a456-426614174000'],
    description: 'Region IDs this moderator is authorized to operate in. Replaces the current set.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  regionIds!: string[];
}
```

- [ ] **Step 2: Write the failing spec for `setModeratorRegions`**

Add to `src/modules/admin-identity/services/moderator-provisioning.service.spec.ts`, inside a new `describe('setModeratorRegions', ...)` block (uses the same `prisma`, `roles`, `roleService` mocks already declared at the top of the file — extend them with the calls below):

```ts
describe('setModeratorRegions', () => {
  const BLR = { id: 'region-blr', name: 'Bengaluru Region', isActive: true, stateId: 'state-ka', state: { id: 'state-ka', isActive: true, countryId: 'country-in', country: { id: 'country-in', code: 'IN', isActive: true } } };
  const VJA = { id: 'region-vja', name: 'Vijayawada Region', isActive: true, stateId: 'state-ap', state: { id: 'state-ap', isActive: true, countryId: 'country-in', country: { id: 'country-in', code: 'IN', isActive: true } } };

  beforeEach(() => {
    roleService.assignRoleByName.mockResolvedValue({ id: 'user-role-1' });
    prisma.roleScope.findMany = jest.fn().mockResolvedValue([]);
  });

  it('rejects an actor who is not Admin or Super Admin', async () => {
    roles.getRoleNames.mockResolvedValue(['USER']);
    await expect(service.setModeratorRegions('mod-1', ['region-blr'], 'actor-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws NotFoundException when a regionId does not exist', async () => {
    prisma.region.findMany = jest.fn().mockResolvedValue([]);
    await expect(service.setModeratorRegions('mod-1', ['region-blr'], 'actor-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an inactive region in the batch', async () => {
    prisma.region.findMany = jest.fn().mockResolvedValue([{ ...BLR, isActive: false }]);
    await expect(service.setModeratorRegions('mod-1', ['region-blr'], 'actor-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('creates a RoleScope row per new region when none exist yet', async () => {
    prisma.region.findMany = jest.fn().mockResolvedValue([BLR, VJA]);
    await service.setModeratorRegions('mod-1', ['region-blr', 'region-vja'], 'actor-1');

    expect(roleService.assignRoleScope).toHaveBeenCalledWith({
      userRoleId: 'user-role-1',
      scopeType: 'REGION',
      countryId: 'country-in',
      stateId: 'state-ka',
      regionId: 'region-blr',
    });
    expect(roleService.assignRoleScope).toHaveBeenCalledWith({
      userRoleId: 'user-role-1',
      scopeType: 'REGION',
      countryId: 'country-in',
      stateId: 'state-ap',
      regionId: 'region-vja',
    });
  });

  it('removes RoleScope rows for regions no longer in the target set', async () => {
    prisma.region.findMany = jest.fn().mockResolvedValue([BLR]);
    prisma.roleScope.findMany = jest.fn().mockResolvedValue([
      { id: 'scope-blr', regionId: 'region-blr' },
      { id: 'scope-vja', regionId: 'region-vja' },
    ]);

    await service.setModeratorRegions('mod-1', ['region-blr'], 'actor-1');

    expect(roleService.removeRoleScope).toHaveBeenCalledWith('scope-vja');
    expect(roleService.removeRoleScope).not.toHaveBeenCalledWith('scope-blr');
    expect(roleService.assignRoleScope).not.toHaveBeenCalled();
  });

  it('is a no-op when the target set already matches', async () => {
    prisma.region.findMany = jest.fn().mockResolvedValue([BLR]);
    prisma.roleScope.findMany = jest.fn().mockResolvedValue([{ id: 'scope-blr', regionId: 'region-blr' }]);

    await service.setModeratorRegions('mod-1', ['region-blr'], 'actor-1');

    expect(roleService.assignRoleScope).not.toHaveBeenCalled();
    expect(roleService.removeRoleScope).not.toHaveBeenCalled();
  });

  it('returns the resulting region id list', async () => {
    prisma.region.findMany = jest.fn().mockResolvedValue([BLR, VJA]);
    const result = await service.setModeratorRegions('mod-1', ['region-blr', 'region-vja'], 'actor-1');
    expect(result).toEqual({ regionIds: ['region-blr', 'region-vja'] });
  });
});

describe('getModeratorRegions', () => {
  it('returns the current REGION-scope region ids for the moderator', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    prisma.userRole.findFirst = jest.fn().mockResolvedValue({ id: 'user-role-1' });
    prisma.roleScope.findMany = jest.fn().mockResolvedValue([
      { regionId: 'region-blr' },
      { regionId: 'region-vja' },
    ]);
    const result = await service.getModeratorRegions('actor-1', 'mod-1');
    expect(result).toEqual({ regionIds: ['region-blr', 'region-vja'] });
  });

  it('returns an empty list when the moderator has no UserRole yet', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    prisma.userRole.findFirst = jest.fn().mockResolvedValue(null);
    const result = await service.getModeratorRegions('actor-1', 'mod-1');
    expect(result).toEqual({ regionIds: [] });
  });
});
```

Also add `NotFoundException`, `BadRequestException` to the spec file's imports from `@nestjs/common` if not already present, and add `prisma.userRole = { findFirst: jest.fn() }`, `prisma.roleScope = { findFirst: jest.fn(), findMany: jest.fn() }`, `prisma.region = { findMany: jest.fn() }` to the top-level `prisma` mock object (extending, not replacing, the existing `prisma.region.findUnique`/`prisma.user.findFirst`/etc. already declared there).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/modules/admin-identity/services/moderator-provisioning.service.spec.ts -t "setModeratorRegions|getModeratorRegions"`
Expected: FAIL — `setModeratorRegions is not a function`.

- [ ] **Step 4: Implement `setModeratorRegions` and `getModeratorRegions`**

Add to `moderator-provisioning.service.ts`, as new public methods (add `NotFoundException`, `BadRequestException`, `ScopeType` to the existing imports — `ScopeType` from `@prisma/client`):

```ts
async setModeratorRegions(
  userId: string,
  regionIds: string[],
  actorId: string,
): Promise<{ regionIds: string[] }> {
  await this.assertAdminOrAbove(actorId);

  const regions = await this.prisma.region.findMany({
    where: { id: { in: regionIds } },
    include: { state: { include: { country: true } } },
  });
  const foundIds = new Set(regions.map((r) => r.id));
  const missing = regionIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new NotFoundException(`Region(s) not found: ${missing.join(', ')}`);
  }
  const inactive = regions.find((r) => !r.isActive || !r.state.isActive || !r.state.country.isActive);
  if (inactive) {
    throw new BadRequestException(
      `Cannot assign moderator to inactive region '${inactive.name}'`,
    );
  }

  const userRole = await this.roleService.assignRoleByName(userId, 'MODERATOR', actorId);

  const existingScopes = await this.prisma.roleScope.findMany({
    where: { userRoleId: userRole.id, scopeType: ScopeType.REGION },
  });
  const targetIds = new Set(regionIds);
  const existingIds = new Set(existingScopes.map((s) => s.regionId).filter((id): id is string => !!id));

  const toRemove = existingScopes.filter((s) => s.regionId && !targetIds.has(s.regionId));
  const toAdd = regions.filter((r) => !existingIds.has(r.id));

  await Promise.all(toRemove.map((scope) => this.roleService.removeRoleScope(scope.id)));
  await Promise.all(
    toAdd.map((region) =>
      this.roleService.assignRoleScope({
        userRoleId: userRole.id,
        scopeType: ScopeType.REGION,
        countryId: region.state.countryId,
        stateId: region.stateId,
        regionId: region.id,
      }),
    ),
  );

  return { regionIds };
}

async getModeratorRegions(actorId: string, targetId: string): Promise<{ regionIds: string[] }> {
  await this.assertAdminOrAbove(actorId);

  const role = await this.prisma.role.findUnique({ where: { name: 'MODERATOR' } });
  const userRole = role
    ? await this.prisma.userRole.findFirst({ where: { userId: targetId, roleId: role.id } })
    : null;
  if (!userRole) return { regionIds: [] };

  const scopes = await this.prisma.roleScope.findMany({
    where: { userRoleId: userRole.id, scopeType: ScopeType.REGION },
  });
  return { regionIds: scopes.map((s) => s.regionId).filter((id): id is string => !!id) };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/admin-identity/services/moderator-provisioning.service.spec.ts`
Expected: PASS (all tests, including the pre-existing `createModerator` ones — untouched by this step).

- [ ] **Step 6: Commit**

```bash
git add src/modules/admin-identity/dto/set-moderator-regions.dto.ts src/modules/admin-identity/services/moderator-provisioning.service.ts src/modules/admin-identity/services/moderator-provisioning.service.spec.ts
git commit -m "feat: add setModeratorRegions/getModeratorRegions region reconciliation"
```

---

### Task 2: Rewrite `createModerator` — drop profile-geography, multi-region

**Files:**
- Modify: `src/modules/admin-identity/dto/create-moderator.dto.ts`
- Modify: `src/modules/admin-identity/services/moderator-provisioning.service.ts`
- Test: `src/modules/admin-identity/services/moderator-provisioning.service.spec.ts`

**Interfaces:**
- Consumes: `setModeratorRegions` (Task 1)
- Produces: `CreateModeratorDto.regionIds: string[]` (replaces `regionId: string`)

- [ ] **Step 1: Update the DTO**

In `create-moderator.dto.ts`, replace the `regionId` field:

```ts
// Replace:
@ApiProperty({
  example: '123e4567-e89b-12d3-a456-426614174000',
  description:
    'ID of the Region this moderator is assigned to. The moderator\'s State and Country are derived from it automatically.',
})
@IsUUID()
regionId!: string;

// With:
@ApiProperty({
  type: [String],
  example: ['123e4567-e89b-12d3-a456-426614174000'],
  description:
    'Region IDs this moderator is authorized to operate in. Supports one or more. Country is derived per-region and used only for the display country field.',
})
@IsArray()
@ArrayNotEmpty()
@IsUUID('4', { each: true })
regionIds!: string[];
```

Update the imports at the top: add `ArrayNotEmpty`, `IsArray` to the existing `class-validator` import line, remove `IsUUID` if it becomes unused elsewhere in the file (it's now used via `IsUUID('4', { each: true })`, so keep it).

- [ ] **Step 2: Write the failing spec for the rewritten `createModerator`**

Update the existing `dto` fixture in `moderator-provisioning.service.spec.ts` from `regionId: 'region-1'` to `regionIds: ['region-1']`, and update these existing tests (which currently assert on the old single-region shape) to the new shape:

```ts
it('auto-generates a username and full name for a brand new account, without a profile country', async () => {
  await service.createModerator('actor-1', dto, ctx);
  expect(users.createIdentity).toHaveBeenCalledWith(
    expect.objectContaining({
      username: 'raviteja',
      fullName: 'Moderator raviteja',
      email: dto.email,
    }),
  );
  const createArgs = users.createIdentity.mock.calls[0][0];
  expect(createArgs.country).toBeUndefined();
});

it('does not touch User.countryId/stateId/regionId for a new account', async () => {
  await service.createModerator('actor-1', dto, ctx);
  expect(userLocation.assignLocation).not.toHaveBeenCalled();
});

it('does not write country when promoting an existing account', async () => {
  prisma.user.findFirst.mockResolvedValue({
    id: 'existing-1',
    username: 'already_here',
    roles: ['USER'],
    emailVerifiedAt: null,
  });
  await service.createModerator('actor-1', dto, ctx);
  const updateArgs = prisma.user.update.mock.calls[0][0];
  expect(updateArgs.data.country).toBeUndefined();
});

it('grants a REGION role scope for every region in regionIds via setModeratorRegions', async () => {
  await service.createModerator('actor-1', { ...dto, regionIds: ['region-1'] }, ctx);
  expect(roleService.assignRoleScope).toHaveBeenCalledWith(
    expect.objectContaining({ regionId: 'region-1' }),
  );
});
```

Delete/replace the now-invalid old tests that assert on the single-`regionId` shape (`'cascades the region into the profile location'` and `'grants a REGION role scope resolved from the region hierarchy'` with the old single-arg-object assertion) — they're superseded by the two tests above.

The existing `activeRegion` fixture stays as `prisma.region.findUnique` mock support is no longer used by `createModerator` (it now goes through `setModeratorRegions`'s `prisma.region.findMany`) — update `beforeEach` to mock `prisma.region.findMany` returning `[activeRegion]` instead of `prisma.region.findUnique` returning `activeRegion`, and remove the `prisma.region.findUnique` mock if `createModerator` itself no longer calls it directly (see Step 4 — it doesn't; region resolution moves entirely into `setModeratorRegions`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/modules/admin-identity/services/moderator-provisioning.service.spec.ts`
Expected: FAIL — type error on `dto.regionId` / assertions on `userLocation.assignLocation` not matching current behavior.

- [ ] **Step 4: Rewrite `createModerator`**

Replace the existing region-resolution block, `country` derivation, and RoleScope block in `createModerator` (everything from the `// Region determines State and Country` comment through the `existingScope`/`assignRoleScope` block) with a call to `setModeratorRegions`, and remove the `country: countryCode` writes:

```ts
async createModerator(
  actorId: string,
  dto: CreateModeratorDto,
  ctx?: { ip?: string; userAgent?: string },
) {
  await this.assertAdminOrAbove(actorId);

  const email = dto.email.toLowerCase().trim();

  // Check if user already exists
  let existingUser = await this.prisma.user.findFirst({ where: { email } });

  let userId: string;
  let username: string;

  if (existingUser) {
    userId = existingUser.id;
    username = existingUser.username;

    const currentRoles = (existingUser.roles as string[]) || [];
    const updatedRoles = Array.from(new Set([...currentRoles, 'USER', 'MODERATOR']));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        roles: updatedRoles as any,
        emailVerifiedAt: existingUser.emailVerifiedAt || new Date(),
        status: 'ACTIVE',
      },
    });
  } else {
    username = await this.generateUsername(email);
    const newUser = await this.users.createIdentity({
      username,
      email,
      fullName: `Moderator ${username}`,
      dateOfBirth: new Date('2000-01-01'),
      roles: ['USER', 'MODERATOR'],
      isGuest: false,
    });
    userId = newUser.id;
  }

  // 2. Set / update password hash
  const passwordHash = await this.passwords.hash(dto.password);
  await this.prisma.userCredential.upsert({
    where: { userId },
    create: { userId, passwordHash, passwordUpdatedAt: new Date() },
    update: { passwordHash, passwordUpdatedAt: new Date() },
  });

  // 3. Ensure AuthProvider is active
  await this.prisma.userAuthProvider.upsert({
    where: { provider_providerUserId: { provider: 'PASSWORD', providerUserId: userId } },
    create: { userId, provider: 'PASSWORD', providerUserId: userId, email },
    update: { email },
  });

  // 4. Assign the MODERATOR role + operational regions.
  const { regionIds } = await this.setModeratorRegions(userId, dto.regionIds, actorId);

  // 5. Assign the working shift (unchanged by this task — still reads the
  // same shift fields off dto, still deactivates any prior active shift).
  await this.moderatorShift.assignShift({
    moderatorId: userId,
    daysOfWeek:
      dto.shiftDaysOfWeek && dto.shiftDaysOfWeek.length > 0
        ? dto.shiftDaysOfWeek
        : ALL_DAYS_OF_WEEK,
    startHour: dto.shiftStartHour,
    startMinute: dto.shiftStartMinute,
    endHour: dto.shiftEndHour,
    endMinute: dto.shiftEndMinute,
    timezone: dto.shiftTimezone ?? 'UTC',
    assignedBy: actorId,
  });

  // 6. Hide the account immediately from all public surfaces
  await this.identity.syncHiddenState(userId);

  // 7. Audit log
  await this.audit.logAction({
    actorId,
    action: 'moderator.created',
    resource: 'moderator_account',
    resourceId: userId,
    details: { username, email, regionIds },
    ipAddress: ctx?.ip,
    status: 'SUCCESS',
  });

  return { id: userId, username, email, regionIds };
}
```

Leave the constructor and its `UserLocationService`/`ModeratorShiftService` injections exactly as they are — do **not** remove `userLocation` from the constructor even though `createModerator` stops calling it. Removing it would change the constructor's arity and break every existing positional `new ModeratorProvisioningService(...)` call in the spec file for no benefit; the class simply has an unused-in-this-method dependency now; `getModeratorRegions`/`setModeratorRegions` (Task 1) don't need it either, so nothing in the class calls `this.userLocation` after this change, but the injection itself stays untouched. `ModeratorShiftService` stays both injected and called, per Step 5 above.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/admin-identity/services/moderator-provisioning.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the whole backend**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Fix any caller of `moderator-provisioning-admin.controller.ts` that still references the old single-`regionId` shape (none expected outside the controller, updated in Task 3).

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin-identity/dto/create-moderator.dto.ts src/modules/admin-identity/services/moderator-provisioning.service.ts src/modules/admin-identity/services/moderator-provisioning.service.spec.ts
git commit -m "refactor: provisioning assigns regions via setModeratorRegions, stops touching profile geography"
```

---

### Task 3: `PUT`/`GET /admin-identity/moderators/:id/regions`

**Files:**
- Modify: `src/modules/admin-identity/controllers/moderator-provisioning-admin.controller.ts`

**Interfaces:**
- Consumes: `setModeratorRegions`, `getModeratorRegions` (Task 1), `SetModeratorRegionsDto` (Task 1)

- [ ] **Step 1: Add the two routes**

Add to `moderator-provisioning-admin.controller.ts` (add `Put` to the `@nestjs/common` import, add `SetModeratorRegionsDto` import):

```ts
@ApiOperation({ summary: "Get a Moderator's current operational regions (Admin only)" })
@ApiResponse({ status: 200, description: 'Current RoleScope region ids' })
@Get(':id/regions')
getRegions(@CurrentUser('id') actorId: string, @Param('id') targetId: string) {
  return this.service.getModeratorRegions(actorId, targetId);
}

@ApiOperation({ summary: "Replace a Moderator's operational regions (Admin only)" })
@ApiResponse({ status: 200, description: 'Regions reconciled' })
@Put(':id/regions')
setRegions(
  @CurrentUser('id') actorId: string,
  @Param('id') targetId: string,
  @Body() dto: SetModeratorRegionsDto,
) {
  return this.service.setModeratorRegions(targetId, dto.regionIds, actorId);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/admin-identity/controllers/moderator-provisioning-admin.controller.ts
git commit -m "feat: expose GET/PUT /admin-identity/moderators/:id/regions"
```

---

### Task 4: Audio-rooms — required `scopeService` + `unkick`/`unban`/`unmute` scope checks

**Files:**
- Modify: `src/modules/audio-rooms/services/moderation.service.ts`
- Test: `src/modules/audio-rooms/services/moderation.service.spec.ts`

**Interfaces:**
- Consumes: `WorkforceScopeService.assertModeratorInScope(actorId: string, regionId: string | null): Promise<void>` (existing)

- [ ] **Step 1: Write the failing tests**

Add to `moderation.service.spec.ts`, inside (or alongside) the existing `describe('region scope enforcement', ...)` block:

```ts
it('unkick checks the room region before lifting the kick', async () => {
  rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
  repo.findActiveKick.mockResolvedValue({ id: 'kick-1' });
  await scopedService.unkick(MOD, 'r', TARGET);
  expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
});

it('unkick rejects a moderator outside the room region', async () => {
  rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
  repo.findActiveKick.mockResolvedValue({ id: 'kick-1' });
  scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
  await expect(scopedService.unkick(MOD, 'r', TARGET)).rejects.toBeInstanceOf(ForbiddenException);
  expect(repo.liftKick).not.toHaveBeenCalled();
});

it('unban checks the room region before lifting the ban', async () => {
  rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
  repo.findActiveBan.mockResolvedValue({ id: 'ban-1', status: 'ACTIVE' });
  await scopedService.unban(MOD, 'r', TARGET);
  expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
});

it('unmute checks the room region before lifting the mute', async () => {
  rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
  repo.findActiveMute.mockResolvedValue({ id: 'mute-1', status: 'ACTIVE' });
  await scopedService.unmute(MOD, 'r', TARGET);
  expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
});
```

(These reuse the file's existing `scopedService`/`scopeService`/`rooms`/`repo`/`MOD`/`TARGET` fixtures — see the constructor reorder in Step 3 below, which changes how `scopedService` is built.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/audio-rooms/services/moderation.service.spec.ts -t "unkick|unban|unmute"`
Expected: FAIL — `scopeService.assertModeratorInScope` not called.

- [ ] **Step 3: Reorder the constructor — `scopeService` becomes required**

In `moderation.service.ts`, change the constructor (moves `scopeService` from optional position 13 to required position 10, right after `bus`):

```ts
// Old (lines 100-119):
constructor(
  private readonly repo: ModerationRepository,
  private readonly permissions: RoomPermissionService,
  private readonly rooms: AudioRoomsRepository,
  private readonly seats: AudioRoomSeatsRepository,
  private readonly presence: PresenceService,
  private readonly voice: VoiceService,
  private readonly locks: LockService,
  private readonly queue: QueueService,
  @Inject(EVENT_BUS) private readonly bus: IEventBus,
  @Optional() private readonly investigationRecording?: InvestigationRecordingService,
  @Optional() private readonly performanceStats?: ModeratorPerformanceService,
  @Optional() private readonly auditLog?: AuditLogService,
  @Optional() private readonly scopeService?: WorkforceScopeService,
  @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
  @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
  @Optional() private readonly approvalService?: ModerationApprovalService,
) {}

// New:
constructor(
  private readonly repo: ModerationRepository,
  private readonly permissions: RoomPermissionService,
  private readonly rooms: AudioRoomsRepository,
  private readonly seats: AudioRoomSeatsRepository,
  private readonly presence: PresenceService,
  private readonly voice: VoiceService,
  private readonly locks: LockService,
  private readonly queue: QueueService,
  @Inject(EVENT_BUS) private readonly bus: IEventBus,
  private readonly scopeService: WorkforceScopeService,
  @Optional() private readonly investigationRecording?: InvestigationRecordingService,
  @Optional() private readonly performanceStats?: ModeratorPerformanceService,
  @Optional() private readonly auditLog?: AuditLogService,
  @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
  @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
  @Optional() private readonly approvalService?: ModerationApprovalService,
) {}
```

Update `assertModerationPrereqs` (lines 1142-1163) to drop the now-redundant `if (this.scopeService)` guard:

```ts
private async assertModerationPrereqs(
  roomId: string,
  actor: RoomActor,
  targetUserId: string,
): Promise<void> {
  if (targetUserId === actor.id) {
    throw new BusinessException(
      ERROR_CODES.CANNOT_MODERATE_SELF,
      'You cannot moderate yourself.',
      HttpStatus.BAD_REQUEST,
    );
  }
  await this.permissions.assertCanModerate(roomId, actor);
  await this.permissions.assertOutranks(roomId, actor, targetUserId);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
}
```

- [ ] **Step 4: Add scope checks to `unkick`/`unban`/`unmute`**

```ts
// unkick — insert right after the existing assertCanModerate call:
async unkick(actor: RoomActor, roomId: string, targetUserId: string): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const kick = await this.repo.findActiveKick(roomId, targetUserId);
  // ...unchanged from here...
```

```ts
// unban:
async unban(actor: RoomActor, roomId: string, targetUserId: string): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const ban = await this.repo.findActiveBan(roomId, targetUserId);
  // ...unchanged from here...
```

```ts
// unmute:
async unmute(actor: RoomActor, roomId: string, targetUserId: string): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const mute = await this.repo.findActiveMute(roomId, targetUserId);
  // ...unchanged from here...
```

- [ ] **Step 5: Fix every existing constructor call site in the spec file**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep moderation.service.spec`

For every resulting `Expected 10 arguments, but got 9` (or similar) error at a `new ModerationService(...)` call, insert a `scopeService` mock as the 10th positional argument. Two shapes to use, matching what's already established in the file:
- If the surrounding test doesn't care about scope (most of the file): `{ assertModeratorInScope: jest.fn().mockResolvedValue(undefined) }`.
- The existing `describe('region scope enforcement', ...)` block's own construction (currently 3 leading `undefined`s then `scopeService` at position 13) becomes: `repo, permissions, rooms, seats, presence, voice, locks, queue, bus, scopeService` (drop the 3 leading `undefined`s — `scopeService` is now positional argument 10, immediately after `bus`, with `investigationRecording`/`performanceStats`/`auditLog` — all still optional — simply omitted/undefined by omission at the tail).

Repeat until `tsc` reports zero errors in this file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/audio-rooms/services/moderation.service.spec.ts`
Expected: PASS — full file, including every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add src/modules/audio-rooms/services/moderation.service.ts src/modules/audio-rooms/services/moderation.service.spec.ts
git commit -m "fix: enforce region scope on audio-room unkick/unban/unmute; make scope service required"
```

---

### Task 5: Audio-rooms — report/appeal lifecycle scope checks

**Files:**
- Modify: `src/modules/audio-rooms/services/moderation.service.ts`
- Test: `src/modules/audio-rooms/services/moderation.service.spec.ts`

**Interfaces:**
- Consumes: `this.scopeService.assertModeratorInScope` (required as of Task 4), `this.rooms.findRoomRow` (existing)

- [ ] **Step 1: Write the failing tests**

```ts
describe('report/appeal lifecycle region scope enforcement', () => {
  it('assignReport checks the room region', async () => {
    rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
    repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'r', status: 'PENDING' });
    await scopedService.assignReport(MOD, 'r', 'rep-1', 'assignee-1');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
  });

  it('addReportNotes checks the room region', async () => {
    rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
    await scopedService.addReportNotes(MOD, 'r', 'rep-1', 'notes');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
  });

  it('dismissReport checks the room region', async () => {
    rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
    repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'r', createdAt: new Date() });
    await scopedService.dismissReport(MOD, 'r', 'rep-1', 'reason');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
  });

  it('resolveAppeal checks the room region', async () => {
    rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
    repo.getAppeal.mockResolvedValue({ id: 'appeal-1', roomId: 'r', status: 'PENDING', userId: TARGET });
    await scopedService.resolveAppeal(MOD, 'r', 'appeal-1', { approve: false });
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
  });

  it('reviewReport checks the room region even for a bare dismiss (no recommendedAction)', async () => {
    rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
    repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'r', status: 'PENDING', targetUserId: TARGET, createdAt: new Date() });
    await scopedService.reviewReport(MOD, 'r', 'rep-1', { status: 'REVIEWED' });
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'region-eu-west');
  });

  it('reviewReport rejects a moderator outside scope before touching the report', async () => {
    rooms.findRoomRow.mockResolvedValue({ id: 'r', region: 'region-eu-west' });
    scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      scopedService.reviewReport(MOD, 'r', 'rep-1', { status: 'REVIEWED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.reviewReport).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/audio-rooms/services/moderation.service.spec.ts -t "report/appeal lifecycle"`
Expected: FAIL.

- [ ] **Step 3: Add the scope checks**

```ts
// assignReport — insert right after assertCanModerate:
async assignReport(actor: RoomActor, roomId: string, reportId: string, assigneeId: string): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const report = await this.repo.getReport(reportId);
  // ...unchanged from here...
```

```ts
// addReportNotes:
async addReportNotes(actor: RoomActor, roomId: string, reportId: string, notes: string): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  await this.repo.updateReportNotes(reportId, actor.id, notes);
  // ...unchanged from here...
```

```ts
// dismissReport:
async dismissReport(actor: RoomActor, roomId: string, reportId: string, reason?: string): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const report = await this.repo.getReport(reportId);
  // ...unchanged from here...
```

```ts
// resolveAppeal:
async resolveAppeal(actor: RoomActor, roomId: string, appealId: string, dto: ResolveAppealDto): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const appeal = await this.repo.getAppeal(appealId);
  // ...unchanged from here...
```

```ts
// reviewReport — move the check to the top (unconditional), and reuse the
// already-fetched room in the BAN sub-branch instead of fetching it twice:
async reviewReport(actor: RoomActor, roomId: string, reportId: string, dto: ReviewReportDto): Promise<void> {
  await this.permissions.assertCanModerate(roomId, actor);
  const room = await this.rooms.findRoomRow(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const report = await this.repo.getReport(reportId);
  if (!report || report.roomId !== roomId) {
    throw new BusinessException(ERROR_CODES.REPORT_NOT_FOUND, 'Report not found.', HttpStatus.NOT_FOUND);
  }
  if (report.status !== 'PENDING') {
    throw new BusinessException(ERROR_CODES.REPORT_NOT_FOUND, 'Report has already been reviewed.', HttpStatus.CONFLICT);
  }
  await this.repo.reviewReport(reportId, actor.id, dto.status, dto.resolution ?? null);
  await this.repo.appendAction({
    roomId,
    moderatorId: actor.id,
    targetUserId: report.targetUserId,
    action: ModerationActionType.REPORT_REVIEWED,
    reason: dto.resolution ?? null,
    metadata: { reportId, status: dto.status, recommendedAction: dto.recommendedAction ?? null },
  });

  if (dto.recommendedAction) {
    const reason = buildReportReviewReason(reportId, dto.resolution, dto.recommendedAction);
    if (dto.recommendedAction === 'WARNING') {
      await this.warn(actor, roomId, report.targetUserId, reason);
    } else if (dto.recommendedAction === 'MUTE') {
      await this.mute(actor, roomId, report.targetUserId, { type: ModerationMuteType.PERMANENT, reason });
    } else if (dto.recommendedAction === 'KICK') {
      await this.kick(actor, roomId, report.targetUserId, reason);
    } else if (dto.recommendedAction === 'BAN') {
      if (this.approvalService) {
        await this.approvalService.propose({
          roomType: 'AUDIO_ROOM',
          roomId,
          reportId,
          proposedBy: actor.id,
          targetUserId: report.targetUserId,
          reason,
          regionId: room?.region ?? null,
        });
      }
    }
  }

  await recordReportResolutionIfConfigured(this.performanceStats, actor.id, report.createdAt);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/audio-rooms/services/moderation.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/audio-rooms/services/moderation.service.ts src/modules/audio-rooms/services/moderation.service.spec.ts
git commit -m "fix: enforce region scope on audio-room report/appeal lifecycle methods"
```

---

### Task 6: Video-rooms — required `scopeService` + `unblacklist`/`unmute` scope checks

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-moderation.service.ts`
- Test: `src/modules/video-rooms/services/video-room-moderation.service.spec.ts`

**Interfaces:**
- Consumes: `WorkforceScopeService.assertModeratorInScope` (existing)

- [ ] **Step 1: Write the failing tests**

Add near the existing `describe('escalateViolation ...')` block in `video-room-moderation.service.spec.ts`:

```ts
describe('restorative actions region scope enforcement', () => {
  let scopeService: { assertModeratorInScope: jest.Mock };
  let scopedSubject: VideoRoomModerationService;

  beforeEach(() => {
    rooms.findById.mockResolvedValue({ ...ROOM, region: 'region-eu-west' });
    scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };
    scopedSubject = new VideoRoomModerationService(
      rooms, moderationRepo, permissions, session, sockets, locks, metrics, queue, bus,
      media, warningRepo, reportService, config, scopeService as unknown as WorkforceScopeService,
    );
  });

  it('unblacklist checks the room region before lifting the block', async () => {
    moderationRepo.findActiveBlock.mockResolvedValue({ id: 'block-1' });
    await scopedSubject.unblacklist(ACTOR, ROOM.id, TARGET);
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(ACTOR.id, 'region-eu-west');
  });

  it('unmute checks the room region before lifting the mute', async () => {
    moderationRepo.findActiveMute.mockResolvedValue({ id: 'mute-1' });
    await scopedSubject.unmute(ACTOR, ROOM.id, TARGET);
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(ACTOR.id, 'region-eu-west');
  });

  it('unblacklist rejects a moderator outside scope', async () => {
    scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
    await expect(scopedSubject.unblacklist(ACTOR, ROOM.id, TARGET)).rejects.toBeInstanceOf(ForbiddenException);
    expect(moderationRepo.liftBlock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-moderation.service.spec.ts -t "restorative actions region scope"`
Expected: FAIL.

- [ ] **Step 3: Reorder the constructor**

```ts
// Old (lines 98-120): scopeService is the 16th param, @Optional().
// New: scopeService moves to required position 14, right after `config`
// (the last currently-required param), pushing investigationRecording/
// auditLog/performanceStats/notifications to remain optional but shifted:
constructor(
  private readonly rooms: VideoRoomsRepository,
  private readonly moderationRepo: VideoRoomModerationRepository,
  private readonly permissions: VideoRoomPermissionService,
  private readonly session: VideoRoomSessionService,
  private readonly sockets: SocketManager,
  private readonly locks: LockService,
  private readonly metrics: VideoRoomModerationMetrics,
  @InjectQueue(VIDEO_ROOM_MODERATION_QUEUES.PROCESSING) private readonly queue: Queue,
  @Inject(EVENT_BUS) private readonly bus: IEventBus,
  private readonly media: VideoRoomMediaService,
  private readonly warningRepo: VideoRoomWarningRepository,
  @Inject(forwardRef(() => VideoRoomReportService))
  private readonly reportService: VideoRoomReportService,
  private readonly config: ConfigService,
  private readonly scopeService: WorkforceScopeService,
  @Optional() private readonly investigationRecording?: InvestigationRecordingService,
  @Optional() private readonly auditLog?: AuditLogService,
  @Optional() private readonly performanceStats?: ModeratorPerformanceService,
  @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
) {}
```

Update `assertPrereqs` (lines 1129-1166) to drop the `if (this.scopeService)` guard:

```ts
private async assertPrereqs(
  roomId: string,
  actor: RoomActor,
  targetUserId: string,
  permission: VideoRoomPermission,
): Promise<PermissionRoomRef> {
  if (targetUserId === actor.id) {
    throw new ModerationException(
      ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
      'You cannot moderate yourself.',
      HttpStatus.BAD_REQUEST,
    );
  }

  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, permission);

  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }

  if (!this.isPlatformStaff(actor)) {
    if (targetUserId === ref.ownerId) {
      throw new OwnerProtectionException();
    }
    await this.permissions.assertOutranks(ref, actor.id, targetUserId);
  }
  return ref;
}
```

- [ ] **Step 4: Add scope checks to `unblacklist`/`unmute`**

```ts
// unblacklist — insert right after requireRoom + assertPermission:
async unblacklist(actor: RoomActor, roomId: string, targetUserId: string, requestMeta?: RequestMetadata): Promise<void> {
  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, VideoRoomPermission.BLOCK_USERS);

  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }

  const block = await this.moderationRepo.findActiveBlock(ref.id, targetUserId);
  // ...unchanged from here...
```

```ts
// unmute:
async unmute(actor: RoomActor, roomId: string, targetUserId: string, channels?: MuteChannel[], requestMeta?: RequestMetadata): Promise<void> {
  const chans = channels ?? DEFAULT_MUTE_CHANNELS;
  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, VideoRoomPermission.MUTE_USERS);

  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }

  await this.locks.withLock(moderationLockKey(ref.id), async () => {
    // ...unchanged from here...
```

- [ ] **Step 5: Fix every existing constructor call site in the spec file**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep video-room-moderation.service.spec`

For each error, insert a `scopeService` mock (`{ assertModeratorInScope: jest.fn().mockResolvedValue(undefined) }`, or the block's own richer mock if one already exists, e.g. the `escalateViolation` describe block's existing `scopeService` variable) as the 14th positional constructor argument. The already-shown `escalateViolation` block's construction (Task research: 13 positional args then `undefined, undefined, scopeService, undefined, notifications`) collapses to `rooms, moderationRepo, permissions, session, sockets, locks, metrics, queue, bus, media, warningRepo, reportService, config, scopeService, undefined, undefined, undefined, notifications` (scopeService moves from slot 16 to slot 14; the 2 `undefined`s before it — investigationRecording/auditLog — move to slots 15/16 as `undefined, undefined`; `performanceStats` stays `undefined` at 17; `notifications` stays at 18).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-moderation.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/video-rooms/services/video-room-moderation.service.ts src/modules/video-rooms/services/video-room-moderation.service.spec.ts
git commit -m "fix: enforce region scope on video-room unblacklist/unmute; make scope service required"
```

---

### Task 7: Video-rooms — `video-room-report.service.ts` gets `scopeService` + report scope checks

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-report.service.ts`
- Test: `src/modules/video-rooms/services/video-room-report.service.spec.ts` (create if it doesn't already exist — check first with `Glob "src/modules/video-rooms/services/video-room-report.service.spec.ts"`; if absent, create it following the constructor-mocking convention already used in `video-room-moderation.service.spec.ts`)

**Interfaces:**
- Consumes: `WorkforceScopeService` (new import: `src/modules/mobile-workforce/services/workforce-scope.service.ts`)

- [ ] **Step 1: Write the failing tests**

If `video-room-report.service.spec.ts` does not exist yet, create it with a minimal harness (mirroring the constructor list from Step 3) plus these cases; if it exists, add this `describe` block to it:

```ts
import { ForbiddenException } from '@nestjs/common';
import { VideoRoomReportService } from './video-room-report.service';
import type { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

describe('VideoRoomReportService region scope enforcement', () => {
  const ACTOR = { id: 'mod-1', roles: ['MODERATOR'] } as any;
  const TARGET = 'target-1';
  const ROOM_ID = 'room-1';

  let reportRepo: any;
  let rooms: any;
  let roles: any;
  let permissions: any;
  let moderationRepo: any;
  let metrics: any;
  let queue: any;
  let bus: any;
  let moderation: any;
  let scopeService: { assertModeratorInScope: jest.Mock };
  let service: VideoRoomReportService;

  beforeEach(() => {
    reportRepo = { getById: jest.fn(), updateNotes: jest.fn(), review: jest.fn(), assign: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue({ id: ROOM_ID, ownerId: 'owner-1', region: 'region-eu-west' }) };
    roles = {};
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    moderationRepo = { appendAction: jest.fn().mockResolvedValue(undefined) };
    metrics = { incReport: jest.fn() };
    queue = { add: jest.fn() };
    bus = { publish: jest.fn() };
    moderation = { warn: jest.fn(), mute: jest.fn(), kick: jest.fn() };
    scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };

    service = new VideoRoomReportService(
      reportRepo, rooms, roles, permissions, moderationRepo, metrics, queue, bus, moderation,
      scopeService as unknown as WorkforceScopeService,
    );
  });

  it('reviewReport checks the room region', async () => {
    reportRepo.getById.mockResolvedValue({ id: 'rep-1', roomId: ROOM_ID, status: 'PENDING', targetUserId: TARGET, createdAt: new Date() });
    await service.reviewReport(ACTOR, ROOM_ID, 'rep-1', { status: 'REVIEWED' } as any);
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(ACTOR.id, 'region-eu-west');
  });

  it('reviewReport rejects a moderator outside scope', async () => {
    scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      service.reviewReport(ACTOR, ROOM_ID, 'rep-1', { status: 'REVIEWED' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reportRepo.review).not.toHaveBeenCalled();
  });

  it('addReportNotes checks the room region', async () => {
    await service.addReportNotes(ACTOR, ROOM_ID, 'rep-1', 'notes');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(ACTOR.id, 'region-eu-west');
  });

  it('dismissReport checks the room region', async () => {
    reportRepo.getById.mockResolvedValue({ id: 'rep-1', roomId: ROOM_ID, createdAt: new Date() });
    await service.dismissReport(ACTOR, ROOM_ID, 'rep-1', 'reason');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(ACTOR.id, 'region-eu-west');
  });

  it('assignReport checks the room region', async () => {
    reportRepo.getById.mockResolvedValue({ id: 'rep-1', roomId: ROOM_ID, status: 'PENDING' });
    await service.assignReport(ACTOR, ROOM_ID, 'rep-1', 'assignee-1');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(ACTOR.id, 'region-eu-west');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-report.service.spec.ts`
Expected: FAIL — `scopeService` not injected / not called.

- [ ] **Step 3: Inject `scopeService` (new, required) into the constructor**

```ts
// Add import:
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

// Constructor — insert scopeService as a required param right after `moderation`:
constructor(
  private readonly reportRepo: VideoRoomReportRepository,
  private readonly rooms: VideoRoomsRepository,
  private readonly roles: VideoRoomRolesRepository,
  private readonly permissions: VideoRoomPermissionService,
  private readonly moderationRepo: VideoRoomModerationRepository,
  private readonly metrics: VideoRoomModerationMetrics,
  @InjectQueue(VIDEO_ROOM_MODERATION_QUEUES.REPORT) private readonly queue: Queue,
  @Inject(EVENT_BUS) private readonly bus: IEventBus,
  @Inject(forwardRef(() => VideoRoomModerationService))
  private readonly moderation: VideoRoomModerationService,
  private readonly scopeService: WorkforceScopeService,
  @Optional() private readonly performanceStats?: ModeratorPerformanceService,
  @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
  @Optional() private readonly approvalService?: ModerationApprovalService,
) {}
```

- [ ] **Step 4: Add scope checks to `reviewReport`, `addReportNotes`, `dismissReport`, `assignReport`**

```ts
// reviewReport — fetch room + check unconditionally at the top, reuse for the BAN branch:
async reviewReport(actor: RoomActor, roomId: string, reportId: string, dto: ReviewReportDto, requestMeta?: RequestMetadata): Promise<void> {
  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);

  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }

  const report = await this.reportRepo.getById(reportId);
  if (!report || report.roomId !== ref.id) {
    throw new ReportException(ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND, 'Report not found.', HttpStatus.NOT_FOUND);
  }
  if (report.status !== 'PENDING') {
    throw new ReportException(ERROR_CODES.VIDEO_ROOM_REPORT_NOT_PENDING, 'That report has already been reviewed.', HttpStatus.CONFLICT);
  }

  await this.reportRepo.review(reportId, actor.id, dto.status, dto.resolutionAction);
  await this.moderationRepo.appendAction({
    roomId: ref.id,
    moderatorId: actor.id,
    targetUserId: report.targetUserId,
    action: VideoRoomModerationActionType.REPORT_REVIEWED,
    reason: dto.resolutionAction ?? null,
    metadata: this.auditMetadata({ reportId, status: dto.status, recommendedAction: dto.recommendedAction ?? null }, requestMeta),
  });

  if (dto.recommendedAction) {
    const reason = buildReportReviewReason(reportId, dto.resolutionAction, dto.recommendedAction);
    if (dto.recommendedAction === 'WARNING') {
      await this.moderation.warn(actor, roomId, report.targetUserId, reason, undefined, requestMeta);
    } else if (dto.recommendedAction === 'MUTE') {
      await this.moderation.mute(actor, roomId, { userId: report.targetUserId, type: VideoRoomModerationMuteType.PERMANENT, reason }, requestMeta);
    } else if (dto.recommendedAction === 'KICK') {
      await this.moderation.kick(actor, roomId, report.targetUserId, reason, requestMeta);
    } else if (dto.recommendedAction === 'BAN') {
      if (this.approvalService) {
        await this.approvalService.propose({
          roomType: 'VIDEO_ROOM',
          roomId,
          reportId,
          proposedBy: actor.id,
          targetUserId: report.targetUserId,
          reason,
          regionId: room?.region ?? null,
        });
      }
    }
  }

  await recordReportResolutionIfConfigured(this.performanceStats, actor.id, report.createdAt);

  await this.bus.publish(
    new ReportReviewedEvent({
      roomId: ref.id,
      reportId,
      moderatorId: actor.id,
      targetUserId: report.targetUserId,
      status: dto.status,
      resolutionAction: dto.resolutionAction ?? null,
    }),
  );
}
```

```ts
// addReportNotes:
async addReportNotes(actor: RoomActor, roomId: string, reportId: string, notes: string): Promise<void> {
  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);
  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  await this.reportRepo.updateNotes(reportId, actor.id, notes);
  // ...unchanged from here...
```

```ts
// dismissReport:
async dismissReport(actor: RoomActor, roomId: string, reportId: string, reason?: string): Promise<void> {
  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);
  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const report = await this.reportRepo.getById(reportId);
  // ...unchanged from here...
```

```ts
// assignReport:
async assignReport(actor: RoomActor, roomId: string, reportId: string, assigneeId: string): Promise<void> {
  const ref = await this.requireRoom(roomId);
  await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);
  const room = await this.rooms.findById(roomId);
  if (room?.region) {
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
  const report = await this.reportRepo.getById(reportId);
  // ...unchanged from here...
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-report.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors — `video-rooms.module.ts` already imports `MobileWorkforceModule`, so DI resolves without a module change.

- [ ] **Step 7: Commit**

```bash
git add src/modules/video-rooms/services/video-room-report.service.ts src/modules/video-rooms/services/video-room-report.service.spec.ts
git commit -m "fix: enforce region scope on video-room report lifecycle methods"
```

---

### Task 8: Live-streaming — required `scopeService` (no new checks needed here)

**Files:**
- Modify: `src/modules/live-streaming/services/live-stream.service.ts`
- Test: `src/modules/live-streaming/services/live-stream.service.spec.ts`

**Interfaces:**
- No new checks — `moderateUser`/`escalateViolation` already call `assertModeratorInScope`. This task only removes the `@Optional()` fail-open risk.

- [ ] **Step 1: Reorder the constructor**

```ts
// Old (lines 49-64): scopeService is @Optional(), 2nd of 4 optional params.
// New: scopeService required, inserted right after the last required param (`sockets`):
constructor(
  private readonly prisma: PrismaService,
  private readonly investigationRecording: InvestigationRecordingService,
  private readonly performanceStats: ModeratorPerformanceService,
  private readonly presence: PresenceService,
  private readonly moderationRepo: LiveStreamModerationRepository,
  private readonly sockets: SocketManager,
  private readonly scopeService: WorkforceScopeService,
  @Optional() private readonly auditLog?: AuditLogService,
  @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
  @Optional() private readonly reportRepo?: LiveStreamReportRepository,
) {}
```

Update `moderateUser` (drop the `if (this.scopeService)` guard):

```ts
async moderateUser(input: LiveStreamModerationInput, requestMeta?: RequestMetadata) {
  const stream = await this.getStream(input.streamId);
  if (stream.status !== LiveStreamStatus.ACTIVE) {
    throw new BadRequestException('Cannot moderate a closed stream');
  }

  await this.scopeService.assertModeratorInScope(input.moderatorId, stream.regionId);

  // ...unchanged from here (the "1. Reuse an already-open recording..." comment onward)...
```

Find and update `escalateViolation` the same way (drop its `if (this.scopeService)` guard around its `assertModeratorInScope`/`resolveEscalationRecipients` calls — read the method first at `live-stream.service.ts` around lines 357-397 to apply the same unconditional-call pattern; `resolveEscalationRecipients` doesn't depend on `scopeService` being optional-checked either way since it's now always present).

- [ ] **Step 2: Fix the spec file's constructor call**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep live-stream.service.spec`

Update the main `beforeEach` construction (already shown in research: `subject = new LiveStreamService(prisma, investigationRecording, performanceStats, presence, moderationRepo, sockets, auditLog, scopeService, notifications, reportRepo)`) to the new order:

```ts
subject = new LiveStreamService(
  prisma,
  investigationRecording,
  performanceStats,
  presence,
  moderationRepo,
  sockets,
  scopeService,
  auditLog,
  notifications,
  reportRepo,
);
```

(This file already defines a `scopeService` mock with both `assertModeratorInScope` and `resolveEscalationRecipients` stubbed — reuse it as-is, just move its position in the constructor call.)

- [ ] **Step 3: Add the missing assertion the research found absent**

Add this test (the research explicitly flagged that `moderateUser`'s call to `assertModeratorInScope` was never actually asserted on):

```ts
it('moderateUser checks the stream region before acting', async () => {
  await subject.moderateUser({ streamId: STREAM_ID, moderatorId: MODERATOR_ID, targetUserId: VIEWER_ID, action: 'MUTE' });
  expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MODERATOR_ID, ACTIVE_STREAM.regionId);
});

it('moderateUser rejects a moderator outside the stream region', async () => {
  scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
  await expect(
    subject.moderateUser({ streamId: STREAM_ID, moderatorId: MODERATOR_ID, targetUserId: VIEWER_ID, action: 'MUTE' }),
  ).rejects.toBeInstanceOf(ForbiddenException);
});
```

(Adapt `STREAM_ID`/`MODERATOR_ID`/`VIEWER_ID`/`ACTIVE_STREAM` to whatever fixture names the existing file already uses — the research shows `moderateUser(...)` calls already exist at lines 99/115/125/134/154/163/177/186/262/279-280 using these or equivalent names; place the new tests near one of those, reusing its fixtures.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/live-streaming/services/live-stream.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/live-streaming/services/live-stream.service.ts src/modules/live-streaming/services/live-stream.service.spec.ts
git commit -m "fix: make live-stream scope service required; add missing moderateUser scope test"
```

---

### Task 9: Live-streaming — `live-stream-report.service.ts` `reviewReport`/`addNotes` scope checks

**Files:**
- Modify: `src/modules/live-streaming/services/live-stream-report.service.ts`
- Test: `src/modules/live-streaming/services/live-stream-report.service.spec.ts` (create if it doesn't exist yet — check with Glob first)

**Interfaces:**
- Consumes: `WorkforceScopeService` (already imported in this file, currently `@Optional()`)

- [ ] **Step 1: Write the failing tests**

```ts
import { ForbiddenException } from '@nestjs/common';
import { LiveStreamReportService } from './live-stream-report.service';

describe('LiveStreamReportService region scope enforcement', () => {
  const STREAM_ID = 'stream-1';
  const MODERATOR_ID = 'mod-1';

  let reportRepo: any;
  let liveStream: any;
  let scopeService: { assertModeratorInScope: jest.Mock; resolveModeratorsInScope: jest.Mock };
  let service: LiveStreamReportService;

  beforeEach(() => {
    reportRepo = { getReport: jest.fn(), reviewReport: jest.fn(), addNotes: jest.fn(), findOpenReport: jest.fn(), createReport: jest.fn() };
    liveStream = { getStream: jest.fn().mockResolvedValue({ id: STREAM_ID, regionId: 'region-eu-west' }), moderateUser: jest.fn() };
    scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined), resolveModeratorsInScope: jest.fn().mockResolvedValue([]) };
    service = new LiveStreamReportService(reportRepo, liveStream, scopeService as any);
  });

  it('reviewReport checks the stream region', async () => {
    reportRepo.getReport.mockResolvedValue({ id: 'rep-1', streamId: STREAM_ID, status: 'PENDING', targetUserId: 'target-1', createdAt: new Date() });
    await service.reviewReport({ streamId: STREAM_ID, reportId: 'rep-1', moderatorId: MODERATOR_ID, status: 'REVIEWED' as any });
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MODERATOR_ID, 'region-eu-west');
  });

  it('reviewReport rejects a moderator outside scope', async () => {
    scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      service.reviewReport({ streamId: STREAM_ID, reportId: 'rep-1', moderatorId: MODERATOR_ID, status: 'REVIEWED' as any }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reportRepo.reviewReport).not.toHaveBeenCalled();
  });

  it('addNotes checks the stream region', async () => {
    reportRepo.getReport.mockResolvedValue({ id: 'rep-1', streamId: STREAM_ID });
    await service.addNotes(STREAM_ID, 'rep-1', 'notes');
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(undefined, 'region-eu-west');
  });
});
```

Note the last test: `addNotes(streamId, reportId, notes)` has no `moderatorId` parameter today — see Step 3 for the signature change this requires.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/live-streaming/services/live-stream-report.service.spec.ts`
Expected: FAIL — `scopeService.assertModeratorInScope` not called; `addNotes` signature mismatch.

- [ ] **Step 3: Reorder the constructor, add scope checks**

```ts
// Constructor — scopeService required, right after `liveStream`:
constructor(
  private readonly reportRepo: LiveStreamReportRepository,
  private readonly liveStream: LiveStreamService,
  private readonly scopeService: WorkforceScopeService,
  @Optional() private readonly performanceStats?: ModeratorPerformanceService,
  @Optional() private readonly auditLog?: AuditLogService,
  @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
  @Optional() private readonly approvalService?: ModerationApprovalService,
) {}
```

`fileReport`'s existing `if (this.scopeService && this.moderatorNotify && ...)` guard becomes `if (this.moderatorNotify && ...)` (drop `this.scopeService &&`, since it's always present now):

```ts
if (this.moderatorNotify && HIGH_PRIORITY_REPORT_REASONS.includes(input.reason)) {
  const moderatorIds = await this.scopeService.resolveModeratorsInScope(stream.regionId);
  // ...unchanged...
```

`reviewReport` — fetch the stream unconditionally at the top instead of only inside the BAN branch, check scope, reuse for the BAN proposal:

```ts
async reviewReport(input: ReviewLiveStreamReportInput, requestMeta?: RequestMetadata): Promise<void> {
  const report = await this.reportRepo.getReport(input.reportId);
  if (!report || report.streamId !== input.streamId) {
    throw new NotFoundException('Report not found.');
  }
  if (report.status !== LiveStreamReportStatus.PENDING) {
    throw new ConflictException('That report has already been reviewed.');
  }

  const stream = await this.liveStream.getStream(input.streamId);
  await this.scopeService.assertModeratorInScope(input.moderatorId, stream?.regionId ?? null);

  await this.reportRepo.reviewReport(input.reportId, input.moderatorId, input.status, input.resolution ?? null);

  if (input.recommendedAction) {
    const reason = buildReportReviewReason(input.reportId, input.resolution, input.recommendedAction);
    if (input.recommendedAction === 'BAN') {
      if (this.approvalService) {
        await this.approvalService.propose({
          roomType: 'LIVE_STREAM',
          liveStreamId: input.streamId,
          reportId: input.reportId,
          proposedBy: input.moderatorId,
          targetUserId: report.targetUserId,
          reason,
          regionId: stream?.regionId ?? null,
        });
      }
    } else {
      await this.liveStream.moderateUser({
        streamId: input.streamId,
        moderatorId: input.moderatorId,
        targetUserId: report.targetUserId,
        action: input.recommendedAction,
        reason,
      });
    }
  }

  await recordReportResolutionIfConfigured(this.performanceStats, input.moderatorId, report.createdAt);

  if (this.auditLog) {
    void this.auditLog.logAction({
      actorId: input.moderatorId,
      action: 'live_stream.report_reviewed',
      resource: 'live_stream',
      resourceId: input.streamId,
      targetUserId: report.targetUserId,
      violationReason: input.resolution ?? report.reason,
      ipAddress: requestMeta?.ip,
      userAgent: requestMeta?.userAgent,
      details: { reportId: input.reportId, status: input.status, recommendedAction: input.recommendedAction ?? null },
    });
  }
}
```

`addNotes` — this method currently has no `moderatorId` parameter (`addNotes(streamId, reportId, notes)`), so there's no actor to scope-check against. Add `moderatorId` as a new required parameter (update its one call site — the controller — to pass the authenticated actor's id):

```ts
async addNotes(streamId: string, reportId: string, moderatorId: string, notes: string): Promise<void> {
  const report = await this.reportRepo.getReport(reportId);
  if (!report || report.streamId !== streamId) {
    throw new NotFoundException('Report not found.');
  }
  const stream = await this.liveStream.getStream(streamId);
  await this.scopeService.assertModeratorInScope(moderatorId, stream?.regionId ?? null);
  await this.reportRepo.addNotes(reportId, notes);
}
```

Find `addNotes`'s controller call site (grep `\.addNotes(` under `src/modules/live-streaming/controllers/`) and add the current actor's id as the new 3rd positional argument, using whatever decorator that controller already uses elsewhere for the current user (e.g. `@CurrentUser('id') moderatorId: string`, matching the pattern used by `reviewReport`'s own controller route).

Update the Step-1 test's expectation to match the new signature: `await service.addNotes(STREAM_ID, 'rep-1', MODERATOR_ID, 'notes'); expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MODERATOR_ID, 'region-eu-west');`.

- [ ] **Step 4: Fix any other constructor call sites**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "live-stream-report"`
Fix each resulting error by supplying the new required `scopeService` argument at its correct position.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/live-streaming/services/live-stream-report.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/live-streaming/services/live-stream-report.service.ts src/modules/live-streaming/services/live-stream-report.service.spec.ts src/modules/live-streaming/controllers/live-stream.controller.ts
git commit -m "fix: enforce region scope on live-stream report review/notes"
```

---

### Task 10: `ModerationApprovalService.decide()` — region resolution + scope check

**Files:**
- Modify: `src/modules/moderation-approval/services/moderation-approval.service.ts`
- Test: `src/modules/moderation-approval/services/moderation-approval.service.spec.ts`

**Interfaces:**
- Produces: `private resolveRegion(roomType, roomId, liveStreamId): Promise<string | null>` (new, private)

- [ ] **Step 1: Write the failing tests**

Add to `moderation-approval.service.spec.ts`'s `decide` describe block (the file's `PENDING_ROW` fixture needs `roomType: 'AUDIO_ROOM', roomId: 'room-1', liveStreamId: null` — confirm/add these fields to the existing fixture if not already present):

```ts
it('resolves the region from the audio room and checks the decider is in scope', async () => {
  prisma.audioRoom = { findUnique: jest.fn().mockResolvedValue({ region: 'region-eu-west' }) };
  await service.decide('approval-1', 'official-1', 'APPROVED');
  expect(prisma.audioRoom.findUnique).toHaveBeenCalledWith({ where: { id: 'room-1' }, select: { region: true } });
  expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('official-1', 'region-eu-west');
});

it('resolves the region from the live stream when roomType is LIVE_STREAM', async () => {
  prisma.moderationActionApproval.findUnique.mockResolvedValue({
    ...PENDING_ROW, roomType: 'LIVE_STREAM', roomId: null, liveStreamId: 'stream-1',
  });
  prisma.liveStream = { findUnique: jest.fn().mockResolvedValue({ regionId: 'region-eu-west' }) };
  await service.decide('approval-1', 'official-1', 'APPROVED');
  expect(prisma.liveStream.findUnique).toHaveBeenCalledWith({ where: { id: 'stream-1' }, select: { regionId: true } });
  expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('official-1', 'region-eu-west');
});

it('rejects an Official deciding outside their assigned region', async () => {
  prisma.audioRoom = { findUnique: jest.fn().mockResolvedValue({ region: 'region-eu-west' }) };
  scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
  await expect(service.decide('approval-1', 'official-1', 'APPROVED')).rejects.toBeInstanceOf(ForbiddenException);
  expect(prisma.moderationActionApproval.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/moderation-approval/services/moderation-approval.service.spec.ts -t decide`
Expected: FAIL.

- [ ] **Step 3: Reorder the constructor, add `resolveRegion` + the `decide()` check**

```ts
// Constructor — scopeService required (was already 2nd positionally, just drop @Optional()):
constructor(
  private readonly prisma: PrismaService,
  private readonly scopeService: WorkforceScopeService,
  @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
  @Optional() @Inject(EVENT_BUS) private readonly bus?: IEventBus,
) {}
```

`propose()`'s guard drops `this.scopeService &&`:

```ts
if (this.notifications) {
  const recipients = await this.scopeService.resolveEscalationRecipients('HIGH', input.regionId ?? null);
  // ...unchanged...
```

Add the private resolver and wire it into `decide()`:

```ts
private async resolveRegion(
  roomType: ModerationApprovalRoomType,
  roomId: string | null,
  liveStreamId: string | null,
): Promise<string | null> {
  if (roomType === 'AUDIO_ROOM' && roomId) {
    const room = await this.prisma.audioRoom.findUnique({ where: { id: roomId }, select: { region: true } });
    return room?.region ?? null;
  }
  if (roomType === 'VIDEO_ROOM' && roomId) {
    const room = await this.prisma.videoRoom.findUnique({ where: { id: roomId }, select: { region: true } });
    return room?.region ?? null;
  }
  if (roomType === 'LIVE_STREAM' && liveStreamId) {
    const stream = await this.prisma.liveStream.findUnique({ where: { id: liveStreamId }, select: { regionId: true } });
    return stream?.regionId ?? null;
  }
  return null;
}

async decide(
  approvalId: string,
  deciderId: string,
  decision: ApprovalDecision,
  note?: string,
): Promise<ModerationActionApproval> {
  const approval = await this.getById(approvalId);
  if (approval.status !== 'PENDING') {
    throw new ConflictException('This approval request has already been decided');
  }

  const region = await this.resolveRegion(approval.roomType, approval.roomId, approval.liveStreamId);
  await this.scopeService.assertModeratorInScope(deciderId, region);

  const updated = await this.prisma.moderationActionApproval.update({
    where: { id: approvalId },
    data: { status: decision, decidedBy: deciderId, decidedAt: new Date(), decisionNote: note ?? null },
  });

  // ...unchanged from here (payload / bus.publish / notifications.create)...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/moderation-approval/services/moderation-approval.service.spec.ts`
Expected: PASS — the file's existing `beforeEach` already passes a real `scopeService` mock positionally at arg 2, so no other test in the file breaks.

- [ ] **Step 5: Commit**

```bash
git add src/modules/moderation-approval/services/moderation-approval.service.ts src/modules/moderation-approval/services/moderation-approval.service.spec.ts
git commit -m "fix: enforce region scope on moderation approval decide()"
```

---

### Task 11: Investigation Recording — defense-in-depth scope check in `beginRecording`

**Files:**
- Modify: `src/modules/investigation-recording/investigation-recording.module.ts`
- Modify: `src/modules/investigation-recording/services/investigation-recording.service.ts`
- Test: `src/modules/investigation-recording/services/investigation-recording.service.spec.ts`

**Interfaces:**
- Consumes: `WorkforceScopeService` (new)

- [ ] **Step 1: Write the failing tests**

Add to `investigation-recording.service.spec.ts`:

```ts
describe('beginRecording region scope (defense in depth)', () => {
  it('checks scope when a regionId is provided', async () => {
    await service.beginRecording({ moderatorId: 'mod-1', targetUserId: 'target-1', roomId: 'room-1', regionId: 'region-eu-west' });
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('mod-1', 'region-eu-west');
  });

  it('permits (skips the check) when no regionId is given', async () => {
    await service.beginRecording({ moderatorId: 'mod-1', targetUserId: 'target-1', roomId: 'room-1' });
    expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('mod-1', null);
  });

  it('rejects a moderator outside the given region', async () => {
    scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      service.beginRecording({ moderatorId: 'mod-1', targetUserId: 'target-1', liveStreamId: 'stream-1', regionId: 'region-eu-west' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.investigationRecording.create).not.toHaveBeenCalled();
  });
});
```

Update the file's `beforeEach` to declare and inject the new dependency:

```ts
let scopeService: { assertModeratorInScope: jest.Mock };
// ...inside beforeEach, alongside the existing `prisma` setup:
scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };
service = new InvestigationRecordingService(prisma, scopeService as any);
```

(Add `import { ForbiddenException } from '@nestjs/common';` to the spec file if not already present.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/investigation-recording/services/investigation-recording.service.spec.ts`
Expected: FAIL — `new InvestigationRecordingService(prisma, scopeService)` — too many arguments (current constructor only takes `prisma` + optional `auditLog`).

- [ ] **Step 3: Wire `MobileWorkforceModule` into the module, inject `scopeService`, call it in `beginRecording`**

```ts
// investigation-recording.module.ts:
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { InvestigationRecordingController } from './controllers/investigation-recording.controller';
import { InvestigationRecordingExpiryScheduler } from './services/investigation-recording-expiry.scheduler';
import { InvestigationRecordingService } from './services/investigation-recording.service';

@Module({
  imports: [PrismaModule, MobileWorkforceModule],
  controllers: [InvestigationRecordingController],
  providers: [InvestigationRecordingService, InvestigationRecordingExpiryScheduler],
  exports: [InvestigationRecordingService],
})
export class InvestigationRecordingModule {}
```

```ts
// investigation-recording.service.ts — add import + reorder constructor
// (scopeService required, right after prisma — auditLog stays @Optional()):
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

constructor(
  private readonly prisma: PrismaService,
  private readonly scopeService: WorkforceScopeService,
  @Optional() private readonly auditLog?: AuditLogService,
) {}

async beginRecording(input: BeginRecordingInput) {
  await this.scopeService.assertModeratorInScope(input.moderatorId, input.regionId ?? null);

  const evidenceId = `EVD-${randomUUID().toUpperCase().replace(/-/g, '').slice(0, 16)}`;

  const recording = await this.prisma.investigationRecording.create({
    data: {
      evidenceId,
      moderatorId: input.moderatorId,
      targetUserId: input.targetUserId,
      roomId: input.roomId ?? null,
      liveStreamId: input.liveStreamId ?? null,
      regionId: input.regionId ?? null,
      violationReason: input.violationReason ?? null,
      evidencePayload: (input.evidencePayload as Prisma.InputJsonValue) ?? undefined,
      status: 'ACTIVE',
    },
  });

  this.logger.debug(`Investigation recording started: ${recording.evidenceId}`);
  return recording;
}
```

Note: this deliberately does **not** thread `regionId` through the 8 Audio/Video Room `beginRecording` call sites (they currently omit it) — those calls will pass `undefined`, which permits (matches the documented null-region safety valve, same as every other check in this plan). Only Live Stream's existing call site (which already passes `stream.regionId`) exercises this check today; it stands as defense-in-depth for any future/direct caller, consistent with requirement A's "if given Moderator-specific context, it may validate" — not a mandate to retrofit every existing caller.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/investigation-recording/services/investigation-recording.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + run the full unit suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest`
Expected: no errors; every spec file touched in Tasks 1-11 passes.

- [ ] **Step 6: Commit**

```bash
git add src/modules/investigation-recording/investigation-recording.module.ts src/modules/investigation-recording/services/investigation-recording.service.ts src/modules/investigation-recording/services/investigation-recording.service.spec.ts
git commit -m "feat: add defense-in-depth region scope check to InvestigationRecordingService.beginRecording"
```

---

### Task 12: Dashboard — `regionalDailyActivity()` report counts scoped by target resource

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Test: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- No new public methods — `regionalDailyActivity`'s return shape (`assignedReportsCount`, etc.) is unchanged; only how `assignedReportsCount` is computed changes.

- [ ] **Step 1: Update the mock `prisma` object and write the failing tests**

Add `liveStreamReport: { count: jest.fn().mockResolvedValue(0) }` to the spec file's top-level `prisma` mock (Step required per the research finding — omitting this makes any new `liveStreamReport.count` call throw `Cannot read properties of undefined`). Add `videoRoom: { findMany: jest.fn().mockResolvedValue([]) }` if not already present (it already is, per the mock object shown in research — confirm and reuse). Add `audioRoom.findMany` id-only support if the existing mock only stubs it for the `assignedAudioRooms` call — it's the same mock function, called twice now (once for the id list, once for the display list), so no new mock is needed, just more calls recorded.

Replace the existing `'scopes rooms by owner-in-region and streams/investigations by regionId'` test's `roomReport.count` assertion, and add new cases:

```ts
it('scopes report counts by the target room/stream region, not the reporter', async () => {
  prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);
  scope.userScopeFilter.mockResolvedValue({ OR: [{ regionId: 'r-1' }] });
  prisma.audioRoom.findMany.mockResolvedValue([{ id: 'room-a' }, { id: 'room-b' }]);
  prisma.videoRoom.findMany.mockResolvedValue([{ id: 'vroom-a' }]);
  prisma.liveStream.findMany.mockResolvedValue([{ id: 'stream-a' }]);

  await service.regionalDailyActivity('mod-1');

  expect(prisma.roomReport.count).toHaveBeenCalledWith({ where: { roomId: { in: ['room-a', 'room-b'] } } });
  expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({ where: { roomId: { in: ['vroom-a'] } } });
  expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({ where: { streamId: { in: ['stream-a'] } } });
});

it('is unrestricted for platform staff: counts all reports with no id filter', async () => {
  scope.userScopeFilter.mockResolvedValue({});
  await service.regionalDailyActivity('admin-1');
  expect(prisma.roomReport.count).toHaveBeenCalledWith({ where: {} });
  expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({ where: {} });
  expect(prisma.liveStreamReport.count).toHaveBeenCalledWith({ where: {} });
});

it('assignedReportsCount is the sum across all three report surfaces', async () => {
  scope.userScopeFilter.mockResolvedValue({});
  prisma.roomReport.count.mockResolvedValue(3);
  prisma.videoRoomReport.count.mockResolvedValue(2);
  prisma.liveStreamReport.count.mockResolvedValue(1);
  const result = await service.regionalDailyActivity('admin-1');
  expect(result.assignedReportsCount).toBe(6);
});
```

Remove/replace the old test at the researched lines (`'scopes rooms by owner-in-region and streams/investigations by regionId'`'s `expect(prisma.roomReport.count).toHaveBeenCalledWith({ where: { reporterId: { in: ['u-1', 'u-2'] } } });` line) since that assertion is superseded by the new region-based expectation above — keep the rest of that test (the `audioRoom.findMany`/`liveStream.findMany`/`investigationRecording.count` assertions) unchanged, since `ownerFilter`/`investigationLocationFilter`/`streamLocationFilter` aren't touched by this task.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts -t "regionalDailyActivity"`
Expected: FAIL.

- [ ] **Step 3: Rewrite the report-count portion of `regionalDailyActivity`**

```ts
async regionalDailyActivity(userId: string, resolvedScope?: ResolvedUserScope) {
  const { scopeWhere, isUnrestricted, inScopeUserIds } =
    resolvedScope ?? (await this.resolveUserScope(userId));
  const ownerFilter = inScopeUserIds !== null ? { ownerId: { in: inScopeUserIds } } : {};

  const scopeClauses = isUnrestricted || !('OR' in scopeWhere) ? [] : scopeWhere.OR;
  const streamLocationFilter = isUnrestricted
    ? {}
    : {
        OR: scopeClauses.map((clause) => {
          const out: Record<string, unknown> = {};
          if ('countryId' in clause) out['countryId'] = clause['countryId'];
          if ('stateId' in clause) out['stateId'] = clause['stateId'];
          if ('regionId' in clause) out['regionId'] = clause['regionId'];
          return out;
        }),
      };
  const investigationLocationFilter = isUnrestricted
    ? {}
    : {
        OR: scopeClauses.flatMap((clause) =>
          'regionId' in clause ? [{ regionId: clause['regionId'] as string }] : [],
        ),
      };
  // AudioRoom/VideoRoom store only a flat `region` snapshot column (no
  // separate state/country columns), so only regionId-level scope clauses
  // can match them — same limitation investigationLocationFilter already
  // has, and for the same reason.
  const roomRegionFilter = isUnrestricted
    ? {}
    : {
        OR: scopeClauses.flatMap((clause) =>
          'regionId' in clause ? [{ region: clause['regionId'] as string }] : [],
        ),
      };

  const [
    inScopeAudioRoomIds,
    inScopeVideoRoomIds,
    inScopeLiveStreamIds,
    assignedInvestigationQueueCount,
    assignedAudioRooms,
    assignedVideoRooms,
    assignedLiveStreams,
  ] = await Promise.all([
    isUnrestricted ? Promise.resolve(null) : this.prisma.audioRoom.findMany({ where: roomRegionFilter, select: { id: true } }),
    isUnrestricted ? Promise.resolve(null) : this.prisma.videoRoom.findMany({ where: roomRegionFilter, select: { id: true } }),
    isUnrestricted ? Promise.resolve(null) : this.prisma.liveStream.findMany({ where: streamLocationFilter, select: { id: true } }),
    this.prisma.investigationRecording.count({ where: { status: 'ACTIVE', ...investigationLocationFilter } }),
    this.prisma.audioRoom.findMany({
      where: { ...ownerFilter, status: 'LIVE' },
      select: { id: true, name: true, status: true, ownerId: true },
      take: 25,
    }),
    this.prisma.videoRoom.findMany({
      where: { ...ownerFilter, status: 'LIVE' },
      select: { id: true, name: true, status: true, ownerId: true },
      take: 25,
    }),
    this.prisma.liveStream.findMany({
      where: { status: 'ACTIVE', ...streamLocationFilter },
      select: { id: true, title: true, status: true, hostId: true },
      take: 25,
    }),
  ]);

  const [roomReportsCount, videoRoomReportsCount, liveStreamReportsCount] = await Promise.all([
    this.prisma.roomReport.count({
      where: inScopeAudioRoomIds === null ? {} : { roomId: { in: inScopeAudioRoomIds.map((r) => r.id) } },
    }),
    this.prisma.videoRoomReport.count({
      where: inScopeVideoRoomIds === null ? {} : { roomId: { in: inScopeVideoRoomIds.map((r) => r.id) } },
    }),
    this.prisma.liveStreamReport.count({
      where: inScopeLiveStreamIds === null ? {} : { streamId: { in: inScopeLiveStreamIds.map((r) => r.id) } },
    }),
  ]);
  const assignedReportsCount = roomReportsCount + videoRoomReportsCount + liveStreamReportsCount;

  return {
    assignedReportsCount,
    assignedInvestigationQueueCount,
    assignedAudioRooms,
    assignedVideoRooms,
    assignedLiveStreams,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "fix: scope dashboard report counts by target room/stream region, not reporter location"
```

---

### Task 13: Seed data — additional regions for multi-region testing

**Files:**
- Modify: `prisma/seed-rbac.ts`

- [ ] **Step 1: Add Andhra Pradesh/Vijayawada and Tamil Nadu/Chennai**

Insert right after the existing Bengaluru block (after the `console.log('Geographic reference data seeded successfully.');` line, or immediately before it — place all geography upserts together):

```ts
const stateAP = await prisma.state.upsert({
  where: { countryId_code: { countryId: country.id, code: 'AP' } },
  create: { countryId: country.id, code: 'AP', name: 'Andhra Pradesh' },
  update: { name: 'Andhra Pradesh' },
});

await prisma.region.upsert({
  where: { stateId_code: { stateId: stateAP.id, code: 'VJA' } },
  create: { stateId: stateAP.id, code: 'VJA', name: 'Vijayawada Region' },
  update: { name: 'Vijayawada Region' },
});

const stateTN = await prisma.state.upsert({
  where: { countryId_code: { countryId: country.id, code: 'TN' } },
  create: { countryId: country.id, code: 'TN', name: 'Tamil Nadu' },
  update: { name: 'Tamil Nadu' },
});

await prisma.region.upsert({
  where: { stateId_code: { stateId: stateTN.id, code: 'CHN' } },
  create: { stateId: stateTN.id, code: 'CHN', name: 'Chennai Region' },
  update: { name: 'Chennai Region' },
});
```

- [ ] **Step 2: Run it against the local dev DB and verify**

Run: `npx ts-node prisma/seed-rbac.ts`
Expected: console output includes `Geographic reference data seeded successfully.` with no errors; verify via `npx prisma studio` or a quick query that `Region` now has 3 rows (Bengaluru, Vijayawada, Chennai).

- [ ] **Step 3: Commit**

```bash
git add prisma/seed-rbac.ts
git commit -m "feat: seed Vijayawada and Chennai regions for multi-region testing"
```

---

### Task 14: Seed data — e2e fixtures: rooms per region, moderator scoped to 2 regions

**Files:**
- Modify: `prisma/seed-e2e-fixtures.ts`

- [ ] **Step 1: Extend the fixture script**

Replace the moderator's `scope` field (currently a single `{ type: ScopeType.REGION, regionCode: 'BLR' }`) and add room/stream fixtures. Since the existing `Fixture` interface only supports a single scope, extend it to support an array, and handle the moderator specially:

```ts
// Change the Fixture interface's scope field to an array:
interface Fixture {
  username: string;
  email: string;
  role: string | null;
  scopes?: Array<{ type: ScopeType; countryCode?: string; stateCode?: string; regionCode?: string }>;
  note: string;
}
```

Update every existing fixture's `scope:` key to `scopes: [{ ... }]` (wrap the single object in an array) — e.g. the Country Manager fixture becomes `scopes: [{ type: ScopeType.COUNTRY, countryCode: 'IN' }]`, the Official becomes `scopes: [{ type: ScopeType.STATE, stateCode: 'KA' }]`. The Moderator fixture becomes:

```ts
{
  username: 'e2e_moderator',
  email: 'moderator@e2e.test',
  role: 'MODERATOR',
  scopes: [
    { type: ScopeType.REGION, regionCode: 'BLR' },
    { type: ScopeType.REGION, regionCode: 'VJA' },
  ],
  note: 'scoped to Bengaluru + Vijayawada',
},
```

Add region lookups for AP/Vijayawada and TN/Chennai right after the existing `region` lookup:

```ts
const stateAP = await prisma.state.findFirst({ where: { countryId: country.id, code: 'AP' } });
const regionVJA = await prisma.region.findFirst({ where: { stateId: stateAP!.id, code: 'VJA' } });
const stateTN = await prisma.state.findFirst({ where: { countryId: country.id, code: 'TN' } });
const regionCHN = await prisma.region.findFirst({ where: { stateId: stateTN!.id, code: 'CHN' } });
if (!regionVJA || !regionCHN) throw new Error('Run seed-rbac.ts first — Vijayawada/Chennai regions are missing.');
```

Update the region-code-to-id resolution helper used inside the fixture loop (the block building `data:` for `roleScope.create`) to look up by code across all three known regions rather than only `region`/`BLR`:

```ts
const REGION_BY_CODE: Record<string, { id: string; stateId: string; countryId: string }> = {
  BLR: { id: region!.id, stateId: state!.id, countryId: country.id },
  VJA: { id: regionVJA.id, stateId: stateAP!.id, countryId: country.id },
  CHN: { id: regionCHN.id, stateId: stateTN!.id, countryId: country.id },
};
```

Replace the fixture loop's single-scope `roleScope.create` block with one that iterates `fixture.scopes` and creates a row per entry (guarding against duplicates the same way the original did, now per-scope rather than per-fixture):

```ts
for (const scopeEntry of fixture.scopes ?? []) {
  const existing = await prisma.roleScope.findFirst({
    where: {
      userRoleId: userRole.id,
      scopeType: scopeEntry.type,
      ...(scopeEntry.regionCode ? { regionId: REGION_BY_CODE[scopeEntry.regionCode].id } : {}),
    },
  });
  if (existing) continue;
  await prisma.roleScope.create({
    data: {
      userRoleId: userRole.id,
      scopeType: scopeEntry.type,
      countryId: scopeEntry.countryCode ? country.id : null,
      stateId: scopeEntry.stateCode ? state!.id : scopeEntry.regionCode ? REGION_BY_CODE[scopeEntry.regionCode].stateId : null,
      regionId: scopeEntry.regionCode ? REGION_BY_CODE[scopeEntry.regionCode].id : null,
    },
  });
}
```

Add one `AudioRoom` per region right after the fixture loop, before the final `console.log`, so the e2e spec has real region-tagged rooms to hit (owner is the `e2e_pop_blr` population user, reused across all three so ownership rules stay simple):

```ts
const owner = await prisma.user.findUnique({ where: { email: 'pop.blr@e2e.test' } });
if (!owner) throw new Error('Population fixtures must run before room fixtures.');

const ROOMS = [
  { slug: 'blr', region: region!.id },
  { slug: 'vja', region: regionVJA.id },
  { slug: 'chn', region: regionCHN.id },
];
for (const r of ROOMS) {
  await prisma.audioRoom.upsert({
    where: { agoraChannel: `e2e-room-${r.slug}` },
    create: {
      ownerId: owner.id,
      name: `E2E Room ${r.slug.toUpperCase()}`,
      maxParticipants: 10,
      agoraChannel: `e2e-room-${r.slug}`,
      status: 'LIVE',
      region: r.region,
    },
    update: { region: r.region, status: 'LIVE' },
  });
}
console.log(`Rooms seeded: ${ROOMS.length} (one per region)`);
```

- [ ] **Step 2: Run it against the local dev DB and verify**

Run: `npx ts-node prisma/seed-rbac.ts && npx ts-node prisma/seed-e2e-fixtures.ts`
Expected: console output ends with `All fixtures share the password: E2ePass!2026` and no errors; verify the moderator has 2 `RoleScope` rows and 3 `AudioRoom` rows exist with the expected `region` values (e.g. via `npx prisma studio`).

- [ ] **Step 3: Commit**

```bash
git add prisma/seed-e2e-fixtures.ts
git commit -m "feat: seed e2e moderator with 2-region scope and one room per region"
```

---

### Task 15: `seed:e2e` npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `dotenv-cli` and the script**

Run: `npm install --save-dev dotenv-cli`

Add to `package.json`'s `scripts` block, right after `"prisma:format"`:

```json
"seed:e2e": "dotenv -e .env.e2e -- npx prisma migrate deploy && dotenv -e .env.e2e -- npx ts-node prisma/seed-rbac.ts && dotenv -e .env.e2e -- npx ts-node prisma/seed-e2e-fixtures.ts"
```

- [ ] **Step 2: Run it and verify against the e2e DB specifically**

Run: `npm run seed:e2e`
Expected: migrations apply (or report already-applied) against `soulzaa_e2e` (port 5433, per `.env.e2e`), both seed scripts complete successfully. Spot-check with `psql postgresql://nasinaudaysankar@127.0.0.1:5433/soulzaa_e2e -c "select code,name from regions;"` (or via Prisma Studio pointed at `.env.e2e`) that Bengaluru/Vijayawada/Chennai all exist in the **e2e** database, confirming the script targeted the right instance and not the primary dev DB.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add seed:e2e script for the dedicated e2e database"
```

---

### Task 16: E2E test suite — the 12 required scenarios

**Files:**
- Create: `test/moderator-region-scope.e2e-spec.ts`

**Interfaces:**
- Consumes: `POST /api/staff/auth/login` (existing), `PUT /api/admin-identity/moderators/:id/regions` (Task 3), every REST moderation endpoint touched in Tasks 4-11.

- [ ] **Step 1: Write the spec skeleton and the login helper**

```ts
// test/moderator-region-scope.e2e-spec.ts
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Proves RoleScope — not User.regionId — gates Moderator access, across
 * one-region, multi-region, and revoked-region cases. Requires `npm run
 * seed:e2e` to have run against the DATABASE_URL/REDIS_URL in .env.e2e first
 * (the e2e Postgres on port 5433 — never the primary dev DB).
 */
describe('Moderator region scope enforcement (e2e)', () => {
  let app: INestApplication;
  let moderatorToken: string;
  let officialToken: string;
  let adminToken: string;

  async function loginAs(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/staff/auth/login')
      .send({ email, password: 'E2ePass!2026' });
    expect(res.status).toBe(200);
    return res.body.data.tokens.accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'metrics'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    moderatorToken = await loginAs('moderator@e2e.test');
    officialToken = await loginAs('official@e2e.test');
    adminToken = await loginAs('admin@e2e.test');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // Scenarios follow in later steps of this task.
});
```

- [ ] **Step 2: Run it to verify the login helper works**

Run: `npm run seed:e2e && npx dotenv -e .env.e2e -- npx jest --config ./test/jest-e2e.json moderator-region-scope`
Expected: PASS (no scenario tests yet, just `beforeAll` succeeding — if it fails on login, re-check `npm run seed:e2e` ran against the same DB the test's `AppModule` boots against; `test/jest-e2e.json`'s `AppModule` reads `DATABASE_URL`/`REDIS_URL` from whatever `.env` NestJS's `ConfigModule` loads by default — confirm this test run also exports `.env.e2e`'s values into the process env before `jest` starts, e.g. run via `dotenv -e .env.e2e -- npx jest --config ./test/jest-e2e.json moderator-region-scope`, matching the pattern used in `seed:e2e`).

- [ ] **Step 3: Add scenarios 1-3 (profile independence, single-region access, multi-region access)**

I need the actual room ids seeded in Task 14 — since `agoraChannel` is deterministic (`e2e-room-blr`/`e2e-room-vja`/`e2e-room-chn`), look them up once in `beforeAll` instead of hardcoding ids:

```ts
// Add to the top-level describe, alongside the token variables:
let roomIds: { blr: string; vja: string; chn: string };

// Add to beforeAll, after the three loginAs calls — fetch room ids via the
// existing audio-rooms discovery endpoint filtered by name, or (simpler and
// more direct for a fixture-driven test) query them straight from Prisma:
import { PrismaClient } from '@prisma/client';
// ...
const prisma = new PrismaClient();
const rooms = await prisma.audioRoom.findMany({
  where: { agoraChannel: { in: ['e2e-room-blr', 'e2e-room-vja', 'e2e-room-chn'] } },
  select: { id: true, agoraChannel: true },
});
roomIds = {
  blr: rooms.find((r) => r.agoraChannel === 'e2e-room-blr')!.id,
  vja: rooms.find((r) => r.agoraChannel === 'e2e-room-vja')!.id,
  chn: rooms.find((r) => r.agoraChannel === 'e2e-room-chn')!.id,
};
await prisma.$disconnect();
```

```ts
describe('scenarios 1-3: profile independence, single and multi region access', () => {
  it('1. moderator profile region is untouched by operational region assignment', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/organization/users/me/location') // adjust to whatever the actual "my profile location" read route is if named differently — see src/modules/organization/controllers/user-location.controller.ts
      .set('Authorization', `Bearer ${moderatorToken}`);
    // Profile geography was never set by provisioning/region assignment in this suite — assert it stays null, not silently populated to match the operational scope.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.data.regionId).not.toBe(roomIds.blr);
    }
  });

  it('2 & 3. moderator can join/observe the Bengaluru room (assigned region)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audio-rooms/${roomIds.blr}`)
      .set('Authorization', `Bearer ${moderatorToken}`);
    expect(res.status).toBe(200);
  });
});
```

(The exact profile-location read route in scenario 1 must be confirmed against `src/modules/organization/controllers/user-location.controller.ts` at implementation time — adjust the path if it differs from the guess above; the assertion's intent — profile geography is untouched — is what matters, not the exact route shape.)

- [ ] **Step 4: Add scenarios 4-6 (multi-region access, deny, revoke)**

```ts
describe('scenarios 4-6: multi-region access, deny, and revoke', () => {
  it('4. moderator can act on the Vijayawada room (second assigned region)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.vja}/moderation/warn/some-target-user-id`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reason: 'e2e scenario 4' });
    // Room membership/target-existence errors are acceptable (404/400) — a
    // 403 ForbiddenException specifically would mean the region check itself
    // rejected the assigned region, which is the failure this test guards against.
    expect(res.status).not.toBe(403);
  });

  it('5. moderator cannot act on the Chennai room (unassigned region)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.chn}/moderation/warn/some-target-user-id`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reason: 'e2e scenario 5' });
    expect(res.status).toBe(403);
  });

  it('6. removing the Vijayawada RoleScope immediately revokes access', async () => {
    const moderatorId = await getModeratorUserId(); // helper below
    await request(app.getHttpServer())
      .put(`/api/admin-identity/moderators/${moderatorId}/regions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ regionIds: [/* Bengaluru region id only */] });

    const res = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.vja}/moderation/warn/some-target-user-id`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reason: 'e2e scenario 6 — should now be denied' });
    expect(res.status).toBe(403);

    // Restore full scope so later scenarios in this file aren't affected by ordering.
    await request(app.getHttpServer())
      .put(`/api/admin-identity/moderators/${moderatorId}/regions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ regionIds: [/* Bengaluru + Vijayawada region ids */] });
  });
});
```

Add a `getModeratorUserId`/region-id-lookup helper in `beforeAll` alongside the room-id lookup (query `prisma.user.findUnique({ where: { email: 'moderator@e2e.test' } })` for the id, and `prisma.region.findFirst({ where: { code: 'BLR' | 'VJA' } })` for the two region ids), assigning them to `let` variables declared at the top of the `describe` block so every scenario can reference them.

- [ ] **Step 5: Add scenarios 7-9 (REST moderation ops, report ops, restorative ops)**

```ts
describe('scenarios 7-9: moderation actions, reports, and restorative actions all enforce scope', () => {
  it('7. kick on the unassigned Chennai room is denied', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.chn}/moderation/kick/some-target-user-id`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reason: 'e2e scenario 7' });
    expect(res.status).toBe(403);
  });

  it('8. dismissing a report on the unassigned Chennai room is denied', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.chn}/moderation/reports/some-report-id/dismiss`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reason: 'e2e scenario 8' });
    expect(res.status).toBe(403);
  });

  it('9. unkick on the unassigned Chennai room is denied (restorative action regression guard)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.chn}/moderation/unkick/some-target-user-id`)
      .set('Authorization', `Bearer ${moderatorToken}`);
    expect(res.status).toBe(403);
  });
});
```

(Adjust each route path against the real controller decorators in `src/modules/audio-rooms/controllers/moderation.controller.ts` at implementation time if any differ from the guesses above.)

- [ ] **Step 6: Add scenarios 10-11 (Official approval, investigation recording)**

```ts
describe('scenarios 10-11: approval decisions and investigation recording respect scope', () => {
  it("10. an Official scoped to Karnataka cannot decide an approval whose room is in Chennai (Tamil Nadu)", async () => {
    // Requires a PENDING ModerationActionApproval row for the Chennai room —
    // seed one via the report-review BAN-recommendation flow first (moderator
    // reviews a report on the Chennai room with recommendedAction: 'BAN'),
    // or seed it directly via Prisma in this test's own setup if that flow
    // requires state not otherwise present in this suite.
    // Then:
    const res = await request(app.getHttpServer())
      .put(`/api/moderation-approval/<approval-id>/decide`) // confirm exact route in moderation-approval.controller.ts
      .set('Authorization', `Bearer ${officialToken}`)
      .send({ decision: 'APPROVED' });
    expect(res.status).toBe(403);
  });

  it('11. investigation recordings created via a scoped kick are retrievable and carry no bypass', async () => {
    const kickRes = await request(app.getHttpServer())
      .post(`/api/audio-rooms/${roomIds.blr}/moderation/kick/some-other-target-user-id`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reason: 'e2e scenario 11' });
    expect(kickRes.status).not.toBe(403);

    const listRes = await request(app.getHttpServer())
      .get('/api/investigation-recordings/mine')
      .set('Authorization', `Bearer ${moderatorToken}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data.items)).toBe(true);
  });
});
```

(Scenario 10's exact setup — creating a PENDING approval row for a Chennai-region room — and both scenarios' exact route paths must be confirmed against `src/modules/moderation-approval/controllers/moderation-approval.controller.ts` and `src/modules/investigation-recording/controllers/investigation-recording.controller.ts` at implementation time; the assertions are the fixed target, the setup mechanics are the part to verify against real routes.)

- [ ] **Step 7: Add scenario 12 (dashboard)**

```ts
describe('scenario 12: dashboard is restricted to operational scope', () => {
  it('12. moderator dashboard reflects only Bengaluru + Vijayawada, never Chennai', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/mobile/workforce/me/dashboard')
      .set('Authorization', `Bearer ${moderatorToken}`);
    expect(res.status).toBe(200);
    const roomIdsInDashboard = (res.body.data.dailyActivity?.assignedAudioRooms ?? []).map((r: any) => r.id);
    expect(roomIdsInDashboard).not.toContain(roomIds.chn);
  });
});
```

- [ ] **Step 8: Run the full e2e file**

Run: `npm run seed:e2e && dotenv -e .env.e2e -- npx jest --config ./test/jest-e2e.json moderator-region-scope`
Expected: PASS, 12+ tests. Fix any route-path guesses flagged above against the real controllers as they surface as 404s rather than the expected 403/200 — the failure mode (404 instead of 403) is the signal that a path needs correcting, not that the scope enforcement itself is wrong.

- [ ] **Step 9: Wire `test:e2e` to run this file by default and document the prerequisite**

No `jest-e2e.json` change needed — `testRegex: ".e2e-spec.ts$"` already picks up the new file automatically alongside `app.e2e-spec.ts`. Add a short README note (or a comment at the top of this new file, already present from Step 1) stating `npm run seed:e2e` must run first, since `npm run test:e2e` itself doesn't seed — this suite is idempotent (upserts) but not self-seeding, matching how `app.e2e-spec.ts` already assumes a reachable, already-migrated database.

- [ ] **Step 10: Commit**

```bash
git add test/moderator-region-scope.e2e-spec.ts
git commit -m "test: add e2e suite proving RoleScope-based moderator region enforcement"
```

---

### Task 17: Frontend — multi-select region UI + region editing

**Files:**
- Modify: `packages/shared/src/api/endpoints.ts`
- Modify: `packages/shared/src/modules/ModeratorManagementModule.tsx`

**Interfaces:**
- Consumes: `PUT`/`GET /admin-identity/moderators/:id/regions` (Task 3)

- [ ] **Step 1: Add the two endpoint wrappers**

In `endpoints.ts`, extend the existing `moderators` block:

```ts
moderators: {
  list: () => api.get<any>('/admin-identity/moderators'),
  create: (body: any) => api.post<any>('/admin-identity/moderators', body),
  setStatus: (id: string, status: string) => api.patch<any>(`/admin-identity/moderators/${id}/status`, { status }),
  getRegions: (id: string) => api.get<{ regionIds: string[] }>(`/admin-identity/moderators/${id}/regions`),
  setRegions: (id: string, regionIds: string[]) =>
    api.put<{ regionIds: string[] }>(`/admin-identity/moderators/${id}/regions`, { regionIds }),
},
```

- [ ] **Step 2: Change the provisioning form's region field to multi-select**

In `ModeratorManagementModule.tsx`, change `regionId`/`setRegionId` (a single string) to `regionIds`/`setRegionIds` (a string array), and replace the `<select>` with a checkbox list, matching the shift-days checkbox pattern already used lower in the same form:

```tsx
// Replace:
const [regionId, setRegionId]   = useState('');
// With:
const [regionIds, setRegionIds] = useState<string[]>([]);

function toggleRegion(id: string) {
  setRegionIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
}
```

```tsx
// Replace the <select> block for Region with:
<div>
  <label style={labelStyle}>Regions <span style={{ color: 'var(--faint)' }}>(country is derived automatically; select one or more)</span></label>
  {geographyTree.error && (
    <ErrorNote message={geographyTree.error} onRetry={geographyTree.reload} />
  )}
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', maxHeight: 200, overflowY: 'auto' }}>
    {regionOptions.map((option) => (
      <label key={option.id} style={{ fontSize: 'var(--step--1)', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <input type="checkbox" checked={regionIds.includes(option.id)} onChange={() => toggleRegion(option.id)} />
        {option.label}
      </label>
    ))}
  </div>
  {geographyTree.data && regionOptions.length === 0 && (
    <p style={{ fontSize: 'var(--step--1)', color: 'var(--faint)', marginTop: 'var(--space-1)' }}>
      No active regions found. Create one under Organization → Geography first.
    </p>
  )}
</div>
```

Update `handleCreate`'s validation and payload:

```tsx
if (!email.trim() || !password || regionIds.length === 0) {
  setNotice({ kind: 'error', text: 'Email, password and at least one region are all required.' });
  return;
}
// ...
const result = await endpoints.superAdmin.moderators.create({
  email: email.trim(),
  password,
  regionIds,
  shiftStartHour: start.hour,
  shiftStartMinute: start.minute,
  shiftEndHour: end.hour,
  shiftEndMinute: end.minute,
  shiftDaysOfWeek: shiftDays,
});
// ...
setNotice({
  kind: 'ok',
  text: `Moderator account "${result.username}" (${result.email}) provisioned successfully — assigned to ${result.regionIds.length} region(s).`,
});
setEmail('');
setPassword('');
setRegionIds([]);
```

- [ ] **Step 3: Add a "Regions" edit action to the Directory tab**

Add state for the regions-editor panel, alongside the existing `ipsTargetId`:

```tsx
const [regionsTargetId, setRegionsTargetId] = useState<string | undefined>(undefined);
const [editingRegionIds, setEditingRegionIds] = useState<string[]>([]);
const [regionsSaving, setRegionsSaving] = useState(false);

async function openRegionsEditor(moderatorId: string) {
  setRegionsTargetId(moderatorId);
  setActiveTab('editRegions' as any); // extend ModeratorTab union with 'editRegions'
  const current = await endpoints.superAdmin.moderators.getRegions(moderatorId);
  setEditingRegionIds(current.regionIds);
}

async function saveRegions() {
  if (!regionsTargetId) return;
  setRegionsSaving(true);
  try {
    await endpoints.superAdmin.moderators.setRegions(regionsTargetId, editingRegionIds);
    setNotice({ kind: 'ok', text: 'Regions updated.' });
    setActiveTab('directory');
  } catch (err) {
    setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to update regions.' });
  } finally {
    setRegionsSaving(false);
  }
}
```

Extend `ModeratorTab` to include `'editRegions'`, add a "Regions" button in the Directory table's Actions column next to the existing "IPs" button:

```tsx
<button
  onClick={() => openRegionsEditor(row.id)}
  style={{ ...buttonStyle, padding: '2px 8px', fontSize: 'var(--step--1)' }}
>
  Regions
</button>
```

Add a new `activeTab === 'editRegions'` panel (mirrors the create-tab's region checkbox list, bound to `editingRegionIds`/a `toggleEditingRegion` helper, with a "Save" button calling `saveRegions()` and a "Cancel" button returning to `'directory'`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` (in `packages/shared`)
Expected: no errors.

- [ ] **Step 5: Manual verification**

Start the admin dev server, provision a moderator with 2 regions selected, confirm the success message reports 2 regions, open the Directory, click "Regions" on that moderator, confirm both checkboxes are pre-checked, uncheck one, save, reopen — confirm only 1 remains checked.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/api/endpoints.ts packages/shared/src/modules/ModeratorManagementModule.tsx
git commit -m "feat: multi-region moderator provisioning + region editing in admin panel"
```

---

## Self-Review Notes (completed during plan authoring)

- **Spec coverage:** every numbered item in the spec's Design §1-§7 and §3a maps to a task above (Task 1-3 → §1/§2; Tasks 4-11 → §3/§3a; Task 12 → §4; Task 17 → §5; Tasks 13-14 → §6; Tasks 15-16 → §7). The three review-requested points (profile-geography independence, null-region verification, required-dependency fail-closed) are each addressed at their specific call sites rather than as a single generic task, since they're cross-cutting properties of every other task.
- **Placeholder scan:** every task's code steps use the actual current code (gathered via direct file reads this session) as the "old" side of each diff, and a concrete "new" side — no "add appropriate handling" language. The three spots that name an uncertain exact route/field (Task 16 scenarios 1/8/10/11, Task 9's `escalateViolation` line numbers) are flagged explicitly as "confirm against the real file" rather than left silently assumed, consistent with the spec's own "Open questions for plan-time verification" list.
- **Type consistency:** `assertModeratorInScope(actorId: string, regionId: string | null)` is called with that exact signature in every task; `setModeratorRegions(userId: string, regionIds: string[], actorId: string): Promise<{ regionIds: string[] }>` (Task 1) is the exact signature `createModerator` (Task 2) and the controller (Task 3) both consume; `SetModeratorRegionsDto.regionIds: string[]` (Task 1) matches the controller's `@Body() dto: SetModeratorRegionsDto` (Task 3) and the frontend's `regionIds: string[]` state (Task 17).
