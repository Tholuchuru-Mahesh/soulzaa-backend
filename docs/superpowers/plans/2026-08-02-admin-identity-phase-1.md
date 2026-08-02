# Phase 1 — Admin Identity, Invisibility & Admin Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship hidden Admin accounts that no ordinary user can discover through any surface, restrict Admin creation to Super Admin, and harden the admin login path with telemetry, TOTP 2FA, and device/IP verification.

**Architecture:** A denormalised `User.isHiddenAccount` boolean is the single source of truth for invisibility. The new `admin-identity` module is its only writer, setting it on ADMIN/SUPER_ADMIN role grant and clearing it on revoke, plus a one-off backfill. Three read chokepoints filter on it: `PostgresUserSearchProvider.search()`, `ProfileService.getCards()` (consumed by 9 modules, so one filter covers followers, friends, room members, live viewers and mentions at once), and the rankings write path. Admin login gains a dedicated portal endpoint with TOTP, device and IP checks layered on the existing session engine.

**Tech Stack:** NestJS 11, TypeScript, Prisma + PostgreSQL, Redis, Jest, `otplib` (new), `ua-parser-js` (new).

## Global Constraints

- **No cross-module imports.** `.dependency-cruiser.cjs` rule `no-cross-module-imports` is `severity: 'error'`. Access another module only via its public `interfaces/` (contract + DI token), its published `events/`, or `EVENT_BUS` (`src/common/events`). Verify with `pnpm boundaries`.
- **No direct Prisma mutations across module lines.** `admin-identity` must never write the `users` table directly — it calls `IUsersService`.
- **Administrative controllers must be named `*-admin.controller.ts`** or live under `src/modules/super-admin/`. `rbac-role-matrix.spec.ts` discovers them by exactly that convention; a differently-named controller escapes the authority-matrix test.
- **Never grant a `SUPER_ADMIN_ONLY` code to `ADMIN`:** `config.settings.update`, `config.settings.reset`, `config.flags.manage`, `treasury.policies.update`, `treasury.risk.manage`, `revenue.configuration.manage`, `coin.manage`.
- **`User.roles` (`PlatformRole[]`) is legacy and being retired.** Guards read only the `UserRole` table. Never gate new behaviour on the enum column.
- Every new route needs `@RequirePermissions(...)`, an `AuditLogService.logAction(...)` call for mutations, and `@ApiOperation`/`@ApiResponse` decorators.
- Commands: `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm boundaries`, `pnpm build`.

---

## File Structure

**Created — the new module (single writer of the hidden flag):**

```
src/modules/admin-identity/
├── admin-identity.module.ts                          Wires providers; imports UsersModule, AuthorizationModule
├── index.ts                                          Public surface
├── interfaces/
│   └── admin-identity.interface.ts                   IAdminIdentityService + ADMIN_IDENTITY_SERVICE token
├── services/
│   ├── admin-identity.service.ts                     Flag sync + backfill
│   ├── admin-identity.service.spec.ts
│   ├── admin-provisioning.service.ts                 Create/suspend Admin accounts
│   └── admin-provisioning.service.spec.ts
├── controllers/
│   ├── admin-provisioning-admin.controller.ts        Super-Admin-only Admin CRUD
│   └── index.ts
├── dto/
│   └── create-admin.dto.ts
└── listeners/
    ├── admin-role-sync.listener.ts                   Reacts to role grant/revoke
    └── admin-role-sync.listener.spec.ts
```

**Modified — additive filters at existing seams:**

- `prisma/schema/users.prisma` — add `isHiddenAccount` to `User`
- `src/modules/users/interfaces/users.service.interface.ts` — add flag to `UserIdentity`, add `setHiddenAccount`
- `src/modules/users/interfaces/profile.interface.ts` — add flag to `ProfileView`
- `src/modules/users/services/profile.service.ts` — filter in `getCards`, thread flag through snapshot
- `src/modules/users/services/search/user-search.provider.ts` — filter in `search`
- `src/modules/users/controllers/users.controller.ts:166` — 404 hidden accounts on public profile
- `src/modules/rankings/services/rankings.service.ts` — skip hidden accounts
- `src/modules/authorization/constants/rbac-permissions.constants.ts` — new permission codes
- `src/modules/auth/services/auth.service.ts` — admin login path
- `prisma/schema/session.prisma` — login telemetry columns

---

### Task 1: Add the `isHiddenAccount` flag to the user identity

**Files:**
- Modify: `prisma/schema/users.prisma` (the `User` model)
- Modify: `src/modules/users/interfaces/users.service.interface.ts`
- Modify: `src/modules/users/services/users.service.ts`
- Test: `src/modules/users/services/users.service.hidden-account.spec.ts` (create)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `UserIdentity.isHiddenAccount: boolean`; `IUsersService.setHiddenAccount(id: string, hidden: boolean): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/users/services/users.service.hidden-account.spec.ts`:

```ts
import { UsersService } from './users.service';

describe('UsersService.setHiddenAccount', () => {
  const repo = { setHiddenAccount: jest.fn() } as any;
  // UsersService's real signature is (repo: UsersRepository, config: ConfigService),
  // and the constructor reads security.minUserAge eagerly — the stub must supply it.
  const config = { get: () => ({ minUserAge: 18 }) } as any;
  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(repo, config);
  });

  it('marks an account hidden', async () => {
    await service.setHiddenAccount('u-1', true);
    expect(repo.setHiddenAccount).toHaveBeenCalledWith('u-1', true);
  });

  it('clears the hidden flag', async () => {
    await service.setHiddenAccount('u-1', false);
    expect(repo.setHiddenAccount).toHaveBeenCalledWith('u-1', false);
  });
});
```

Note: match `UsersService`'s real constructor arity — open the file first and pass mocks positionally for every dependency it declares.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- users.service.hidden-account`
Expected: FAIL — `service.setHiddenAccount is not a function`

- [ ] **Step 3: Add the column, the interface method, and the implementation**

In `prisma/schema/users.prisma`, add to `model User` immediately after the `status` line:

```prisma
  /// True for platform staff accounts that must never surface to ordinary
  /// users. Denormalised from the ADMIN / SUPER_ADMIN role assignment and
  /// maintained solely by the admin-identity module, so read paths can filter
  /// with no extra query and no cross-module dependency.
  isHiddenAccount   Boolean        @default(false)
```

And add to the model's index block:

```prisma
  @@index([isHiddenAccount])
```

In `src/modules/users/interfaces/users.service.interface.ts`, add to `UserIdentity`:

```ts
  isHiddenAccount: boolean;
```

and to `IUsersService`:

```ts
  /** Marks/unmarks an account as platform-staff-hidden. Written only by the admin-identity module. */
  setHiddenAccount(id: string, hidden: boolean): Promise<void>;
```

Implement in `src/modules/users/services/users.service.ts`:

```ts
  async setHiddenAccount(id: string, hidden: boolean): Promise<void> {
    await this.users.setHiddenAccount(id, hidden);
  }
```

Add to `UsersRepository`:

```ts
  async setHiddenAccount(id: string, hidden: boolean): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { isHiddenAccount: hidden } });
  }
```

Ensure every `select`/mapper in `UsersRepository` that builds a `UserIdentity` includes `isHiddenAccount: true`.

- [ ] **Step 4: Generate the migration and run the tests**

```bash
pnpm prisma migrate dev --name add_user_is_hidden_account
pnpm test -- users.service.hidden-account
pnpm build
```

Expected: migration applies, tests PASS, build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema/users.prisma prisma/migrations src/modules/users
git commit -m "feat(users): add isHiddenAccount flag to user identity"
```

---

### Task 2: Create the admin-identity module and its service contract

**Files:**
- Create: `src/modules/admin-identity/interfaces/admin-identity.interface.ts`
- Create: `src/modules/admin-identity/services/admin-identity.service.ts`
- Create: `src/modules/admin-identity/admin-identity.module.ts`
- Create: `src/modules/admin-identity/index.ts`
- Test: `src/modules/admin-identity/services/admin-identity.service.spec.ts`

**Interfaces:**
- Consumes: `IUsersService.setHiddenAccount` (Task 1), `USERS_SERVICE` token, `PROFILE_SERVICE` token
- Produces: `ADMIN_IDENTITY_SERVICE` token; `IAdminIdentityService` with `syncHiddenState(userId: string): Promise<void>`, `isHidden(userId: string): Promise<boolean>`, `backfill(): Promise<{ scanned: number; hidden: number }>`; `IProfileService.invalidateProfile(userId: string): Promise<void>`

**Cache invalidation is part of this task, not an afterthought.** `ProfileService` caches each profile snapshot under `CACHE_KEYS.USER + 'profile:' + userId` with a TTL, and `getCards` (Task 5) reads that snapshot. Without invalidation a newly-promoted Admin stays visible until the TTL expires. `ProfileService.invalidate` is currently **private** — promote it onto the public `IProfileService` contract as `invalidateProfile` so `admin-identity` can call it across the module boundary.

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin-identity/services/admin-identity.service.spec.ts`:

```ts
import { AdminIdentityService } from './admin-identity.service';

describe('AdminIdentityService.syncHiddenState', () => {
  const users = { setHiddenAccount: jest.fn(), findById: jest.fn() } as any;
  const roles = { getRoleNames: jest.fn() } as any;
  const profiles = { invalidateProfile: jest.fn() } as any;
  let service: AdminIdentityService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminIdentityService(users, roles, profiles);
  });

  it('invalidates the cached profile so the change takes effect immediately', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    await service.syncHiddenState('u-1');
    expect(profiles.invalidateProfile).toHaveBeenCalledWith('u-1');
  });

  it('hides an account holding ADMIN', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    await service.syncHiddenState('u-1');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-1', true);
  });

  it('hides an account holding SUPER_ADMIN', async () => {
    roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    await service.syncHiddenState('u-2');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-2', true);
  });

  it('unhides an account whose privileged role was revoked', async () => {
    roles.getRoleNames.mockResolvedValue(['HOST']);
    await service.syncHiddenState('u-3');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-3', false);
  });

  it('does not hide a MODERATOR — only ADMIN and SUPER_ADMIN are hidden', async () => {
    roles.getRoleNames.mockResolvedValue(['MODERATOR']);
    await service.syncHiddenState('u-4');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-4', false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- admin-identity.service`
Expected: FAIL — cannot find module `./admin-identity.service`

- [ ] **Step 3: Write the interface and implementation**

Create `src/modules/admin-identity/interfaces/admin-identity.interface.ts`:

```ts
export const ADMIN_IDENTITY_SERVICE = Symbol('ADMIN_IDENTITY_SERVICE');

export interface IAdminIdentityService {
  /** Recomputes and persists the hidden flag from the account's current roles. */
  syncHiddenState(userId: string): Promise<void>;
  isHidden(userId: string): Promise<boolean>;
  /** One-off reconciliation for accounts that predate the flag. */
  backfill(): Promise<{ scanned: number; hidden: number }>;
}
```

Create `src/modules/admin-identity/services/admin-identity.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { RoleResolverService } from 'src/modules/authorization/services/role-resolver.service';
import type { IAdminIdentityService } from '../interfaces/admin-identity.interface';

/** Roles whose holders must never surface to ordinary users. */
const HIDDEN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

/**
 * Owns `User.isHiddenAccount` — the denormalised projection of "this account
 * holds a hidden role". Every read path filters on that column rather than
 * resolving roles per request, so invisibility costs no extra query.
 *
 * This service is the column's ONLY writer. It writes through IUsersService
 * because the users table belongs to the users module.
 */
@Injectable()
export class AdminIdentityService implements IAdminIdentityService {
  private readonly logger = new Logger(AdminIdentityService.name);

  constructor(
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    private readonly roles: RoleResolverService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  async syncHiddenState(userId: string): Promise<void> {
    const names = await this.roles.getRoleNames(userId);
    const shouldHide = names.some((name) => HIDDEN_ROLES.has(name));
    await this.users.setHiddenAccount(userId, shouldHide);
    // The profile snapshot is cached and carries the flag; without this a
    // freshly-promoted Admin stays visible until the TTL lapses.
    await this.profiles.invalidateProfile(userId);
  }

  async isHidden(userId: string): Promise<boolean> {
    const user = await this.users.findById(userId);
    return user?.isHiddenAccount ?? false;
  }

  async backfill(): Promise<{ scanned: number; hidden: number }> {
    const holders = await this.roles.getUserIdsWithAnyRole([...HIDDEN_ROLES]);
    for (const userId of holders) {
      await this.users.setHiddenAccount(userId, true);
      await this.profiles.invalidateProfile(userId);
    }
    this.logger.log(`Backfilled ${holders.length} hidden accounts`);
    return { scanned: holders.length, hidden: holders.length };
  }
}
```

Promote the cache invalidator onto the public contract. In `src/modules/users/interfaces/profile.interface.ts` add to `IProfileService`:

```ts
  /** Drops the cached profile snapshot. Called when a field other modules read (e.g. isHiddenAccount) changes. */
  invalidateProfile(userId: string): Promise<void>;
```

and in `profile.service.ts` expose the existing private `invalidate` under that name:

```ts
  async invalidateProfile(userId: string): Promise<void> {
    await this.invalidate(userId);
  }
```

`RoleResolverService.getRoleNames(userId)` already exists (`role-resolver.service.ts:98`). `getUserIdsWithAnyRole` does **not** — add it:

```ts
  async getUserIdsWithAnyRole(roleNames: string[]): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { role: { name: { in: roleNames } } },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }
```

Create `src/modules/admin-identity/admin-identity.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthorizationModule } from 'src/modules/authorization/authorization.module';
import { UsersModule } from 'src/modules/users/users.module';
import { ADMIN_IDENTITY_SERVICE } from './interfaces/admin-identity.interface';
import { AdminIdentityService } from './services/admin-identity.service';

@Module({
  imports: [UsersModule, AuthorizationModule],
  providers: [
    AdminIdentityService,
    { provide: ADMIN_IDENTITY_SERVICE, useExisting: AdminIdentityService },
  ],
  exports: [ADMIN_IDENTITY_SERVICE, AdminIdentityService],
})
export class AdminIdentityModule {}
```

Create `src/modules/admin-identity/index.ts`:

```ts
export * from './admin-identity.module';
export * from './interfaces/admin-identity.interface';
```

Register `AdminIdentityModule` in `src/modules/index.ts` alongside the other modules.

- [ ] **Step 4: Run tests and the boundary check**

```bash
pnpm test -- admin-identity.service
pnpm boundaries
```

Expected: tests PASS; `pnpm boundaries` reports no `no-cross-module-imports` error.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin-identity src/modules/index.ts src/modules/authorization
git commit -m "feat(admin-identity): add hidden-account identity service"
```

---

### Task 3: Keep the flag in sync on role grant and revoke

**Files:**
- Create: `src/modules/authorization/events/role.events.ts`
- Modify: `src/modules/authorization/services/role.service.ts` (publish on assign/revoke)
- Create: `src/modules/admin-identity/listeners/admin-role-sync.listener.ts`
- Test: `src/modules/admin-identity/listeners/admin-role-sync.listener.spec.ts`
- Modify: `src/modules/admin-identity/admin-identity.module.ts`

**Interfaces:**
- Consumes: `IAdminIdentityService.syncHiddenState` (Task 2), `EVENT_BUS`
- Produces: `ROLE_EVENTS.ASSIGNED`, `ROLE_EVENTS.REVOKED`, `RoleAssignedEvent`, `RoleRevokedEvent`

**Confirmed:** the authorization module has **no `events/` directory** — it must be created. Follow the exact convention used by `src/modules/gifts/events/gift.events.ts`: a frozen constants object of event names plus event classes carrying a `payload`. Publish via the injected `EVENT_BUS` from `RoleService.assignRole` and `RoleService.removeRole`.

Create `src/modules/authorization/events/role.events.ts`:

```ts
export const ROLE_EVENTS = {
  ASSIGNED: 'role.assigned',
  REVOKED: 'role.revoked',
} as const;

export interface RoleChangePayload {
  userId: string;
  roleName: string;
  actorId: string | null;
}

export class RoleAssignedEvent {
  constructor(readonly payload: RoleChangePayload) {}
}

export class RoleRevokedEvent {
  constructor(readonly payload: RoleChangePayload) {}
}
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin-identity/listeners/admin-role-sync.listener.spec.ts`:

```ts
import { ROLE_EVENTS } from 'src/modules/authorization/events/role.events';
import { AdminRoleSyncListener } from './admin-role-sync.listener';

describe('AdminRoleSyncListener', () => {
  const identity = { syncHiddenState: jest.fn() } as any;
  const handlers = new Map<string, (e: unknown) => unknown>();
  const bus = {
    subscribe: jest.fn((name: string, handler: (e: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    new AdminRoleSyncListener(bus, identity).onModuleInit();
  });

  const event = { payload: { userId: 'u-1', roleName: 'ADMIN', actorId: null } };

  it('resyncs the subject when a role is assigned', async () => {
    await handlers.get(ROLE_EVENTS.ASSIGNED)!(event);
    expect(identity.syncHiddenState).toHaveBeenCalledWith('u-1');
  });

  it('resyncs the subject when a role is revoked', async () => {
    await handlers.get(ROLE_EVENTS.REVOKED)!(event);
    expect(identity.syncHiddenState).toHaveBeenCalledWith('u-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- admin-role-sync`
Expected: FAIL — cannot find module `./admin-role-sync.listener`

- [ ] **Step 3: Declare the events, publish them, and write the listener**

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  ROLE_EVENTS,
  type RoleAssignedEvent,
  type RoleRevokedEvent,
} from 'src/modules/authorization/events/role.events';
import {
  ADMIN_IDENTITY_SERVICE,
  type IAdminIdentityService,
} from '../interfaces/admin-identity.interface';

/**
 * Recomputes the hidden flag on any role change. Deliberately unconditional:
 * resyncing on every change costs one role lookup and removes a whole class of
 * bug where a role rename, or a role added to HIDDEN_ROLES later, leaves stale
 * flags behind on accounts that changed while the old rule was in force.
 */
@Injectable()
export class AdminRoleSyncListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(ADMIN_IDENTITY_SERVICE) private readonly identity: IAdminIdentityService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(ROLE_EVENTS.ASSIGNED, (e) =>
      this.identity.syncHiddenState(e.payload.userId),
    );
    this.bus.subscribe<RoleRevokedEvent>(ROLE_EVENTS.REVOKED, (e) =>
      this.identity.syncHiddenState(e.payload.userId),
    );
  }
}
```

Register `AdminRoleSyncListener` in the module's `providers`. Note this listener imports from another module's `events/` directory, which the boundary rule explicitly permits.

The spec test above calls `onRoleAssigned`/`onRoleRevoked` directly; rewrite it against this shape instead — construct the listener with a fake bus that captures handlers, call `onModuleInit()`, then invoke the captured handler with `{ payload: { userId: 'u-1', roleName: 'ADMIN', actorId: null } }` and assert `syncHiddenState` was called with `'u-1'`.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- admin-role-sync`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin-identity
git commit -m "feat(admin-identity): resync hidden flag on role change"
```

---

### Task 4: Exclude hidden accounts from user search

**Files:**
- Modify: `src/modules/users/services/search/user-search.provider.ts`
- Test: `src/modules/users/services/search/user-search.provider.hidden.spec.ts` (create)

**Interfaces:**
- Consumes: `User.isHiddenAccount` (Task 1)
- Produces: `UserSearchOptions.includeHidden?: boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { PostgresUserSearchProvider } from './user-search.provider';

describe('PostgresUserSearchProvider — hidden accounts', () => {
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  } as any;
  const media = { resolve: jest.fn() } as any;
  let provider: PostgresUserSearchProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new PostgresUserSearchProvider(prisma, media);
  });

  it('excludes hidden accounts by default', async () => {
    await provider.search('nas', {});
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isHiddenAccount: false }) }),
    );
  });

  it('includes hidden accounts when a privileged caller opts in', async () => {
    await provider.search('nas', { includeHidden: true });
    const { where } = prisma.user.findMany.mock.calls[0][0];
    expect(where.isHiddenAccount).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- user-search.provider.hidden`
Expected: FAIL — `where` has no `isHiddenAccount` key

- [ ] **Step 3: Add the filter**

In `user-search.provider.ts`, extend `UserSearchOptions`:

```ts
  /**
   * Include platform-staff accounts. Off by default: hidden accounts must not
   * surface to ordinary users. Only privileged admin-console callers set this.
   */
  includeHidden?: boolean;
```

and add to the `where` object built in `search`, directly after `deletedAt: null`:

```ts
      ...(opts.includeHidden ? {} : { isHiddenAccount: false }),
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- user-search`
Expected: PASS, and the pre-existing search specs stay green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/users/services/search
git commit -m "feat(users): exclude hidden accounts from search by default"
```

---

### Task 5: Exclude hidden accounts from the cross-module card resolver

This is the highest-leverage task in the phase. `ProfileService.getCards()` is documented as *"the only sanctioned cross-module read of user/profile data"* and is consumed by **9 modules** — audio-rooms, calls, casino, chat, games, notification, social, users and video-rooms. Filtering here covers followers, friends, room members, live viewers, audience lists and mentions in one change.

**Files:**
- Modify: `src/modules/users/interfaces/profile.interface.ts`
- Modify: `src/modules/users/services/profile.service.ts`
- Test: `src/modules/users/services/profile.service.hidden.spec.ts` (create)

**Interfaces:**
- Consumes: `UserIdentity.isHiddenAccount` (Task 1)
- Produces: `ProfileView.isHiddenAccount: boolean`; `getCards` returns only visible accounts

- [ ] **Step 1: Write the failing test**

```ts
import { ProfileService } from './profile.service';

describe('ProfileService.getCards — hidden accounts', () => {
  function view(id: string, hidden: boolean) {
    return {
      id,
      username: id,
      fullName: null,
      avatarUrl: null,
      country: null,
      isHiddenAccount: hidden,
      statistics: { level: 1, vipLevel: 0 },
      verification: { verified: false },
    };
  }

  it('drops hidden accounts from resolved cards', async () => {
    const service = Object.create(ProfileService.prototype) as ProfileService;
    (service as any).getProfileView = jest.fn(async (id: string) =>
      id === 'admin-1' ? view('admin-1', true) : view(id, false),
    );

    const cards = await service.getCards(['u-1', 'admin-1', 'u-2']);

    expect(cards.map((c) => c.id)).toEqual(['u-1', 'u-2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- profile.service.hidden`
Expected: FAIL — received `['u-1', 'admin-1', 'u-2']`

- [ ] **Step 3: Thread the flag through and filter**

In `src/modules/users/interfaces/profile.interface.ts`, add to `ProfileView`:

```ts
  /** True for platform-staff accounts. Never rendered to ordinary users. */
  isHiddenAccount: boolean;
```

In `profile.service.ts`, include `isHiddenAccount` in `buildSnapshot` (so it is part of `CachedProfile`) and in `resolveView`, sourcing it from the `UserIdentity` returned by `this.users.findById`.

Then change `getCards` (currently at `src/modules/users/services/profile.service.ts:176`) to filter:

```ts
  async getCards(ids: string[]): Promise<UserCard[]> {
    const unique = [...new Set(ids)];
    const views = await Promise.all(unique.map((id) => this.getProfileView(id)));
    return views
      .filter((v): v is ProfileView => v !== null)
      // Platform-staff accounts are invisible to every consumer of this
      // resolver — followers, friends, room members, live viewers, mentions.
      .filter((v) => !v.isHiddenAccount)
      .map((v) => ({
        id: v.id,
        username: v.username,
        fullName: v.fullName,
        avatarUrl: v.avatarUrl,
        verified: v.verification.verified,
        level: v.statistics.level,
        vipLevel: v.statistics.vipLevel,
        country: v.country,
      }));
  }
```

Apply the same filter to `resolvePublicIdentities(ids)` — the batch identity resolver documented immediately below `getCards`, used by games player panels and video-room seat/request panels. It batch-loads from `users`/`user_profiles`/`user_statistics` directly rather than going through `getProfileView`, so it needs `isHiddenAccount: false` added to its own `where` clause instead of an in-memory filter.

`ProfileService.search` at `profile.service.ts:247` needs no change — Task 4 filters inside the provider it delegates to.

Cache invalidation is already handled by Task 2 (`invalidateProfile`), so a promotion takes effect immediately rather than at TTL expiry. Confirm that during review of this task.

- [ ] **Step 4: Run the full users suite**

```bash
pnpm test -- users
pnpm build
```

Expected: new test PASSES, all pre-existing users specs stay green, build clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/users
git commit -m "feat(users): hide staff accounts from the cross-module card resolver"
```

---

### Task 6: Return 404 for hidden accounts on the public profile route

`getCards` covers list surfaces, but a direct fetch by username or id still resolves an Admin profile to anyone who guesses the handle.

**Files:**
- Modify: `src/modules/users/services/profile.service.ts` (`getPublicProfile`, `getProfileByUsername`)
- Test: `test/users-hidden-profile.e2e-spec.ts` (create)

The public route `@Get(':identifier')` at `users.controller.ts:166` delegates to `IProfileService.getPublicProfile(identifier, viewerId)`, which already takes `viewerId` and is already privacy-aware. Put the check **there**, not in the controller: `getProfileByUsername` is a second public entry point with the same exposure, and a service-level check covers both.

**Interfaces:**
- Consumes: `ProfileView.isHiddenAccount` (Task 5)
- Produces: nothing

- [ ] **Step 1: Write the failing test**

Create `test/users-hidden-profile.e2e-spec.ts` following the structure of an existing file in `test/`. Assert:

```ts
it('returns 404 for a hidden staff account', async () => {
  await request(app.getHttpServer())
    .get(`/api/users/${hiddenAdminUsername}`)
    .set('Authorization', `Bearer ${ordinaryUserToken}`)
    .expect(404);
});

it('still resolves a hidden account for another staff account', async () => {
  // adminToken belongs to an account that is itself hidden — per spec, only
  // Super Admin and Admin can identify Admin accounts.
  await request(app.getHttpServer())
    .get(`/api/users/${hiddenAdminUsername}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(200);
});

it('returns 404 to an anonymous caller', async () => {
  await request(app.getHttpServer()).get(`/api/users/${hiddenAdminUsername}`).expect(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:e2e -- users-hidden-profile`
Expected: FAIL — first case returns 200

- [ ] **Step 3: Add the visibility check**

In `ProfileService`, add a shared guard and apply it in both `getPublicProfile` and `getProfileByUsername`, immediately before returning the resolved view:

```ts
  /**
   * A hidden staff account is indistinguishable from a non-existent one.
   * Returning null (→ 404) rather than throwing 403: a 403 would itself confirm
   * that the handle belongs to staff, which is exactly what must stay secret.
   */
  private hideIfStaff(view: ProfileView | null, viewerIsPrivileged: boolean): ProfileView | null {
    if (view?.isHiddenAccount && !viewerIsPrivileged) return null;
    return view;
  }
```

The users module must not import the authorization module to resolve `viewerIsPrivileged` — that would breach the boundary rule. Instead resolve it the way this codebase already does for cross-cutting viewer facts: the viewer's own `isHiddenAccount` flag is already on their `UserIdentity`, so `viewerIsPrivileged` is simply "the viewer is themselves a hidden staff account". That satisfies the spec exactly — *"Only Super Admin and Admin can identify Admin accounts"* — and costs one `findById` the service already performs.

Anonymous viewers (`viewerId` undefined) are never privileged, so they always get the null branch.

- [ ] **Step 4: Run tests**

Run: `pnpm test:e2e -- users-hidden-profile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/users/controllers test/users-hidden-profile.e2e-spec.ts
git commit -m "feat(users): 404 hidden staff accounts on public profile lookup"
```

---

### Task 7: Keep hidden accounts out of rankings

Rankings bypass `getCards` — `RankingsService.getGifters` hydrates via `repo.getUsersDetails(userIds)`. Filtering on the write side is preferred: an account that never enters a leaderboard cannot leak through a stale snapshot.

**Files:**
- Modify: `src/modules/rankings/services/rankings.service.ts`
- Modify: `src/modules/rankings/services/leaderboard-store.service.ts`
- Test: `src/modules/rankings/services/rankings.hidden.spec.ts` (create)

**Interfaces:**
- Consumes: `User.isHiddenAccount` (Task 1)
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```ts
describe('Rankings — hidden accounts', () => {
  it('never enrols a hidden account into a leaderboard', async () => {
    // increments arrive for a normal user and a hidden admin
    await store.incrementMany([
      { key: 'gifters:daily', member: 'u-1', score: 10 },
      { key: 'gifters:daily', member: 'admin-1', score: 999 },
    ]);
    expect(redis.zincrby).toHaveBeenCalledTimes(1);
    expect(redis.zincrby).toHaveBeenCalledWith('gifters:daily', 10, 'u-1');
  });

  it('drops a hidden account already present in a snapshot on read', async () => {
    const page = await service.getGifters('DAILY', 10, 1);
    expect(page.items.map((i) => i.userId)).not.toContain('admin-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- rankings.hidden`
Expected: FAIL — hidden member is enrolled

- [ ] **Step 3: Filter both sides**

Write side, in `LeaderboardStoreService.incrementMany`: resolve the member ids through the users module contract and drop hidden ones before writing to Redis. Read side, in `getGifters`/`getReceivers`/`getStreamers`: after `this.repo.getUsersDetails(userIds)`, drop entries whose detail row is hidden, then renumber ranks so the page has no gaps.

`getFamilies` ranks families rather than users and needs no change — note that explicitly so a reviewer does not read it as an omission.

- [ ] **Step 4: Run tests**

```bash
pnpm test -- rankings
```

Expected: PASS, existing rankings specs green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rankings
git commit -m "feat(rankings): keep hidden staff accounts out of leaderboards"
```

---

### Task 8: Admin provisioning — only Super Admin creates an Admin

**Files:**
- Create: `src/modules/admin-identity/services/admin-provisioning.service.ts`
- Create: `src/modules/admin-identity/controllers/admin-provisioning-admin.controller.ts`
- Create: `src/modules/admin-identity/dto/create-admin.dto.ts`
- Modify: `src/modules/authorization/constants/rbac-permissions.constants.ts`
- Test: `src/modules/admin-identity/services/admin-provisioning.service.spec.ts`

**Interfaces:**
- Consumes: `IAdminIdentityService` (Task 2), `AuditLogService.logAction`
- Produces: `POST /api/admin-identity/admins`, `GET /api/admin-identity/admins`, `PATCH /api/admin-identity/admins/:id/status`

The controller filename ends in `-admin.controller.ts` so `rbac-role-matrix.spec.ts` picks it up.

- [ ] **Step 1: Write the failing test**

```ts
import { ForbiddenException } from '@nestjs/common';
import { AdminProvisioningService } from './admin-provisioning.service';

describe('AdminProvisioningService', () => {
  const users = { createIdentity: jest.fn(), findById: jest.fn() } as any;
  const roles = { assignRole: jest.fn(), getRoleNames: jest.fn() } as any;
  const identity = { syncHiddenState: jest.fn() } as any;
  const audit = { logAction: jest.fn() } as any;
  let service: AdminProvisioningService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminProvisioningService(users, roles, identity, audit);
  });

  it('rejects creation by an actor who is not SUPER_ADMIN', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    await expect(
      service.createAdmin('actor-1', { email: 'a@b.com', username: 'ops1', password: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(users.createIdentity).not.toHaveBeenCalled();
  });

  it('creates and hides the account when the actor is SUPER_ADMIN', async () => {
    roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    users.createIdentity.mockResolvedValue({ id: 'new-1' });

    await service.createAdmin('actor-1', { email: 'a@b.com', username: 'ops1', password: 'x' });

    expect(roles.assignRole).toHaveBeenCalledWith('new-1', 'ADMIN', 'actor-1');
    expect(identity.syncHiddenState).toHaveBeenCalledWith('new-1');
  });

  it('writes an audit entry on creation', async () => {
    roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    users.createIdentity.mockResolvedValue({ id: 'new-1' });

    await service.createAdmin('actor-1', { email: 'a@b.com', username: 'ops1', password: 'x' });

    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'actor-1', action: 'admin.created', resourceId: 'new-1' }),
    );
  });

  it('refuses to suspend a SUPER_ADMIN', async () => {
    roles.getRoleNames.mockImplementation(async (id: string) =>
      id === 'actor-1' ? ['SUPER_ADMIN'] : ['SUPER_ADMIN'],
    );
    await expect(service.setStatus('actor-1', 'target-1', 'SUSPENDED')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- admin-provisioning`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

Add to `rbac-permissions.constants.ts` a new `admin.provision` code, and grant it to `SUPER_ADMIN` only — add it to the `SUPER_ADMIN_ONLY` array in `rbac-role-matrix.spec.ts` so the matrix test enforces that `ADMIN` never receives it.

The service enforces four spec rules, each with its own guard clause:
1. Actor must hold `SUPER_ADMIN` → else `ForbiddenException`.
2. An `ADMIN` may never create another `ADMIN` — falls out of rule 1.
3. Target holding `SUPER_ADMIN` may not be suspended or deleted → `ForbiddenException`.
4. Every mutation calls `audit.logAction` with `action: 'admin.created' | 'admin.status_changed'`.

After creation, call `identity.syncHiddenState(newId)` so the account is hidden immediately rather than at next role change.

Controller: guard the class with `@RequirePermissions('admin.provision')` and `@UseGuards(JwtAuthGuard, RbacPermissionsGuard)`, add `@ApiTags('Admin Identity')`, `@ApiBearerAuth()`, and `@ApiOperation`/`@ApiResponse` on each route. DTO uses `class-validator` (`@IsEmail`, `@IsString`, `@MinLength(12)`) — the global `ValidationPipe` runs `whitelist: true, forbidNonWhitelisted: true`.

- [ ] **Step 4: Run tests including the authority matrix**

```bash
pnpm test -- admin-provisioning
pnpm test -- rbac-role-matrix
pnpm boundaries
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin-identity src/modules/authorization
git commit -m "feat(admin-identity): super-admin-only admin provisioning"
```

---

### Task 9: Make Super Admin unidentifiable to Admin

Spec rule: an Admin *"cannot identify Super Admin"*. Admin holds `user.view` and `user.audit.view`, so today an Admin listing users can read `SUPER_ADMIN` straight off the role column.

**Files:**
- Modify: `src/modules/super-admin/controllers/super-admin-user.controller.ts`
- Modify: the user-management service backing it
- Test: `src/modules/super-admin/services/super-admin-user.masking.spec.ts` (create)

**Interfaces:**
- Consumes: `RoleResolverService.getRoleNames`
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```ts
describe('User detail role masking', () => {
  it('masks SUPER_ADMIN as STAFF for a viewer who is not SUPER_ADMIN', async () => {
    viewerRoles.mockResolvedValue(['ADMIN']);
    targetRoles.mockResolvedValue(['SUPER_ADMIN']);
    const detail = await service.getUser('viewer-1', 'target-1');
    expect(detail.roles).toEqual(['STAFF']);
  });

  it('shows the real role to a SUPER_ADMIN viewer', async () => {
    viewerRoles.mockResolvedValue(['SUPER_ADMIN']);
    targetRoles.mockResolvedValue(['SUPER_ADMIN']);
    const detail = await service.getUser('viewer-1', 'target-1');
    expect(detail.roles).toEqual(['SUPER_ADMIN']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- super-admin-user.masking`
Expected: FAIL — roles returned unmasked

- [ ] **Step 3: Implement masking**

Add a private helper applied to every role projection leaving the user-management service:

```ts
  /**
   * Super Admin is invisible as a *role* to anyone below it: an Admin sees
   * "STAFF". Masking at the projection boundary means every read route — detail,
   * list and audit log — inherits it without remembering to opt in.
   */
  private maskRoles(roles: string[], viewerIsSuperAdmin: boolean): string[] {
    if (viewerIsSuperAdmin) return roles;
    return roles.map((r) => (r === 'SUPER_ADMIN' ? 'STAFF' : r));
  }
```

Apply it in the detail, list and audit-log projections. Pass `viewerIsSuperAdmin` down from the controller via `@CurrentUser('id')`.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- super-admin`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/super-admin
git commit -m "feat(super-admin): mask SUPER_ADMIN role from lower operators"
```

---

### Task 10: Capture admin login telemetry

Spec §2 requires Login Time, Logout Time, Browser, Device, OS, Country, IP and Login Status. `SessionHistory` already stores `ip`, `userAgent`, `event` and `createdAt`. Missing: parsed browser/OS/device and geo-IP country.

**Files:**
- Modify: `prisma/schema/session.prisma`
- Create: `src/modules/session/services/login-telemetry.service.ts`
- Test: `src/modules/session/services/login-telemetry.service.spec.ts`
- Modify: `package.json` (add `ua-parser-js`)

**Interfaces:**
- Consumes: `RequestMetadata` (`{ requestId, ip, userAgent, timestamp }` from `src/common/decorators/request-meta.decorator.ts`)
- Produces: `LoginTelemetryService.describe(meta): { browser, os, deviceType, country }`

- [ ] **Step 1: Write the failing test**

```ts
import { LoginTelemetryService } from './login-telemetry.service';

describe('LoginTelemetryService.describe', () => {
  const geo = { countryFor: jest.fn().mockResolvedValue('IN') } as any;
  const service = new LoginTelemetryService(geo);

  it('parses browser, os and device from a desktop user-agent', async () => {
    const out = await service.describe({
      ip: '1.2.3.4',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    });
    expect(out.browser).toBe('Chrome');
    expect(out.os).toBe('Mac OS');
    expect(out.deviceType).toBe('desktop');
    expect(out.country).toBe('IN');
  });

  it('degrades gracefully when the user-agent is absent', async () => {
    const out = await service.describe({ ip: '1.2.3.4', userAgent: undefined });
    expect(out.browser).toBeNull();
    expect(out.os).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- login-telemetry`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

```bash
pnpm add ua-parser-js
```

Add to `SessionHistory` in `prisma/schema/session.prisma`:

```prisma
  browser    String?
  os         String?
  deviceType String?
  country    String?
```

Implement `describe` with `UAParser`, returning `null` for each field it cannot determine (never throw — a login must not fail because a user-agent was unparseable). Resolve `country` from the existing geo-IP source if one is configured; otherwise return `null` and log once at startup that geo-IP is unconfigured, so the gap is visible rather than silent.

Record the telemetry on the existing `UserLoggedInEvent` listener path (`auth.service.ts:415`) so no new call site is threaded through the login flow.

- [ ] **Step 4: Run tests and migrate**

```bash
pnpm prisma migrate dev --name add_session_login_telemetry
pnpm test -- login-telemetry
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prisma src/modules/session package.json pnpm-lock.yaml
git commit -m "feat(session): capture browser, os, device and country on login"
```

---

### Task 11: TOTP 2FA and device/IP verification on the admin portal

**Files:**
- Create: `src/modules/admin-identity/services/admin-2fa.service.ts`
- Create: `src/modules/admin-identity/controllers/admin-auth-admin.controller.ts`
- Create: `prisma/schema/admin_identity.prisma`
- Test: `src/modules/admin-identity/services/admin-2fa.service.spec.ts`
- Modify: `package.json` (add `otplib`)

**Interfaces:**
- Consumes: `AuthService.loginWithPassword`, `LoginTelemetryService.describe` (Task 10), `IAdminIdentityService.isHidden` (Task 2)
- Produces: `POST /api/admin-auth/login`, `POST /api/admin-auth/2fa/enroll`, `POST /api/admin-auth/2fa/verify`

- [ ] **Step 1: Write the failing test**

```ts
import { UnauthorizedException } from '@nestjs/common';
import { authenticator } from 'otplib';
import { Admin2faService } from './admin-2fa.service';

describe('Admin2faService', () => {
  const repo = { getSecret: jest.fn(), saveSecret: jest.fn(), isTrustedDevice: jest.fn() } as any;
  const service = new Admin2faService(repo);

  beforeEach(() => jest.clearAllMocks());

  it('accepts a valid TOTP code', async () => {
    const secret = authenticator.generateSecret();
    repo.getSecret.mockResolvedValue(secret);
    await expect(
      service.verify('admin-1', authenticator.generate(secret)),
    ).resolves.toBe(true);
  });

  it('rejects an invalid TOTP code', async () => {
    repo.getSecret.mockResolvedValue(authenticator.generateSecret());
    await expect(service.verify('admin-1', '000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the account has not enrolled', async () => {
    repo.getSecret.mockResolvedValue(null);
    await expect(service.verify('admin-1', '123456')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- admin-2fa`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

```bash
pnpm add otplib
```

Create `prisma/schema/admin_identity.prisma`:

```prisma
/// TOTP enrolment and trusted device/IP allow-list for hidden staff accounts.
/// Separate from the user session tables: staff second-factor state must not be
/// readable through any user-facing session query.
model AdminCredential {
  id          String    @id @default(uuid()) @db.Uuid
  userId      String    @unique @db.Uuid
  totpSecret  String
  enrolledAt  DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@map("admin_credentials")
}

model AdminTrustedDevice {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @db.Uuid
  deviceHash String
  ipAddress  String?
  lastSeenAt DateTime @default(now())
  createdAt  DateTime @default(now())

  @@unique([userId, deviceHash])
  @@index([userId])
  @@map("admin_trusted_devices")
}
```

The login route composes existing pieces rather than reimplementing auth:
1. `AuthService.loginWithPassword` for the credential check (unchanged).
2. Reject if the account is **not** hidden — the admin portal is for staff only, so an ordinary user's credentials must fail here even when correct.
3. `Admin2faService.verify` for the TOTP code.
4. Device check against `AdminTrustedDevice`; an unknown device requires a fresh enrolment step.
5. IP check against the configured allow-list when one is set; if unset, log the attempt and allow, so the feature can be enabled per-environment.
6. `AuditLogService.logAction({ action: 'admin.login', status })` on both success and failure.

Return the same `{ tokens }` envelope as the standard login so the console's `ApiClient.login` needs no change.

- [ ] **Step 4: Run tests**

```bash
pnpm prisma migrate dev --name add_admin_credentials
pnpm test -- admin-2fa
pnpm test
pnpm lint
pnpm boundaries
pnpm build
```

Expected: all PASS. This is the phase's exit gate — the full suite must be green.

- [ ] **Step 5: Commit**

```bash
git add prisma src/modules/admin-identity package.json pnpm-lock.yaml
git commit -m "feat(admin-identity): totp 2fa and device verification on admin portal"
```

---

## Phase exit criteria

- [ ] `pnpm test` green (422 pre-existing spec files plus the new ones)
- [ ] `pnpm test:e2e` green
- [ ] `pnpm lint` clean at `--max-warnings 0`
- [ ] `pnpm boundaries` reports no `no-cross-module-imports` error
- [ ] `pnpm build` clean
- [ ] An account holding ADMIN is absent from: search, rankings, follower lists, friend lists, room member lists, live viewer lists, mentions, and direct profile lookup
- [ ] Only SUPER_ADMIN can create an ADMIN; an ADMIN attempting it gets 403
- [ ] SUPER_ADMIN renders as `STAFF` to an ADMIN viewer
- [ ] Admin login requires a valid TOTP code and records browser, OS, device, country, IP and status

## Spec coverage for this phase

| Spec requirement | Task |
|---|---|
| §1 Admin created only by Super Admin | 8 |
| §1 No self-registration / cannot create another Admin | 8 |
| §1 Cannot delete or suspend Super Admin | 8 |
| §1 Cannot identify Super Admin | 9 |
| §1 Hidden from search | 4, 6 |
| §1 Hidden from rankings | 7 |
| §1 Hidden from followers, friends, audience, room members, live viewers, mentions, tags | 5 |
| §1 Only Super Admin and Admin can identify Admin accounts | 4 (`includeHidden`), 6 |
| §2 Dedicated Admin Portal, username/email/password | 11 |
| §2 2FA | 11 |
| §2 Device Verification, IP Verification | 11 |
| §2 Track login/logout time, browser, device, OS, country, IP, status | 10 |

**Not covered in Phase 1, by design:** §2's *optional* OTP second factor. Gifts as a hiding surface (§1) is covered transitively — gift sender/receiver panels resolve identities through `getCards` (Task 5) — but confirm this during Task 5 review rather than assuming it.
