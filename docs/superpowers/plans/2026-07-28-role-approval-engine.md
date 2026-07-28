# Role Approval & Lifecycle Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the role hierarchy real approval chains — Agency, Coin Seller, Moderator and BD requests that travel Official → Manager → Admin and grant the role on approval.

**Architecture:** A new `src/modules/role-requests` module holding three Prisma models (request, append-only action log, reference counter). Pipelines and the state machine are pure, dependency-free services so the rules that carry the risk are testable without Prisma or Redis. Role granting, notifications and events go through existing public ports, adding no module-boundary violations.

**Tech Stack:** NestJS 11, TypeScript (strict), Prisma + PostgreSQL, Jest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-role-approval-engine-design.md`
- TDD is mandatory: write the failing test, watch it fail for the right reason, then implement.
- Zero TypeScript errors (`npx tsc --noEmit -p tsconfig.json`) at every task.
- No new lint errors. The repo has 11 pre-existing errors in games/gift-registry files; that count must not rise.
- No new module-boundary violations. Baseline is **215** (`npm run boundaries`); it must not rise. Reach other modules only through their `interfaces/`.
- After editing any `prisma/schema/*.prisma`, run `npx prisma generate` before typechecking, or the client is stale and produces phantom errors.
- **No database is reachable** in this environment (`prisma migrate status` fails P1000). Never run `prisma migrate dev`. Schema plus `prisma generate` is the full scope; migration SQL is the repo owner's.
- **Run no git commands at all** — no commit, add, branch, stash. The repo owner handles git. Leave everything uncommitted.
- Only the Admin stage may approve or reject. Officials and Managers may only advance or send back. This is a PRD rule, not a preference.

## Existing interfaces this consumes (verified against source)

- `RoleService.assignRoleToUser(dto: AssignRoleDto, assignedByUserId?: string)` — upserts `UserRole` **and already invalidates the authorization cache**.
- `RoleService.assignRoleScope(dto: CreateRoleScopeDto)` — creates `RoleScope` **and already invalidates the cache**. Fields: `userRoleId`, `scopeType`, `countryId?`, `stateId?`, `regionId?`.
- `RegionService.getRegionById(id)` / `StateService` — used only INSIDE the Organization port adapter; consumers use the port.
- `INotificationService.create({ userId, type, actorId?, entityType?, entityId?, data? })` behind `NOTIFICATION_SERVICE`.
- `IEventBus.publish(event)` behind `EVENT_BUS`; events extend `DomainEvent` from `src/common/events`.
- `ScopeType` enum: `GLOBAL | COUNTRY | STATE | REGION`.

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema/role_requests.prisma` | Three models + four enums |
| `src/modules/role-requests/constants/role-request.constants.ts` | Pipelines, pipeline version, reference format |
| `src/modules/role-requests/services/role-request-pipeline.service.ts` | Pure: stages per type, submitter rules |
| `src/modules/role-requests/services/role-request-state.service.ts` | Pure: which action is legal from which state |
| `src/modules/role-requests/services/role-request-reference.service.ts` | Reference allocation inside a transaction |
| `src/modules/role-requests/repositories/role-request.repository.ts` | All Prisma access |
| `src/modules/role-requests/services/role-request-submit.service.ts` | Submit + resubmit |
| `src/modules/role-requests/services/role-request-action.service.ts` | advance / send-back / withdraw / cancel |
| `src/modules/role-requests/services/role-request-decision.service.ts` | approve (grants) / reject |
| `src/modules/role-requests/services/role-request-query.service.ts` | Scope-filtered queues |
| `src/modules/role-requests/events/role-request.events.ts` | Domain events incl. `RoleGrantedEvent` |
| `src/modules/role-requests/controllers/role-request.controller.ts` | REST surface |
| `src/modules/role-requests/dto/role-request.dto.ts` | Request/response DTOs |
| `src/modules/role-requests/role-requests.module.ts` | Wiring |

Splitting submit / action / decision keeps each service to one reason to change; the decision service is the only one that grants a role, which is where the risk concentrates.

---

### Task 1: Prisma models and enums

**Files:**
- Create: `prisma/schema/role_requests.prisma`
- Modify: `prisma/schema/notification.prisma` — append two `NotificationType` values

**Interfaces:**
- Consumes: nothing.
- Produces: models `RoleRequest`, `RoleRequestAction`, `RoleRequestCounter`; enums `RoleRequestType`, `RoleRequestStatus`, `RoleRequestStage`, `RoleRequestActionType`; notification types `ROLE_REQUEST_UPDATE`, `ROLE_GRANTED`.

- [ ] **Step 1: Create the schema file**

```prisma
// ============================================================
// Role requests — the approval chains that create staff. A request
// travels Official → Manager → Admin (or Manager → Admin for
// recommendations) and grants a role on approval. Owned by the
// "role-requests" module. No cross-module relations: reference users
// and organization rows by id.
// ============================================================

enum RoleRequestType {
  AGENCY
  COIN_SELLER
  MODERATOR
  BUSINESS_DEVELOPMENT
}

enum RoleRequestStatus {
  SUBMITTED
  IN_REVIEW
  NEEDS_INFO
  APPROVED
  REJECTED
  WITHDRAWN
  CANCELLED
}

enum RoleRequestStage {
  OFFICIAL
  MANAGER
  ADMIN
}

enum RoleRequestActionType {
  SUBMIT
  ADVANCE
  SEND_BACK
  RESUBMIT
  APPROVE
  REJECT
  WITHDRAW
  CANCEL
}

/// A live request for a role. One open request per (subject, type) is
/// enforced by a partial unique index, so a concurrent double-submit
/// cannot create two.
model RoleRequest {
  id                    String            @id @default(uuid()) @db.Uuid
  reference             String            @unique
  type                  RoleRequestType
  subjectUserId         String            @db.Uuid
  initiatedByUserId     String            @db.Uuid
  status                RoleRequestStatus @default(SUBMITTED)
  currentStage          RoleRequestStage?
  currentStageEnteredAt DateTime?
  pipelineVersion       Int
  formData              Json?
  documentKeys          String[]
  regionId              String            @db.Uuid
  stateId               String?           @db.Uuid
  countryId             String?           @db.Uuid
  submittedAt           DateTime          @default(now())
  decidedAt             DateTime?
  decidedByUserId       String?           @db.Uuid
  outcomeReason         String?
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt

  actions RoleRequestAction[]

  @@index([status, currentStage])
  @@index([regionId, status])
  @@index([countryId, status])
  @@index([subjectUserId, type])
  @@map("role_requests")
}

/// Append-only record of every stage action. Never updated, never deleted.
model RoleRequestAction {
  id              String                @id @default(uuid()) @db.Uuid
  requestId       String                @db.Uuid
  sequence        Int
  stage           RoleRequestStage
  action          RoleRequestActionType
  actorUserId     String                @db.Uuid
  actorRole       String
  notes           String?
  checklistSnapshot Json?
  stageEnteredAt  DateTime
  actedAt         DateTime              @default(now())

  request RoleRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  @@unique([requestId, sequence])
  @@index([requestId, actedAt])
  @@map("role_request_actions")
}

/// Per-year counter backing the human-readable reference (RR-2026-000154).
/// Incremented atomically inside the submitting transaction.
model RoleRequestCounter {
  year         Int      @id
  lastSequence Int      @default(0)
  updatedAt    DateTime @updatedAt

  @@map("role_request_counters")
}
```

- [ ] **Step 2: Append the two notification types**

In `prisma/schema/notification.prisma`, add to the END of the `NotificationType` enum, after `SYSTEM`:

```prisma
  // ---- Role approval chain (append-only) ----
  ROLE_REQUEST_UPDATE
  ROLE_GRANTED
```

Append only. Reordering that enum would renumber existing values.

- [ ] **Step 3: Add the partial unique index**

Prisma cannot express a partial unique index in the schema, so add it as raw SQL the repo owner will apply with the migration. Create `prisma/schema/role_requests.README.md` containing exactly:

```sql
-- Enforces one OPEN request per (subjectUserId, type). Terminal statuses are
-- excluded so a user may reapply after a decision. Apply with the migration
-- that creates role_requests.
CREATE UNIQUE INDEX role_requests_one_open_per_subject_type
  ON role_requests ("subjectUserId", type)
  WHERE status IN ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO');
```

Note in your report that this index is NOT enforced until the repo owner applies it, so the service-level check in Task 7 is the only guard until then.

- [ ] **Step 4: Generate and typecheck**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json`
Expected: generate succeeds reporting the three new models; 0 type errors.

---

### Task 2: Permissions

**Files:**
- Modify: `src/modules/authorization/constants/rbac-permissions.constants.ts`

**Interfaces:**
- Produces: permission codes `role_request.submit`, `role_request.view`, `role_request.verify`, `role_request.review`, `role_request.decide`.

Existing guard specs in that folder will fail if a code is enforced but undefined, if a role is granted a code that does not exist, or if a member-tier role holds a code guarding an administrative route. Run them as your RED/GREEN signal.

- [ ] **Step 1: Add the five definitions**

Append to `DEFAULT_PERMISSIONS`, following the shape of the entries already there:

```typescript
  // Role approval chain (Agency / Coin Seller / Moderator / BD requests)
  {
    code: 'role_request.submit',
    module: 'role_requests',
    action: 'create',
    category: 'SYSTEM',
    displayName: 'Submit Role Request',
    description: 'Can submit an application or recommendation for a platform role',
  },
  {
    code: 'role_request.view',
    module: 'role_requests',
    action: 'view',
    category: 'SYSTEM',
    displayName: 'View Role Requests',
    description: 'Can view role requests within the assigned geographic scope',
  },
  {
    code: 'role_request.verify',
    module: 'role_requests',
    action: 'update',
    category: 'SYSTEM',
    displayName: 'Verify Role Request',
    description: 'Can complete the Official verification stage of a role request',
  },
  {
    code: 'role_request.review',
    module: 'role_requests',
    action: 'update',
    category: 'SYSTEM',
    displayName: 'Review Role Request',
    description: 'Can complete the Manager review stage of a role request',
  },
  {
    code: 'role_request.decide',
    module: 'role_requests',
    action: 'approve',
    category: 'SYSTEM',
    displayName: 'Decide Role Request',
    description: 'Can approve or reject a role request and grant the role',
  },
```

- [ ] **Step 2: Grant them in the role matrix**

In `DEFAULT_ROLE_PERMISSIONS`:
- add `'role_request.submit'` to the `MEMBER_PERMISSIONS` array (an application is a member action, so every role inherits it);
- add `'role_request.view'` and `'role_request.verify'` to `OFFICIAL`;
- add `'role_request.view'` and `'role_request.review'` to `COUNTRY_MANAGER`;
- add `'role_request.view'` and `'role_request.decide'` to `ADMIN`.

Do not grant `verify`, `review` or `decide` to any other role, and do not add anything to `MEMBER_PERMISSIONS` beyond `submit`.

- [ ] **Step 3: Run the guard specs**

Run: `npx jest src/modules/authorization/constants`
Expected: all pass. If "never grants a member-tier role a permission that guards an administrative route" fails, you have put a staff permission in `MEMBER_PERMISSIONS` — move it.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors.

---

### Task 3: Authorization and Organization ports

**Files:**
- Create: `src/modules/authorization/interfaces/authorization-grant.interface.ts`
- Create: `src/modules/authorization/interfaces/index.ts`
- Modify: `src/modules/authorization/authorization.module.ts`
- Create: `src/modules/organization/interfaces/organization.interface.ts`
- Create: `src/modules/organization/interfaces/index.ts`
- Modify: `src/modules/organization/organization.module.ts`

**Interfaces:**
- Produces: tokens `AUTHORIZATION_GRANT` / `ORGANIZATION` and interfaces `IAuthorizationGrant` / `IOrganization`.

Consumers may only reach another module through its `interfaces/`. Neither
`AuthorizationModule` nor `OrganizationModule` has such a folder, so importing
`RoleService` or `RegionService` directly would add boundary violations to a count
that must stay at 215. Both ports mirror the `PLATFORM_CONFIG` port already in
`platform-configuration/interfaces/`.

**Why the Organization port is not just a passthrough:** `Region` carries only
`stateId` — there is no `countryId` on it. Resolving a region to its country needs a
Region → State traversal. Doing that traversal inside the port means every consumer
gets a complete `{ regionId, stateId, countryId }` triple, and none of them has to
know the hierarchy's shape. Without it, the Manager queue in Task 10 would filter on a
`countryId` that was never populated and would silently return nothing.

- [ ] **Step 1: Write the port**

```typescript
import type { ScopeType } from '@prisma/client';

/**
 * Public contract for granting a platform role with a geographic scope.
 *
 * Domain modules depend on this token rather than importing RoleService,
 * which keeps them inside the module boundary rule. Both operations
 * invalidate the authorization cache for the affected user — without that a
 * freshly granted role would not take effect until the Redis TTL expired,
 * which is indistinguishable from a grant that silently failed.
 */
export interface IAuthorizationGrant {
  /** Grant a role by NAME (e.g. 'AGENCY'); returns the UserRole id. */
  grantRole(input: {
    userId: string;
    roleName: string;
    assignedByUserId?: string;
  }): Promise<{ userRoleId: string }>;

  /** Attach a geographic scope to a granted role. */
  grantScope(input: {
    userRoleId: string;
    scopeType: ScopeType;
    countryId?: string;
    stateId?: string;
    regionId?: string;
  }): Promise<void>;

  /** True when the user already holds the named role. */
  hasRole(userId: string, roleName: string): Promise<boolean>;

  /**
   * The geographic scopes a user holds, flattened for queue filtering. Used to
   * decide which requests a reviewer may see; an empty pair means "no scope",
   * which for a scoped role means they see nothing.
   */
  scopesFor(userId: string): Promise<{ regionIds: string[]; countryIds: string[] }>;
}

export const AUTHORIZATION_GRANT = Symbol('AUTHORIZATION_GRANT');
```

Also create `src/modules/authorization/interfaces/index.ts` re-exporting it:

```typescript
export * from './authorization-grant.interface';
```

- [ ] **Step 2: Write the adapter and register it**

Create the adapter beside the services, `src/modules/authorization/services/authorization-grant.adapter.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { ScopeType } from '@prisma/client';
import type { IAuthorizationGrant } from '../interfaces/authorization-grant.interface';
import { RoleResolver } from './role-resolver.service';
import { RoleService } from './role.service';

/**
 * Adapts RoleService to the public IAuthorizationGrant port. Resolves a role
 * NAME to its id so callers never need to know role ids; RoleService already
 * invalidates the authorization cache on both writes.
 */
@Injectable()
export class AuthorizationGrantAdapter implements IAuthorizationGrant {
  constructor(
    private readonly roles: RoleService,
    private readonly roleResolver: RoleResolver,
  ) {}

  async grantRole(input: {
    userId: string;
    roleName: string;
    assignedByUserId?: string;
  }): Promise<{ userRoleId: string }> {
    const role = await this.roles.getRoleByName(input.roleName);
    const userRole = await this.roles.assignRoleToUser(
      { userId: input.userId, roleId: role.id },
      input.assignedByUserId,
    );
    return { userRoleId: userRole.id };
  }

  async grantScope(input: {
    userRoleId: string;
    scopeType: ScopeType;
    countryId?: string;
    stateId?: string;
    regionId?: string;
  }): Promise<void> {
    await this.roles.assignRoleScope({
      userRoleId: input.userRoleId,
      scopeType: input.scopeType,
      countryId: input.countryId,
      stateId: input.stateId,
      regionId: input.regionId,
    });
  }

  async hasRole(userId: string, roleName: string): Promise<boolean> {
    return this.roleResolver.hasRole(userId, roleName);
  }

  async scopesFor(userId: string): Promise<{ regionIds: string[]; countryIds: string[] }> {
    // GeographicScopeResolver.getUserScopes returns UserScopeDetail[]; read its
    // actual shape before writing this and map the region/country ids out of it.
    const scopes = await this.scopeResolver.getUserScopes(userId);
    return {
      regionIds: scopes.map((s) => s.regionId).filter((id): id is string => Boolean(id)),
      countryIds: scopes.map((s) => s.countryId).filter((id): id is string => Boolean(id)),
    };
  }
}
```

Inject `GeographicScopeResolver` alongside `RoleService` and `RoleResolver`.

- [ ] **Step 1b: Write the Organization port**

```typescript
/**
 * Public contract for reading organization geography.
 *
 * `Region` carries only `stateId`, so resolving a region to its country needs a
 * Region → State traversal. Doing it here means consumers get a complete triple
 * and none of them has to know the hierarchy's shape.
 */
export interface IOrganization {
  /**
   * Resolve a region to its full location triple. Returns null when the region
   * does not exist; `isActive` is false when it exists but is deactivated —
   * callers must reject those rather than treating them as valid.
   */
  resolveRegion(regionId: string): Promise<{
    regionId: string;
    stateId: string;
    countryId: string;
    isActive: boolean;
  } | null>;
}

export const ORGANIZATION = Symbol('ORGANIZATION');
```

Implement it as an adapter over `RegionService` and `StateService` (both already
exported by `OrganizationModule`), provide it under the token, and export the token.
`OrganizationModule` is not `@Global()`, so consumers import `OrganizationModule` and
inject `ORGANIZATION` — importing the module is permitted; importing its *services* is
what the boundary rule forbids.

In `authorization.module.ts`: import both the adapter and `AUTHORIZATION_GRANT`, add `AuthorizationGrantAdapter` and `{ provide: AUTHORIZATION_GRANT, useExisting: AuthorizationGrantAdapter }` to `providers`, and add `AUTHORIZATION_GRANT` to `exports`.

- [ ] **Step 3: Typecheck and confirm boundaries did not rise**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors.
Run: `npm run boundaries` → still 215 violations.

---

### Task 4: Pipelines and reference format

**Files:**
- Create: `src/modules/role-requests/constants/role-request.constants.ts`
- Test: `src/modules/role-requests/constants/role-request.constants.spec.ts`

**Interfaces:**
- Produces: `PIPELINE_VERSION`, `PIPELINES`, `SUBMITTER_RULES`, `formatReference(year, sequence)`, `ELIGIBILITY_CHECKLISTS`.

- [ ] **Step 1: Write the failing test**

```typescript
import {
  ELIGIBILITY_CHECKLISTS,
  PIPELINES,
  PIPELINE_VERSION,
  SUBMITTER_RULES,
  formatReference,
} from './role-request.constants';

describe('role request constants', () => {
  it('routes applications through all three stages', () => {
    expect(PIPELINES[PIPELINE_VERSION].AGENCY).toEqual(['OFFICIAL', 'MANAGER', 'ADMIN']);
    expect(PIPELINES[PIPELINE_VERSION].COIN_SELLER).toEqual(['OFFICIAL', 'MANAGER', 'ADMIN']);
  });

  it('skips the Official stage for recommendations an Official already made', () => {
    // The PRD has the Official verify the candidate before submitting, so a
    // second Official stage would re-do work already done.
    expect(PIPELINES[PIPELINE_VERSION].MODERATOR).toEqual(['MANAGER', 'ADMIN']);
    expect(PIPELINES[PIPELINE_VERSION].BUSINESS_DEVELOPMENT).toEqual(['MANAGER', 'ADMIN']);
  });

  it('ends every pipeline at ADMIN, the only stage that may decide', () => {
    for (const stages of Object.values(PIPELINES[PIPELINE_VERSION])) {
      expect(stages[stages.length - 1]).toBe('ADMIN');
    }
  });

  it('says who may submit each type and for whom', () => {
    expect(SUBMITTER_RULES.AGENCY).toEqual({ selfOnly: true, requiresRole: null });
    expect(SUBMITTER_RULES.COIN_SELLER).toEqual({ selfOnly: true, requiresRole: 'AGENCY' });
    expect(SUBMITTER_RULES.MODERATOR).toEqual({ selfOnly: false, requiresRole: 'OFFICIAL' });
    expect(SUBMITTER_RULES.BUSINESS_DEVELOPMENT).toEqual({
      selfOnly: false,
      requiresRole: 'OFFICIAL',
    });
  });

  it('formats a padded, year-scoped reference', () => {
    expect(formatReference(2026, 154)).toBe('RR-2026-000154');
    expect(formatReference(2026, 1)).toBe('RR-2026-000001');
    expect(formatReference(2026, 999999)).toBe('RR-2026-999999');
  });

  it('does not truncate a sequence that outgrows the padding', () => {
    // Better a longer reference than two requests sharing one.
    expect(formatReference(2026, 1_000_000)).toBe('RR-2026-1000000');
  });

  it('carries the PRD eligibility criteria for coin sellers', () => {
    expect(ELIGIBILITY_CHECKLISTS.COIN_SELLER).toEqual([
      'MIN_50_ACTIVE_USERS',
      'MONTHLY_TARGETS_ACHIEVED',
      'GOOD_PERFORMANCE_GRADE',
      'NO_POLICY_VIOLATIONS',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/role-requests/constants/role-request.constants.spec.ts`
Expected: FAIL — "Cannot find module './role-request.constants'".

- [ ] **Step 3: Write the implementation**

```typescript
import type { RoleRequestStage, RoleRequestType } from '@prisma/client';

/**
 * The pipeline definition in force for NEW requests. Stored on each request so
 * a chain change can never retroactively alter what an in-flight or historical
 * request meant — always evaluate a request against ITS version, never this one.
 */
export const PIPELINE_VERSION = 1;

export const PIPELINES: Record<number, Record<RoleRequestType, RoleRequestStage[]>> = {
  1: {
    AGENCY: ['OFFICIAL', 'MANAGER', 'ADMIN'],
    COIN_SELLER: ['OFFICIAL', 'MANAGER', 'ADMIN'],
    // Recommendations are raised BY an Official who has already verified the
    // candidate, so their submission is the verification.
    MODERATOR: ['MANAGER', 'ADMIN'],
    BUSINESS_DEVELOPMENT: ['MANAGER', 'ADMIN'],
  },
};

/**
 * Who may submit each type. `selfOnly` means the subject must be the submitter;
 * `requiresRole` is a role the submitter must already hold.
 */
export const SUBMITTER_RULES: Record<
  RoleRequestType,
  { selfOnly: boolean; requiresRole: string | null }
> = {
  AGENCY: { selfOnly: true, requiresRole: null },
  COIN_SELLER: { selfOnly: true, requiresRole: 'AGENCY' },
  MODERATOR: { selfOnly: false, requiresRole: 'OFFICIAL' },
  BUSINESS_DEVELOPMENT: { selfOnly: false, requiresRole: 'OFFICIAL' },
};

/** Advisory criteria an Official attests; nothing here is auto-computed. */
export const ELIGIBILITY_CHECKLISTS: Partial<Record<RoleRequestType, string[]>> = {
  COIN_SELLER: [
    'MIN_50_ACTIVE_USERS',
    'MONTHLY_TARGETS_ACHIEVED',
    'GOOD_PERFORMANCE_GRADE',
    'NO_POLICY_VIOLATIONS',
  ],
  AGENCY: ['DOCUMENTS_VERIFIED', 'IDENTITY_CONFIRMED', 'NO_POLICY_VIOLATIONS'],
};

/** `RR-2026-000154`. Padding is a minimum, never a truncation. */
export function formatReference(year: number, sequence: number): string {
  return `RR-${year}-${String(sequence).padStart(6, '0')}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/role-requests/constants/role-request.constants.spec.ts`
Expected: PASS, 7 tests.

---

### Task 5: State machine

**Files:**
- Create: `src/modules/role-requests/services/role-request-state.service.ts`
- Test: `src/modules/role-requests/services/role-request-state.service.spec.ts`

**Interfaces:**
- Consumes: `PIPELINES` from Task 4.
- Produces: class `RoleRequestStateService` with

```typescript
assertActionAllowed(input: {
  action: RoleRequestActionType;
  status: RoleRequestStatus;
  currentStage: RoleRequestStage | null;
  pipelineVersion: number;
  type: RoleRequestType;
  actorIsSubject: boolean;
  actorIsInitiator: boolean;
}): void;   // throws ConflictException / ForbiddenException

nextStage(input: { type; pipelineVersion; currentStage }): RoleRequestStage | null;
firstStage(input: { type; pipelineVersion }): RoleRequestStage;
```

- [ ] **Step 1: Write the failing test**

```typescript
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RoleRequestStateService } from './role-request-state.service';

describe('RoleRequestStateService', () => {
  const svc = new RoleRequestStateService();

  const base = {
    status: 'IN_REVIEW' as const,
    currentStage: 'OFFICIAL' as const,
    pipelineVersion: 1,
    type: 'AGENCY' as const,
    actorIsSubject: false,
    actorIsInitiator: false,
  };

  it('lets a non-final stage advance', () => {
    expect(() => svc.assertActionAllowed({ ...base, action: 'ADVANCE' })).not.toThrow();
  });

  it('refuses approval anywhere but the ADMIN stage', () => {
    // The PRD reserves approve/reject for the Admin.
    expect(() => svc.assertActionAllowed({ ...base, action: 'APPROVE' })).toThrow(
      ForbiddenException,
    );
    expect(() =>
      svc.assertActionAllowed({ ...base, currentStage: 'MANAGER', action: 'REJECT' }),
    ).toThrow(ForbiddenException);
  });

  it('allows approve and reject at ADMIN', () => {
    const admin = { ...base, currentStage: 'ADMIN' as const };
    expect(() => svc.assertActionAllowed({ ...admin, action: 'APPROVE' })).not.toThrow();
    expect(() => svc.assertActionAllowed({ ...admin, action: 'REJECT' })).not.toThrow();
  });

  it('refuses ADVANCE from the final stage', () => {
    expect(() =>
      svc.assertActionAllowed({ ...base, currentStage: 'ADMIN', action: 'ADVANCE' }),
    ).toThrow(ConflictException);
  });

  it('allows send-back from every stage', () => {
    for (const stage of ['OFFICIAL', 'MANAGER', 'ADMIN'] as const) {
      expect(() =>
        svc.assertActionAllowed({ ...base, currentStage: stage, action: 'SEND_BACK' }),
      ).not.toThrow();
    }
  });

  it('only allows resubmit from NEEDS_INFO, and only by the subject', () => {
    const needsInfo = { ...base, status: 'NEEDS_INFO' as const, currentStage: null };
    expect(() =>
      svc.assertActionAllowed({ ...needsInfo, action: 'RESUBMIT', actorIsSubject: true }),
    ).not.toThrow();
    expect(() => svc.assertActionAllowed({ ...needsInfo, action: 'RESUBMIT' })).toThrow(
      ForbiddenException,
    );
    expect(() =>
      svc.assertActionAllowed({ ...base, action: 'RESUBMIT', actorIsSubject: true }),
    ).toThrow(ConflictException);
  });

  it('lets the subject withdraw, and the initiator withdraw a recommendation', () => {
    expect(() =>
      svc.assertActionAllowed({ ...base, action: 'WITHDRAW', actorIsSubject: true }),
    ).not.toThrow();
    expect(() =>
      svc.assertActionAllowed({
        ...base,
        type: 'MODERATOR',
        currentStage: 'MANAGER',
        action: 'WITHDRAW',
        actorIsInitiator: true,
      }),
    ).not.toThrow();
    expect(() => svc.assertActionAllowed({ ...base, action: 'WITHDRAW' })).toThrow(
      ForbiddenException,
    );
  });

  it('refuses every action on a terminal request', () => {
    for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'] as const) {
      for (const action of ['ADVANCE', 'SEND_BACK', 'APPROVE', 'WITHDRAW', 'CANCEL'] as const) {
        expect(() =>
          svc.assertActionAllowed({ ...base, status, currentStage: null, action }),
        ).toThrow(ConflictException);
      }
    }
  });

  it('walks the pipeline', () => {
    expect(svc.firstStage({ type: 'AGENCY', pipelineVersion: 1 })).toBe('OFFICIAL');
    expect(svc.firstStage({ type: 'MODERATOR', pipelineVersion: 1 })).toBe('MANAGER');
    expect(
      svc.nextStage({ type: 'AGENCY', pipelineVersion: 1, currentStage: 'OFFICIAL' }),
    ).toBe('MANAGER');
    expect(svc.nextStage({ type: 'AGENCY', pipelineVersion: 1, currentStage: 'ADMIN' })).toBeNull();
  });

  it('evaluates against the request\'s own pipeline version', () => {
    // A request submitted under v1 must keep behaving like v1 even if a v2 exists.
    expect(() =>
      svc.firstStage({ type: 'AGENCY', pipelineVersion: 99 }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/role-requests/services/role-request-state.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  RoleRequestActionType,
  RoleRequestStage,
  RoleRequestStatus,
  RoleRequestType,
} from '@prisma/client';
import { PIPELINES } from '../constants/role-request.constants';

const TERMINAL: RoleRequestStatus[] = ['APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'];

/**
 * The rules governing which action is legal from which state. Pure: no storage,
 * no clock — the caller supplies the request's state and who is acting.
 */
@Injectable()
export class RoleRequestStateService {
  private stages(type: RoleRequestType, pipelineVersion: number): RoleRequestStage[] {
    const pipeline = PIPELINES[pipelineVersion]?.[type];
    if (!pipeline) {
      throw new ConflictException(
        `No pipeline version ${pipelineVersion} for request type ${type}.`,
      );
    }
    return pipeline;
  }

  firstStage(input: { type: RoleRequestType; pipelineVersion: number }): RoleRequestStage {
    return this.stages(input.type, input.pipelineVersion)[0];
  }

  nextStage(input: {
    type: RoleRequestType;
    pipelineVersion: number;
    currentStage: RoleRequestStage;
  }): RoleRequestStage | null {
    const stages = this.stages(input.type, input.pipelineVersion);
    const i = stages.indexOf(input.currentStage);
    return i >= 0 && i < stages.length - 1 ? stages[i + 1] : null;
  }

  assertActionAllowed(input: {
    action: RoleRequestActionType;
    status: RoleRequestStatus;
    currentStage: RoleRequestStage | null;
    pipelineVersion: number;
    type: RoleRequestType;
    actorIsSubject: boolean;
    actorIsInitiator: boolean;
  }): void {
    const { action, status, currentStage, type, pipelineVersion } = input;

    if (TERMINAL.includes(status)) {
      throw new ConflictException(`This request is already ${status.toLowerCase()}.`);
    }

    if (action === 'RESUBMIT') {
      if (status !== 'NEEDS_INFO') {
        throw new ConflictException('Only a request awaiting more information can be resubmitted.');
      }
      if (!input.actorIsSubject && !input.actorIsInitiator) {
        throw new ForbiddenException('Only the applicant may resubmit this request.');
      }
      return;
    }

    if (action === 'WITHDRAW') {
      if (!input.actorIsSubject && !input.actorIsInitiator) {
        throw new ForbiddenException('Only the applicant may withdraw this request.');
      }
      return;
    }

    if (action === 'CANCEL') return; // Admin-only; enforced by permission.

    if (status === 'NEEDS_INFO') {
      throw new ConflictException('This request is awaiting more information from the applicant.');
    }

    const stages = this.stages(type, pipelineVersion);
    const isFinal = currentStage === stages[stages.length - 1];

    if (action === 'SEND_BACK') return; // legal from every stage

    if (action === 'ADVANCE') {
      if (isFinal) {
        throw new ConflictException('The final stage decides; it cannot advance.');
      }
      return;
    }

    if (action === 'APPROVE' || action === 'REJECT') {
      if (!isFinal) {
        // The PRD reserves approve/reject for the Admin stage.
        throw new ForbiddenException('Only the final stage may approve or reject a request.');
      }
      return;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/role-requests/services/role-request-state.service.spec.ts`
Expected: PASS, 10 tests.

---

### Task 6: Repository and reference allocation

**Files:**
- Create: `src/modules/role-requests/repositories/role-request.repository.ts`
- Create: `src/modules/role-requests/services/role-request-reference.service.ts`
- Test: `src/modules/role-requests/services/role-request-reference.service.spec.ts`

**Interfaces:**
- Produces:
  - `RoleRequestReferenceService.allocate(tx, year): Promise<string>`
  - `RoleRequestRepository` with `findById`, `findOpenFor(subjectUserId, type)`, `create(tx, data)`, `appendAction(tx, data)`, `updateStatus(tx, id, patch)`, `nextSequence(tx, requestId)`, `queue(filter)`

- [ ] **Step 1: Write the failing test for reference allocation**

```typescript
import { RoleRequestReferenceService } from './role-request-reference.service';

describe('RoleRequestReferenceService', () => {
  const svc = new RoleRequestReferenceService();

  const tx = (lastSequence: number) => ({
    roleRequestCounter: {
      upsert: jest.fn().mockResolvedValue({ year: 2026, lastSequence }),
    },
  });

  it('formats the allocated sequence', async () => {
    await expect(svc.allocate(tx(154) as never, 2026)).resolves.toBe('RR-2026-000154');
  });

  it('allocates through an atomic increment, never a read-then-write', async () => {
    // Two concurrent submits must not be able to read the same value and both
    // write sequence+1 — the increment has to happen in the database.
    const client = tx(1);
    await svc.allocate(client as never, 2026);
    const call = client.roleRequestCounter.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ lastSequence: { increment: 1 } });
    expect(call.create).toEqual({ year: 2026, lastSequence: 1 });
    expect(call.where).toEqual({ year: 2026 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/role-requests/services/role-request-reference.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the reference service**

```typescript
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { formatReference } from '../constants/role-request.constants';

/**
 * Allocates the human-readable reference. The increment happens in the database
 * inside the caller's transaction, so two concurrent submits cannot read the
 * same counter and mint the same reference.
 */
@Injectable()
export class RoleRequestReferenceService {
  async allocate(tx: Prisma.TransactionClient, year: number): Promise<string> {
    const counter = await tx.roleRequestCounter.upsert({
      where: { year },
      create: { year, lastSequence: 1 },
      update: { lastSequence: { increment: 1 } },
    });
    return formatReference(year, counter.lastSequence);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/role-requests/services/role-request-reference.service.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the repository**

No unit test of its own: it is a thin Prisma wrapper with no branching, covered through the services in Tasks 7–9.

```typescript
import { Injectable } from '@nestjs/common';
import type { Prisma, RoleRequest, RoleRequestType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class RoleRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.roleRequest.findUnique({
      where: { id },
      include: { actions: { orderBy: { sequence: 'asc' } } },
    });
  }

  /** The one open request for this subject and type, if any. */
  findOpenFor(subjectUserId: string, type: RoleRequestType): Promise<RoleRequest | null> {
    return this.prisma.roleRequest.findFirst({
      where: {
        subjectUserId,
        type,
        status: { in: ['SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO'] },
      },
    });
  }

  create(tx: Prisma.TransactionClient, data: Prisma.RoleRequestUncheckedCreateInput) {
    return tx.roleRequest.create({ data });
  }

  updateStatus(
    tx: Prisma.TransactionClient,
    id: string,
    patch: Prisma.RoleRequestUncheckedUpdateInput,
  ) {
    return tx.roleRequest.update({ where: { id }, data: patch });
  }

  async nextSequence(tx: Prisma.TransactionClient, requestId: string): Promise<number> {
    const last = await tx.roleRequestAction.findFirst({
      where: { requestId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    return (last?.sequence ?? 0) + 1;
  }

  appendAction(tx: Prisma.TransactionClient, data: Prisma.RoleRequestActionUncheckedCreateInput) {
    return tx.roleRequestAction.create({ data });
  }

  /** Scope-filtered queue. Callers pass only the scopes the actor may see. */
  queue(filter: {
    stage?: Prisma.EnumRoleRequestStageFilter;
    regionIds?: string[];
    countryIds?: string[];
    type?: RoleRequestType;
    status?: Prisma.EnumRoleRequestStatusFilter;
    skip: number;
    take: number;
  }) {
    return this.prisma.roleRequest.findMany({
      where: {
        currentStage: filter.stage,
        status: filter.status,
        type: filter.type,
        ...(filter.regionIds ? { regionId: { in: filter.regionIds } } : {}),
        ...(filter.countryIds ? { countryId: { in: filter.countryIds } } : {}),
      },
      orderBy: { submittedAt: 'asc' },
      skip: filter.skip,
      take: filter.take,
    });
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json` → 0 errors.

---

### Task 7: Submit and resubmit

**Files:**
- Create: `src/modules/role-requests/events/role-request.events.ts`
- Create: `src/modules/role-requests/services/role-request-submit.service.ts`
- Test: `src/modules/role-requests/services/role-request-submit.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–6, `AUTHORIZATION_GRANT` (for `hasRole`), `ORGANIZATION` (for `resolveRegion`), `NOTIFICATION_SERVICE`, `EVENT_BUS`, `PrismaService`.
- Produces: `RoleRequestSubmitService.submit(actorUserId, dto)` and `.resubmit(actorUserId, requestId, dto)`.

- [ ] **Step 1: Write the events file**

```typescript
import { DomainEvent } from 'src/common/events';

export const ROLE_REQUEST_EVENTS = {
  SUBMITTED: 'role.request.submitted',
  ADVANCED: 'role.request.advanced',
  SENT_BACK: 'role.request.sent_back',
  DECIDED: 'role.request.decided',
  CLOSED: 'role.request.closed',
  ROLE_GRANTED: 'role.granted',
} as const;

export class RoleRequestSubmittedEvent extends DomainEvent<{
  requestId: string;
  reference: string;
  type: string;
  subjectUserId: string;
  regionId: string;
}> {
  readonly name = ROLE_REQUEST_EVENTS.SUBMITTED;
}

export class RoleRequestAdvancedEvent extends DomainEvent<{
  requestId: string;
  reference: string;
  fromStage: string;
  toStage: string;
  actorUserId: string;
}> {
  readonly name = ROLE_REQUEST_EVENTS.ADVANCED;
}

export class RoleRequestSentBackEvent extends DomainEvent<{
  requestId: string;
  reference: string;
  reason: string;
  actorUserId: string;
}> {
  readonly name = ROLE_REQUEST_EVENTS.SENT_BACK;
}

export class RoleRequestDecidedEvent extends DomainEvent<{
  requestId: string;
  reference: string;
  approved: boolean;
  reason: string | null;
  actorUserId: string;
}> {
  readonly name = ROLE_REQUEST_EVENTS.DECIDED;
}

export class RoleRequestClosedEvent extends DomainEvent<{
  requestId: string;
  reference: string;
  status: string;
  actorUserId: string;
}> {
  readonly name = ROLE_REQUEST_EVENTS.CLOSED;
}

/**
 * Published AFTER a grant commits. Other modules (badges, analytics,
 * onboarding) react to this rather than this module knowing they exist.
 */
export class RoleGrantedEvent extends DomainEvent<{
  userId: string;
  role: string;
  scope: { scopeType: string; regionId: string };
  requestId: string;
  reference: string;
  grantedByUserId: string;
}> {
  readonly name = ROLE_REQUEST_EVENTS.ROLE_GRANTED;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RoleRequestStateService } from './role-request-state.service';
import { RoleRequestReferenceService } from './role-request-reference.service';
import { RoleRequestSubmitService } from './role-request-submit.service';

describe('RoleRequestSubmitService', () => {
  let repo: Record<string, jest.Mock>;
  let grant: Record<string, jest.Mock>;
  let organization: Record<string, jest.Mock>;
  let notifications: Record<string, jest.Mock>;
  let bus: Record<string, jest.Mock>;
  let prisma: Record<string, jest.Mock>;
  let service: RoleRequestSubmitService;

  beforeEach(() => {
    repo = {
      findOpenFor: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((_tx, data) => ({ id: 'req-1', ...data })),
      appendAction: jest.fn().mockResolvedValue({}),
      nextSequence: jest.fn().mockResolvedValue(1),
      findById: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue({}),
    };
    grant = { hasRole: jest.fn().mockResolvedValue(true) };
    organization = {
      resolveRegion: jest.fn().mockResolvedValue({
        regionId: 'reg-1',
        stateId: 'st-1',
        countryId: 'c-1',
        isActive: true,
      }),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    prisma = { $transaction: jest.fn().mockImplementation((cb) => cb(prisma)) };

    service = new RoleRequestSubmitService(
      repo as never,
      new RoleRequestStateService(),
      new RoleRequestReferenceService(),
      grant as never,
      organization as never,
      notifications as never,
      bus as never,
      prisma as never,
    );
    (prisma as Record<string, unknown>).roleRequestCounter = {
      upsert: jest.fn().mockResolvedValue({ year: 2026, lastSequence: 7 }),
    };
  });

  const dto = (over: Record<string, unknown> = {}) => ({
    type: 'AGENCY',
    regionId: 'reg-1',
    formData: { businessName: 'Acme' },
    documentKeys: ['doc-1'],
    ...over,
  });

  it('creates the request at the first stage of its pipeline', async () => {
    const res = await service.submit('u1', dto() as never);

    expect(res.reference).toBe('RR-2026-000007');
    const created = repo.create.mock.calls[0][1];
    expect(created).toMatchObject({
      type: 'AGENCY',
      subjectUserId: 'u1',
      initiatedByUserId: 'u1',
      status: 'IN_REVIEW',
      currentStage: 'OFFICIAL',
      pipelineVersion: 1,
      regionId: 'reg-1',
    });
    expect(created.currentStageEnteredAt).toBeInstanceOf(Date);
  });

  it('starts a moderator recommendation at MANAGER, not OFFICIAL', async () => {
    await service.submit('official-1', dto({ type: 'MODERATOR', subjectUserId: 'cand-1' }) as never);
    expect(repo.create.mock.calls[0][1]).toMatchObject({
      currentStage: 'MANAGER',
      subjectUserId: 'cand-1',
      initiatedByUserId: 'official-1',
    });
  });

  it('refuses a second open request for the same subject and type', async () => {
    repo.findOpenFor.mockResolvedValue({ id: 'req-0', reference: 'RR-2026-000001' });
    await expect(service.submit('u1', dto() as never)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses an application submitted on someone else\'s behalf', async () => {
    await expect(
      service.submit('u1', dto({ subjectUserId: 'someone-else' }) as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a coin seller request from a user who is not an agency', async () => {
    grant.hasRole.mockResolvedValue(false);
    await expect(service.submit('u1', dto({ type: 'COIN_SELLER' }) as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a request naming an inactive region', async () => {
    organization.resolveRegion.mockResolvedValue({
      regionId: 'reg-1',
      stateId: 'st-1',
      countryId: 'c-1',
      isActive: false,
    });
    await expect(service.submit('u1', dto() as never)).rejects.toThrow();
  });

  it('refuses a request naming a region that does not exist', async () => {
    organization.resolveRegion.mockResolvedValue(null);
    await expect(service.submit('u1', dto() as never)).rejects.toThrow();
  });

  it('stores the full location triple so Manager routing works', async () => {
    // countryId routes the MANAGER stage; a null here makes every request
    // invisible to Country Managers.
    await service.submit('u1', dto() as never);
    expect(repo.create.mock.calls[0][1]).toMatchObject({
      regionId: 'reg-1',
      stateId: 'st-1',
      countryId: 'c-1',
    });
  });

  it('records the SUBMIT action and notifies the subject', async () => {
    await service.submit('u1', dto() as never);
    expect(repo.appendAction.mock.calls[0][1]).toMatchObject({
      action: 'SUBMIT',
      stage: 'OFFICIAL',
      actorUserId: 'u1',
      sequence: 1,
    });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'ROLE_REQUEST_UPDATE' }),
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'role.request.submitted' }),
    );
  });

  it('returns a resubmitted request to the first stage', async () => {
    repo.findById.mockResolvedValue({
      id: 'req-1',
      reference: 'RR-2026-000007',
      type: 'AGENCY',
      status: 'NEEDS_INFO',
      currentStage: null,
      pipelineVersion: 1,
      subjectUserId: 'u1',
      initiatedByUserId: 'u1',
    });

    await service.resubmit('u1', 'req-1', { formData: { businessName: 'Acme 2' } } as never);

    expect(repo.updateStatus.mock.calls[0][2]).toMatchObject({
      status: 'IN_REVIEW',
      currentStage: 'OFFICIAL',
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/role-requests/services/role-request-submit.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Write `RoleRequestSubmitService` satisfying the test above. Required behaviour, in order:

1. Look up `SUBMITTER_RULES[dto.type]`. If `selfOnly`, the subject must equal the actor — otherwise `ForbiddenException`. If `requiresRole`, call `grant.hasRole(actor, role)` and throw `ForbiddenException` when false. For non-`selfOnly` types the dto must carry `subjectUserId`.
2. Resolve the region via `organization.resolveRegion(dto.regionId)` (the `ORGANIZATION` port from Task 3). Throw `BadRequestException` when it returns null or when `isActive` is false. Store all three of `regionId`, `stateId` and `countryId` on the request — `countryId` is what routes the Manager stage, so leaving it null would make every request invisible to Country Managers.
3. `repo.findOpenFor(subjectUserId, type)` — if present, `ConflictException` naming the existing reference.
4. Inside `prisma.$transaction`: allocate the reference; `repo.create` with `status: 'IN_REVIEW'`, `currentStage` = `state.firstStage(...)`, `currentStageEnteredAt` = now, `pipelineVersion` = `PIPELINE_VERSION`; append the `SUBMIT` action with `sequence` from `repo.nextSequence` and `stageEnteredAt` = now.
5. After commit: notify the subject (`type: 'ROLE_REQUEST_UPDATE'`, `entityType: 'role_request'`, `entityId` = request id, `data` carrying the reference) and publish `RoleRequestSubmittedEvent`.

`resubmit` loads the request, calls `state.assertActionAllowed({ action: 'RESUBMIT', ... })`, then in a transaction updates `formData`/`documentKeys`, sets `status: 'IN_REVIEW'` and `currentStage` back to `state.firstStage(...)` with a fresh `currentStageEnteredAt`, and appends the `RESUBMIT` action.

Post-commit notification and publish failures must be caught and logged at `error` with the reference — never propagated, because the request is already recorded.

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/modules/role-requests/services/role-request-submit.service.spec.ts`
Expected: PASS, 10 tests.

---

### Task 8: Stage actions

**Files:**
- Create: `src/modules/role-requests/services/role-request-action.service.ts`
- Test: `src/modules/role-requests/services/role-request-action.service.spec.ts`

**Interfaces:**
- Produces: `RoleRequestActionService` with `advance`, `sendBack`, `withdraw`, `cancel` — each `(actorUserId, actorRole, requestId, body)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RoleRequestActionService } from './role-request-action.service';
import { RoleRequestStateService } from './role-request-state.service';

describe('RoleRequestActionService', () => {
  let repo: Record<string, jest.Mock>;
  let notifications: Record<string, jest.Mock>;
  let bus: Record<string, jest.Mock>;
  let prisma: Record<string, jest.Mock>;
  let service: RoleRequestActionService;

  const request = (over: Record<string, unknown> = {}) => ({
    id: 'req-1',
    reference: 'RR-2026-000007',
    type: 'AGENCY',
    status: 'IN_REVIEW',
    currentStage: 'OFFICIAL',
    currentStageEnteredAt: new Date('2026-07-28T09:00:00Z'),
    pipelineVersion: 1,
    subjectUserId: 'u1',
    initiatedByUserId: 'u1',
    ...over,
  });

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(request()),
      updateStatus: jest.fn().mockResolvedValue({}),
      appendAction: jest.fn().mockResolvedValue({}),
      nextSequence: jest.fn().mockResolvedValue(2),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    prisma = { $transaction: jest.fn().mockImplementation((cb) => cb(prisma)) };

    service = new RoleRequestActionService(
      repo as never,
      new RoleRequestStateService(),
      notifications as never,
      bus as never,
      prisma as never,
    );
  });

  it('moves the request to the next stage and resets the stage clock', async () => {
    await service.advance('off-1', 'OFFICIAL', 'req-1', { notes: 'verified' } as never);

    const patch = repo.updateStatus.mock.calls[0][2];
    expect(patch.currentStage).toBe('MANAGER');
    expect(patch.currentStageEnteredAt).toBeInstanceOf(Date);
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'role.request.advanced' }),
    );
  });

  it('stores the checklist as a whole snapshot on the action', async () => {
    const checklist = { DOCUMENTS_VERIFIED: true, IDENTITY_CONFIRMED: true };
    await service.advance('off-1', 'OFFICIAL', 'req-1', { checklist } as never);

    const action = repo.appendAction.mock.calls[0][1];
    expect(action.checklistSnapshot).toEqual(checklist);
    expect(action.stageEnteredAt).toEqual(new Date('2026-07-28T09:00:00Z'));
    expect(action.actorRole).toBe('OFFICIAL');
  });

  it('refuses to advance past the final stage', async () => {
    repo.findById.mockResolvedValue(request({ currentStage: 'ADMIN' }));
    await expect(
      service.advance('adm-1', 'ADMIN', 'req-1', {} as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sends a request back and requires a reason', async () => {
    await service.sendBack('off-1', 'OFFICIAL', 'req-1', { reason: 'missing licence' } as never);

    const patch = repo.updateStatus.mock.calls[0][2];
    expect(patch).toMatchObject({ status: 'NEEDS_INFO', currentStage: null });
    expect(patch.outcomeReason).toBe('missing licence');
    expect(notifications.create).toHaveBeenCalled();
  });

  it('lets the subject withdraw but not a bystander', async () => {
    await service.withdraw('u1', 'req-1');
    expect(repo.updateStatus.mock.calls[0][2]).toMatchObject({ status: 'WITHDRAWN' });

    repo.updateStatus.mockClear();
    await expect(service.withdraw('other', 'req-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the recommending Official withdraw a recommendation', async () => {
    repo.findById.mockResolvedValue(
      request({ type: 'MODERATOR', currentStage: 'MANAGER', subjectUserId: 'cand', initiatedByUserId: 'off-1' }),
    );
    await service.withdraw('off-1', 'req-1');
    expect(repo.updateStatus.mock.calls[0][2]).toMatchObject({ status: 'WITHDRAWN' });
  });

  it('records cancel as administratively distinct from withdraw', async () => {
    await service.cancel('adm-1', 'ADMIN', 'req-1', { reason: 'duplicate' } as never);

    expect(repo.updateStatus.mock.calls[0][2]).toMatchObject({ status: 'CANCELLED' });
    expect(repo.appendAction.mock.calls[0][1]).toMatchObject({
      action: 'CANCEL',
      actorUserId: 'adm-1',
    });
  });

  it('refuses any action on a terminal request', async () => {
    repo.findById.mockResolvedValue(request({ status: 'APPROVED', currentStage: null }));
    await expect(service.advance('off-1', 'OFFICIAL', 'req-1', {} as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/role-requests/services/role-request-action.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Each method loads the request (404 when absent), calls
`state.assertActionAllowed({ action, status, currentStage, pipelineVersion, type, actorIsSubject, actorIsInitiator })`, then inside one transaction updates the request and appends the action, and after commit notifies the subject and publishes the matching event.

- `advance` — `currentStage` = `state.nextStage(...)`, `currentStageEnteredAt` = now; action `ADVANCE` carrying `notes` and `checklistSnapshot`; event `RoleRequestAdvancedEvent`.
- `sendBack` — `status: 'NEEDS_INFO'`, `currentStage: null`, `outcomeReason` = the reason (required; `BadRequestException` when blank); action `SEND_BACK`; event `RoleRequestSentBackEvent`.
- `withdraw` — `status: 'WITHDRAWN'`, `currentStage: null`, `decidedAt` = now; action `WITHDRAW`; event `RoleRequestClosedEvent`.
- `cancel` — `status: 'CANCELLED'`, `currentStage: null`, `decidedAt` = now, `decidedByUserId` = actor, `outcomeReason` = reason; action `CANCEL`; event `RoleRequestClosedEvent`.

Every appended action carries `stageEnteredAt` = the request's `currentStageEnteredAt` at the time of the action, so time-in-stage is derivable. Post-commit failures are caught and logged at `error`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/role-requests/services/role-request-action.service.spec.ts`
Expected: PASS, 8 tests.

---

### Task 9: Decision and role grant

**Files:**
- Create: `src/modules/role-requests/services/role-request-decision.service.ts`
- Test: `src/modules/role-requests/services/role-request-decision.service.spec.ts`

**Interfaces:**
- Consumes: `AUTHORIZATION_GRANT`, repo, state service, notifications, bus, prisma.
- Produces: `RoleRequestDecisionService.decide(actorUserId, actorRole, requestId, { approve, reason?, checklist? })`.

This is the only service that grants a role. It carries the most risk in the feature.

- [ ] **Step 1: Write the failing test**

```typescript
import { ForbiddenException } from '@nestjs/common';
import { RoleRequestDecisionService } from './role-request-decision.service';
import { RoleRequestStateService } from './role-request-state.service';

describe('RoleRequestDecisionService', () => {
  let repo: Record<string, jest.Mock>;
  let grant: Record<string, jest.Mock>;
  let notifications: Record<string, jest.Mock>;
  let bus: Record<string, jest.Mock>;
  let prisma: Record<string, jest.Mock>;
  let service: RoleRequestDecisionService;

  const request = (over: Record<string, unknown> = {}) => ({
    id: 'req-1',
    reference: 'RR-2026-000007',
    type: 'AGENCY',
    status: 'IN_REVIEW',
    currentStage: 'ADMIN',
    currentStageEnteredAt: new Date('2026-07-28T09:00:00Z'),
    pipelineVersion: 1,
    subjectUserId: 'u1',
    initiatedByUserId: 'u1',
    regionId: 'reg-1',
    ...over,
  });

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(request()),
      updateStatus: jest.fn().mockResolvedValue({}),
      appendAction: jest.fn().mockResolvedValue({}),
      nextSequence: jest.fn().mockResolvedValue(3),
    };
    grant = {
      grantRole: jest.fn().mockResolvedValue({ userRoleId: 'ur-1' }),
      grantScope: jest.fn().mockResolvedValue(undefined),
      hasRole: jest.fn().mockResolvedValue(false),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    prisma = { $transaction: jest.fn().mockImplementation((cb) => cb(prisma)) };

    service = new RoleRequestDecisionService(
      repo as never,
      new RoleRequestStateService(),
      grant as never,
      notifications as never,
      bus as never,
      prisma as never,
    );
  });

  it('grants the role and its region scope on approval', async () => {
    await service.decide('adm-1', 'ADMIN', 'req-1', { approve: true } as never);

    expect(grant.grantRole).toHaveBeenCalledWith({
      userId: 'u1',
      roleName: 'AGENCY',
      assignedByUserId: 'adm-1',
    });
    expect(grant.grantScope).toHaveBeenCalledWith({
      userRoleId: 'ur-1',
      scopeType: 'REGION',
      regionId: 'reg-1',
    });
  });

  it('grants COIN_SELLER onto the same account, not a new one', async () => {
    repo.findById.mockResolvedValue(request({ type: 'COIN_SELLER' }));
    await service.decide('adm-1', 'ADMIN', 'req-1', { approve: true } as never);
    expect(grant.grantRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', roleName: 'COIN_SELLER' }),
    );
  });

  it('publishes role.granted only after the grant, never before', async () => {
    const order: string[] = [];
    grant.grantRole.mockImplementation(async () => {
      order.push('grant');
      return { userRoleId: 'ur-1' };
    });
    bus.publish.mockImplementation(async (e: { name: string }) => {
      order.push(e.name);
    });

    await service.decide('adm-1', 'ADMIN', 'req-1', { approve: true } as never);

    expect(order.indexOf('grant')).toBeLessThan(order.indexOf('role.granted'));
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'role.granted' }),
    );
  });

  it('marks the request approved with the deciding admin recorded', async () => {
    await service.decide('adm-1', 'ADMIN', 'req-1', { approve: true } as never);
    expect(repo.updateStatus.mock.calls[0][2]).toMatchObject({
      status: 'APPROVED',
      decidedByUserId: 'adm-1',
    });
  });

  it('rejects without granting anything', async () => {
    await service.decide('adm-1', 'ADMIN', 'req-1', {
      approve: false,
      reason: 'insufficient documents',
    } as never);

    expect(grant.grantRole).not.toHaveBeenCalled();
    expect(repo.updateStatus.mock.calls[0][2]).toMatchObject({
      status: 'REJECTED',
      outcomeReason: 'insufficient documents',
    });
  });

  it('refuses a decision from a non-final stage', async () => {
    repo.findById.mockResolvedValue(request({ currentStage: 'OFFICIAL' }));
    await expect(
      service.decide('off-1', 'OFFICIAL', 'req-1', { approve: true } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(grant.grantRole).not.toHaveBeenCalled();
  });

  it('refuses to approve when the subject already holds the role', async () => {
    grant.hasRole.mockResolvedValue(true);
    await expect(
      service.decide('adm-1', 'ADMIN', 'req-1', { approve: true } as never),
    ).rejects.toThrow();
    expect(grant.grantRole).not.toHaveBeenCalled();
  });

  it('keeps the approval when the post-commit notification fails', async () => {
    // The decision is recorded and the role granted; a notification outage must
    // not surface as a failed approval the admin would retry.
    notifications.create.mockRejectedValue(new Error('notify down'));
    await expect(
      service.decide('adm-1', 'ADMIN', 'req-1', { approve: true } as never),
    ).resolves.toMatchObject({ approved: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/role-requests/services/role-request-decision.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Order of operations:

1. Load the request; 404 when absent.
2. `state.assertActionAllowed({ action: approve ? 'APPROVE' : 'REJECT', ... })` — this is what refuses a non-Admin stage.
3. On approve only: `grant.hasRole(subjectUserId, roleName)`; `ConflictException` when already held.
4. In one transaction: `repo.updateStatus` to `APPROVED`/`REJECTED` with `decidedAt`, `decidedByUserId`, `outcomeReason`; append the `APPROVE`/`REJECT` action with `stageEnteredAt` from the request.
5. After commit, on approve only: `grant.grantRole` then `grant.grantScope` with `scopeType: 'REGION'` and the request's `regionId`.
6. Publish `RoleGrantedEvent` — **after** the grant returns, never before.
7. Publish `RoleRequestDecidedEvent`, then notify the subject.

Steps 5–7 sit outside the transaction because the grant writes through a different module's service and cannot join this transaction. Wrap 6 and 7 so a failure is caught and logged at `error` with the reference, subject and role. A failure in step 5 must propagate — a recorded approval that granted nothing is worse than a visible error.

The role name is the request `type` for all four flows, since `RoleRequestType` values match role names exactly.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/role-requests/services/role-request-decision.service.spec.ts`
Expected: PASS, 8 tests.

---

### Task 10: Scope-filtered queue

**Files:**
- Create: `src/modules/role-requests/services/role-request-query.service.ts`
- Test: `src/modules/role-requests/services/role-request-query.service.spec.ts`

**Interfaces:**
- Consumes: repo and `AUTHORIZATION_GRANT.scopesFor(userId)` from Task 3. Do NOT import `GeographicScopeResolver` directly — that crosses a module boundary and would raise the violation count.
- Produces: `RoleRequestQueryService.queue(actor, filter)` and `.detail(actor, requestId)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { NotFoundException } from '@nestjs/common';
import { RoleRequestQueryService } from './role-request-query.service';

describe('RoleRequestQueryService', () => {
  let repo: Record<string, jest.Mock>;
  let scopes: Record<string, jest.Mock>;
  let service: RoleRequestQueryService;

  beforeEach(() => {
    repo = {
      queue: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue({
        id: 'req-1',
        regionId: 'reg-1',
        countryId: 'c-1',
        subjectUserId: 'u1',
        actions: [],
      }),
    };
    scopes = {
      scopesFor: jest.fn().mockResolvedValue({ regionIds: ['reg-1'], countryIds: ['c-1'] }),
    };
    service = new RoleRequestQueryService(repo as never, scopes as never);
  });

  it('filters an Official queue to their own regions', async () => {
    await service.queue(
      { id: 'off-1', roles: ['OFFICIAL'] } as never,
      { skip: 0, take: 20 } as never,
    );
    expect(repo.queue).toHaveBeenCalledWith(
      expect.objectContaining({ regionIds: ['reg-1'], stage: 'OFFICIAL' }),
    );
  });

  it('filters a Manager queue by country and the MANAGER stage', async () => {
    await service.queue(
      { id: 'mgr-1', roles: ['COUNTRY_MANAGER'] } as never,
      { skip: 0, take: 20 } as never,
    );
    expect(repo.queue).toHaveBeenCalledWith(
      expect.objectContaining({ countryIds: ['c-1'], stage: 'MANAGER' }),
    );
  });

  it('does not scope-restrict an Admin', async () => {
    await service.queue(
      { id: 'adm-1', roles: ['ADMIN'] } as never,
      { skip: 0, take: 20 } as never,
    );
    const filter = repo.queue.mock.calls[0][0];
    expect(filter.regionIds).toBeUndefined();
    expect(filter.countryIds).toBeUndefined();
  });

  it('hides an out-of-scope request behind 404, not 403', async () => {
    // A 403 would confirm the request exists to someone barred from that region.
    scopes.scopesFor.mockResolvedValue({ regionIds: ['other'], countryIds: ['other'] });
    await expect(
      service.detail({ id: 'off-1', roles: ['OFFICIAL'] } as never, 'req-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('always lets the subject read their own request', async () => {
    scopes.scopesFor.mockResolvedValue({ regionIds: [], countryIds: [] });
    await expect(
      service.detail({ id: 'u1', roles: ['USER'] } as never, 'req-1'),
    ).resolves.toMatchObject({ id: 'req-1' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/role-requests/services/role-request-query.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`queue(actor, filter)` derives the stage and scope restriction from the actor's highest applicable role: `OFFICIAL` → stage `OFFICIAL` restricted to their region ids; `COUNTRY_MANAGER` → stage `MANAGER` restricted to their country ids; `ADMIN`/`SUPER_ADMIN` → stage `ADMIN`, unrestricted. Callers may narrow further by `type` and `status`.

`detail(actor, requestId)` loads the request and returns it when the actor is the subject, the initiator, an Admin, or holds a scope covering the request. Otherwise `NotFoundException` — never `ForbiddenException`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/modules/role-requests/services/role-request-query.service.spec.ts`
Expected: PASS, 5 tests.

---

### Task 11: HTTP surface and wiring

**Files:**
- Create: `src/modules/role-requests/dto/role-request.dto.ts`
- Create: `src/modules/role-requests/controllers/role-request.controller.ts`
- Create: `src/modules/role-requests/role-requests.module.ts`
- Modify: `src/modules/index.ts`

**Interfaces:**
- Consumes: the four services from Tasks 7–10.

- [ ] **Step 1: Write the DTOs**

Request DTOs with `class-validator` decorators and `@ApiProperty` on every field:
`SubmitRoleRequestDto` (`type` enum, `regionId` uuid, optional `subjectUserId` uuid, optional `formData` object, optional `documentKeys` string array), `ResubmitRoleRequestDto`, `AdvanceDto` (optional `notes`, optional `checklist` record), `SendBackDto` (`reason`, non-empty), `DecideDto` (`approve` boolean, optional `reason`, optional `checklist`), `CancelDto` (`reason`), and `RoleRequestQueryDto` (optional `type`, `status`, plus pagination).

Response DTOs: `RoleRequestView` (id, reference, type, status, currentStage, timestamps, region) and `RoleRequestDetailView` (adds the action history).

- [ ] **Step 2: Write the controller**

Base path `role-requests`, `@ApiTags('role-requests')`, `@ApiBearerAuth()`, every route carrying `@ApiOperation`.

| Method | Route | Guard |
| --- | --- | --- |
| POST | `/` | `@NotGuest()` + `@RequirePermissions('role_request.submit')` |
| GET | `/` | `@RequirePermissions('role_request.view')` |
| GET | `/mine` | `@NotGuest()` |
| GET | `/:id` | none beyond JWT — the query service decides visibility |
| POST | `/:id/advance` | `@RequirePermissions('role_request.verify', 'role_request.review')` |
| POST | `/:id/send-back` | `@RequirePermissions('role_request.verify', 'role_request.review')` |
| POST | `/:id/resubmit` | `@NotGuest()` |
| POST | `/:id/decide` | `@RequirePermissions('role_request.decide')` |
| POST | `/:id/withdraw` | `@NotGuest()` |
| POST | `/:id/cancel` | `@RequirePermissions('role_request.decide')` |

`advance` and `send-back` accept either permission because Officials hold `verify` and Managers hold `review`; the state machine and the actor's stage decide what is actually legal. Pass the actor's role into the services so `actorRole` is recorded on the action.

All POST routes take `@HttpCode(HttpStatus.OK)` except `/` which may keep 201.

- [ ] **Step 3: Write the module and register it**

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { OrganizationModule } from '../organization/organization.module';
import { RoleRequestController } from './controllers/role-request.controller';
import { RoleRequestRepository } from './repositories/role-request.repository';
import { RoleRequestActionService } from './services/role-request-action.service';
import { RoleRequestDecisionService } from './services/role-request-decision.service';
import { RoleRequestQueryService } from './services/role-request-query.service';
import { RoleRequestReferenceService } from './services/role-request-reference.service';
import { RoleRequestStateService } from './services/role-request-state.service';
import { RoleRequestSubmitService } from './services/role-request-submit.service';

@Module({
  imports: [PrismaModule, OrganizationModule],
  controllers: [RoleRequestController],
  providers: [
    RoleRequestRepository,
    RoleRequestStateService,
    RoleRequestReferenceService,
    RoleRequestSubmitService,
    RoleRequestActionService,
    RoleRequestDecisionService,
    RoleRequestQueryService,
  ],
  exports: [RoleRequestQueryService],
})
export class RoleRequestsModule {}
```

`AUTHORIZATION_GRANT`, `NOTIFICATION_SERVICE` and `EVENT_BUS` come from `@Global()` modules and must NOT be imported here — doing so risks a circular dependency. Verify each is provided AND exported by a module carrying `@Global()` before assuming it resolves; report per token.

In `src/modules/index.ts`, add the import and the array entry. Two lines, nothing else.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors.
Run: `npx jest src/modules/role-requests` → all pass.
Run: `npx eslint` on every new file plus `src/modules/index.ts` → clean.

---

### Task 12: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Typecheck**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json` → 0 errors.

- [ ] **Step 2: Full suite**

Run: `npx jest --silent`
Expected: every suite passes. Baseline before this work was 383 suites / 4368 tests; this plan adds roughly 48 tests across 6 new spec files.

- [ ] **Step 3: Lint**

Run: `npx eslint "{src,test}/**/*.ts"`
Expected: 11 problems, all pre-existing in games and gift-registry files. Zero in `src/modules/role-requests`.

- [ ] **Step 4: Boundaries**

Run: `npm run boundaries`
Expected: 215 violations, unchanged. A rise means the new module imported another module's internals instead of its `interfaces/`.

- [ ] **Step 5: Report**

Summarise: the endpoints added, the four pipelines, the permissions granted per role, and the fact that the partial unique index in `prisma/schema/role_requests.README.md` must be applied with the migration before the one-open-request rule is enforced at the database level.

---

## Notes for the implementer

**The database is not reachable.** Never run `prisma migrate dev`. Schema plus `npx prisma generate` is the whole scope; the repo owner generates migration SQL.

**Only the Admin stage decides.** If a test seems to want an Official approving something, the test is wrong — the PRD is explicit and the state machine enforces it.

**Post-commit steps are deliberately outside the transaction.** Role granting writes through another module's service and cannot join this one's transaction. Notifications and events must never fail a recorded decision; the grant itself must fail loudly.

**Time-in-stage depends on `stageEnteredAt` being the stage's entry time, not the action time.** Copy it from the request's `currentStageEnteredAt` when appending an action; do not set it to `now`.
