# Video Room Phase 7 — Role & Permission Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Video Room authorization story — role assignment, ownership transfer, temporary-grant expiry, an O(1)-invalidated Redis permission cache, events, audit and monitoring — by extending the existing code matrix + grants model.

**Architecture:** `VideoRoomPermissionService` already is the single decision point (6 consuming services, ~20 call sites) and is **not** rebuilt. VR-7 adds a management surface around it: two new domain services (role assignment, ownership), one cache class, one scheduler monitor, one controller, six events. The coarse `assertCanManage` gate is deleted in favour of a `MANAGE_ROOM` permission so the PRD's admin restrictions become expressible. Zero new tables, zero migrations.

**Tech Stack:** NestJS 11, TypeScript (strict), Prisma (Postgres), ioredis via `CacheService`/`LockService`, Socket.IO via `EVENT_BUS` → `VideoRoomSocketListener`, prom-client, Jest.

## Global Constraints

- **NO GIT OPERATIONS.** No `git add`, `git commit`, `git push`, no branches, no stashes. The user handles all Git after every phase completes. Each task ends with a **verification** step instead of a commit.
- **Zero new tables and zero Prisma migrations.** If a task appears to need one, stop and report — the design is wrong, not the schema.
- **No Prisma inside services.** All persistence goes through repositories (`src/modules/video-rooms/repositories/`).
- **No custom exception classes.** Errors are `BusinessException(ERROR_CODES.X, message, HttpStatus.Y)` — the platform convention.
- **No authorization logic in controllers.** Controllers delegate to services.
- **No inbound socket handlers.** Commands are REST; the `/video-room` namespace stays broadcast-only.
- Redis keys are **hash-tagged** `{roomId}` (Cluster safety). Any keys read together in one `MGET` must share the tag.
- Test command: `npx jest <path>`. Full module: `npx jest src/modules/video-rooms`. Lint: `npm run lint`. Types: `npx tsc --noEmit`.
- Existing behaviour outside the ADMIN-matrix tightening must not change.

**Reference spec:** `docs/superpowers/specs/2026-07-21-video-room-phase7-role-permission-engine-design.md`

---

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `src/modules/video-rooms/services/video-room-permission-cache.service.ts` | Versioned Redis cache for permission decisions |
| `src/modules/video-rooms/services/video-room-role.service.ts` | Role assign / remove / update + the 8-step validation chain |
| `src/modules/video-rooms/services/video-room-ownership.service.ts` | Ownership transfer + owner recovery |
| `src/modules/video-rooms/scheduler/video-room-role.monitor.ts` | Temporary-grant expiry sweep |
| `src/modules/video-rooms/controllers/video-rooms-roles.controller.ts` | The 8 REST routes |
| `src/modules/video-rooms/events/video-room-role.events.ts` | 6 domain event classes |
| `src/modules/video-rooms/dto/video-room-role.dto.ts` | Remove / update / transfer / response DTOs |
| `src/modules/video-rooms/listeners/video-room-role-socket.listener.ts` | Role events → socket broadcasts |
| `src/modules/video-rooms/listeners/video-room-role-metrics.listener.ts` | Role events → Prometheus counters |

**Modify:**
| File | Change |
|---|---|
| `constants/video-room-permissions.ts` | `MANAGE_ROOM`, PRD-aligned matrix, hierarchy helper |
| `constants/video-room.constants.ts` | 2 cache keys, 5 socket event names, admin cap |
| `dto/grant-video-room-role.dto.ts` | Narrow grantable roles to ADMIN/MODERATOR |
| `repositories/video-room-roles.repository.ts` | `findActive`, `countByRole`, `listExpired`, `deleteByIds` |
| `services/video-room-permission.service.ts` | Cache wiring, 5 new predicates, delete `assertCanManage` |
| `services/video-room-lifecycle.service.ts` | 6 call sites → `MANAGE_ROOM` |
| `events/video-room.events.ts` | 6 `VIDEO_ROOM_EVENTS` entries |
| `video-rooms.metrics.ts` | 8 metric families + helpers |
| `video-rooms.module.ts` | Register new providers + controller |
| `src/infra/redis/cache.service.ts` | Generic `mget<T>` |
| `src/common/exceptions/error-codes.ts` | 6 new codes |

---

## Task 1: Permission enum, PRD-aligned matrix, hierarchy

**Files:**
- Modify: `src/modules/video-rooms/constants/video-room-permissions.ts`
- Modify: `src/modules/video-rooms/dto/grant-video-room-role.dto.ts:7-11`
- Test: `src/modules/video-rooms/constants/video-room-permissions.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VideoRoomPermission.MANAGE_ROOM`; `VIDEO_ROOM_PERMISSION_MATRIX`; `videoRoomRoleHasPermission(role, permission): boolean`; `videoRoomRolePermissions(role): VideoRoomPermission[]`; `VIDEO_ROOM_ROLE_RANK: Record<VideoRoomMemberRole, number>`; `GRANTABLE_VIDEO_ROOM_ROLES: VideoRoomMemberRole[]` (now `[ADMIN, MODERATOR]`).

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/constants/video-room-permissions.spec.ts`:

```typescript
import { VideoRoomMemberRole } from '@prisma/client';
import {
  VIDEO_ROOM_PERMISSION_MATRIX,
  VIDEO_ROOM_ROLE_RANK,
  VideoRoomPermission,
  videoRoomRoleHasPermission,
  videoRoomRolePermissions,
} from './video-room-permissions';

describe('VR-7 PRD-aligned matrix', () => {
  const admin = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.ADMIN];

  // production.txt:3364-3372 — "Admins CANNOT: Edit room profile, Change room
  // password, Add or remove admins, Change room category".
  it.each([
    VideoRoomPermission.MANAGE_ROOM,
    VideoRoomPermission.LOCK_ROOM,
    VideoRoomPermission.GRANT_ROLES,
    VideoRoomPermission.CHANGE_THEME,
    VideoRoomPermission.TRANSFER_OWNERSHIP,
    VideoRoomPermission.CLOSE_ROOM,
  ])('denies %s to ADMIN (PRD admin restrictions)', (perm) => {
    expect(admin.has(perm)).toBe(false);
  });

  it.each([
    VideoRoomPermission.MANAGE_SEATS,
    VideoRoomPermission.MANAGE_PARTICIPANTS,
    VideoRoomPermission.INVITE_USERS,
    VideoRoomPermission.KICK_USERS,
    VideoRoomPermission.BLOCK_USERS,
    VideoRoomPermission.MUTE_USERS,
    VideoRoomPermission.ROOM_MUTE,
    VideoRoomPermission.PIN_MESSAGES,
    VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
    VideoRoomPermission.VIEW_ANALYTICS,
    VideoRoomPermission.START_PK,
  ])('grants %s to ADMIN (PRD admin duties)', (perm) => {
    expect(admin.has(perm)).toBe(true);
  });

  it('gives OWNER every permission including MANAGE_ROOM', () => {
    const owner = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.OWNER];
    expect(owner.size).toBe(Object.values(VideoRoomPermission).length);
    expect(owner.has(VideoRoomPermission.MANAGE_ROOM)).toBe(true);
  });

  // Hierarchy is inheritance-by-construction, asserted rather than walked.
  it('makes each role a superset of the role below it', () => {
    const descending = [
      VideoRoomMemberRole.OWNER,
      VideoRoomMemberRole.ADMIN,
      VideoRoomMemberRole.MODERATOR,
      VideoRoomMemberRole.HOST,
      VideoRoomMemberRole.PARTICIPANT,
      VideoRoomMemberRole.VIEWER,
    ];
    for (let i = 0; i < descending.length - 1; i++) {
      const higher = VIDEO_ROOM_PERMISSION_MATRIX[descending[i]];
      const lower = VIDEO_ROOM_PERMISSION_MATRIX[descending[i + 1]];
      for (const perm of lower) {
        expect(higher.has(perm)).toBe(true);
      }
    }
  });

  it('ranks roles strictly descending', () => {
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.OWNER]).toBe(5);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.ADMIN]).toBe(4);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.MODERATOR]).toBe(3);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.HOST]).toBe(2);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.PARTICIPANT]).toBe(1);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.VIEWER]).toBe(0);
  });

  it('lists a role permissions as a stable sorted array', () => {
    expect(videoRoomRolePermissions(VideoRoomMemberRole.VIEWER)).toEqual([]);
    const mod = videoRoomRolePermissions(VideoRoomMemberRole.MODERATOR);
    expect(mod).toEqual([...mod].sort());
    expect(mod).toContain(VideoRoomPermission.KICK_USERS);
  });

  it('answers videoRoomRoleHasPermission against the matrix', () => {
    expect(
      videoRoomRoleHasPermission(VideoRoomMemberRole.MODERATOR, VideoRoomPermission.KICK_USERS),
    ).toBe(true);
    expect(
      videoRoomRoleHasPermission(VideoRoomMemberRole.MODERATOR, VideoRoomPermission.MANAGE_SEATS),
    ).toBe(false);
  });
});
```

Also update `src/modules/video-rooms/dto/grant-video-room-role.dto.ts` test expectations if any exist for `HOST`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/constants/video-room-permissions.spec.ts`
Expected: FAIL — `MANAGE_ROOM` and `VIDEO_ROOM_ROLE_RANK` are not exported; ADMIN currently holds `LOCK_ROOM`/`GRANT_ROLES`/`CHANGE_THEME`.

- [ ] **Step 3: Rewrite the constants file**

Replace lines 16-109 of `src/modules/video-rooms/constants/video-room-permissions.ts` (keep the file header comment, updating the VR-1 note to reference VR-7):

```typescript
export enum VideoRoomPermission {
  /** Edit the room profile, settings, category — the room's identity. VR-7:
   *  replaces the coarse `assertCanManage` gate so the PRD's "Admins CANNOT edit
   *  room profile" restriction is expressible. Owner-only. */
  MANAGE_ROOM = 'MANAGE_ROOM',
  /** Configure the seat layout, lock/unlock seats, accept/reject seat requests. */
  MANAGE_SEATS = 'MANAGE_SEATS',
  /** Invite / move / remove hosts & participants on the stage. */
  MANAGE_PARTICIPANTS = 'MANAGE_PARTICIPANTS',
  /** Remove a user from the room (kick). */
  KICK_USERS = 'KICK_USERS',
  /** Block a user from the room (durable blocklist) and lift blocks. */
  BLOCK_USERS = 'BLOCK_USERS',
  /** Mute an individual member. */
  MUTE_USERS = 'MUTE_USERS',
  /** Mute/unmute the whole room. */
  ROOM_MUTE = 'ROOM_MUTE',
  /** Pin chat messages (chat phase consumes this). */
  PIN_MESSAGES = 'PIN_MESSAGES',
  /** Grant/revoke in-room roles. Owner-only per PRD: "Only the Room Owner can
   *  appoint Admins" / "Admins CANNOT add or remove admins". */
  GRANT_ROLES = 'GRANT_ROLES',
  /** Change the room theme / background. */
  CHANGE_THEME = 'CHANGE_THEME',
  /** Lock/unlock the room (password / gift lock). */
  LOCK_ROOM = 'LOCK_ROOM',
  /** Post/pin/remove room announcements. */
  MANAGE_ANNOUNCEMENTS = 'MANAGE_ANNOUNCEMENTS',
  /** Start/stop PK battles. */
  START_PK = 'START_PK',
  /** View room analytics. */
  VIEW_ANALYTICS = 'VIEW_ANALYTICS',
  /** Invite users to the room. */
  INVITE_USERS = 'INVITE_USERS',
  /** Transfer room ownership. */
  TRANSFER_OWNERSHIP = 'TRANSFER_OWNERSHIP',
  /** Close / end the room. */
  CLOSE_ROOM = 'CLOSE_ROOM',
}

/**
 * MODERATOR is a behaviour/content moderator: it disciplines users and manages
 * chat/announcements, but cannot reshape the room.
 */
const MODERATOR_PERMISSIONS: readonly VideoRoomPermission[] = [
  VideoRoomPermission.KICK_USERS,
  VideoRoomPermission.BLOCK_USERS,
  VideoRoomPermission.MUTE_USERS,
  VideoRoomPermission.ROOM_MUTE,
  VideoRoomPermission.PIN_MESSAGES,
  VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
];

/**
 * ADMIN = the PRD's Room Admin (production.txt:3349-3372): accept/reject seat
 * requests, invite to seats, remove from seats, mute, kick, pin. Explicitly NOT
 * room profile (MANAGE_ROOM), password/lock (LOCK_ROOM), admin appointment
 * (GRANT_ROLES), category or theme (CHANGE_THEME) — those stay owner-only.
 * Superset of MODERATOR by construction, which the hierarchy test asserts.
 */
const ADMIN_PERMISSIONS: readonly VideoRoomPermission[] = [
  ...MODERATOR_PERMISSIONS,
  VideoRoomPermission.MANAGE_SEATS,
  VideoRoomPermission.MANAGE_PARTICIPANTS,
  VideoRoomPermission.INVITE_USERS,
  VideoRoomPermission.VIEW_ANALYTICS,
  VideoRoomPermission.START_PK,
];

/**
 * Role → permission set. OWNER: full access. ADMIN: the PRD admin duties.
 * MODERATOR: moderation subset. HOST / PARTICIPANT / VIEWER: no management
 * permissions (their media capabilities are seat-derived, checked via seat
 * occupancy, not entries here).
 */
export const VIDEO_ROOM_PERMISSION_MATRIX: Record<
  VideoRoomMemberRole,
  ReadonlySet<VideoRoomPermission>
> = {
  [VideoRoomMemberRole.OWNER]: new Set(Object.values(VideoRoomPermission)),
  [VideoRoomMemberRole.ADMIN]: new Set(ADMIN_PERMISSIONS),
  [VideoRoomMemberRole.MODERATOR]: new Set(MODERATOR_PERMISSIONS),
  [VideoRoomMemberRole.HOST]: new Set<VideoRoomPermission>(),
  [VideoRoomMemberRole.PARTICIPANT]: new Set<VideoRoomPermission>(),
  [VideoRoomMemberRole.VIEWER]: new Set<VideoRoomPermission>(),
};

/**
 * Numeric authority for hierarchy guards (higher outranks lower). Single source
 * of truth — VideoRoomPermissionService and VideoRoomRoleService both read this
 * rather than keeping private copies.
 */
export const VIDEO_ROOM_ROLE_RANK: Record<VideoRoomMemberRole, number> = {
  [VideoRoomMemberRole.OWNER]: 5,
  [VideoRoomMemberRole.ADMIN]: 4,
  [VideoRoomMemberRole.MODERATOR]: 3,
  [VideoRoomMemberRole.HOST]: 2,
  [VideoRoomMemberRole.PARTICIPANT]: 1,
  [VideoRoomMemberRole.VIEWER]: 0,
};

/** In-room roles that carry an elevated grant (persisted in video_room_roles). */
export const ELEVATED_VIDEO_ROOM_ROLES: readonly VideoRoomMemberRole[] = [
  VideoRoomMemberRole.OWNER,
  VideoRoomMemberRole.ADMIN,
  VideoRoomMemberRole.MODERATOR,
];

export function isElevatedVideoRoomRole(role: VideoRoomMemberRole): boolean {
  return ELEVATED_VIDEO_ROOM_ROLES.includes(role);
}

export function videoRoomRoleHasPermission(
  role: VideoRoomMemberRole,
  permission: VideoRoomPermission,
): boolean {
  return VIDEO_ROOM_PERMISSION_MATRIX[role]?.has(permission) ?? false;
}

/** A role's permissions as a stable, sorted array (cache payloads, API responses). */
export function videoRoomRolePermissions(role: VideoRoomMemberRole): VideoRoomPermission[] {
  return [...(VIDEO_ROOM_PERMISSION_MATRIX[role] ?? [])].sort();
}
```

- [ ] **Step 4: Narrow the grantable roles**

In `src/modules/video-rooms/dto/grant-video-room-role.dto.ts`, replace lines 5-11:

```typescript
/**
 * The elevated roles that may be granted. OWNER is not grantable — it is
 * transferred (POST /owner/transfer). HOST is NOT grantable either (VR-7): it is
 * derived from seat occupancy by `resolveEffectiveRole`, so a grantable HOST could
 * hold the role with no seat, diverging from the seat stage that VR-4/5 treat as
 * authoritative. VIEWER/PARTICIPANT are membership/seat-derived.
 */
export const GRANTABLE_VIDEO_ROOM_ROLES: VideoRoomMemberRole[] = [
  VideoRoomMemberRole.ADMIN,
  VideoRoomMemberRole.MODERATOR,
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/constants/video-room-permissions.spec.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Verify (no commit)**

Run: `npx tsc --noEmit`
Expected: errors ONLY at `video-room-permission.service.ts` (`assertCanManage` still references the old shape) and `video-room-lifecycle.service.ts` — these are fixed in Tasks 6 and 7. Record them; do not fix here.

---

## Task 2: Error codes

**Files:**
- Modify: `src/common/exceptions/error-codes.ts`
- Test: none (a constant map; covered by the services that throw them)

**Interfaces:**
- Produces: `ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND`, `.VIDEO_ROOM_ROLE_INVALID`, `.VIDEO_ROOM_ROLE_LIMIT_EXCEEDED`, `.VIDEO_ROOM_DUPLICATE_ROLE`, `.VIDEO_ROOM_INVALID_HIERARCHY`, `.VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED`.

- [ ] **Step 1: Add the codes**

In `src/common/exceptions/error-codes.ts`, immediately after the existing `VIDEO_ROOM_SUBSCRIPTION_LIMIT` entry (line ~170), add:

```typescript
  // ---- VR-7 role & permission engine ----
  VIDEO_ROOM_ROLE_NOT_FOUND: 'VIDEO_ROOM_ROLE_NOT_FOUND',
  VIDEO_ROOM_ROLE_INVALID: 'VIDEO_ROOM_ROLE_INVALID',
  VIDEO_ROOM_ROLE_LIMIT_EXCEEDED: 'VIDEO_ROOM_ROLE_LIMIT_EXCEEDED',
  VIDEO_ROOM_DUPLICATE_ROLE: 'VIDEO_ROOM_DUPLICATE_ROLE',
  VIDEO_ROOM_INVALID_HIERARCHY: 'VIDEO_ROOM_INVALID_HIERARCHY',
  VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED: 'VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED',
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit 2>&1 | grep error-codes`
Expected: no output (no new type errors from this file).

---

## Task 3: Roles repository — expiry-aware reads

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-room-roles.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-roles.repository.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `findActive(roomId, userId, now?: Date): Promise<VideoRoomRole | null>`; `countByRole(roomId, role): Promise<number>`; `listActiveByRoom(roomId, now?: Date): Promise<VideoRoomRole[]>`; `listExpired(now: Date, take: number): Promise<VideoRoomRole[]>`; `deleteByIds(ids: string[]): Promise<number>`. `find()` is **retained** (raw read, used by nothing in the hot path after Task 6).

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/repositories/video-room-roles.repository.spec.ts` (follow the existing mock-Prisma style already in that file):

```typescript
describe('VR-7 expiry-aware reads', () => {
  const NOW = new Date('2026-07-21T12:00:00.000Z');

  it('findActive excludes a grant whose expiry has passed', async () => {
    prisma.videoRoomRole.findFirst.mockResolvedValue(null);
    const result = await repo.findActive('room-1', 'user-1', NOW);
    expect(result).toBeNull();
    expect(prisma.videoRoomRole.findFirst).toHaveBeenCalledWith({
      where: {
        roomId: 'room-1',
        userId: 'user-1',
        OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
      },
    });
  });

  it('findActive returns a permanent grant (expiresAt null)', async () => {
    const grant = { id: 'g1', roomId: 'room-1', userId: 'user-1', expiresAt: null };
    prisma.videoRoomRole.findFirst.mockResolvedValue(grant);
    await expect(repo.findActive('room-1', 'user-1', NOW)).resolves.toBe(grant);
  });

  it('countByRole counts grants of one role in a room', async () => {
    prisma.videoRoomRole.count.mockResolvedValue(24);
    await expect(repo.countByRole('room-1', VideoRoomMemberRole.ADMIN)).resolves.toBe(24);
    expect(prisma.videoRoomRole.count).toHaveBeenCalledWith({
      where: {
        roomId: 'room-1',
        role: VideoRoomMemberRole.ADMIN,
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
    });
  });

  it('listExpired returns grants past their expiry, oldest first', async () => {
    prisma.videoRoomRole.findMany.mockResolvedValue([]);
    await repo.listExpired(NOW, 100);
    expect(prisma.videoRoomRole.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { not: null, lte: NOW } },
      orderBy: { expiresAt: 'asc' },
      take: 100,
    });
  });

  it('deleteByIds is a no-op for an empty list', async () => {
    await expect(repo.deleteByIds([])).resolves.toBe(0);
    expect(prisma.videoRoomRole.deleteMany).not.toHaveBeenCalled();
  });

  it('deleteByIds removes the given grants', async () => {
    prisma.videoRoomRole.deleteMany.mockResolvedValue({ count: 2 });
    await expect(repo.deleteByIds(['a', 'b'])).resolves.toBe(2);
    expect(prisma.videoRoomRole.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/repositories/video-room-roles.repository.spec.ts`
Expected: FAIL — `repo.findActive is not a function`.

- [ ] **Step 3: Add the methods**

Insert into `VideoRoomRolesRepository` after `find()` (line 52):

```typescript
  /**
   * A user's *active* grant — the expiry-aware read every permission decision
   * must use. VR-1 added `expiresAt` and VR-7 makes it mean something: a grant
   * whose expiry has passed resolves to null immediately (lazy expiry), so
   * correctness never depends on the sweeper having run.
   */
  async findActive(roomId: string, userId: string, now: Date = new Date()) {
    return this.prisma.videoRoomRole.findFirst({
      where: { roomId, userId, ...VideoRoomRolesRepository.notExpired(now) },
    });
  }

  /** All active grants in a room (role listing, effective-role reporting). */
  async listActiveByRoom(roomId: string, now: Date = new Date()): Promise<VideoRoomRole[]> {
    return this.prisma.videoRoomRole.findMany({
      where: { roomId, ...VideoRoomRolesRepository.notExpired(now) },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** How many active grants of `role` a room has (enforces the PRD 25-admin cap). */
  async countByRole(
    roomId: string,
    role: VideoRoomMemberRole,
    now: Date = new Date(),
  ): Promise<number> {
    return this.prisma.videoRoomRole.count({
      where: { roomId, role, ...VideoRoomRolesRepository.notExpired(now) },
    });
  }

  /** Grants whose expiry has passed — the sweeper's work queue, oldest first. */
  async listExpired(now: Date, take: number): Promise<VideoRoomRole[]> {
    return this.prisma.videoRoomRole.findMany({
      where: { expiresAt: { not: null, lte: now } },
      orderBy: { expiresAt: 'asc' },
      take,
    });
  }

  /** Hard-delete grants by id (sweeper cleanup). Returns rows removed. */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.videoRoomRole.deleteMany({
      where: { id: { in: ids } },
    });
    return count;
  }

  /** "Permanent, or not yet expired" — the shared active-grant predicate. */
  private static notExpired(now: Date) {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/repositories/video-room-roles.repository.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | grep roles.repository`
Expected: no output.

---

## Task 4: `CacheService.mget` + permission cache keys

**Files:**
- Modify: `src/infra/redis/cache.service.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts`
- Test: `src/infra/redis/cache.service.spec.ts` (create the describe block if the file exists; if not, create the file following the `LockService` spec style)

**Interfaces:**
- Produces: `CacheService.mget<T>(keys: string[]): Promise<(T | null)[]>`; `videoRoomPermissionVersionKey(roomId): string`; `videoRoomPermissionKey(roomId, userId): string`; `VIDEO_ROOM_PERMISSION_CACHE_TTL_SECONDS = 300`; `VIDEO_ROOM_MAX_ADMINS = 25`.

- [ ] **Step 1: Write the failing tests**

In `src/infra/redis/cache.service.spec.ts`:

```typescript
describe('mget', () => {
  it('returns an empty array without calling redis for no keys', async () => {
    await expect(service.mget<number>([])).resolves.toEqual([]);
    expect(client.mget).not.toHaveBeenCalled();
  });

  it('parses each JSON payload and maps misses to null', async () => {
    client.mget.mockResolvedValue(['42', null, '{"a":1}']);
    await expect(service.mget<unknown>(['k1', 'k2', 'k3'])).resolves.toEqual([
      42,
      null,
      { a: 1 },
    ]);
    expect(client.mget).toHaveBeenCalledWith('k1', 'k2', 'k3');
  });
});
```

And in `src/modules/video-rooms/constants/video-room.constants.ts`'s spec neighbour (`video-room.constants.ts` has no spec — add these assertions to `src/modules/video-rooms/constants/video-room-permissions.spec.ts`):

```typescript
import {
  videoRoomPermissionKey,
  videoRoomPermissionVersionKey,
} from './video-room.constants';

describe('VR-7 permission cache keys', () => {
  // Both keys must hash to the same Redis Cluster slot or MGET fails across
  // slots — the hash tag is the FIRST {...} in the key, so both tag on roomId.
  it('hash-tags both keys on the room id', () => {
    expect(videoRoomPermissionVersionKey('r1')).toBe('video-room:{r1}:perm:ver');
    expect(videoRoomPermissionKey('r1', 'u1')).toBe('video-room:{r1}:perm:u1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/infra/redis/cache.service.spec.ts src/modules/video-rooms/constants/video-room-permissions.spec.ts`
Expected: FAIL — `service.mget is not a function`; key helpers not exported.

- [ ] **Step 3: Add `mget` to CacheService**

Insert into `src/infra/redis/cache.service.ts` after `get<T>` (line ~32):

```typescript
  /**
   * Multi-key JSON read in one round trip. Misses (and unparseable payloads)
   * come back as null, positionally aligned with `keys`. Used by the video-room
   * permission cache to fetch a room's permission version and a user's cached
   * decision together — both keys are hash-tagged on the room id so they share a
   * Cluster slot.
   */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return [];
    const raws = await this.client.mget(...keys);
    return raws.map((raw) => {
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    });
  }
```

- [ ] **Step 4: Add the keys and caps**

Append to `src/modules/video-rooms/constants/video-room.constants.ts`:

```typescript
// ---- VR-7 role & permission engine ----

/**
 * Per-room monotonic permission version. Bumped (INCR) on any role/ownership
 * change; a cached decision is only a hit when it embeds the current version, so
 * invalidation is O(1) regardless of how many users are cached.
 */
export function videoRoomPermissionVersionKey(roomId: string): string {
  return `video-room:{${roomId}}:perm:ver`;
}

/**
 * A user's cached permission decision in a room. Hash-tagged on the ROOM id (not
 * the user) so it shares a Cluster slot with the version key above and the two
 * can be read in a single MGET.
 */
export function videoRoomPermissionKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:perm:${userId}`;
}

/** How long a cached permission decision survives absent an explicit bump. */
export const VIDEO_ROOM_PERMISSION_CACHE_TTL_SECONDS = 300;

/** PRD (production.txt:3345): "Maximum Admin Limit: 25". */
export const VIDEO_ROOM_MAX_ADMINS = 25;

/** Expired-grant sweep batch size + interval (VideoRoomRoleMonitor). */
export const VIDEO_ROOM_ROLE_SWEEP_BATCH = 200;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/infra/redis/cache.service.spec.ts src/modules/video-rooms/constants/video-room-permissions.spec.ts`
Expected: PASS.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -E "cache.service|video-room.constants"`
Expected: no output.

---

## Task 5: `VideoRoomPermissionCache`

**Files:**
- Create: `src/modules/video-rooms/services/video-room-permission-cache.service.ts`
- Test: `src/modules/video-rooms/services/video-room-permission-cache.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`VideoRoomPermission`), Task 4 (keys, TTL), `CacheService.mget/set/increment`.
- Produces:
  ```typescript
  export interface CachedPermissionDecision {
    ver: number;
    role: VideoRoomMemberRole | null;
    permissions: VideoRoomPermission[];
    temporary: boolean;
  }
  class VideoRoomPermissionCache {
    read(roomId: string, userId: string): Promise<CachedPermissionDecision | null>;
    write(roomId: string, userId: string, decision: Omit<CachedPermissionDecision,'ver'>): Promise<void>;
    invalidateRoom(roomId: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-permission-cache.service.spec.ts`:

```typescript
import { VideoRoomMemberRole } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomPermissionCache } from './video-room-permission-cache.service';

describe('VideoRoomPermissionCache', () => {
  let cache: jest.Mocked<Pick<CacheService, 'mget' | 'set' | 'increment'>>;
  let metrics: jest.Mocked<Pick<VideoRoomsMetrics, 'incPermissionCacheHit' | 'incPermissionCacheMiss'>>;
  let subject: VideoRoomPermissionCache;

  beforeEach(() => {
    cache = { mget: jest.fn(), set: jest.fn(), increment: jest.fn() } as never;
    metrics = { incPermissionCacheHit: jest.fn(), incPermissionCacheMiss: jest.fn() } as never;
    subject = new VideoRoomPermissionCache(cache as never, metrics as never);
  });

  const decision = {
    role: VideoRoomMemberRole.ADMIN,
    permissions: [VideoRoomPermission.KICK_USERS],
    temporary: false,
  };

  it('reads both keys in one MGET, room-tagged', async () => {
    cache.mget.mockResolvedValue([7, { ver: 7, ...decision }]);
    await subject.read('r1', 'u1');
    expect(cache.mget).toHaveBeenCalledWith(['video-room:{r1}:perm:ver', 'video-room:{r1}:perm:u1']);
  });

  it('returns the entry and counts a hit when versions agree', async () => {
    cache.mget.mockResolvedValue([7, { ver: 7, ...decision }]);
    await expect(subject.read('r1', 'u1')).resolves.toEqual({ ver: 7, ...decision });
    expect(metrics.incPermissionCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.incPermissionCacheMiss).not.toHaveBeenCalled();
  });

  it('misses when the entry was resolved under an older version', async () => {
    cache.mget.mockResolvedValue([8, { ver: 7, ...decision }]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
    expect(metrics.incPermissionCacheMiss).toHaveBeenCalledTimes(1);
  });

  it('misses when there is no entry', async () => {
    cache.mget.mockResolvedValue([7, null]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
  });

  // The fail-closed property: an evicted/absent version key must never let a
  // stale entry through, because a stale entry can carry a revoked grant.
  it('fails closed to a miss when the version key is absent', async () => {
    cache.mget.mockResolvedValue([null, { ver: 7, ...decision }]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
    expect(metrics.incPermissionCacheMiss).toHaveBeenCalledTimes(1);
  });

  it('writes the entry stamped with the current version and a TTL', async () => {
    cache.mget.mockResolvedValue([4, null]);
    await subject.write('r1', 'u1', decision);
    expect(cache.set).toHaveBeenCalledWith(
      'video-room:{r1}:perm:u1',
      { ver: 4, ...decision },
      300,
    );
  });

  it('treats a missing version as 0 when writing', async () => {
    cache.mget.mockResolvedValue([null, null]);
    await subject.write('r1', 'u1', decision);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:perm:u1', { ver: 0, ...decision }, 300);
  });

  it('invalidates a whole room with a single INCR', async () => {
    cache.increment.mockResolvedValue(9);
    await subject.invalidateRoom('r1');
    expect(cache.increment).toHaveBeenCalledWith('video-room:{r1}:perm:ver');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-permission-cache.service.spec.ts`
Expected: FAIL — module `./video-room-permission-cache.service` not found.

- [ ] **Step 3: Implement**

Create `src/modules/video-rooms/services/video-room-permission-cache.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { VideoRoomMemberRole } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  VIDEO_ROOM_PERMISSION_CACHE_TTL_SECONDS,
  videoRoomPermissionKey,
  videoRoomPermissionVersionKey,
} from '../constants/video-room.constants';
import type { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/** A memoised authorization decision, stamped with the version it was resolved under. */
export interface CachedPermissionDecision {
  ver: number;
  role: VideoRoomMemberRole | null;
  permissions: VideoRoomPermission[];
  /** True when the backing grant carries an expiry (temporary admin/moderator). */
  temporary: boolean;
}

/**
 * Versioned permission cache (VR-7). A hit requires two independently-stored
 * values to agree — the room's current permission version and the version the
 * entry embeds — so the cache is **fail-closed by construction**: eviction, a
 * flush, cross-instance skew or a reset version key all produce disagreement,
 * and disagreement means a database read. No Redis anomaly can extend a revoked
 * grant.
 *
 * Invalidation is a single INCR on the room's version key: O(1) no matter how
 * many users are cached, which is what makes it safe in the hot rooms where a
 * delete-every-member-key scheme would degrade worst.
 *
 * Seat changes deliberately do NOT invalidate — see the design spec §9: seat-
 * derived roles carry an empty permission set, so stale seat state can only
 * misreport an authority rank inside the 0–2 band, always below MODERATOR.
 */
@Injectable()
export class VideoRoomPermissionCache {
  constructor(
    private readonly cache: CacheService,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  /** The cached decision, or null on any miss (including a version mismatch). */
  async read(roomId: string, userId: string): Promise<CachedPermissionDecision | null> {
    const [version, entry] = await this.cache.mget<number | CachedPermissionDecision>([
      videoRoomPermissionVersionKey(roomId),
      videoRoomPermissionKey(roomId, userId),
    ]);

    const current = typeof version === 'number' ? version : null;
    const decision = this.asDecision(entry);

    if (current === null || decision === null || decision.ver !== current) {
      this.metrics.incPermissionCacheMiss();
      return null;
    }
    this.metrics.incPermissionCacheHit();
    return decision;
  }

  /** Memoise a freshly resolved decision under the room's current version. */
  async write(
    roomId: string,
    userId: string,
    decision: Omit<CachedPermissionDecision, 'ver'>,
  ): Promise<void> {
    const [version] = await this.cache.mget<number>([videoRoomPermissionVersionKey(roomId)]);
    const ver = typeof version === 'number' ? version : 0;
    await this.cache.set(
      videoRoomPermissionKey(roomId, userId),
      { ver, ...decision },
      VIDEO_ROOM_PERMISSION_CACHE_TTL_SECONDS,
    );
  }

  /** Orphan every cached decision for a room. O(1), any room size. */
  async invalidateRoom(roomId: string): Promise<void> {
    await this.cache.increment(videoRoomPermissionVersionKey(roomId));
  }

  private asDecision(value: unknown): CachedPermissionDecision | null {
    if (value === null || typeof value !== 'object') return null;
    const candidate = value as CachedPermissionDecision;
    return typeof candidate.ver === 'number' && Array.isArray(candidate.permissions)
      ? candidate
      : null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-permission-cache.service.spec.ts`
Expected: PASS — 8 cases. (The two metrics helpers land in Task 13; until then `tsc` will flag them. That is expected and is recorded in Step 5.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | grep permission-cache`
Expected: errors only for `incPermissionCacheHit`/`incPermissionCacheMiss` not existing on `VideoRoomsMetrics` — resolved in Task 13.

---

## Task 6: Permission service — cache wiring, new predicates, delete `assertCanManage`

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-permission.service.ts`
- Test: `src/modules/video-rooms/services/video-room-permission.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`VIDEO_ROOM_ROLE_RANK`, `videoRoomRolePermissions`), Task 3 (`findActive`), Task 5 (`VideoRoomPermissionCache`).
- Produces on `VideoRoomPermissionService`: unchanged `resolveEffectiveRole`, `hasPermission`, `assertPermission`, `authorityRank`, `assertOutranks`; new `hasRole(actor, room, role)`, `hasAnyPermission(actor, room, perms)`, `hasAllPermissions(actor, room, perms)`, `hasTemporaryRole(room, userId)`, `resolveCapabilities(actor, room)` returning `{ role, permissions, temporary, isPlatformAdmin }`. **`assertCanManage` is deleted.**

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/services/video-room-permission.service.spec.ts`:

```typescript
describe('VR-7 cache + predicates', () => {
  const room = { id: 'r1', ownerId: 'owner-1' };
  const actor = { id: 'admin-1', roles: [] as PlatformRole[] };

  it('serves a cache hit without touching the repositories', async () => {
    permissionCache.read.mockResolvedValue({
      ver: 3,
      role: VideoRoomMemberRole.ADMIN,
      permissions: [VideoRoomPermission.KICK_USERS],
      temporary: false,
    });
    await expect(
      service.hasPermission(actor, room, VideoRoomPermission.KICK_USERS),
    ).resolves.toBe(true);
    expect(roles.findActive).not.toHaveBeenCalled();
    expect(seats.findOccupiedSeat).not.toHaveBeenCalled();
  });

  it('resolves and memoises on a miss', async () => {
    permissionCache.read.mockResolvedValue(null);
    roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
    await expect(
      service.hasPermission(actor, room, VideoRoomPermission.KICK_USERS),
    ).resolves.toBe(true);
    expect(permissionCache.write).toHaveBeenCalledWith('r1', 'admin-1', {
      role: VideoRoomMemberRole.MODERATOR,
      permissions: videoRoomRolePermissions(VideoRoomMemberRole.MODERATOR),
      temporary: false,
    });
  });

  it('uses the expiry-aware read, never the raw find', async () => {
    permissionCache.read.mockResolvedValue(null);
    roles.findActive.mockResolvedValue(null);
    seats.findOccupiedSeat.mockResolvedValue(null);
    await service.resolveEffectiveRole(room, 'ghost');
    expect(roles.findActive).toHaveBeenCalledWith('r1', 'ghost');
    expect(roles.find).not.toHaveBeenCalled();
  });

  it('marks a decision temporary when the grant carries an expiry', async () => {
    permissionCache.read.mockResolvedValue(null);
    roles.findActive.mockResolvedValue({
      role: VideoRoomMemberRole.ADMIN,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    await expect(service.hasTemporaryRole(room, 'admin-1')).resolves.toBe(true);
  });

  it('hasRole compares the effective role', async () => {
    permissionCache.read.mockResolvedValue(null);
    roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
    await expect(service.hasRole(actor, room, VideoRoomMemberRole.ADMIN)).resolves.toBe(true);
    await expect(service.hasRole(actor, room, VideoRoomMemberRole.OWNER)).resolves.toBe(false);
  });

  it('hasAnyPermission is true when one matches; hasAllPermissions needs every one', async () => {
    permissionCache.read.mockResolvedValue({
      ver: 1,
      role: VideoRoomMemberRole.MODERATOR,
      permissions: videoRoomRolePermissions(VideoRoomMemberRole.MODERATOR),
      temporary: false,
    });
    await expect(
      service.hasAnyPermission(actor, room, [
        VideoRoomPermission.MANAGE_SEATS,
        VideoRoomPermission.KICK_USERS,
      ]),
    ).resolves.toBe(true);
    await expect(
      service.hasAllPermissions(actor, room, [
        VideoRoomPermission.MANAGE_SEATS,
        VideoRoomPermission.KICK_USERS,
      ]),
    ).resolves.toBe(false);
  });

  it('platform admins bypass and are reported as such', async () => {
    const staff = { id: 'staff-1', roles: [PlatformRole.ADMIN] };
    await expect(service.resolveCapabilities(staff, room)).resolves.toEqual(
      expect.objectContaining({ isPlatformAdmin: true }),
    );
    await expect(
      service.hasPermission(staff, room, VideoRoomPermission.CLOSE_ROOM),
    ).resolves.toBe(true);
  });

  it('no longer exposes assertCanManage', () => {
    expect((service as unknown as Record<string, unknown>).assertCanManage).toBeUndefined();
  });
});
```

Add `permissionCache` to the existing `beforeEach` mock set-up in that spec:

```typescript
permissionCache = { read: jest.fn(), write: jest.fn(), invalidateRoom: jest.fn() } as never;
service = new VideoRoomPermissionService(roles as never, seats as never, permissionCache as never);
```

Update every pre-existing case in this spec that asserted ADMIN holds `LOCK_ROOM`, `CHANGE_THEME`, `GRANT_ROLES` or used `assertCanManage`, to the tightened matrix.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-permission.service.spec.ts`
Expected: FAIL — constructor arity, `hasRole is not a function`, `assertCanManage` still defined.

- [ ] **Step 3: Rewrite the service**

Replace the body of `src/modules/video-rooms/services/video-room-permission.service.ts` below the imports:

```typescript
/** The minimal room shape a permission decision needs. */
export interface PermissionRoomRef {
  id: string;
  ownerId: string;
}

/** A fully resolved authorization answer for one user in one room. */
export interface VideoRoomCapabilities {
  role: VideoRoomMemberRole | null;
  permissions: VideoRoomPermission[];
  temporary: boolean;
  isPlatformAdmin: boolean;
}

/**
 * The single RBAC decision point for the video-room domain. Resolves a user's
 * *effective* in-room role and checks it against the code
 * `VIDEO_ROOM_PERMISSION_MATRIX`. Platform ADMIN / SUPER_ADMIN bypass every room
 * check.
 *
 * Effective-role precedence: OWNER (room.ownerId) → active persisted grant
 * (`video_room_roles`, expiry-aware) → seat-derived (HOST on a HOST seat,
 * PARTICIPANT on a GUEST seat) → null.
 *
 * VR-7: every resolution goes through the versioned `VideoRoomPermissionCache`,
 * so a check is one Redis round trip on the hot path and a database read only on
 * a miss. `assertCanManage` is gone — room management is the `MANAGE_ROOM`
 * permission, which is what makes the PRD's admin restrictions expressible.
 */
@Injectable()
export class VideoRoomPermissionService {
  constructor(
    private readonly roles: VideoRoomRolesRepository,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly cache: VideoRoomPermissionCache,
  ) {}

  /** The user's effective role, cache-first. */
  async resolveEffectiveRole(
    room: PermissionRoomRef,
    userId: string,
  ): Promise<VideoRoomMemberRole | null> {
    return (await this.resolve(room, userId)).role;
  }

  /** Full capability set for a user — backs GET /me/permissions. */
  async resolveCapabilities(
    actor: RoomActor,
    room: PermissionRoomRef,
  ): Promise<VideoRoomCapabilities> {
    const isPlatformAdmin = this.isPlatformAdmin(actor.roles);
    const resolved = await this.resolve(room, actor.id);
    return {
      role: resolved.role,
      permissions: isPlatformAdmin
        ? Object.values(VideoRoomPermission)
        : resolved.permissions,
      temporary: resolved.temporary,
      isPlatformAdmin,
    };
  }

  /** True if `actor` may exercise `permission` in `room` (platform admin bypasses). */
  async hasPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permission: VideoRoomPermission,
  ): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const { permissions } = await this.resolve(room, actor.id);
    return permissions.includes(permission);
  }

  /** True if `actor` holds at least one of `permissions`. */
  async hasAnyPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permissions: VideoRoomPermission[],
  ): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const held = (await this.resolve(room, actor.id)).permissions;
    return permissions.some((p) => held.includes(p));
  }

  /** True if `actor` holds every one of `permissions`. */
  async hasAllPermissions(
    actor: RoomActor,
    room: PermissionRoomRef,
    permissions: VideoRoomPermission[],
  ): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const held = (await this.resolve(room, actor.id)).permissions;
    return permissions.every((p) => held.includes(p));
  }

  /** True if `actor`'s effective role is exactly `role`. */
  async hasRole(
    actor: RoomActor,
    room: PermissionRoomRef,
    role: VideoRoomMemberRole,
  ): Promise<boolean> {
    return (await this.resolve(room, actor.id)).role === role;
  }

  /** True when the user's elevated grant carries an expiry (temporary admin/mod). */
  async hasTemporaryRole(room: PermissionRoomRef, userId: string): Promise<boolean> {
    return (await this.resolve(room, userId)).temporary;
  }

  /** Throw VIDEO_ROOM_FORBIDDEN (403) unless `actor` holds `permission`. */
  async assertPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permission: VideoRoomPermission,
  ): Promise<void> {
    if (!(await this.hasPermission(actor, room, permission))) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        `You do not have permission to ${permission} in this room.`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** The user's authority rank in the room (0 if they hold no role). */
  async authorityRank(room: PermissionRoomRef, userId: string): Promise<number> {
    const { role } = await this.resolve(room, userId);
    return role ? VIDEO_ROOM_ROLE_RANK[role] : 0;
  }

  /**
   * Guard for moderation over another user (force-transfer / remove / kick): the
   * actor must strictly outrank the target. Throws VIDEO_ROOM_FORBIDDEN otherwise.
   */
  async assertOutranks(room: PermissionRoomRef, actorId: string, targetId: string): Promise<void> {
    const [actorRank, targetRank] = await Promise.all([
      this.authorityRank(room, actorId),
      this.authorityRank(room, targetId),
    ]);
    if (actorRank <= targetRank) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'You cannot act on a user of equal or higher authority.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Cache-first resolution — the one place role derivation happens. */
  private async resolve(
    room: PermissionRoomRef,
    userId: string,
  ): Promise<Omit<CachedPermissionDecision, 'ver'>> {
    const cached = await this.cache.read(room.id, userId);
    if (cached) {
      return { role: cached.role, permissions: cached.permissions, temporary: cached.temporary };
    }
    const fresh = await this.derive(room, userId);
    await this.cache.write(room.id, userId, fresh);
    return fresh;
  }

  private async derive(
    room: PermissionRoomRef,
    userId: string,
  ): Promise<Omit<CachedPermissionDecision, 'ver'>> {
    if (room.ownerId === userId) {
      return this.decision(VideoRoomMemberRole.OWNER, false);
    }
    const grant = await this.roles.findActive(room.id, userId);
    if (grant) {
      return this.decision(grant.role, grant.expiresAt !== null);
    }
    const seat = await this.seats.findOccupiedSeat(room.id, userId);
    if (seat) {
      const role =
        seat.seatType === VideoRoomSeatType.GUEST
          ? VideoRoomMemberRole.PARTICIPANT
          : VideoRoomMemberRole.HOST;
      return this.decision(role, false);
    }
    return { role: null, permissions: [], temporary: false };
  }

  private decision(
    role: VideoRoomMemberRole,
    temporary: boolean,
  ): Omit<CachedPermissionDecision, 'ver'> {
    return { role, permissions: videoRoomRolePermissions(role), temporary };
  }

  private isPlatformAdmin(platformRoles: PlatformRole[]): boolean {
    return (
      platformRoles.includes(PlatformRole.ADMIN) || platformRoles.includes(PlatformRole.SUPER_ADMIN)
    );
  }
}
```

Update the import block to add `VIDEO_ROOM_ROLE_RANK`, `videoRoomRolePermissions`, and `VideoRoomPermissionCache` / `CachedPermissionDecision`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-permission.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v "incPermissionCache"`
Expected: errors remain ONLY in `video-room-lifecycle.service.ts` (`assertCanManage` gone) — Task 7 fixes them.

---

## Task 7: Migrate lifecycle call sites to `MANAGE_ROOM`

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-lifecycle.service.ts` (lines 152, 280, 327, 371 — the four `assertCanManage` calls)
- Test: `src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`VideoRoomPermission.MANAGE_ROOM`), Task 6 (`assertPermission`).
- Produces: no new symbols; `VideoRoomLifecycleService` behaviour for ADMIN changes from allow to deny on room edit/settings/delete/restore.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts`:

```typescript
describe('VR-7 MANAGE_ROOM gate', () => {
  it('asks for MANAGE_ROOM when updating a room', async () => {
    repo.findRoomRow.mockResolvedValue({ id: 'r1', ownerId: 'owner-1', status: 'LIVE' });
    await service.update(actor, 'r1', { name: 'New name' } as never).catch(() => undefined);
    expect(permissions.assertPermission).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ id: 'r1' }),
      VideoRoomPermission.MANAGE_ROOM,
    );
  });

  it('no longer calls the removed assertCanManage', async () => {
    expect(permissions.assertCanManage).toBeUndefined();
  });
});
```

Remove `assertCanManage: jest.fn()` from the `permissions` mock in that spec's `beforeEach`, and add `assertPermission: jest.fn()` if not already present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts`
Expected: FAIL — `assertPermission` not called with `MANAGE_ROOM`.

- [ ] **Step 3: Replace the four call sites**

In `src/modules/video-rooms/services/video-room-lifecycle.service.ts`, replace each of the four occurrences of:

```typescript
    await this.permissions.assertCanManage(actor, room);
```

with:

```typescript
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);
```

`VideoRoomPermission` is already imported in this file (it is used for `LOCK_ROOM` / `CLOSE_ROOM`). Leave the `LOCK_ROOM` (lines 247, 267) and `CLOSE_ROOM` (lines 298, 350) calls untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole module still type-checks**

Run: `npx tsc --noEmit 2>&1 | grep -v "incPermissionCache"`
Expected: no output. Then `npx jest src/modules/video-rooms` — expected: all suites pass except any pre-existing spec still asserting the old ADMIN matrix; fix those to the tightened matrix now.

---

## Task 8: Role events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-role.events.ts`
- Modify: `src/modules/video-rooms/events/video-room.events.ts:19-46` (`VIDEO_ROOM_EVENTS`)
- Modify: `src/modules/video-rooms/events/index.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (`VIDEO_ROOM_SOCKET_EVENTS`)
- Test: `src/modules/video-rooms/events/video-room-role.events.spec.ts`

**Interfaces:**
- Produces: `RoleAssignedEvent`, `RoleRemovedEvent`, `RoleUpdatedEvent`, `TemporaryRoleGrantedEvent`, `TemporaryRoleExpiredEvent`, `OwnershipTransferredEvent`; `VIDEO_ROOM_EVENTS.{ROLE_ASSIGNED,ROLE_REMOVED,ROLE_UPDATED,TEMPORARY_ROLE_GRANTED,TEMPORARY_ROLE_EXPIRED,OWNERSHIP_TRANSFERRED}`; `VIDEO_ROOM_SOCKET_EVENTS.{ROLE_ASSIGNED,ROLE_REMOVED,ROLE_UPDATED,PERMISSION_UPDATED}` (`OWNERSHIP_TRANSFERRED` already exists at line 32).

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/events/video-room-role.events.spec.ts`:

```typescript
import { VideoRoomMemberRole } from '@prisma/client';
import { VIDEO_ROOM_EVENTS } from './video-room.events';
import {
  OwnershipTransferredEvent,
  RoleAssignedEvent,
  RoleRemovedEvent,
  RoleUpdatedEvent,
  TemporaryRoleExpiredEvent,
  TemporaryRoleGrantedEvent,
} from './video-room-role.events';

describe('VR-7 role events', () => {
  it('names each event on the shared registry', () => {
    expect(
      new RoleAssignedEvent({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'a1',
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: null,
      }).name,
    ).toBe(VIDEO_ROOM_EVENTS.ROLE_ASSIGNED);
    expect(new RoleRemovedEvent({ roomId: 'r1', userId: 'u1', actorId: 'a1', role: VideoRoomMemberRole.ADMIN }).name).toBe(
      VIDEO_ROOM_EVENTS.ROLE_REMOVED,
    );
    expect(
      new RoleUpdatedEvent({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'a1',
        previousRole: VideoRoomMemberRole.MODERATOR,
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: null,
      }).name,
    ).toBe(VIDEO_ROOM_EVENTS.ROLE_UPDATED);
    expect(
      new TemporaryRoleGrantedEvent({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'a1',
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: '2026-07-22T00:00:00.000Z',
      }).name,
    ).toBe(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_GRANTED);
    expect(
      new TemporaryRoleExpiredEvent({ roomId: 'r1', userId: 'u1', role: VideoRoomMemberRole.ADMIN }).name,
    ).toBe(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_EXPIRED);
    expect(
      new OwnershipTransferredEvent({
        roomId: 'r1',
        previousOwnerId: 'o1',
        newOwnerId: 'o2',
        actorId: 'a1',
        reason: 'TRANSFER',
      }).name,
    ).toBe(VIDEO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room-role.events.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the event names**

In `src/modules/video-rooms/events/video-room.events.ts`, inside `VIDEO_ROOM_EVENTS` before the closing `} as const;`:

```typescript
  // ---- VR-7 role & permission engine ----
  ROLE_ASSIGNED: 'video_room.role_assigned',
  ROLE_REMOVED: 'video_room.role_removed',
  ROLE_UPDATED: 'video_room.role_updated',
  TEMPORARY_ROLE_GRANTED: 'video_room.temporary_role_granted',
  TEMPORARY_ROLE_EXPIRED: 'video_room.temporary_role_expired',
  OWNERSHIP_TRANSFERRED: 'video_room.ownership_transferred',
```

In `src/modules/video-rooms/constants/video-room.constants.ts`, inside `VIDEO_ROOM_SOCKET_EVENTS` (`OWNERSHIP_TRANSFERRED` is already there at line 32 — do not duplicate it):

```typescript
  // ---- VR-7 role & permission engine (client-facing) ----
  ROLE_ASSIGNED: 'video_room.role_assigned',
  ROLE_REMOVED: 'video_room.role_removed',
  ROLE_UPDATED: 'video_room.role_updated',
  /** Point-to-point: the recipient's own capability set changed — refetch it. */
  PERMISSION_UPDATED: 'video_room.permission_updated',
```

- [ ] **Step 4: Create the event classes**

Create `src/modules/video-rooms/events/video-room-role.events.ts`:

```typescript
import { VideoRoomMemberRole } from '@prisma/client';
import { DomainEvent } from 'src/common/events';
import { VIDEO_ROOM_EVENTS } from './video-room.events';

/** An elevated in-room role was granted to a user. */
export class RoleAssignedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  role: VideoRoomMemberRole;
  /** ISO-8601 when the grant is temporary; null when permanent. */
  expiresAt: string | null;
}> {
  readonly name = VIDEO_ROOM_EVENTS.ROLE_ASSIGNED;
}

/** A user's elevated grant was revoked. */
export class RoleRemovedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  role: VideoRoomMemberRole;
}> {
  readonly name = VIDEO_ROOM_EVENTS.ROLE_REMOVED;
}

/** A user's elevated grant was replaced with a different role. */
export class RoleUpdatedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  previousRole: VideoRoomMemberRole;
  role: VideoRoomMemberRole;
  expiresAt: string | null;
}> {
  readonly name = VIDEO_ROOM_EVENTS.ROLE_UPDATED;
}

/** A time-limited grant was issued (temporary admin / moderator). */
export class TemporaryRoleGrantedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  role: VideoRoomMemberRole;
  expiresAt: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_GRANTED;
}

/** A time-limited grant lapsed and was swept (automatic revocation). */
export class TemporaryRoleExpiredEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  role: VideoRoomMemberRole;
}> {
  readonly name = VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_EXPIRED;
}

/**
 * Room ownership moved. `reason` distinguishes a deliberate handover from
 * succession after the owner departed, so audit review can tell them apart.
 */
export class OwnershipTransferredEvent extends DomainEvent<{
  roomId: string;
  previousOwnerId: string;
  newOwnerId: string;
  actorId: string;
  reason: 'TRANSFER' | 'RECOVERY';
}> {
  readonly name = VIDEO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED;
}
```

Add `export * from './video-room-role.events';` to `src/modules/video-rooms/events/index.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room-role.events.spec.ts`
Expected: PASS.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v incPermissionCache`
Expected: no output.

---

## Task 9: DTOs

**Files:**
- Create: `src/modules/video-rooms/dto/video-room-role.dto.ts`
- Modify: `src/modules/video-rooms/dto/index.ts`
- Test: `src/modules/video-rooms/dto/video-room-role.dto.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`GRANTABLE_VIDEO_ROOM_ROLES`).
- Produces: `RemoveVideoRoomRoleDto{userId}`, `UpdateVideoRoomRoleDto{userId, role, expiresAt?}`, `TransferVideoRoomOwnershipDto{newOwnerId}`, `VideoRoomRoleResponseDto`, `VideoRoomPermissionCatalogueDto`, `MyVideoRoomPermissionsDto`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/dto/video-room-role.dto.spec.ts`:

```typescript
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VideoRoomMemberRole } from '@prisma/client';
import {
  RemoveVideoRoomRoleDto,
  TransferVideoRoomOwnershipDto,
  UpdateVideoRoomRoleDto,
} from './video-room-role.dto';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('VR-7 role DTOs', () => {
  it('rejects a non-uuid userId on remove', async () => {
    const dto = plainToInstance(RemoveVideoRoomRoleDto, { userId: 'nope' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('accepts a uuid userId on remove', async () => {
    const dto = plainToInstance(RemoveVideoRoomRoleDto, { userId: UUID });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects OWNER as an update target role (ownership is transferred)', async () => {
    const dto = plainToInstance(UpdateVideoRoomRoleDto, {
      userId: UUID,
      role: VideoRoomMemberRole.OWNER,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects HOST as an update target role (seat-derived)', async () => {
    const dto = plainToInstance(UpdateVideoRoomRoleDto, {
      userId: UUID,
      role: VideoRoomMemberRole.HOST,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('accepts ADMIN with an ISO expiry', async () => {
    const dto = plainToInstance(UpdateVideoRoomRoleDto, {
      userId: UUID,
      role: VideoRoomMemberRole.ADMIN,
      expiresAt: '2026-07-22T00:00:00.000Z',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('requires a uuid newOwnerId on transfer', async () => {
    expect(
      await validate(plainToInstance(TransferVideoRoomOwnershipDto, { newOwnerId: 'x' })),
    ).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(TransferVideoRoomOwnershipDto, { newOwnerId: UUID })),
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/video-room-role.dto.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/modules/video-rooms/dto/video-room-role.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMemberRole } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { GRANTABLE_VIDEO_ROOM_ROLES } from './grant-video-room-role.dto';

/** Revoke a user's elevated in-room grant. */
export class RemoveVideoRoomRoleDto {
  @ApiProperty({ description: 'The user whose grant is revoked.' })
  @IsUUID()
  userId!: string;
}

/** Replace a user's elevated grant with a different role (and/or expiry). */
export class UpdateVideoRoomRoleDto {
  @ApiProperty({ description: 'The user whose grant changes.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    enum: GRANTABLE_VIDEO_ROOM_ROLES,
    description: 'OWNER is not accepted — ownership is transferred, not assigned.',
  })
  @IsIn(GRANTABLE_VIDEO_ROOM_ROLES)
  role!: VideoRoomMemberRole;

  @ApiPropertyOptional({ description: 'ISO-8601 expiry; omit for a permanent grant.' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

/** Hand room ownership to another active member. */
export class TransferVideoRoomOwnershipDto {
  @ApiProperty({ description: 'The active member who becomes the new owner.' })
  @IsUUID()
  newOwnerId!: string;
}

/** One elevated grant as returned by GET /roles. */
export class VideoRoomRoleResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: VideoRoomMemberRole }) role!: VideoRoomMemberRole;
  @ApiProperty({ nullable: true }) grantedBy!: string | null;
  @ApiProperty({ nullable: true, description: 'ISO-8601; null when permanent.' })
  expiresAt!: string | null;
  @ApiProperty({ description: 'True when the grant carries an expiry.' })
  temporary!: boolean;
}

/** The permission catalogue + role matrix, for clients that render capability UI. */
export class VideoRoomPermissionCatalogueDto {
  @ApiProperty({ enum: VideoRoomPermission, isArray: true })
  permissions!: VideoRoomPermission[];

  @ApiProperty({
    description: 'Role → permissions it holds.',
    example: { OWNER: ['MANAGE_ROOM'], ADMIN: ['MANAGE_SEATS'], VIEWER: [] },
  })
  matrix!: Record<VideoRoomMemberRole, VideoRoomPermission[]>;
}

/** The caller's own effective authority in a room. */
export class MyVideoRoomPermissionsDto {
  @ApiProperty({ enum: VideoRoomMemberRole, nullable: true })
  role!: VideoRoomMemberRole | null;

  @ApiProperty({ enum: VideoRoomPermission, isArray: true })
  permissions!: VideoRoomPermission[];

  @ApiProperty({ description: 'True when the caller holds a time-limited grant.' })
  temporary!: boolean;

  @ApiProperty({ description: 'True when platform staff privileges are bypassing room checks.' })
  isPlatformAdmin!: boolean;
}
```

Add `export * from './video-room-role.dto';` to `src/modules/video-rooms/dto/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/dto/video-room-role.dto.spec.ts`
Expected: PASS, 6 cases.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v incPermissionCache`
Expected: no output.

---

## Task 10: `VideoRoomRoleService` — assignment engine

**Files:**
- Create: `src/modules/video-rooms/services/video-room-role.service.ts`
- Test: `src/modules/video-rooms/services/video-room-role.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 5, 6, 8, 9.
- Produces:
  ```typescript
  class VideoRoomRoleService {
    listRoles(actor: RoomActor, roomId: string): Promise<VideoRoomRoleResponseDto[]>;
    assign(actor: RoomActor, roomId: string, dto: GrantVideoRoomRoleDto): Promise<VideoRoomRoleResponseDto>;
    update(actor: RoomActor, roomId: string, dto: UpdateVideoRoomRoleDto): Promise<VideoRoomRoleResponseDto>;
    remove(actor: RoomActor, roomId: string, dto: RemoveVideoRoomRoleDto): Promise<void>;
  }
  ```

**LEARNING-CONTRIBUTION POINT:** Step 3 leaves `assertNoEscalation` as a documented signature for the human to implement. Do not fill it in — implement everything around it, run the tests, and surface the decision.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/services/video-room-role.service.spec.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import { VideoRoomRoleService } from './video-room-role.service';

describe('VideoRoomRoleService', () => {
  const ROOM = { id: 'r1', ownerId: 'owner-1', deletedAt: null };
  const owner = { id: 'owner-1', roles: [] as PlatformRole[] };
  const target = 'user-2';

  let rooms: any, roles: any, moderation: any, permissions: any, cache: any, bus: any, subject: VideoRoomRoleService;

  beforeEach(() => {
    rooms = {
      findRoomRow: jest.fn().mockResolvedValue(ROOM),
      getMember: jest.fn().mockResolvedValue({ userId: target, isActive: true }),
      setMemberRole: jest.fn(),
      appendLog: jest.fn(),
    };
    roles = {
      findActive: jest.fn().mockResolvedValue(null),
      listActiveByRoom: jest.fn().mockResolvedValue([]),
      countByRole: jest.fn().mockResolvedValue(0),
      grant: jest.fn().mockImplementation(({ role, expiresAt }) =>
        Promise.resolve({ userId: target, role, grantedBy: owner.id, expiresAt: expiresAt ?? null }),
      ),
      revoke: jest.fn().mockResolvedValue(1),
    };
    moderation = { appendAction: jest.fn() };
    permissions = {
      assertPermission: jest.fn(),
      resolveEffectiveRole: jest.fn().mockResolvedValue(null),
      authorityRank: jest.fn().mockResolvedValue(0),
    };
    cache = { invalidateRoom: jest.fn() };
    bus = { publish: jest.fn() };
    subject = new VideoRoomRoleService(rooms, roles, moderation, permissions, cache, bus);
  });

  const assign = (role = VideoRoomMemberRole.ADMIN, expiresAt?: string) =>
    subject.assign(owner, 'r1', { userId: target, role, expiresAt } as never);

  it('requires GRANT_ROLES', async () => {
    permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
    await expect(assign()).rejects.toThrow('forbidden');
    expect(roles.grant).not.toHaveBeenCalled();
  });

  it('rejects a target who is not an active member', async () => {
    rooms.getMember.mockResolvedValue({ userId: target, isActive: false });
    await expect(assign()).rejects.toMatchObject({ code: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER });
  });

  it('rejects a self-grant', async () => {
    await expect(
      subject.assign(owner, 'r1', { userId: owner.id, role: VideoRoomMemberRole.ADMIN } as never),
    ).rejects.toMatchObject({ code: ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY });
  });

  it('rejects granting the role the target already holds', async () => {
    roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
    await expect(assign()).rejects.toMatchObject({ code: ERROR_CODES.VIDEO_ROOM_DUPLICATE_ROLE });
  });

  it('enforces the PRD 25-admin cap at the boundary', async () => {
    roles.countByRole.mockResolvedValue(24);
    await expect(assign()).resolves.toBeDefined();

    roles.countByRole.mockResolvedValue(25);
    await expect(assign()).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_ROOM_ROLE_LIMIT_EXCEEDED,
      status: HttpStatus.CONFLICT,
    });
  });

  it('does not cap MODERATOR grants', async () => {
    roles.countByRole.mockResolvedValue(999);
    await expect(assign(VideoRoomMemberRole.MODERATOR)).resolves.toBeDefined();
  });

  it('persists, mirrors the member role, audits, invalidates and publishes', async () => {
    await assign();
    expect(roles.grant).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: target,
      role: VideoRoomMemberRole.ADMIN,
      grantedBy: owner.id,
      expiresAt: null,
    });
    expect(rooms.setMemberRole).toHaveBeenCalledWith('r1', target, VideoRoomMemberRole.ADMIN, owner.id);
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', actorId: owner.id, action: 'ROLE_CHANGED' }),
    );
    expect(moderation.appendAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ROLE_GRANTED', targetUserId: target }),
    );
    expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
    expect(bus.publish).toHaveBeenCalled();
  });

  it('publishes the temporary event too when an expiry is set', async () => {
    await assign(VideoRoomMemberRole.ADMIN, '2099-01-01T00:00:00.000Z');
    const names = bus.publish.mock.calls.map(([e]: [{ name: string }]) => e.name);
    expect(names).toContain('video_room.role_assigned');
    expect(names).toContain('video_room.temporary_role_granted');
  });

  it('invalidates the cache even though the grant row is what changed', async () => {
    await assign();
    expect(cache.invalidateRoom).toHaveBeenCalledTimes(1);
  });

  describe('remove', () => {
    it('rejects when the target holds no grant', async () => {
      roles.findActive.mockResolvedValue(null);
      await expect(subject.remove(owner, 'r1', { userId: target })).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND,
      });
    });

    it('refuses to revoke OWNER', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.OWNER, expiresAt: null });
      await expect(subject.remove(owner, 'r1', { userId: target })).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
      });
    });

    it('revokes, demotes the member mirror to VIEWER, audits and invalidates', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      await subject.remove(owner, 'r1', { userId: target });
      expect(roles.revoke).toHaveBeenCalledWith('r1', target);
      expect(rooms.setMemberRole).toHaveBeenCalledWith('r1', target, VideoRoomMemberRole.VIEWER, owner.id);
      expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
    });
  });

  describe('update', () => {
    it('rejects when the target holds no grant to change', async () => {
      roles.findActive.mockResolvedValue(null);
      await expect(
        subject.update(owner, 'r1', { userId: target, role: VideoRoomMemberRole.MODERATOR } as never),
      ).rejects.toMatchObject({ code: ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND });
    });

    it('replaces the role and publishes RoleUpdated with the previous role', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      await subject.update(owner, 'r1', {
        userId: target,
        role: VideoRoomMemberRole.ADMIN,
      } as never);
      const updated = bus.publish.mock.calls
        .map(([e]: [{ name: string; payload: Record<string, unknown> }]) => e)
        .find((e: { name: string }) => e.name === 'video_room.role_updated');
      expect(updated.payload).toMatchObject({
        previousRole: VideoRoomMemberRole.MODERATOR,
        role: VideoRoomMemberRole.ADMIN,
      });
    });
  });

  describe('listRoles', () => {
    it('marks grants with an expiry as temporary', async () => {
      roles.listActiveByRoom.mockResolvedValue([
        { userId: 'a', role: VideoRoomMemberRole.ADMIN, grantedBy: 'owner-1', expiresAt: null },
        {
          userId: 'b',
          role: VideoRoomMemberRole.MODERATOR,
          grantedBy: 'owner-1',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      ]);
      const result = await subject.listRoles(owner, 'r1');
      expect(result[0]).toMatchObject({ temporary: false, expiresAt: null });
      expect(result[1]).toMatchObject({ temporary: true, expiresAt: '2099-01-01T00:00:00.000Z' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-role.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement, leaving `assertNoEscalation` for the human**

Create `src/modules/video-rooms/services/video-room-role.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  VideoRoomLogAction,
  VideoRoomMemberRole,
  VideoRoomModerationActionType,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { VIDEO_ROOM_MAX_ADMINS } from '../constants/video-room.constants';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { GrantVideoRoomRoleDto } from '../dto/grant-video-room-role.dto';
import type {
  RemoveVideoRoomRoleDto,
  UpdateVideoRoomRoleDto,
  VideoRoomRoleResponseDto,
} from '../dto/video-room-role.dto';
import {
  RoleAssignedEvent,
  RoleRemovedEvent,
  RoleUpdatedEvent,
  TemporaryRoleGrantedEvent,
} from '../events/video-room-role.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionCache } from './video-room-permission-cache.service';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

/**
 * Role assignment engine (VR-7). Every mutation runs the same ordered validation
 * chain before any write, so privilege escalation is rejected at one place rather
 * than per-endpoint. Writes then follow a fixed order — persist, mirror, audit,
 * invalidate, publish — so a cached decision can never outlive the grant it
 * describes.
 *
 * The PRD (production.txt:3341-3372) sets the policy this encodes: only the room
 * owner appoints admins, and a room holds at most 25 of them.
 */
@Injectable()
export class VideoRoomRoleService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly roles: VideoRoomRolesRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly cache: VideoRoomPermissionCache,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Every active elevated grant in the room. Requires room membership. */
  async listRoles(actor: RoomActor, roomId: string): Promise<VideoRoomRoleResponseDto[]> {
    const room = await this.requireRoom(roomId);
    await this.requireActiveMember(room.id, actor.id, 'You must be a member of this room.');
    const grants = await this.roles.listActiveByRoom(room.id);
    return grants.map((g) => ({
      userId: g.userId,
      role: g.role,
      grantedBy: g.grantedBy,
      expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
      temporary: g.expiresAt !== null,
    }));
  }

  /** Grant an elevated role. Runs the full validation chain. */
  async assign(
    actor: RoomActor,
    roomId: string,
    dto: GrantVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    const room = await this.requireRoom(roomId);
    await this.validate(actor, room, dto.userId, dto.role);

    const existing = await this.roles.findActive(room.id, dto.userId);
    if (existing?.role === dto.role) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_DUPLICATE_ROLE,
        'That user already holds this role.',
        HttpStatus.CONFLICT,
      );
    }
    await this.assertRoleCapacity(room.id, dto.role);

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const grant = await this.write(room.id, actor.id, dto.userId, dto.role, expiresAt);

    await this.bus.publish(
      new RoleAssignedEvent({
        roomId: room.id,
        userId: dto.userId,
        actorId: actor.id,
        role: dto.role,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
    );
    if (expiresAt) {
      await this.bus.publish(
        new TemporaryRoleGrantedEvent({
          roomId: room.id,
          userId: dto.userId,
          actorId: actor.id,
          role: dto.role,
          expiresAt: expiresAt.toISOString(),
        }),
      );
    }
    return grant;
  }

  /** Replace an existing grant with a different role and/or expiry. */
  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    const room = await this.requireRoom(roomId);
    await this.validate(actor, room, dto.userId, dto.role);

    const existing = await this.roles.findActive(room.id, dto.userId);
    if (!existing) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND,
        'That user has no elevated role to update.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.role !== dto.role) await this.assertRoleCapacity(room.id, dto.role);

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const grant = await this.write(room.id, actor.id, dto.userId, dto.role, expiresAt);

    await this.bus.publish(
      new RoleUpdatedEvent({
        roomId: room.id,
        userId: dto.userId,
        actorId: actor.id,
        previousRole: existing.role,
        role: dto.role,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
    );
    return grant;
  }

  /** Revoke a grant, returning the user to plain membership. */
  async remove(actor: RoomActor, roomId: string, dto: RemoveVideoRoomRoleDto): Promise<void> {
    const room = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.GRANT_ROLES);

    const existing = await this.roles.findActive(room.id, dto.userId);
    if (!existing) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND,
        'That user has no elevated role.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.role === VideoRoomMemberRole.OWNER) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
        'The owner role cannot be revoked — transfer ownership instead.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.assertNoEscalation(room, actor, dto.userId);

    await this.roles.revoke(room.id, dto.userId);
    await this.rooms.setMemberRole(room.id, dto.userId, VideoRoomMemberRole.VIEWER, actor.id);
    await this.audit(room.id, actor.id, dto.userId, VideoRoomModerationActionType.ROLE_REVOKED, {
      role: existing.role,
    });
    await this.cache.invalidateRoom(room.id);
    await this.bus.publish(
      new RoleRemovedEvent({
        roomId: room.id,
        userId: dto.userId,
        actorId: actor.id,
        role: existing.role,
      }),
    );
  }

  // ======================= validation chain =======================

  /** Steps 1-4 + 6 of the chain, shared by assign and update. */
  private async validate(
    actor: RoomActor,
    room: PermissionRoomRef,
    targetId: string,
    role: VideoRoomMemberRole,
  ): Promise<void> {
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.GRANT_ROLES);

    if (targetId === actor.id) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY,
        'You cannot change your own role.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (role === VideoRoomMemberRole.OWNER) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
        'Ownership is transferred, not assigned.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.requireActiveMember(
      room.id,
      targetId,
      'The user must be an active member of the room.',
    );
    await this.assertNoEscalation(room, actor, targetId);
  }

  /**
   * LEARNING-CONTRIBUTION POINT — the anti-escalation predicate.
   *
   * Everything else in this service is mechanical. This is the actual policy: it
   * decides who may act on whom, and it is the only thing standing between a
   * compromised admin account and a room takeover.
   *
   * `this.permissions.authorityRank(room, userId)` returns the numeric rank
   * (OWNER 5 · ADMIN 4 · MODERATOR 3 · HOST 2 · PARTICIPANT 1 · VIEWER/none 0).
   * Throw `this.fail(ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY, <message>,
   * HttpStatus.FORBIDDEN)` to reject.
   *
   * Decisions worth making deliberately:
   *  - Strict outranking (`actor > target`), or may equals act on each other?
   *    Strict is safer; equality lets two admins demote each other, which is a
   *    known griefing vector in room products.
   *  - Should platform staff (`actor.roles` contains ADMIN/SUPER_ADMIN) bypass
   *    this entirely? `assertPermission` already lets them through step 1, so
   *    without an explicit bypass here they are still bound by in-room rank —
   *    which may or may not be what you want for support tooling.
   *  - Is acting on the room OWNER ever legal for a non-owner? Audio Rooms
   *    raises a distinct CANNOT_MODERATE_OWNER for this case.
   *
   * @param room   the room the action targets
   * @param actor  who is acting
   * @param targetId whose role is being changed
   * @throws BusinessException(VIDEO_ROOM_INVALID_HIERARCHY, 403) when disallowed
   */
  private async assertNoEscalation(
    room: PermissionRoomRef,
    actor: RoomActor,
    targetId: string,
  ): Promise<void> {
    // TODO(human): implement the anti-escalation policy described above.
  }

  /** PRD: at most 25 admins per room. Other roles are uncapped. */
  private async assertRoleCapacity(roomId: string, role: VideoRoomMemberRole): Promise<void> {
    if (role !== VideoRoomMemberRole.ADMIN) return;
    const count = await this.roles.countByRole(roomId, VideoRoomMemberRole.ADMIN);
    if (count >= VIDEO_ROOM_MAX_ADMINS) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_LIMIT_EXCEEDED,
        `A room may have at most ${VIDEO_ROOM_MAX_ADMINS} admins.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  // ======================= write path =======================

  /**
   * Persist → mirror → audit → invalidate, in that order. The cache bump comes
   * after the write so no reader can repopulate a stale entry in between.
   */
  private async write(
    roomId: string,
    actorId: string,
    userId: string,
    role: VideoRoomMemberRole,
    expiresAt: Date | null,
  ): Promise<VideoRoomRoleResponseDto> {
    const grant = await this.roles.grant({ roomId, userId, role, grantedBy: actorId, expiresAt });
    await this.rooms.setMemberRole(roomId, userId, role, actorId);
    await this.audit(roomId, actorId, userId, VideoRoomModerationActionType.ROLE_GRANTED, {
      role,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
    await this.cache.invalidateRoom(roomId);
    return {
      userId: grant.userId,
      role: grant.role,
      grantedBy: grant.grantedBy,
      expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      temporary: grant.expiresAt !== null,
    };
  }

  /** Both audit trails: the room log and the moderation-action record. */
  private async audit(
    roomId: string,
    actorId: string,
    targetUserId: string,
    action: VideoRoomModerationActionType,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.rooms.appendLog({
      roomId,
      actorId,
      action: VideoRoomLogAction.ROLE_CHANGED,
      metadata: { targetUserId, ...metadata },
    });
    await this.moderation.appendAction({
      roomId,
      moderatorId: actorId,
      targetUserId,
      action,
      metadata,
    });
  }

  // ======================= helpers =======================

  private async requireRoom(roomId: string): Promise<PermissionRoomRef> {
    const room = await this.rooms.findRoomRow(roomId);
    if (!room || room.deletedAt) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return { id: room.id, ownerId: room.ownerId };
  }

  private async requireActiveMember(
    roomId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw this.fail(ERROR_CODES.VIDEO_ROOM_NOT_MEMBER, message, HttpStatus.BAD_REQUEST);
    }
  }

  private fail(code: string, message: string, status: HttpStatus): BusinessException {
    return new BusinessException(code, message, status);
  }
}
```

- [ ] **Step 4: Run tests — expect the escalation cases to fail**

Run: `npx jest src/modules/video-rooms/services/video-room-role.service.spec.ts`
Expected: all cases PASS except any that depend on escalation rejection, which fail because `assertNoEscalation` is an empty stub. **Stop here and surface the contribution point to the human.** Do not implement it.

- [ ] **Step 5: After the human implements it, re-run**

Run: `npx jest src/modules/video-rooms/services/video-room-role.service.spec.ts`
Expected: PASS, all cases. Then `npx tsc --noEmit 2>&1 | grep -v incPermissionCache` — expected: no output.

---

## Task 11: `VideoRoomOwnershipService`

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ownership.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ownership.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 5, 6, 8, 9.
- Produces: `transfer(actor, roomId, dto: TransferVideoRoomOwnershipDto): Promise<void>`; `recoverOwner(roomId, actorId): Promise<{ newOwnerId: string | null }>`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/video-rooms/services/video-room-ownership.service.spec.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import { VideoRoomOwnershipService } from './video-room-ownership.service';

describe('VideoRoomOwnershipService', () => {
  const ROOM = { id: 'r1', ownerId: 'owner-1', deletedAt: null };
  const owner = { id: 'owner-1', roles: [] as PlatformRole[] };

  let rooms: any, roles: any, permissions: any, cache: any, locks: any, lifecycle: any, bus: any;
  let subject: VideoRoomOwnershipService;

  beforeEach(() => {
    rooms = {
      findRoomRow: jest.fn().mockResolvedValue(ROOM),
      getMember: jest.fn().mockResolvedValue({ userId: 'user-2', isActive: true }),
      setOwner: jest.fn(),
      setMemberRole: jest.fn(),
      appendLog: jest.fn(),
      listActiveMembers: jest.fn().mockResolvedValue([]),
    };
    roles = { grant: jest.fn(), revoke: jest.fn() };
    permissions = { assertPermission: jest.fn(), authorityRank: jest.fn().mockResolvedValue(0) };
    cache = { invalidateRoom: jest.fn() };
    locks = { withLock: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()) };
    lifecycle = { closeRoom: jest.fn() };
    bus = { publish: jest.fn() };
    subject = new VideoRoomOwnershipService(rooms, roles, permissions, cache, locks, lifecycle, bus);
  });

  describe('transfer', () => {
    it('requires TRANSFER_OWNERSHIP', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'user-2' })).rejects.toThrow('forbidden');
      expect(rooms.setOwner).not.toHaveBeenCalled();
    });

    it('serialises under a per-room lock', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(locks.withLock).toHaveBeenCalledWith('video-room:transfer:{r1}', expect.any(Function));
    });

    it('rejects transferring to the current owner', async () => {
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'owner-1' })).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED,
        status: HttpStatus.CONFLICT,
      });
    });

    it('rejects a target who is not an active member', async () => {
      rooms.getMember.mockResolvedValue({ userId: 'user-2', isActive: false });
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'user-2' })).rejects.toMatchObject({
        code: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('demotes the previous owner to ADMIN and promotes the target', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(roles.grant).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: 'r1', userId: 'owner-1', role: VideoRoomMemberRole.ADMIN }),
      );
      expect(roles.revoke).toHaveBeenCalledWith('r1', 'user-2');
      expect(rooms.setOwner).toHaveBeenCalledWith('r1', 'user-2', 'owner-1');
      expect(rooms.setMemberRole).toHaveBeenCalledWith('r1', 'user-2', VideoRoomMemberRole.OWNER, 'owner-1');
    });

    it('logs, invalidates and publishes with reason TRANSFER', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(rooms.appendLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'OWNERSHIP_TRANSFERRED',
          metadata: expect.objectContaining({ previousOwnerId: 'owner-1', newOwnerId: 'user-2' }),
        }),
      );
      expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
      const [[event]] = bus.publish.mock.calls;
      expect(event.payload).toMatchObject({ reason: 'TRANSFER', newOwnerId: 'user-2' });
    });
  });

  describe('recoverOwner', () => {
    it('promotes the highest-ranking active member that is not the departed owner', async () => {
      rooms.listActiveMembers.mockResolvedValue([
        { userId: 'owner-1' },
        { userId: 'mod-1' },
        { userId: 'admin-1' },
      ]);
      permissions.authorityRank.mockImplementation((_r: unknown, id: string) =>
        Promise.resolve(id === 'admin-1' ? 4 : id === 'mod-1' ? 3 : 5),
      );
      await expect(subject.recoverOwner('r1', 'staff-1')).resolves.toEqual({ newOwnerId: 'admin-1' });
      expect(rooms.setOwner).toHaveBeenCalledWith('r1', 'admin-1', 'staff-1');
    });

    it('publishes with reason RECOVERY', async () => {
      rooms.listActiveMembers.mockResolvedValue([{ userId: 'owner-1' }, { userId: 'admin-1' }]);
      permissions.authorityRank.mockResolvedValue(1);
      await subject.recoverOwner('r1', 'staff-1');
      const [[event]] = bus.publish.mock.calls;
      expect(event.payload).toMatchObject({ reason: 'RECOVERY' });
    });

    it('closes the room when there is no successor', async () => {
      rooms.listActiveMembers.mockResolvedValue([{ userId: 'owner-1' }]);
      await expect(subject.recoverOwner('r1', 'staff-1')).resolves.toEqual({ newOwnerId: null });
      expect(lifecycle.closeRoom).toHaveBeenCalledWith('r1', 'staff-1');
      expect(rooms.setOwner).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-ownership.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `setOwner` to the rooms repository**

Insert into `src/modules/video-rooms/repositories/video-rooms.repository.ts` near `setMemberRole` (line ~521):

```typescript
  /** Move a room to a new owner (ownership transfer / recovery). */
  async setOwner(roomId: string, newOwnerId: string, actorId: string): Promise<void> {
    await this.prisma.videoRoom.update({
      where: { id: roomId },
      data: { ownerId: newOwnerId, ...auditUpdate(actorId) },
    });
  }
```

- [ ] **Step 4: Implement the service**

Create `src/modules/video-rooms/services/video-room-ownership.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { VideoRoomLogAction, VideoRoomMemberRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { TransferVideoRoomOwnershipDto } from '../dto/video-room-role.dto';
import { OwnershipTransferredEvent } from '../events/video-room-role.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomLifecycleService } from './video-room-lifecycle.service';
import { VideoRoomPermissionCache } from './video-room-permission-cache.service';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

/** Members considered for succession, largest page we will scan. */
const RECOVERY_MEMBER_SCAN = 200;

/**
 * Room ownership (VR-7). Exactly one owner exists at any moment — structurally,
 * because `VideoRoom.ownerId` is a single column and `resolveEffectiveRole`
 * consults it before any grant. Transfer is serialised under a per-room lock so
 * two concurrent transfers cannot interleave and leave the previous owner
 * demoted with the room handed to neither target.
 *
 * History is the existing append-only `video_room_logs` — the
 * `OWNERSHIP_TRANSFERRED` action has been in the schema since VR-1, unused until
 * now. No dedicated history table, and deliberately no reclaim window: reclaim
 * would let ownership change without the sitting owner's consent.
 */
@Injectable()
export class VideoRoomOwnershipService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly roles: VideoRoomRolesRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly cache: VideoRoomPermissionCache,
    private readonly locks: LockService,
    private readonly lifecycle: VideoRoomLifecycleService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Hand the room to another active member. Owner-only (TRANSFER_OWNERSHIP). */
  async transfer(
    actor: RoomActor,
    roomId: string,
    dto: TransferVideoRoomOwnershipDto,
  ): Promise<void> {
    const room = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.TRANSFER_OWNERSHIP);

    if (dto.newOwnerId === room.ownerId) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED,
        'That user is already the room owner.',
        HttpStatus.CONFLICT,
      );
    }

    const member = await this.rooms.getMember(room.id, dto.newOwnerId);
    if (!member?.isActive) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'The new owner must be an active member of the room.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.locks.withLock(`video-room:transfer:{${room.id}}`, async () => {
      await this.handOver(room.id, room.ownerId, dto.newOwnerId, actor.id);
    });

    await this.announce(room.id, room.ownerId, dto.newOwnerId, actor.id, 'TRANSFER');
  }

  /**
   * The brief's "Owner Recovery": promote the highest-ranking remaining active
   * member when the owner is gone. Deliberately has NO automatic trigger — an
   * owner leaving is normal and reversible, so auto-succession on `leave` would
   * hand rooms away from owners who are merely reconnecting. Invoked explicitly
   * by platform staff, or by a later moderation/reaping phase.
   */
  async recoverOwner(roomId: string, actorId: string): Promise<{ newOwnerId: string | null }> {
    const room = await this.requireRoom(roomId);

    return this.locks.withLock(`video-room:transfer:{${room.id}}`, async () => {
      const members = await this.rooms.listActiveMembers(room.id, RECOVERY_MEMBER_SCAN, 0);
      const candidates = members.filter((m) => m.userId !== room.ownerId);

      let successor: string | null = null;
      let best = -1;
      for (const candidate of candidates) {
        const rank = await this.permissions.authorityRank(room, candidate.userId);
        if (rank > best) {
          best = rank;
          successor = candidate.userId;
        }
      }

      if (!successor) {
        await this.lifecycle.closeRoom(room.id, actorId);
        return { newOwnerId: null };
      }

      await this.handOver(room.id, room.ownerId, successor, actorId, { demotePrevious: false });
      await this.announce(room.id, room.ownerId, successor, actorId, 'RECOVERY');
      return { newOwnerId: successor };
    });
  }

  /**
   * The ownership swap itself. The new owner's elevated grant is revoked because
   * ownership is expressed by `room.ownerId`, not by a grant row — leaving both
   * would give them two sources of authority and make revocation ambiguous.
   */
  private async handOver(
    roomId: string,
    previousOwnerId: string,
    newOwnerId: string,
    actorId: string,
    opts: { demotePrevious?: boolean } = {},
  ): Promise<void> {
    if (opts.demotePrevious !== false) {
      await this.roles.grant({
        roomId,
        userId: previousOwnerId,
        role: VideoRoomMemberRole.ADMIN,
        grantedBy: actorId,
        expiresAt: null,
      });
      await this.rooms.setMemberRole(roomId, previousOwnerId, VideoRoomMemberRole.ADMIN, actorId);
    }
    await this.roles.revoke(roomId, newOwnerId);
    await this.rooms.setOwner(roomId, newOwnerId, actorId);
    await this.rooms.setMemberRole(roomId, newOwnerId, VideoRoomMemberRole.OWNER, actorId);
  }

  /** Audit + cache bump + event, shared by transfer and recovery. */
  private async announce(
    roomId: string,
    previousOwnerId: string,
    newOwnerId: string,
    actorId: string,
    reason: 'TRANSFER' | 'RECOVERY',
  ): Promise<void> {
    await this.rooms.appendLog({
      roomId,
      actorId,
      action: VideoRoomLogAction.OWNERSHIP_TRANSFERRED,
      metadata: { previousOwnerId, newOwnerId, reason },
    });
    await this.cache.invalidateRoom(roomId);
    await this.bus.publish(
      new OwnershipTransferredEvent({ roomId, previousOwnerId, newOwnerId, actorId, reason }),
    );
  }

  private async requireRoom(roomId: string): Promise<PermissionRoomRef> {
    const room = await this.rooms.findRoomRow(roomId);
    if (!room || room.deletedAt) {
      throw this.fail(ERROR_CODES.VIDEO_ROOM_NOT_FOUND, 'Room not found.', HttpStatus.NOT_FOUND);
    }
    return { id: room.id, ownerId: room.ownerId };
  }

  private fail(code: string, message: string, status: HttpStatus): BusinessException {
    return new BusinessException(code, message, status);
  }
}
```

If `VideoRoomLifecycleService` has no `closeRoom(roomId, actorId)` with that exact signature, read the file and call the existing close method with the arguments it declares — do not add a new one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-ownership.service.spec.ts`
Expected: PASS, 10 cases.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v incPermissionCache`
Expected: no output.

---

## Task 12: `VideoRoomRoleMonitor` — temporary-grant sweep

**Files:**
- Create: `src/modules/video-rooms/scheduler/video-room-role.monitor.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-role.monitor.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 8; `LockService`.
- Produces: `VideoRoomRoleMonitor.sweep(): Promise<number>` (rows swept).

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/scheduler/video-room-role.monitor.spec.ts`:

```typescript
import { VideoRoomMemberRole } from '@prisma/client';
import { VideoRoomRoleMonitor } from './video-room-role.monitor';

describe('VideoRoomRoleMonitor', () => {
  let roles: any, moderation: any, cache: any, locks: any, bus: any, subject: VideoRoomRoleMonitor;

  beforeEach(() => {
    roles = { listExpired: jest.fn().mockResolvedValue([]), deleteByIds: jest.fn().mockResolvedValue(0) };
    moderation = { appendAction: jest.fn() };
    cache = { invalidateRoom: jest.fn() };
    locks = { withLock: jest.fn((_k: string, fn: () => Promise<unknown>) => fn()) };
    bus = { publish: jest.fn() };
    subject = new VideoRoomRoleMonitor(roles, moderation, cache, locks, bus);
  });

  it('does nothing when no grants have expired', async () => {
    await expect(subject.sweep()).resolves.toBe(0);
    expect(roles.deleteByIds).not.toHaveBeenCalled();
    expect(cache.invalidateRoom).not.toHaveBeenCalled();
  });

  it('deletes expired grants and publishes one event each', async () => {
    roles.listExpired.mockResolvedValue([
      { id: 'g1', roomId: 'r1', userId: 'u1', role: VideoRoomMemberRole.ADMIN },
      { id: 'g2', roomId: 'r1', userId: 'u2', role: VideoRoomMemberRole.MODERATOR },
    ]);
    roles.deleteByIds.mockResolvedValue(2);

    await expect(subject.sweep()).resolves.toBe(2);
    expect(roles.deleteByIds).toHaveBeenCalledWith(['g1', 'g2']);
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(moderation.appendAction).toHaveBeenCalledTimes(2);
  });

  it('invalidates each affected room exactly once', async () => {
    roles.listExpired.mockResolvedValue([
      { id: 'g1', roomId: 'r1', userId: 'u1', role: VideoRoomMemberRole.ADMIN },
      { id: 'g2', roomId: 'r1', userId: 'u2', role: VideoRoomMemberRole.ADMIN },
      { id: 'g3', roomId: 'r2', userId: 'u3', role: VideoRoomMemberRole.ADMIN },
    ]);
    roles.deleteByIds.mockResolvedValue(3);

    await subject.sweep();
    expect(cache.invalidateRoom).toHaveBeenCalledTimes(2);
    expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
    expect(cache.invalidateRoom).toHaveBeenCalledWith('r2');
  });

  it('runs under a lock so only one instance sweeps', async () => {
    await subject.sweep();
    expect(locks.withLock).toHaveBeenCalledWith('video-room:role-sweep', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/scheduler/video-room-role.monitor.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/modules/video-rooms/scheduler/video-room-role.monitor.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VideoRoomModerationActionType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { VIDEO_ROOM_ROLE_SWEEP_BATCH } from '../constants/video-room.constants';
import { TemporaryRoleExpiredEvent } from '../events/video-room-role.events';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomPermissionCache } from '../services/video-room-permission-cache.service';

/**
 * Sweeps lapsed temporary grants (VR-7). This monitor is NOT the correctness
 * mechanism — `VideoRoomRolesRepository.findActive` already excludes an expired
 * grant the moment it lapses, so authorization is right whether or not this ever
 * runs. The sweep exists to emit the expiry events, write the audit record, and
 * stop the table growing. Lock-guarded so exactly one instance sweeps per tick,
 * mirroring the session/seat/media monitors.
 */
@Injectable()
export class VideoRoomRoleMonitor {
  private readonly logger = new Logger(VideoRoomRoleMonitor.name);

  constructor(
    private readonly roles: VideoRoomRolesRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly cache: VideoRoomPermissionCache,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(`Temporary-role sweep failed: ${String(error)}`);
    }
  }

  /** Delete every lapsed grant, announce it, and bump each affected room. */
  async sweep(): Promise<number> {
    return this.locks.withLock('video-room:role-sweep', async () => {
      const expired = await this.roles.listExpired(new Date(), VIDEO_ROOM_ROLE_SWEEP_BATCH);
      if (expired.length === 0) return 0;

      const removed = await this.roles.deleteByIds(expired.map((g) => g.id));

      for (const grant of expired) {
        await this.moderation.appendAction({
          roomId: grant.roomId,
          moderatorId: null,
          targetUserId: grant.userId,
          action: VideoRoomModerationActionType.ROLE_REVOKED,
          reason: 'Temporary grant expired',
          metadata: { role: grant.role, automatic: true },
        });
        await this.bus.publish(
          new TemporaryRoleExpiredEvent({
            roomId: grant.roomId,
            userId: grant.userId,
            role: grant.role,
          }),
        );
      }

      // One bump per room, not per grant — the version is room-scoped.
      for (const roomId of new Set(expired.map((g) => g.roomId))) {
        await this.cache.invalidateRoom(roomId);
      }

      this.logger.log(`Swept ${removed} expired video-room role grant(s)`);
      return removed;
    });
  }
}
```

Confirm `@nestjs/schedule` `@Cron` is the pattern used by `video-room-session.monitor.ts`; if that file uses an interval or BullMQ repeatable job instead, match it exactly rather than introducing a second scheduling mechanism.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/scheduler/video-room-role.monitor.spec.ts`
Expected: PASS, 4 cases.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v incPermissionCache`
Expected: no output.

---

## Task 13: Metrics + metrics listener

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts`
- Create: `src/modules/video-rooms/listeners/video-room-role-metrics.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-role-metrics.listener.spec.ts`

**Interfaces:**
- Produces on `VideoRoomsMetrics`: `incRoleAssignment(role, action)`, `incPermissionCheck(result)`, `incPermissionDenial(permission)`, `incOwnershipTransfer()`, `incTemporaryRole(action)`, `observeAuthorization(seconds)`, `incPermissionCacheHit()`, `incPermissionCacheMiss()`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/listeners/video-room-role-metrics.listener.spec.ts`:

```typescript
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomRoleMetricsListener } from './video-room-role-metrics.listener';

describe('VideoRoomRoleMetricsListener', () => {
  let bus: any, metrics: any, subject: VideoRoomRoleMetricsListener;
  const handlers = new Map<string, (e: unknown) => void>();

  beforeEach(() => {
    handlers.clear();
    bus = { subscribe: jest.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)) };
    metrics = {
      incRoleAssignment: jest.fn(),
      incOwnershipTransfer: jest.fn(),
      incTemporaryRole: jest.fn(),
    };
    subject = new VideoRoomRoleMetricsListener(bus, metrics);
    subject.onModuleInit();
  });

  it('counts a role assignment', () => {
    handlers.get(VIDEO_ROOM_EVENTS.ROLE_ASSIGNED)!({ payload: { role: 'ADMIN' } });
    expect(metrics.incRoleAssignment).toHaveBeenCalledWith('ADMIN', 'assigned');
  });

  it('counts a role removal', () => {
    handlers.get(VIDEO_ROOM_EVENTS.ROLE_REMOVED)!({ payload: { role: 'MODERATOR' } });
    expect(metrics.incRoleAssignment).toHaveBeenCalledWith('MODERATOR', 'removed');
  });

  it('counts an ownership transfer', () => {
    handlers.get(VIDEO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED)!({ payload: {} });
    expect(metrics.incOwnershipTransfer).toHaveBeenCalledTimes(1);
  });

  it('counts temporary grant and expiry separately', () => {
    handlers.get(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_GRANTED)!({ payload: {} });
    handlers.get(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_EXPIRED)!({ payload: {} });
    expect(metrics.incTemporaryRole).toHaveBeenCalledWith('granted');
    expect(metrics.incTemporaryRole).toHaveBeenCalledWith('expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-role-metrics.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the metric families**

In `src/modules/video-rooms/video-rooms.metrics.ts`, add to the private field block (after the VR-6 fields):

```typescript
  // ---- VR-7 role & permission engine ----
  private readonly roleAssignments: Counter;
  private readonly permissionChecks: Counter;
  private readonly permissionDenials: Counter;
  private readonly ownershipTransfers: Counter;
  private readonly temporaryRoles: Counter;
  private readonly authorizationH: Histogram;
  private readonly permCacheHits: Counter;
  private readonly permCacheMisses: Counter;
```

In the constructor, after the VR-6 registrations:

```typescript
    this.roleAssignments = new Counter({
      name: 'video_rooms_role_assignments_total',
      help: 'In-room role grants and revocations',
      labelNames: ['role', 'action'],
      registers,
    });
    this.permissionChecks = new Counter({
      name: 'video_rooms_permission_checks_total',
      help: 'Authorization decisions, by outcome',
      labelNames: ['result'],
      registers,
    });
    this.permissionDenials = new Counter({
      name: 'video_rooms_permission_denials_total',
      help: 'Denied authorization decisions, by permission',
      labelNames: ['permission'],
      registers,
    });
    this.ownershipTransfers = new Counter({
      name: 'video_rooms_ownership_transfers_total',
      help: 'Room ownership handovers (transfer + recovery)',
      registers,
    });
    this.temporaryRoles = new Counter({
      name: 'video_rooms_temporary_roles_total',
      help: 'Temporary role grants and automatic expiries',
      labelNames: ['action'],
      registers,
    });
    this.authorizationH = new Histogram({
      name: 'video_rooms_authorization_duration_seconds',
      help: 'Latency of a full authorization decision',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
      registers,
    });
    this.permCacheHits = new Counter({
      name: 'video_rooms_permission_cache_hits_total',
      help: 'Permission cache hits',
      registers,
    });
    this.permCacheMisses = new Counter({
      name: 'video_rooms_permission_cache_misses_total',
      help: 'Permission cache misses (including version mismatches)',
      registers,
    });
```

And the helpers, at the end of the class before the closing brace:

```typescript
  // ---- VR-7 role & permission helpers ----

  incRoleAssignment(role: string, action: 'assigned' | 'removed' | 'updated'): void {
    this.roleAssignments.inc({ role, action });
  }

  incPermissionCheck(result: 'allowed' | 'denied'): void {
    this.permissionChecks.inc({ result });
  }

  incPermissionDenial(permission: string): void {
    this.permissionDenials.inc({ permission });
  }

  incOwnershipTransfer(): void {
    this.ownershipTransfers.inc();
  }

  incTemporaryRole(action: 'granted' | 'expired'): void {
    this.temporaryRoles.inc({ action });
  }

  observeAuthorization(seconds: number): void {
    this.authorizationH.observe(seconds);
  }

  incPermissionCacheHit(): void {
    this.permCacheHits.inc();
  }

  incPermissionCacheMiss(): void {
    this.permCacheMisses.inc();
  }
```

- [ ] **Step 4: Create the listener**

Create `src/modules/video-rooms/listeners/video-room-role-metrics.listener.ts`:

```typescript
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import type {
  OwnershipTransferredEvent,
  RoleAssignedEvent,
  RoleRemovedEvent,
  RoleUpdatedEvent,
} from '../events/video-room-role.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Role/ownership events → Prometheus counters. Kept as a listener rather than
 * inlined in the services so monitoring stays decoupled from the write path — a
 * metrics failure can never fail a role grant (the VR-4/VR-5 metrics-listener
 * pattern).
 */
@Injectable()
export class VideoRoomRoleMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(VIDEO_ROOM_EVENTS.ROLE_ASSIGNED, (e) =>
      this.metrics.incRoleAssignment(e.payload.role, 'assigned'),
    );
    this.bus.subscribe<RoleRemovedEvent>(VIDEO_ROOM_EVENTS.ROLE_REMOVED, (e) =>
      this.metrics.incRoleAssignment(e.payload.role, 'removed'),
    );
    this.bus.subscribe<RoleUpdatedEvent>(VIDEO_ROOM_EVENTS.ROLE_UPDATED, (e) =>
      this.metrics.incRoleAssignment(e.payload.role, 'updated'),
    );
    this.bus.subscribe<OwnershipTransferredEvent>(VIDEO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED, () =>
      this.metrics.incOwnershipTransfer(),
    );
    this.bus.subscribe(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_GRANTED, () =>
      this.metrics.incTemporaryRole('granted'),
    );
    this.bus.subscribe(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_EXPIRED, () =>
      this.metrics.incTemporaryRole('expired'),
    );
  }
}
```

- [ ] **Step 5: Instrument the permission service**

In `src/modules/video-rooms/services/video-room-permission.service.ts`, inject `VideoRoomsMetrics` and wrap `hasPermission`'s body:

```typescript
  async hasPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permission: VideoRoomPermission,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const allowed = this.isPlatformAdmin(actor.roles)
      ? true
      : (await this.resolve(room, actor.id)).permissions.includes(permission);

    this.metrics.observeAuthorization((Date.now() - startedAt) / 1000);
    this.metrics.incPermissionCheck(allowed ? 'allowed' : 'denied');
    if (!allowed) this.metrics.incPermissionDenial(permission);
    return allowed;
  }
```

Add `metrics` to the constructor and to the spec's constructor call from Task 6 (mock the three methods).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-role-metrics.listener.spec.ts src/modules/video-rooms/services/video-room-permission-cache.service.spec.ts src/modules/video-rooms/services/video-room-permission.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit`
Expected: no output at all (the `incPermissionCache` errors from Task 5 are now resolved).

---

## Task 14: Controller, socket listener, module wiring

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-roles.controller.ts`
- Create: `src/modules/video-rooms/controllers/video-rooms-roles.controller.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-role-socket.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-role-socket.listener.spec.ts`
- Modify: `src/modules/video-rooms/controllers/index.ts`, `listeners/index.ts`, `services/index.ts`, `video-rooms.module.ts`

**Interfaces:**
- Consumes: Tasks 9, 10, 11, 13.
- Produces: the 8 REST routes; the 5 socket broadcasts.

- [ ] **Step 1: Write the failing controller test**

Create `src/modules/video-rooms/controllers/video-rooms-roles.controller.spec.ts`:

```typescript
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { VideoRoomRolesController } from './video-rooms-roles.controller';

describe('VideoRoomRolesController', () => {
  const user = { id: 'u1', roles: [PlatformRole.USER], sid: 's1' } as never;
  let rolesService: any, ownership: any, permissions: any, rooms: any, subject: VideoRoomRolesController;

  beforeEach(() => {
    rolesService = { listRoles: jest.fn(), assign: jest.fn(), update: jest.fn(), remove: jest.fn() };
    ownership = { transfer: jest.fn(), recoverOwner: jest.fn() };
    permissions = { resolveCapabilities: jest.fn().mockResolvedValue({ role: null, permissions: [], temporary: false, isPlatformAdmin: false }) };
    rooms = { findRoomRow: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'o1', deletedAt: null }) };
    subject = new VideoRoomRolesController(rolesService, ownership, permissions, rooms);
  });

  it('delegates listing without deciding authorization itself', async () => {
    await subject.list(user, 'r1');
    expect(rolesService.listRoles).toHaveBeenCalledWith({ id: 'u1', roles: [PlatformRole.USER] }, 'r1');
  });

  it('delegates assign', async () => {
    const dto = { userId: 'u2', role: VideoRoomMemberRole.ADMIN } as never;
    await subject.assign(user, 'r1', dto);
    expect(rolesService.assign).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'r1', dto);
  });

  it('delegates remove', async () => {
    await subject.remove(user, 'r1', { userId: 'u2' });
    expect(rolesService.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'r1', { userId: 'u2' });
  });

  it('delegates update', async () => {
    const dto = { userId: 'u2', role: VideoRoomMemberRole.MODERATOR } as never;
    await subject.update(user, 'r1', dto);
    expect(rolesService.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'r1', dto);
  });

  it('delegates ownership transfer', async () => {
    await subject.transfer(user, 'r1', { newOwnerId: 'u2' });
    expect(ownership.transfer).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'r1', { newOwnerId: 'u2' });
  });

  it('returns the permission catalogue with every enum value', async () => {
    const result = await subject.catalogue();
    expect(result.permissions).toContain('MANAGE_ROOM');
    expect(result.matrix.VIEWER).toEqual([]);
    expect(result.matrix.ADMIN).not.toContain('GRANT_ROLES');
  });

  it('returns the caller own capabilities', async () => {
    await subject.myPermissions(user, 'r1');
    expect(permissions.resolveCapabilities).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-roles.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

Create `src/modules/video-rooms/controllers/video-rooms-roles.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HttpStatus as Status } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  VIDEO_ROOM_PERMISSION_MATRIX,
  VideoRoomPermission,
  videoRoomRolePermissions,
} from '../constants/video-room-permissions';
import { GrantVideoRoomRoleDto } from '../dto/grant-video-room-role.dto';
import {
  MyVideoRoomPermissionsDto,
  RemoveVideoRoomRoleDto,
  TransferVideoRoomOwnershipDto,
  UpdateVideoRoomRoleDto,
  VideoRoomPermissionCatalogueDto,
  VideoRoomRoleResponseDto,
} from '../dto/video-room-role.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomOwnershipService } from '../services/video-room-ownership.service';
import { VideoRoomPermissionService } from '../services/video-room-permission.service';
import { VideoRoomRoleService } from '../services/video-room-role.service';

/**
 * Video Room role & permission REST surface (VR-7). Command-in over REST;
 * realtime fan-out is EVENT_BUS → VideoRoomRoleSocketListener (no domain socket
 * gateway — the `/video-room` namespace stays broadcast-only, as in every prior
 * phase). Global JwtAuthGuard secures every route; state-changing routes deny
 * guests and return 200. **All authorization lives in the services** — this
 * controller only shapes requests and responses.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomRolesController {
  constructor(
    private readonly roles: VideoRoomRoleService,
    private readonly ownership: VideoRoomOwnershipService,
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Get(':id/roles')
  @ApiOperation({ summary: 'List the elevated role grants in a room' })
  @ApiResponse({ status: Status.OK, type: VideoRoomRoleResponseDto, isArray: true })
  @ApiResponse({ status: Status.NOT_FOUND, description: 'Room not found.' })
  @ApiResponse({ status: Status.BAD_REQUEST, description: 'You are not a member of this room.' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<VideoRoomRoleResponseDto[]> {
    return this.roles.listRoles(this.actor(user), roomId);
  }

  @Get('permissions')
  @ApiOperation({ summary: 'The video-room permission catalogue and role matrix' })
  @ApiResponse({ status: Status.OK, type: VideoRoomPermissionCatalogueDto })
  catalogue(): Promise<VideoRoomPermissionCatalogueDto> {
    const matrix = Object.fromEntries(
      Object.values(VideoRoomMemberRole).map((role) => [role, videoRoomRolePermissions(role)]),
    ) as Record<VideoRoomMemberRole, VideoRoomPermission[]>;
    return Promise.resolve({ permissions: Object.values(VideoRoomPermission), matrix });
  }

  @Get(':id/me/permissions')
  @ApiOperation({ summary: "The caller's effective role and capability set in a room" })
  @ApiResponse({ status: Status.OK, type: MyVideoRoomPermissionsDto })
  @ApiResponse({ status: Status.NOT_FOUND, description: 'Room not found.' })
  async myPermissions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<MyVideoRoomPermissionsDto> {
    const room = await this.rooms.findRoomRow(roomId);
    if (!room || room.deletedAt) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        Status.NOT_FOUND,
      );
    }
    return this.permissions.resolveCapabilities(this.actor(user), {
      id: room.id,
      ownerId: room.ownerId,
    });
  }

  @Post(':id/roles/assign')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant an elevated in-room role (owner only)' })
  @ApiResponse({ status: Status.OK, type: VideoRoomRoleResponseDto })
  @ApiResponse({ status: Status.FORBIDDEN, description: 'You may not grant roles here.' })
  @ApiResponse({ status: Status.CONFLICT, description: 'Duplicate role, or the 25-admin cap is reached.' })
  @ApiResponse({ status: Status.BAD_REQUEST, description: 'Target is not an active member.' })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: GrantVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    return this.roles.assign(this.actor(user), roomId, dto);
  }

  @Post(':id/roles/remove')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an elevated in-room role (owner only)' })
  @ApiResponse({ status: Status.OK, description: 'Revoked.' })
  @ApiResponse({ status: Status.NOT_FOUND, description: 'That user holds no grant.' })
  @ApiResponse({ status: Status.FORBIDDEN, description: 'The owner role cannot be revoked.' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: RemoveVideoRoomRoleDto,
  ): Promise<void> {
    return this.roles.remove(this.actor(user), roomId, dto);
  }

  @Patch(':id/roles/update')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace a user elevated role and/or its expiry (owner only)' })
  @ApiResponse({ status: Status.OK, type: VideoRoomRoleResponseDto })
  @ApiResponse({ status: Status.NOT_FOUND, description: 'That user holds no grant to update.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: UpdateVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    return this.roles.update(this.actor(user), roomId, dto);
  }

  @Post(':id/owner/transfer')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer room ownership to another active member (owner only)' })
  @ApiResponse({ status: Status.OK, description: 'Ownership transferred.' })
  @ApiResponse({ status: Status.CONFLICT, description: 'That user is already the owner.' })
  @ApiResponse({ status: Status.BAD_REQUEST, description: 'Target is not an active member.' })
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: TransferVideoRoomOwnershipDto,
  ): Promise<void> {
    return this.ownership.transfer(this.actor(user), roomId, dto);
  }

  @Post(':id/owner/recover')
  @Roles(PlatformRole.ADMIN, PlatformRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promote the highest-ranking remaining member to owner (platform staff only)',
    description:
      'Recovery for an orphaned room. Closes the room when no successor exists. Has no automatic trigger by design — an owner leaving is normal and reversible.',
  })
  @ApiResponse({ status: Status.OK, description: 'New owner id, or null when the room was closed.' })
  recover(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<{ newOwnerId: string | null }> {
    return this.ownership.recoverOwner(roomId, user.id);
  }
}
```

Note the route order: `@Get('permissions')` must be declared before any `:id`-prefixed GET in the same controller only if they could collide — here they cannot (`permissions` vs `:id/...`), but keep it above `:id/roles` for clarity.

- [ ] **Step 4: Write and implement the socket listener**

Create `src/modules/video-rooms/listeners/video-room-role-socket.listener.spec.ts`:

```typescript
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomRoleSocketListener } from './video-room-role-socket.listener';

describe('VideoRoomRoleSocketListener', () => {
  const handlers = new Map<string, (e: unknown) => void>();
  let bus: any, sockets: any, subject: VideoRoomRoleSocketListener;

  beforeEach(() => {
    handlers.clear();
    bus = { subscribe: jest.fn((n: string, fn: (e: unknown) => void) => handlers.set(n, fn)) };
    sockets = { emitToRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    subject = new VideoRoomRoleSocketListener(bus, sockets);
    subject.onModuleInit();
  });

  it('broadcasts an assignment to the room', () => {
    handlers.get(VIDEO_ROOM_EVENTS.ROLE_ASSIGNED)!({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(sockets.emitToRoom).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      'video_room.role_assigned',
      expect.objectContaining({ roomId: 'r1' }),
    );
  });

  it('also tells the affected user their own permissions changed', () => {
    handlers.get(VIDEO_ROOM_EVENTS.ROLE_ASSIGNED)!({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'video_room.permission_updated',
      expect.objectContaining({ roomId: 'r1' }),
    );
  });

  it('notifies both parties on an ownership transfer', () => {
    handlers.get(VIDEO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED)!({
      payload: { roomId: 'r1', previousOwnerId: 'o1', newOwnerId: 'o2' },
    });
    const notified = sockets.emitToUserEverywhere.mock.calls.map((c: unknown[]) => c[1]);
    expect(notified).toEqual(expect.arrayContaining(['o1', 'o2']));
  });
});
```

Then create `src/modules/video-rooms/listeners/video-room-role-socket.listener.ts`, mirroring `video-room-seat-socket.listener.ts` exactly (read it first for the `SocketManager` method names and namespace argument — use whatever that file uses rather than the names guessed above, and adjust this spec to match):

```typescript
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import type {
  OwnershipTransferredEvent,
  RoleAssignedEvent,
  RoleRemovedEvent,
  RoleUpdatedEvent,
  TemporaryRoleExpiredEvent,
} from '../events/video-room-role.events';

/**
 * Role/ownership events → `/video-room` broadcasts (VR-7). Two audiences per
 * change: the room learns *who* holds *what* (badges, moderator lists), and the
 * affected user is told point-to-point that their own capability set moved so
 * their client refetches GET /me/permissions rather than guessing.
 */
@Injectable()
export class VideoRoomRoleSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(VIDEO_ROOM_EVENTS.ROLE_ASSIGNED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_ASSIGNED, e.payload);
      this.toUser(e.payload.userId, e.payload.roomId);
    });
    this.bus.subscribe<RoleRemovedEvent>(VIDEO_ROOM_EVENTS.ROLE_REMOVED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_REMOVED, e.payload);
      this.toUser(e.payload.userId, e.payload.roomId);
    });
    this.bus.subscribe<RoleUpdatedEvent>(VIDEO_ROOM_EVENTS.ROLE_UPDATED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_UPDATED, e.payload);
      this.toUser(e.payload.userId, e.payload.roomId);
    });
    this.bus.subscribe<TemporaryRoleExpiredEvent>(VIDEO_ROOM_EVENTS.TEMPORARY_ROLE_EXPIRED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_REMOVED, e.payload);
      this.toUser(e.payload.userId, e.payload.roomId);
    });
    this.bus.subscribe<OwnershipTransferredEvent>(
      VIDEO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      (e) => {
        this.toRoom(
          e.payload.roomId,
          VIDEO_ROOM_SOCKET_EVENTS.OWNERSHIP_TRANSFERRED,
          e.payload,
        );
        this.toUser(e.payload.previousOwnerId, e.payload.roomId);
        this.toUser(e.payload.newOwnerId, e.payload.roomId);
      },
    );
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }

  /** Point-to-point: "your capabilities changed — refetch them." */
  private toUser(userId: string, roomId: string): void {
    this.sockets.emitToUserEverywhere(
      VIDEO_ROOM_NAMESPACE,
      userId,
      VIDEO_ROOM_SOCKET_EVENTS.PERMISSION_UPDATED,
      { roomId },
    );
  }
}
```

- [ ] **Step 5: Wire the module**

In `src/modules/video-rooms/video-rooms.module.ts`, add `VideoRoomRolesController` to `controllers` and append to `providers`:

```typescript
    // VR-7 role & permission engine
    VideoRoomPermissionCache,
    VideoRoomRoleService,
    VideoRoomOwnershipService,
    VideoRoomRoleMonitor,
    VideoRoomRoleSocketListener,
    VideoRoomRoleMetricsListener,
```

Add matching exports to `services/index.ts`, `controllers/index.ts`, and `listeners/index.ts`.

- [ ] **Step 6: Run the full module suite**

Run: `npx jest src/modules/video-rooms`
Expected: PASS, all suites, no regressions.

- [ ] **Step 7: Final verification (no commit)**

Run each, all must be clean:
```bash
npx tsc --noEmit
npm run lint
npx jest src/modules/video-rooms
npx jest
```
Expected: no type errors, no lint warnings, all video-room suites green, whole project suite green with no regressions against the pre-VR-7 baseline. **Do not run any git command.**

---

## Self-Review

**Spec coverage:** §5 permission model → T1; §6 role assignment → T10; §7 ownership → T11; §8 temporary roles → T3 + T12; §9 cache → T4 + T5; §10 engine surface → T6; §11 REST/socket/events/errors/DTOs → T2, T8, T9, T14; §12 monitoring → T13; §13 testing → every task's Step 1 plus T7's regression sweep. The `assertCanManage` deletion (§5.4) is split across T6 (removal) and T7 (call-site migration) because the two fail independently and a reviewer can reject either alone.

**Placeholder scan:** the only `TODO` is the deliberate `TODO(human)` at the learning-contribution point in T10, which is called out in the task header, in the step, and in the spec.

**Type consistency:** `findActive` (T3) is the name used in T6 and T10; `invalidateRoom` (T5) is the name used in T10, T11, T12; `VideoRoomRoleResponseDto` (T9) is the return type in T10 and T14; `incPermissionCacheHit`/`incPermissionCacheMiss` (T13) are the names T5 calls, with the resulting temporary `tsc` failure recorded explicitly in T5 Step 5 and cleared in T13 Step 7; `OwnershipTransferredEvent.reason` is `'TRANSFER' | 'RECOVERY'` in T8, T11, and T14.

**Known ordering wrinkle:** T5 cannot type-check until T13. This is deliberate — splitting metrics into its own task keeps the cache's fail-closed tests reviewable in isolation, and both affected steps state the expected error explicitly so it is not mistaken for a defect.
