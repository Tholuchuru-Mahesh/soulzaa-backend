# Video Room Identity & Speaker Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Video Room identity render from real backend data and make the speaker-request workflow fully server-driven, eliminating the client's invented socket contract and its silent failures.

**Architecture:** Backend extends the existing `ProfileService.resolvePublicIdentities` batch resolver with badge fields, and video-rooms consumes it through a thin Redis cache adapter — no new joins, no parallel identity implementation. The Flutter client stops emitting invented socket events, uses the REST seat-request API, persists the real server request id, and updates seat state only in response to server broadcasts.

**Tech Stack:** NestJS 10 · Prisma · Socket.IO · Redis (`CacheService`) · Jest (backend) · Flutter/Riverpod · `flutter_test` (mobile)

## Global Constraints

Every task's requirements implicitly include this section.

- **NO git operations of any kind.** No `git add`, `git commit`, `git checkout`, `git stash`, `git reset`. Work stays in the working tree. The standard "Commit" step is replaced throughout by a **Verify** step. If a task seems to require git, stop and ask.
- **All DTO additions are additive and optional.** No existing field changes name, type, or nullability.
- **Reuse existing services.** No parallel implementations of anything that already exists.
- **Do not modify:** ZEGOCLOUD media layer, room creation, room layout, permissions, authentication, or existing backend business logic beyond what a task explicitly specifies.
- **Out of scope (already correct — do not "fix"):** host-self vs public profile routing, `driveSeating` auto-seat, the `seatApprovalRequired` gate on `queue.advance`, `getCards`'s N+1.
- Backend tests: `cd /Users/lt611-18/soulzaa-backend && npx jest <path>`
- Backend lint: `cd /Users/lt611-18/soulzaa-backend && npm run lint`
- Mobile tests: `cd /Users/lt611-18/soulzaa-mobile && flutter test <path>`
- Mobile analyze: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze`

---

## File Structure

### Backend (`/Users/lt611-18/soulzaa-backend`)

| File | Responsibility |
|---|---|
| `src/modules/users/interfaces/profile.interface.ts` | **Modify** — `PublicIdentity` gains 4 optional badge fields |
| `src/modules/users/services/profile.service.ts` | **Modify** — `resolvePublicIdentities` batch-loads stats + verification |
| `src/modules/users/services/profile.service.spec.ts` | **Modify** — tests for the extended resolver |
| `src/modules/video-rooms/constants/video-room-identity.ts` | **Create** — cache key helper + TTL |
| `src/modules/video-rooms/services/video-room-identity-cache.service.ts` | **Create** — Redis adapter over `PROFILE_SERVICE` |
| `src/modules/video-rooms/services/video-room-identity-cache.service.spec.ts` | **Create** — hit/miss/invalidate tests |
| `src/modules/video-rooms/listeners/video-room-identity-cache.listener.ts` | **Create** — invalidation on user profile/avatar events |
| `src/modules/video-rooms/listeners/video-room-identity-cache.listener.spec.ts` | **Create** |
| `src/modules/video-rooms/dto/seat-queue.dto.ts` | **Modify** — `SeatRequestListItemDto.user?` |
| `src/modules/video-rooms/services/video-room-seat-request.service.ts` | **Modify** — `listRequests` enriches |
| `src/modules/video-rooms/entities/video-room-member.view.ts` | **Modify** — `VideoRoomMemberView.user?` |
| `src/modules/video-rooms/services/video-room-member.service.ts` | **Modify** — `listMembers` enriches |
| `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts` | **Modify** — deferred enrichment of `SEAT_REQUESTED` |
| `src/modules/video-rooms/video-rooms.module.ts` | **Modify** — register the 2 new providers |

### Mobile (`/Users/lt611-18/soulzaa-mobile`)

| File | Responsibility |
|---|---|
| `lib/features/video_room/data/sources/video_room_socket_service.dart` | **Modify** — correct event list, delete `emitRequestSeat` |
| `lib/features/video_room/domain/models/room_identity.dart` | **Create** — `RoomIdentity` value type |
| `lib/features/video_room/domain/repositories/video_room_repository.dart` | **Modify** — `requestSeat` returns an item; add `getRoomMembers` |
| `lib/features/video_room/data/repositories/video_room_repository_impl.dart` | **Modify** — parse responses incl. `user` block |
| `lib/features/video_room/presentation/providers/room_identity_cache.dart` | **Create** — Riverpod identity cache |
| `lib/features/video_room/presentation/providers/video_room_controller.dart` | **Modify** — server-truthed lifecycle |
| `lib/features/video_room/presentation/widgets/profile/host_public_profile_sheet.dart` | **Create** — extracted, identity-bound |
| `lib/features/video_room/presentation/widgets/profile/host_self_profile_sheet.dart` | **Create** — extracted |
| `lib/features/video_room/presentation/widgets/seats/speaker_requests_panel.dart` | **Create** — extracted, identity-bound |
| `lib/features/video_room/presentation/screens/video_room_live_screen.dart` | **Modify** — delegate to extracted widgets |
| `test/features/video_room/video_room_socket_events_test.dart` | **Modify** — add the drift-guard contract test |
| `test/features/video_room/room_identity_cache_test.dart` | **Create** |
| `test/features/video_room/speaker_request_flow_test.dart` | **Create** |

---

## Task 1: Extend `PublicIdentity` with badge fields

**Files:**
- Modify: `src/modules/users/interfaces/profile.interface.ts:78-83`
- Modify: `src/modules/users/services/profile.service.ts:193-221`
- Test: `src/modules/users/services/profile.service.spec.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `PublicIdentity { displayName: string|null; avatarUrl: string|null; username?: string; level?: number; vipLevel?: number; verified?: boolean }` and `IProfileService.resolvePublicIdentities(ids: string[]): Promise<Map<string, PublicIdentity>>` populating all six fields.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe('ProfileService', ...)` in `src/modules/users/services/profile.service.spec.ts`:

```ts
describe('resolvePublicIdentities', () => {
  it('batch-resolves identity plus level, vipLevel and verified in 4 queries', async () => {
    const users = {
      findByIds: jest.fn().mockResolvedValue([
        { id: 'u1', username: 'rahul_92', fullName: 'Rahul' },
        { id: 'u2', username: 'priya', fullName: null },
      ]),
    };
    const profiles = {
      profilesByIds: jest.fn().mockResolvedValue([{ userId: 'u1', avatarKey: 'avatars/u1.jpg' }]),
      statisticsByIds: jest.fn().mockResolvedValue([
        { userId: 'u1', level: 24, vipLevel: 3 },
      ]),
      verificationsByIds: jest.fn().mockResolvedValue([{ userId: 'u1', verified: true }]),
    };
    const media = { resolve: jest.fn(async (k: string | null) => (k ? `https://cdn/${k}` : null)) };
    const svc = Object.create(ProfileService.prototype) as ProfileService;
    Object.assign(svc, { users, profiles, media });

    const out = await svc.resolvePublicIdentities(['u1', 'u2', 'u1']);

    expect(users.findByIds).toHaveBeenCalledTimes(1);
    expect(profiles.statisticsByIds).toHaveBeenCalledTimes(1);
    expect(profiles.verificationsByIds).toHaveBeenCalledTimes(1);
    expect(out.get('u1')).toEqual({
      displayName: 'Rahul',
      avatarUrl: 'https://cdn/avatars/u1.jpg',
      username: 'rahul_92',
      level: 24,
      vipLevel: 3,
      verified: true,
    });
  });

  it('defaults badges for a user with no statistics or verification rows', async () => {
    const users = {
      findByIds: jest.fn().mockResolvedValue([{ id: 'u2', username: 'priya', fullName: null }]),
    };
    const profiles = {
      profilesByIds: jest.fn().mockResolvedValue([]),
      statisticsByIds: jest.fn().mockResolvedValue([]),
      verificationsByIds: jest.fn().mockResolvedValue([]),
    };
    const media = { resolve: jest.fn().mockResolvedValue(null) };
    const svc = Object.create(ProfileService.prototype) as ProfileService;
    Object.assign(svc, { users, profiles, media });

    const out = await svc.resolvePublicIdentities(['u2']);

    expect(out.get('u2')).toEqual({
      displayName: 'priya',
      avatarUrl: null,
      username: 'priya',
      level: 1,
      vipLevel: 0,
      verified: false,
    });
  });

  it('returns an empty map without querying when given no ids', async () => {
    const users = { findByIds: jest.fn() };
    const svc = Object.create(ProfileService.prototype) as ProfileService;
    Object.assign(svc, { users, profiles: {}, media: {} });

    expect((await svc.resolvePublicIdentities([])).size).toBe(0);
    expect(users.findByIds).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/users/services/profile.service.spec.ts -t resolvePublicIdentities`
Expected: FAIL — received object is missing `username`, `level`, `vipLevel`, `verified`.

- [ ] **Step 3: Extend the interface**

In `src/modules/users/interfaces/profile.interface.ts`, replace the `PublicIdentity` block (lines 78-83):

```ts
/**
 * Minimal public identity for cross-module display needs (e.g. games player
 * panels, video-room seat/request panels).
 *
 * The badge fields are optional so the original two-field consumers keep
 * compiling unchanged; `resolvePublicIdentities` always populates all six.
 */
export interface PublicIdentity {
  /** `fullName ?? username` — null only if neither exists. */
  displayName: string | null;
  avatarUrl: string | null;
  /** Raw handle, for surfaces that show @handle alongside the display name. */
  username?: string;
  /** `UserStatistics.level`; 1 when the row is absent. */
  level?: number;
  /** `UserStatistics.vipLevel`; 0 (not VIP) when the row is absent. */
  vipLevel?: number;
  /** `UserVerification.verified`; false when the row is absent. */
  verified?: boolean;
}
```

- [ ] **Step 4: Extend the resolver**

In `src/modules/users/services/profile.service.ts`, replace the body of `resolvePublicIdentities` (lines 200-221):

```ts
  async resolvePublicIdentities(ids: string[]): Promise<Map<string, PublicIdentity>> {
    const unique = [...new Set(ids)];
    const result = new Map<string, PublicIdentity>();
    if (unique.length === 0) return result;

    const [identityUsers, profileRows, statsRows, verificationRows] = await Promise.all([
      this.users.findByIds(unique),
      this.profiles.profilesByIds(unique),
      this.profiles.statisticsByIds(unique),
      this.profiles.verificationsByIds(unique),
    ]);
    const profileByUserId = new Map(profileRows.map((p) => [p.userId, p]));
    const statsByUserId = new Map(statsRows.map((s) => [s.userId, s]));
    const verifiedByUserId = new Map(verificationRows.map((v) => [v.userId, v]));

    await Promise.all(
      identityUsers.map(async (user) => {
        const avatarKey = profileByUserId.get(user.id)?.avatarKey ?? null;
        const stats = statsByUserId.get(user.id);
        result.set(user.id, {
          displayName: user.fullName ?? user.username,
          avatarUrl: await this.media.resolve(avatarKey),
          username: user.username,
          level: stats?.level ?? 1,
          vipLevel: stats?.vipLevel ?? 0,
          verified: verifiedByUserId.get(user.id)?.verified ?? false,
        });
      }),
    );
    return result;
  }
```

Also update the method's doc comment above it to mention the badge fields, and the matching signature comment in `profile.interface.ts:97-102`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/users/services/profile.service.spec.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npm run lint`
Expected: exit 0 both. Confirm the existing games consumer still compiles — `npx jest src/modules/games` must stay green.

---

## Task 2: `VideoRoomIdentityCache` adapter

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-identity.ts`
- Create: `src/modules/video-rooms/services/video-room-identity-cache.service.ts`
- Test: `src/modules/video-rooms/services/video-room-identity-cache.service.spec.ts`

**Interfaces:**
- Consumes: `IProfileService.resolvePublicIdentities` and the extended `PublicIdentity` from Task 1.
- Produces: `VideoRoomIdentityCache.resolve(userIds: string[]): Promise<Map<string, PublicIdentity>>` and `VideoRoomIdentityCache.invalidate(userId: string): Promise<void>`. Constructor arg order is `(cache: CacheService, profiles: IProfileService)`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-identity-cache.service.spec.ts`:

```ts
import { VideoRoomIdentityCache } from './video-room-identity-cache.service';

const IDENTITY = {
  displayName: 'Rahul',
  avatarUrl: 'https://cdn/a.jpg',
  username: 'rahul_92',
  level: 24,
  vipLevel: 3,
  verified: true,
};

describe('VideoRoomIdentityCache', () => {
  let cache: any;
  let profiles: any;
  let svc: VideoRoomIdentityCache;

  beforeEach(() => {
    cache = {
      mget: jest.fn().mockResolvedValue([null]),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    };
    profiles = {
      resolvePublicIdentities: jest.fn().mockResolvedValue(new Map([['u1', IDENTITY]])),
    };
    svc = new VideoRoomIdentityCache(cache, profiles);
  });

  it('returns an empty map without touching Redis for no ids', async () => {
    expect((await svc.resolve([])).size).toBe(0);
    expect(cache.mget).not.toHaveBeenCalled();
  });

  it('resolves a cache miss through the profile service and caches it', async () => {
    const out = await svc.resolve(['u1']);

    expect(cache.mget).toHaveBeenCalledWith(['video-room:identity:{u1}']);
    expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith(['u1']);
    expect(cache.set).toHaveBeenCalledWith('video-room:identity:{u1}', IDENTITY, 60);
    expect(out.get('u1')).toEqual(IDENTITY);
  });

  it('serves a cache hit without calling the profile service', async () => {
    cache.mget.mockResolvedValue([IDENTITY]);

    const out = await svc.resolve(['u1']);

    expect(profiles.resolvePublicIdentities).not.toHaveBeenCalled();
    expect(out.get('u1')).toEqual(IDENTITY);
  });

  it('queries only the missing ids on a partial hit', async () => {
    cache.mget.mockResolvedValue([IDENTITY, null]);
    profiles.resolvePublicIdentities.mockResolvedValue(
      new Map([['u2', { ...IDENTITY, username: 'priya' }]]),
    );

    const out = await svc.resolve(['u1', 'u2']);

    expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith(['u2']);
    expect(out.size).toBe(2);
  });

  it('dedupes ids and drops empty ones before querying', async () => {
    await svc.resolve(['u1', 'u1', '']);
    expect(cache.mget).toHaveBeenCalledWith(['video-room:identity:{u1}']);
  });

  it('omits ids the profile service could not resolve rather than inventing them', async () => {
    profiles.resolvePublicIdentities.mockResolvedValue(new Map());
    const out = await svc.resolve(['ghost']);
    expect(out.has('ghost')).toBe(false);
  });

  it('invalidate deletes the cached key', async () => {
    await svc.invalidate('u1');
    expect(cache.del).toHaveBeenCalledWith('video-room:identity:{u1}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/services/video-room-identity-cache.service.spec.ts`
Expected: FAIL — `Cannot find module './video-room-identity-cache.service'`.

- [ ] **Step 3: Create the constants**

Create `src/modules/video-rooms/constants/video-room-identity.ts`:

```ts
/**
 * Identity cache keys/TTL for the video-room display surfaces.
 *
 * Short TTL by design: identity is display-only, so a stale name for up to a
 * minute is harmless, while the `user.profile_updated` / `user.avatar_updated`
 * invalidation (see `VideoRoomIdentityCacheListener`) makes the common
 * edit-your-profile case update immediately anyway.
 *
 * The `{userId}` hash tag matches the convention used by the seat queue keys
 * (`video-room:seatq:{roomId}`) so a future Redis Cluster keeps a user's key on
 * one slot.
 */
export const VIDEO_ROOM_IDENTITY_TTL_SECONDS = 60;

export function videoRoomIdentityKey(userId: string): string {
  return `video-room:identity:{${userId}}`;
}
```

- [ ] **Step 4: Create the service**

Create `src/modules/video-rooms/services/video-room-identity-cache.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
  type PublicIdentity,
} from 'src/modules/users/interfaces/profile.interface';
import {
  VIDEO_ROOM_IDENTITY_TTL_SECONDS,
  videoRoomIdentityKey,
} from '../constants/video-room-identity';

/**
 * Display identity for room surfaces (seat requests, member lists, join
 * toasts), cached in Redis.
 *
 * This is deliberately a THIN adapter: all data access lives in
 * `ProfileService.resolvePublicIdentities`, which already batch-loads
 * users + profiles + statistics + verification in four parallel queries.
 * Duplicating that join here would be a third copy of it. This class adds
 * caching and nothing else.
 *
 * `UsersModule` is `@Global()` and exports `PROFILE_SERVICE`, so no module
 * import is needed — the same way `games.service.ts` consumes it.
 */
@Injectable()
export class VideoRoomIdentityCache {
  constructor(
    private readonly cache: CacheService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  /**
   * Resolve display identity for a set of user ids. Ids the profile service
   * cannot resolve (deleted users) are absent from the map — never faked, so
   * callers render a placeholder rather than an invented name.
   */
  async resolve(userIds: string[]): Promise<Map<string, PublicIdentity>> {
    const unique = [...new Set(userIds)].filter((id) => !!id);
    const out = new Map<string, PublicIdentity>();
    if (unique.length === 0) return out;

    const cached = await this.cache.mget<PublicIdentity>(unique.map(videoRoomIdentityKey));
    const misses: string[] = [];
    unique.forEach((id, i) => {
      const hit = cached[i];
      if (hit) out.set(id, hit);
      else misses.push(id);
    });
    if (misses.length === 0) return out;

    const fresh = await this.profiles.resolvePublicIdentities(misses);
    await Promise.all(
      [...fresh.entries()].map(async ([id, identity]) => {
        out.set(id, identity);
        await this.cache.set(videoRoomIdentityKey(id), identity, VIDEO_ROOM_IDENTITY_TTL_SECONDS);
      }),
    );
    return out;
  }

  /** Drop a user's cached identity (profile or avatar changed). */
  async invalidate(userId: string): Promise<void> {
    await this.cache.del(videoRoomIdentityKey(userId));
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/services/video-room-identity-cache.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit`
Expected: exit 0. The provider is not registered yet — that happens in Task 3.

---

## Task 3: Identity cache invalidation listener

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-identity-cache.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-identity-cache.listener.spec.ts`
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (providers array)

**Interfaces:**
- Consumes: `VideoRoomIdentityCache.invalidate` (Task 2); `USER_EVENTS.PROFILE_UPDATED` / `AVATAR_UPDATED` from `src/modules/users/events/user.events.ts`.
- Produces: `VideoRoomIdentityCacheListener`, registered in the module so both it and `VideoRoomIdentityCache` are injectable by later tasks.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/listeners/video-room-identity-cache.listener.spec.ts`:

```ts
import { USER_EVENTS } from 'src/modules/users/events/user.events';
import { VideoRoomIdentityCacheListener } from './video-room-identity-cache.listener';

describe('VideoRoomIdentityCacheListener', () => {
  let handlers: Record<string, (e: any) => unknown>;
  let bus: any;
  let identities: any;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, fn: (e: any) => unknown) => {
        handlers[name] = fn;
      }),
    };
    identities = { invalidate: jest.fn().mockResolvedValue(undefined) };
    new VideoRoomIdentityCacheListener(bus, identities).onModuleInit();
  });

  it('invalidates on user.profile_updated', async () => {
    await handlers[USER_EVENTS.PROFILE_UPDATED]({
      payload: { userId: 'u1', username: 'rahul_92', changed: ['fullName'] },
    });
    expect(identities.invalidate).toHaveBeenCalledWith('u1');
  });

  it('invalidates on user.avatar_updated', async () => {
    await handlers[USER_EVENTS.AVATAR_UPDATED]({
      payload: { userId: 'u2', kind: 'avatar', key: 'avatars/u2.jpg' },
    });
    expect(identities.invalidate).toHaveBeenCalledWith('u2');
  });

  it('does not invalidate on a cover-image change', async () => {
    await handlers[USER_EVENTS.AVATAR_UPDATED]({
      payload: { userId: 'u3', kind: 'cover', key: 'covers/u3.jpg' },
    });
    expect(identities.invalidate).not.toHaveBeenCalled();
  });

  it('swallows an invalidation failure so a Redis blip cannot break the bus', async () => {
    identities.invalidate.mockRejectedValue(new Error('redis down'));
    await expect(
      handlers[USER_EVENTS.PROFILE_UPDATED]({ payload: { userId: 'u1' } }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/listeners/video-room-identity-cache.listener.spec.ts`
Expected: FAIL — `Cannot find module './video-room-identity-cache.listener'`.

- [ ] **Step 3: Create the listener**

Create `src/modules/video-rooms/listeners/video-room-identity-cache.listener.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  USER_EVENTS,
  type UserAvatarUpdatedEvent,
  type UserProfileUpdatedEvent,
} from 'src/modules/users/events/user.events';
import { VideoRoomIdentityCache } from '../services/video-room-identity-cache.service';

/**
 * Keeps the room identity cache honest when a user edits their profile.
 *
 * This is what makes the spec's "display name / profile picture changes update
 * live" requirement true without polling: the next room payload that resolves
 * this user re-reads them from Postgres.
 *
 * Every handler is defensive — a Redis failure must not take down the event bus
 * or fail the profile update that triggered it. A stale cached name for up to
 * `VIDEO_ROOM_IDENTITY_TTL_SECONDS` is the worst case.
 */
@Injectable()
export class VideoRoomIdentityCacheListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomIdentityCacheListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly identities: VideoRoomIdentityCache,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserProfileUpdatedEvent>(USER_EVENTS.PROFILE_UPDATED, (e) =>
      this.invalidate(e.payload.userId),
    );
    this.bus.subscribe<UserAvatarUpdatedEvent>(USER_EVENTS.AVATAR_UPDATED, (e) =>
      // Only the avatar appears in PublicIdentity; a cover change would be a
      // pointless cache eviction.
      e.payload.kind === 'avatar' ? this.invalidate(e.payload.userId) : undefined,
    );
  }

  private async invalidate(userId: string): Promise<void> {
    try {
      await this.identities.invalidate(userId);
    } catch (err) {
      this.logger.warn(`Identity cache invalidation failed for ${userId}: ${String(err)}`);
    }
  }
}
```

- [ ] **Step 4: Register both providers**

In `src/modules/video-rooms/video-rooms.module.ts`, add the imports at the top and both entries to the `providers` array (append after `VideoRoomsRepository` on line 260):

```ts
import { VideoRoomIdentityCache } from './services/video-room-identity-cache.service';
import { VideoRoomIdentityCacheListener } from './listeners/video-room-identity-cache.listener';
```

```ts
    // Display identity for seat/member/join surfaces. Thin cache over the
    // global PROFILE_SERVICE — no module import needed (UsersModule is @Global).
    VideoRoomIdentityCache,
    VideoRoomIdentityCacheListener,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/listeners/video-room-identity-cache.listener.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Verify DI resolves (no commit)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npx jest src/modules/video-rooms --silent`
Expected: exit 0, whole video-rooms suite green. A `Nest can't resolve dependencies of the VideoRoomIdentityCache` failure here means `PROFILE_SERVICE` is not resolving — confirm `UsersModule` still carries `@Global()`.

---

## Task 4: Enrich `GET :id/seats/requests`

**Files:**
- Modify: `src/modules/video-rooms/dto/seat-queue.dto.ts:92-112`
- Modify: `src/modules/video-rooms/services/video-room-seat-request.service.ts:389-403`
- Test: `src/modules/video-rooms/services/video-room-seat-request.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomIdentityCache.resolve` (Task 2).
- Produces: `listRequests` rows shaped `VideoRoomSeatRequestView & { position: number|null; user?: PublicIdentity }`. `VideoRoomSeatRequestService`'s constructor gains a trailing `identities: VideoRoomIdentityCache` parameter — **appended last** so existing positional `new VideoRoomSeatRequestService(...)` calls in specs need only one extra argument.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/video-rooms/services/video-room-seat-request.service.spec.ts` inside the top-level describe:

```ts
describe('listRequests identity enrichment', () => {
  it('attaches the requester identity to each row', async () => {
    deps.seats.listPendingRequests = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', seatIndex: null, status: 'PENDING', createdAt: new Date(0) },
      { id: 'r2', userId: 'u2', seatIndex: 2, status: 'PENDING', createdAt: new Date(1) },
    ]);
    deps.queue.position = jest.fn(async (_r: string, u: string) => (u === 'u1' ? 1 : 2));
    deps.identities.resolve = jest.fn().mockResolvedValue(
      new Map([['u1', { displayName: 'Rahul', avatarUrl: null, username: 'rahul_92', level: 24, vipLevel: 3, verified: true }]]),
    );

    const rows = await svc.listRequests({ id: 'owner' } as any, 'room1');

    expect(deps.identities.resolve).toHaveBeenCalledWith(['u1', 'u2']);
    expect(rows[0].user?.displayName).toBe('Rahul');
    expect(rows[0].position).toBe(1);
  });

  it('omits `user` for an unresolvable requester instead of inventing one', async () => {
    deps.seats.listPendingRequests = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'ghost', seatIndex: null, status: 'PENDING', createdAt: new Date(0) },
    ]);
    deps.queue.position = jest.fn().mockResolvedValue(1);
    deps.identities.resolve = jest.fn().mockResolvedValue(new Map());

    const rows = await svc.listRequests({ id: 'owner' } as any, 'room1');

    expect(rows[0].user).toBeUndefined();
    expect(rows[0].userId).toBe('ghost');
  });

  it('still returns rows when identity resolution throws', async () => {
    deps.seats.listPendingRequests = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', seatIndex: null, status: 'PENDING', createdAt: new Date(0) },
    ]);
    deps.queue.position = jest.fn().mockResolvedValue(1);
    deps.identities.resolve = jest.fn().mockRejectedValue(new Error('redis down'));

    const rows = await svc.listRequests({ id: 'owner' } as any, 'room1');

    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBeUndefined();
  });
});
```

In that file's `beforeEach`, add `identities: { resolve: jest.fn().mockResolvedValue(new Map()) }` to `deps` and pass `deps.identities` as the final constructor argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/services/video-room-seat-request.service.spec.ts -t "identity enrichment"`
Expected: FAIL — `rows[0].user` is `undefined` in the first test.

- [ ] **Step 3: Extend the DTO**

In `src/modules/video-rooms/dto/seat-queue.dto.ts`, add to `SeatRequestListItemDto` after `position` (line 111):

```ts
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Requester display identity. Absent when the user could not be resolved ' +
      '(deleted) or identity lookup degraded — clients render a placeholder, never a fake name.',
  })
  user?: {
    displayName: string | null;
    avatarUrl: string | null;
    username?: string;
    level?: number;
    vipLevel?: number;
    verified?: boolean;
  };
```

- [ ] **Step 4: Enrich the service**

In `src/modules/video-rooms/services/video-room-seat-request.service.ts`, add the constructor parameter (append last, after `queue`):

```ts
    private readonly identities: VideoRoomIdentityCache,
```

with the import:

```ts
import { VideoRoomIdentityCache } from './video-room-identity-cache.service';
import type { PublicIdentity } from 'src/modules/users/interfaces/profile.interface';
```

Replace `listRequests` (lines 389-403):

```ts
  async listRequests(
    actor: RoomActor,
    roomId: string,
  ): Promise<
    Array<VideoRoomSeatRequestView & { position: number | null; user?: PublicIdentity }>
  > {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const pending = await this.seats.listPendingRequests(roomId);

    // Identity is display-only: a lookup failure must degrade to bare rows
    // rather than 500 the host's Requests panel.
    let identities = new Map<string, PublicIdentity>();
    try {
      identities = await this.identities.resolve(pending.map((r) => r.userId));
    } catch (err) {
      this.logger.warn(`Identity enrichment failed for room ${roomId}: ${String(err)}`);
    }

    const rows = await Promise.all(
      pending.map(async (req) => ({
        ...toVideoRoomSeatRequestView(req),
        position: await this.queue.position(roomId, req.userId),
        user: identities.get(req.userId),
      })),
    );
    return rows.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  }
```

If the class has no `logger` field, add `private readonly logger = new Logger(VideoRoomSeatRequestService.name);` and import `Logger` from `@nestjs/common`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/services/video-room-seat-request.service.spec.ts`
Expected: PASS — new tests plus all pre-existing ones.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npx jest src/modules/video-rooms --silent`
Expected: exit 0. Any other spec constructing `VideoRoomSeatRequestService` positionally must be given the extra `identities` mock.

---

## Task 5: Enrich `GET :id/members` (cache-warming source)

**Files:**
- Modify: `src/modules/video-rooms/entities/video-room-member.view.ts`
- Modify: `src/modules/video-rooms/services/video-room-member.service.ts:334-342`
- Test: `src/modules/video-rooms/services/video-room-member.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomIdentityCache.resolve` (Task 2).
- Produces: `listMembers(roomId, take, skip): Promise<{ items: Array<VideoRoomMemberView & { user?: PublicIdentity }>; total: number }>`. This endpoint is what the Flutter client warms its identity cache from in Task 10.

### Task 5a (AMENDMENT — added during execution): fix the broken join payload

**Discovered during Task 1.** `emitUserJoined` (lines 194-200) reads `actor.username`,
`actor.name` and `actor.avatarUrl`, but `RoomActor` is `{ id: string; roles: PlatformRole[] }`
— nothing else. This produces **4 real `tsc` errors** and, at runtime, broadcasts
`username: undefined, name: undefined, avatarUrl: undefined`. That is the actual
server-side cause of the client showing "User joined": the payload never carried a name.

The spec's §1 claim that "the payload already carries it" was wrong. Fix it here, in the
same file this task already touches, using the identity cache this task already injects.

Replace the `emitUserJoined` call (lines 194-200) with:

```ts
      // RoomActor carries only { id, roles } — it is built from the access
      // token and has never had profile fields. Reading actor.username /
      // .name / .avatarUrl here did not compile AND emitted three undefineds,
      // which is why clients fell through to the literal string "User".
      // Resolve real identity from the same cache the roster uses.
      const joiner = (await this.identities.resolve([actor.id]).catch(() => null))?.get(
        actor.id,
      );
      await this.events.emitUserJoined({
        roomId,
        userId: actor.id,
        username: joiner?.username,
        name: joiner?.displayName ?? undefined,
        avatarUrl: joiner?.avatarUrl ?? undefined,
        participantCount: liveCount,
      });
```

Add this test to the same spec file:

```ts
it('emits the joiner real display name, not undefined', async () => {
  deps.identities.resolve = jest.fn().mockResolvedValue(
    new Map([['u1', { displayName: 'Rahul', avatarUrl: 'https://cdn/a.jpg', username: 'rahul_92', level: 24, vipLevel: 3, verified: true }]]),
  );

  await svc.join({ id: 'u1', roles: [] } as any, 'room1', ctx);

  expect(deps.events.emitUserJoined).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Rahul', username: 'rahul_92', avatarUrl: 'https://cdn/a.jpg' }),
  );
});

it('still emits the join when identity resolution fails', async () => {
  deps.identities.resolve = jest.fn().mockRejectedValue(new Error('redis down'));

  await svc.join({ id: 'u1', roles: [] } as any, 'room1', ctx);

  expect(deps.events.emitUserJoined).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'u1', name: undefined }),
  );
});
```

Do **not** add profile fields to `RoomActor` — it is built from the access token, which
does not carry them, so the fields would be permanently undefined by construction.

Verification for this amendment: `npx tsc --noEmit` must report **zero** errors in
`video-room-member.service.ts` (it currently reports 4).

- [ ] **Step 1: Write the failing test**

Append to `src/modules/video-rooms/services/video-room-member.service.spec.ts`:

```ts
describe('listMembers identity enrichment', () => {
  it('attaches identity to every member row', async () => {
    deps.repo.listActiveMembers = jest.fn().mockResolvedValue([
      { userId: 'u1', role: 'OWNER', memberStatus: 'ACTIVE', joinedAt: new Date(0), lastActiveAt: new Date(0), isActive: true },
      { userId: 'u2', role: 'VIEWER', memberStatus: 'ACTIVE', joinedAt: new Date(0), lastActiveAt: new Date(0), isActive: true },
    ]);
    deps.repo.countActiveMembers = jest.fn().mockResolvedValue(2);
    deps.identities.resolve = jest.fn().mockResolvedValue(
      new Map([
        ['u1', { displayName: 'Rahul', avatarUrl: null, username: 'rahul_92', level: 24, vipLevel: 3, verified: true }],
        ['u2', { displayName: 'Priya', avatarUrl: null, username: 'priya', level: 5, vipLevel: 0, verified: false }],
      ]),
    );

    const out = await svc.listMembers('room1', 50, 0);

    expect(deps.identities.resolve).toHaveBeenCalledWith(['u1', 'u2']);
    expect(out.items[0].user?.displayName).toBe('Rahul');
    expect(out.items[1].user?.level).toBe(5);
    expect(out.total).toBe(2);
  });

  it('returns bare rows when identity resolution throws', async () => {
    deps.repo.listActiveMembers = jest.fn().mockResolvedValue([
      { userId: 'u1', role: 'VIEWER', memberStatus: 'ACTIVE', joinedAt: new Date(0), lastActiveAt: new Date(0), isActive: true },
    ]);
    deps.repo.countActiveMembers = jest.fn().mockResolvedValue(1);
    deps.identities.resolve = jest.fn().mockRejectedValue(new Error('redis down'));

    const out = await svc.listMembers('room1', 50, 0);

    expect(out.items[0].user).toBeUndefined();
    expect(out.items[0].userId).toBe('u1');
  });
});
```

Add `identities: { resolve: jest.fn().mockResolvedValue(new Map()) }` to that spec's `deps` and pass it as the final constructor argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/services/video-room-member.service.spec.ts -t "identity enrichment"`
Expected: FAIL — `out.items[0].user` is `undefined`.

- [ ] **Step 3: Extend the view type**

In `src/modules/video-rooms/entities/video-room-member.view.ts`, add to the `VideoRoomMemberView` interface:

```ts
  /**
   * Display identity. Optional: absent for an unresolvable user, or when
   * enrichment degraded. Clients warm their identity cache from this.
   */
  user?: import('src/modules/users/interfaces/profile.interface').PublicIdentity;
```

- [ ] **Step 4: Enrich the service**

In `src/modules/video-rooms/services/video-room-member.service.ts`, add the constructor parameter (append last) and import as in Task 4, then replace `listMembers`:

```ts
  async listMembers(
    roomId: string,
    take: number,
    skip: number,
  ): Promise<{ items: VideoRoomMemberView[]; total: number }> {
    const rows = await this.repo.listActiveMembers(roomId, take, skip);
    const total = await this.repo.countActiveMembers(roomId);

    // Display-only: never fail the roster because identity lookup did.
    let identities = new Map<string, PublicIdentity>();
    try {
      identities = await this.identities.resolve(rows.map((r) => r.userId));
    } catch (err) {
      this.logger.warn(`Member identity enrichment failed for room ${roomId}: ${String(err)}`);
    }

    return {
      items: rows.map((r) => ({ ...toVideoRoomMemberView(r), user: identities.get(r.userId) })),
      total,
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/services/video-room-member.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npx jest src/modules/video-rooms --silent`
Expected: exit 0.

---

## Task 6: Deferred enrichment of the `seat_requested` broadcast

**Files:**
- Modify: `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts:102-104, 144-146`
- Test: `src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomIdentityCache.resolve` (Task 2).
- Produces: the `video_room.seat_requested` broadcast payload gains an optional `user` field. No other broadcast changes.

**Critical constraint:** `InMemoryEventBus.publish` awaits listeners on the *publisher's* stack. Awaiting the identity lookup inline would put a Redis/DB round-trip inside `POST :id/seats/request`, and a lookup failure would propagate into `publish()` and fail the seat request. The subscription therefore returns synchronously and defers with `setImmediate`, matching the pattern documented at `video-room-seat-queue.listener.ts:35-59`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`:

```ts
const flush = () => new Promise((r) => setImmediate(r));

describe('seat_requested identity enrichment', () => {
  it('returns synchronously — never awaits the lookup on the publisher stack', () => {
    deps.identities.resolve = jest.fn(() => new Promise(() => {})); // never settles

    const result = handlers['video_room.seat_requested']({
      payload: { roomId: 'room1', requestId: 'r1', userId: 'u1', seatIndex: null },
    });

    expect(result).toBeUndefined();
  });

  it('emits the enriched payload after the deferred lookup', async () => {
    deps.identities.resolve = jest.fn().mockResolvedValue(
      new Map([['u1', { displayName: 'Rahul', avatarUrl: null, username: 'rahul_92', level: 24, vipLevel: 3, verified: true }]]),
    );

    handlers['video_room.seat_requested']({
      payload: { roomId: 'room1', requestId: 'r1', userId: 'u1', seatIndex: null },
    });
    await flush();
    await flush();

    expect(deps.sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      expect.anything(),
      'room1',
      'video_room.seat_requested',
      expect.objectContaining({ requestId: 'r1', user: expect.objectContaining({ displayName: 'Rahul' }) }),
    );
  });

  it('emits the BARE payload when the lookup rejects', async () => {
    deps.identities.resolve = jest.fn().mockRejectedValue(new Error('redis down'));

    handlers['video_room.seat_requested']({
      payload: { roomId: 'room1', requestId: 'r1', userId: 'u1', seatIndex: null },
    });
    await flush();
    await flush();

    const [, , , payload] = deps.sockets.emitToNamespaceRoom.mock.calls.at(-1);
    expect(payload).toEqual({ roomId: 'room1', requestId: 'r1', userId: 'u1', seatIndex: null });
  });

  it('emits the bare payload when the user cannot be resolved', async () => {
    deps.identities.resolve = jest.fn().mockResolvedValue(new Map());

    handlers['video_room.seat_requested']({
      payload: { roomId: 'room1', requestId: 'r1', userId: 'ghost', seatIndex: null },
    });
    await flush();
    await flush();

    const [, , , payload] = deps.sockets.emitToNamespaceRoom.mock.calls.at(-1);
    expect(payload.user).toBeUndefined();
  });
});
```

Add `identities: { resolve: jest.fn().mockResolvedValue(new Map()) }` to that spec's `deps` and pass it as the final constructor argument. If the spec does not already capture handlers, build `handlers` the same way Task 3's spec does (`bus.subscribe` recording into a map).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts -t "identity enrichment"`
Expected: FAIL — the emitted payload has no `user` field.

- [ ] **Step 3: Implement deferred enrichment**

In `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts`, add the constructor parameter (append last) and imports as in Task 4. Replace the `SEAT_REQUESTED` subscription (lines 102-104):

```ts
    // Deliberately NOT `async`. `InMemoryEventBus.publish` (emitAsync) awaits
    // listeners on the publisher's own stack — which here is the
    // `POST :id/seats/request` request path. Awaiting the identity lookup
    // inline would add a Redis/DB round-trip to that request AND let a lookup
    // failure propagate into `publish()`, losing the seat request because its
    // *notification* could not be decorated. Same deferral rationale as
    // `video-room-seat-queue.listener.ts:35-59`.
    this.bus.subscribe<SeatRequestedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUESTED, (e) => {
      setImmediate(() => void this.emitSeatRequested(e.payload));
    });
```

Add the private method next to `emit` (near line 144):

```ts
  /**
   * Broadcast `seat_requested`, decorated with the requester's identity when it
   * is available. Enrichment is best-effort: on any failure the BARE payload
   * still goes out, because a host who sees an un-named request can still act
   * on it, whereas a host who sees nothing cannot.
   *
   * The client rarely needs this anyway — a requester is always an active
   * member, so the host's identity cache is already warmed by `GET :id/members`
   * on entry and by `video_room.user_joined` afterwards.
   */
  private async emitSeatRequested(payload: SeatRequestedEvent['payload']): Promise<void> {
    let user: PublicIdentity | undefined;
    try {
      user = (await this.identities.resolve([payload.userId])).get(payload.userId);
    } catch (err) {
      this.logger.warn(`seat_requested identity enrichment failed: ${String(err)}`);
    }
    this.emit(
      payload.roomId,
      VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUESTED,
      user ? { ...payload, user } : payload,
    );
  }
```

Add `private readonly logger = new Logger(VideoRoomSeatSocketListener.name);` and the `Logger` import if absent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`
Expected: PASS — 4 new tests plus all pre-existing.

- [ ] **Step 5: Verify the whole backend (no commit)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npm run lint && npx jest --silent`
Expected: exit 0 on all three. Record the total test count — it must be ≥ the pre-change count with zero failures.

---

## Task 7: Correct the Flutter socket contract + drift guard

**Files:**
- Modify: `lib/features/video_room/data/sources/video_room_socket_service.dart:26-72, 176-205`
- Test: `test/features/video_room/video_room_socket_events_test.dart`

**Interfaces:**
- Consumes: nothing.
- Produces: a corrected `videoRoomSocketEventNames` list. `VideoRoomSocketService.emitRequestSeat` **no longer exists** — Task 9 must not call it.

- [ ] **Step 1: Write the failing test**

Append to `test/features/video_room/video_room_socket_events_test.dart` inside `group('videoRoomSocketEventNames', ...)`:

```dart
    // The backend's client-facing seat events are ALL dotted
    // (VIDEO_ROOM_SOCKET_EVENTS in video-room.constants.ts). The colon
    // variants below were invented client-side and match no server emit —
    // which is why approve/reject realtime was dead.
    test('subscribes to the real dotted seat-request lifecycle events', () {
      for (final name in <String>[
        'video_room.seat_requested',
        'video_room.seat_approved',
        'video_room.seat_rejected',
        'video_room.seat_request_failed',
        'video_room.seat_request_cancelled',
        'video_room.seat_request_expired',
        'video_room.seat_queue_updated',
      ]) {
        expect(videoRoomSocketEventNames, contains(name),
            reason: '$name is emitted by the backend but not subscribed to');
      }
    });

    test('contains no invented event names', () {
      for (final name in <String>[
        'seat.requested',
        'video_room:seat_requested',
        'video_room:request_seat',
        'seat_requested',
        'video_room.speaker_request_created',
        'seat_request:new',
        'video_room.speaker_request_resolved',
        'video_room:seat_approved',
        'video_room:seat_rejected',
      ]) {
        expect(videoRoomSocketEventNames, isNot(contains(name)),
            reason: '$name matches no backend emit — it can never fire');
      }
    });

    test('has no duplicate entries', () {
      expect(videoRoomSocketEventNames.toSet().length,
          videoRoomSocketEventNames.length);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/video_room_socket_events_test.dart`
Expected: FAIL — `video_room.seat_approved` missing; the nine invented names present.

- [ ] **Step 3: Correct the event list**

In `lib/features/video_room/data/sources/video_room_socket_service.dart`, replace the seat-request block inside `videoRoomSocketEventNames` (the nine names under `// Speaker seat request events.`) with:

```dart
  // Speaker seat request lifecycle. ALL dotted — these mirror
  // VIDEO_ROOM_SOCKET_EVENTS in video-room.constants.ts exactly. The colon
  // variants that used to live here matched no server emit and never fired;
  // `video_room_socket_events_test.dart` now fails if any come back.
  'video_room.seat_requested',
  'video_room.seat_approved',
  'video_room.seat_rejected',
  'video_room.seat_request_failed',
  'video_room.seat_request_cancelled',
  'video_room.seat_request_expired',
  'video_room.seat_queue_updated',
```

- [ ] **Step 4: Delete `emitRequestSeat`**

Delete the entire `emitRequestSeat` method (lines 176-205). Seat requests go over REST only.

Add this note under the class doc comment:

```dart
/// There is deliberately NO seat-request emitter here. The backend gateway
/// subscribes to four chat/typing messages only — a seat request emitted over
/// the socket reaches no handler. The real API is
/// `POST /video-rooms/:id/seats/request`. The removed emitter also sent
/// client-supplied `userId`/`username`, which would be spoofable the day a
/// handler is added.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/video_room_socket_events_test.dart`
Expected: PASS — all groups including the pre-existing VR-17 and moderation assertions.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze lib/features/video_room`
Expected: no errors. Any "method not found: emitRequestSeat" is the Task 9 call site — leave it; Task 9 removes it.

---

## Task 8: Repository returns the real server request id

**Files:**
- Create: `lib/features/video_room/domain/models/room_identity.dart`
- Modify: `lib/features/video_room/domain/repositories/video_room_repository.dart:35, 38`
- Modify: `lib/features/video_room/data/repositories/video_room_repository_impl.dart:228-270`
- Test: `test/features/video_room/video_room_repository_test.dart`

**Interfaces:**
- Consumes: the enriched `GET :id/seats/requests` and `GET :id/members` from Tasks 4-5.
- Produces:
  - `class RoomIdentity { final String userId; final String displayName; final String? avatarUrl; final String? username; final int level; final int vipLevel; final bool verified; }` with `RoomIdentity.fromJson(String userId, Map<String, dynamic> json)`.
  - `Future<SpeakerRequestItem> requestSeat(String roomId, {int? seatIndex})`
  - `Future<List<RoomIdentity>> getRoomMembers(String roomId)`

- [ ] **Step 1: Write the failing test**

Append to `test/features/video_room/video_room_repository_test.dart`:

```dart
  group('requestSeat', () {
    test('returns the SERVER request id, not a client-generated one', () async {
      dio.postHandler = (path, data) {
        expect(path, '/video-rooms/room1/seats/request');
        expect((data as Map)['seatIndex'], isNull);
        return {
          'data': {
            'id': '8f14e45f-ceea-467a-9f8b-1a2b3c4d5e6f',
            'userId': 'u1',
            'seatIndex': null,
            'status': 'PENDING',
            'createdAt': '2026-07-28T06:00:00.000Z',
          }
        };
      };

      final item = await repo.requestSeat('room1', seatIndex: null);

      expect(item.requestId, '8f14e45f-ceea-467a-9f8b-1a2b3c4d5e6f');
      expect(item.requestId, isNot(startsWith('req_')));
      expect(item.userId, 'u1');
    });

    test('propagates a server rejection instead of swallowing it', () async {
      dio.postHandler = (_, __) => throw DioException(
            requestOptions: RequestOptions(path: '/x'),
            response: Response(
              requestOptions: RequestOptions(path: '/x'),
              statusCode: 409,
              data: {'errorCode': 'DUPLICATE_SEAT_REQUEST', 'message': 'You already have a pending seat request.'},
            ),
          );

      expect(() => repo.requestSeat('room1'), throwsA(isA<DioException>()));
    });
  });

  group('getPendingSeatRequests', () {
    test('parses the enriched user block', () async {
      dio.getHandler = (_) => {
            'data': [
              {
                'id': 'r1',
                'userId': 'u1',
                'seatIndex': null,
                'status': 'PENDING',
                'position': 1,
                'createdAt': '2026-07-28T06:00:00.000Z',
                'user': {
                  'displayName': 'Rahul',
                  'avatarUrl': 'https://cdn/a.jpg',
                  'username': 'rahul_92',
                  'level': 24,
                  'vipLevel': 3,
                  'verified': true,
                },
              }
            ]
          };

      final rows = await repo.getPendingSeatRequests('room1');

      expect(rows.single.username, 'Rahul');
      expect(rows.single.avatarUrl, 'https://cdn/a.jpg');
    });

    test('leaves username empty rather than faking one when user is absent', () async {
      dio.getHandler = (_) => {
            'data': [
              {'id': 'r1', 'userId': 'u1', 'seatIndex': null, 'status': 'PENDING', 'createdAt': '2026-07-28T06:00:00.000Z'}
            ]
          };

      final rows = await repo.getPendingSeatRequests('room1');

      expect(rows.single.username, '');
      expect(rows.single.username, isNot('Audience User'));
    });
  });

  group('getRoomMembers', () {
    test('returns identities for cache warming', () async {
      dio.getHandler = (_) => {
            'data': {
              'items': [
                {
                  'userId': 'u1',
                  'role': 'OWNER',
                  'user': {'displayName': 'Rahul', 'avatarUrl': null, 'username': 'rahul_92', 'level': 24, 'vipLevel': 3, 'verified': true},
                },
                {'userId': 'u2', 'role': 'VIEWER'},
              ],
              'total': 2,
            }
          };

      final members = await repo.getRoomMembers('room1');

      expect(members, hasLength(1)); // u2 has no identity block — skipped
      expect(members.single.userId, 'u1');
      expect(members.single.level, 24);
    });
  });
```

Match the existing fake-Dio helper already used in this spec file; if it has no `postHandler`/`getHandler` hooks, extend the existing fake rather than introducing a new mocking library.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/video_room_repository_test.dart`
Expected: FAIL — `requestSeat` returns `void`; `getRoomMembers` undefined.

- [ ] **Step 3: Create the identity model**

Create `lib/features/video_room/domain/models/room_identity.dart`:

```dart
/// Display identity for a user in a video room.
///
/// Mirrors the backend `PublicIdentity` attached to enriched payloads
/// (`GET :id/seats/requests`, `GET :id/members`, `video_room.seat_requested`).
///
/// There are no defaulted display strings here on purpose: an unresolvable
/// user yields NO RoomIdentity at all, so the UI renders an initials
/// placeholder instead of a fabricated name like "Audience User".
class RoomIdentity {
  const RoomIdentity({
    required this.userId,
    required this.displayName,
    this.avatarUrl,
    this.username,
    this.level = 1,
    this.vipLevel = 0,
    this.verified = false,
  });

  final String userId;
  final String displayName;
  final String? avatarUrl;
  final String? username;
  final int level;
  final int vipLevel;
  final bool verified;

  bool get isVip => vipLevel > 0;

  /// Returns null when the block carries no usable display name — the caller
  /// must fall back to a placeholder, never to an invented string.
  static RoomIdentity? fromJson(String userId, Map<String, dynamic>? json) {
    if (json == null) return null;
    final String name =
        (json['displayName'] ?? json['username'] ?? '').toString().trim();
    if (name.isEmpty) return null;
    return RoomIdentity(
      userId: userId,
      displayName: name,
      avatarUrl: (json['avatarUrl'] as String?)?.trim().isEmpty ?? true
          ? null
          : json['avatarUrl'] as String,
      username: json['username'] as String?,
      level: (json['level'] as num?)?.toInt() ?? 1,
      vipLevel: (json['vipLevel'] as num?)?.toInt() ?? 0,
      verified: json['verified'] as bool? ?? false,
    );
  }
}
```

- [ ] **Step 4: Update the interface and implementation**

In `lib/features/video_room/domain/repositories/video_room_repository.dart`, change line 35 and add the members method:

```dart
  /// Ask for a seat. Always sends `seatIndex: null` — the server assigns the
  /// first open seat at approval time (`driveSeating` -> `findOpenSeat`), so a
  /// request can never die because one specific seat filled while it waited.
  ///
  /// Returns the SERVER-created request, whose `requestId` is the only id the
  /// approve/reject routes accept. Throws on rejection — callers must surface it.
  Future<SpeakerRequestItem> requestSeat(String roomId, {int? seatIndex});

  /// Active members with their display identity — the identity cache warm source.
  Future<List<RoomIdentity>> getRoomMembers(String roomId);
```

In `lib/features/video_room/data/repositories/video_room_repository_impl.dart`, replace `requestSeat` (228-235) and the `getPendingSeatRequests` mapping (249-262), and add `getRoomMembers`:

```dart
  @override
  Future<SpeakerRequestItem> requestSeat(String roomId, {int? seatIndex}) async {
    final response = await _dio.post<dynamic>(
      '/video-rooms/$roomId/seats/request',
      data: <String, dynamic>{'seatIndex': seatIndex},
    );
    final data = response.data;
    final m = (data is Map && data['data'] is Map)
        ? Map<String, dynamic>.from(data['data'] as Map)
        : Map<String, dynamic>.from(data as Map);
    return SpeakerRequestItem(
      requestId: (m['id'] ?? '').toString(),
      userId: (m['userId'] ?? '').toString(),
      username: '',
      avatarUrl: null,
      seatIndex: (m['seatIndex'] as num?)?.toInt() ?? -1,
      requestedAt:
          DateTime.tryParse((m['createdAt'] ?? '').toString()) ?? DateTime.now(),
    );
  }

  @override
  Future<List<RoomIdentity>> getRoomMembers(String roomId) async {
    final response = await _dio.get<dynamic>('/video-rooms/$roomId/members');
    final data = response.data;
    final root = (data is Map && data['data'] != null) ? data['data'] : data;
    final items = (root is Map && root['items'] is List)
        ? root['items'] as List
        : (root is List ? root : const <dynamic>[]);
    return items
        .map((raw) {
          final m = Map<String, dynamic>.from(raw as Map);
          return RoomIdentity.fromJson(
            (m['userId'] ?? '').toString(),
            m['user'] == null ? null : Map<String, dynamic>.from(m['user'] as Map),
          );
        })
        .whereType<RoomIdentity>()
        .toList();
  }
```

In `getPendingSeatRequests`, replace the row mapping so it reads the enriched block and never fabricates:

```dart
            final m = item as Map<String, dynamic>;
            final identity = RoomIdentity.fromJson(
              (m['userId'] ?? '').toString(),
              m['user'] == null ? null : Map<String, dynamic>.from(m['user'] as Map),
            );
            return SpeakerRequestItem(
              requestId: (m['id'] ?? '').toString(),
              userId: (m['userId'] ?? '').toString(),
              // Empty, NOT 'Audience User' — the UI renders a placeholder or
              // resolves via the identity cache. A fake name is the bug.
              username: identity?.displayName ?? '',
              avatarUrl: identity?.avatarUrl,
              seatIndex: (m['seatIndex'] as num?)?.toInt() ?? -1,
              requestedAt:
                  DateTime.tryParse((m['createdAt'] ?? '').toString()) ?? DateTime.now(),
            );
```

Add `import '../../domain/models/room_identity.dart';` to both files.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/video_room_repository_test.dart`
Expected: PASS.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze lib/features/video_room`
Expected: only the known Task 9 call-site errors (`requestSeat` return now used, `emitRequestSeat` gone).

---

## Task 9: Server-truthed request lifecycle in the controller

**Files:**
- Modify: `lib/features/video_room/presentation/providers/video_room_controller.dart:152-202, 533-655`
- Test: `test/features/video_room/speaker_request_flow_test.dart` (create)

**Interfaces:**
- Consumes: `requestSeat` returning `SpeakerRequestItem` (Task 8); the corrected event names (Task 7).
- Produces: `requestSeat(int? seatIndex)`, `approveSpeakerRequest(String requestId)`, `rejectSpeakerRequest(String requestId)` — all throwing-free but state-setting, with `state.errorMessage` populated on failure. **Note the signature change:** `approveSpeakerRequest` drops its `targetUserId` and `seatIndex` parameters, since the server assigns the seat.

- [ ] **Step 1: Write the failing test**

Create `test/features/video_room/speaker_request_flow_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';

// Uses the same fake repository/controller harness as
// video_room_controller_test.dart — extend that harness rather than
// introducing a second mocking approach.

void main() {
  group('speaker request lifecycle', () {
    test('stores the server request id, never a client-generated one', () async {
      repo.requestSeatResult = SpeakerRequestItem(
        requestId: '8f14e45f-ceea-467a-9f8b-1a2b3c4d5e6f',
        userId: 'me',
        username: '',
        seatIndex: -1,
        requestedAt: DateTime(2026, 7, 28),
      );

      await controller.requestSeat(null);

      expect(controller.state.myPendingRequestId,
          '8f14e45f-ceea-467a-9f8b-1a2b3c4d5e6f');
      expect(controller.state.myPendingRequestId, isNot(startsWith('req_')));
    });

    test('always requests ANY seat (null), never a specific index', () async {
      await controller.requestSeat(3);
      expect(repo.lastRequestedSeatIndex, isNull);
    });

    test('surfaces a duplicate-request rejection instead of showing success',
        () async {
      repo.requestSeatError = businessError('DUPLICATE_SEAT_REQUEST',
          'You already have a pending seat request.');

      await controller.requestSeat(null);

      expect(controller.state.errorMessage,
          'You already have a pending seat request.');
      expect(controller.state.myPendingRequestId, isNull);
    });

    test('does NOT seat anyone locally on approve — waits for the server',
        () async {
      final before = controller.state.room!.seats;

      await controller.approveSpeakerRequest('r1');

      expect(controller.state.room!.seats, same(before));
      expect(repo.approvedRequestIds, ['r1']);
    });

    test('keeps the request in the panel when approve fails', () async {
      controller.debugSeedPendingRequests([
        SpeakerRequestItem(requestId: 'r1', userId: 'u1', username: 'Rahul', seatIndex: -1, requestedAt: DateTime(2026)),
      ]);
      repo.approveError = businessError('SEAT_FULL', 'No open seat is available.');

      await controller.approveSpeakerRequest('r1');

      expect(controller.state.pendingSpeakerRequests, hasLength(1));
      expect(controller.state.errorMessage, 'No open seat is available.');
    });

    test('removes the row only when the server broadcasts seat_approved', () {
      controller.debugSeedPendingRequests([
        SpeakerRequestItem(requestId: 'r1', userId: 'u1', username: 'Rahul', seatIndex: -1, requestedAt: DateTime(2026)),
      ]);

      controller.debugHandleSocketEvent('video_room.seat_approved', {
        'roomId': 'room1', 'requestId': 'r1', 'userId': 'u1', 'status': 'ACCEPTED',
      });

      expect(controller.state.pendingSpeakerRequests, isEmpty);
    });

    test('reacts to the dotted seat_rejected event', () {
      controller.debugSeedPendingRequests([
        SpeakerRequestItem(requestId: 'r1', userId: 'u1', username: 'Rahul', seatIndex: -1, requestedAt: DateTime(2026)),
      ]);

      controller.debugHandleSocketEvent('video_room.seat_rejected', {
        'roomId': 'room1', 'requestId': 'r1', 'userId': 'u1', 'status': 'REJECTED',
      });

      expect(controller.state.pendingSpeakerRequests, isEmpty);
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/speaker_request_flow_test.dart`
Expected: FAIL — `myPendingRequestId` does not exist.

- [ ] **Step 3: Add the state field**

In `lib/features/video_room/presentation/providers/video_room_state.dart`, add to `VideoRoomState`: a `final String? myPendingRequestId;` field, its constructor entry (`this.myPendingRequestId`), a `copyWith` parameter, and a `bool clearMyPendingRequest = false` flag handled as `myPendingRequestId: clearMyPendingRequest ? null : (myPendingRequestId ?? this.myPendingRequestId)`. Follow the existing `clearActiveSeat` pattern in the same class.

- [ ] **Step 4: Rewrite the lifecycle methods**

Replace `requestSeat`, `approveSpeakerRequest` and `rejectSpeakerRequest` (lines 533-655):

```dart
  /// Ask for a seat. Always any-seat: the server picks the first open one at
  /// approval time, so the request survives seat churn while it waits.
  ///
  /// [seatIndex] is accepted for call-site compatibility and deliberately
  /// ignored — tapping a seat is an intent to speak, not a seat reservation.
  Future<void> requestSeat([int? seatIndex]) async {
    if (state.isSeated || state.myPendingRequestId != null) return;
    state = state.copyWith(clearError: true);
    try {
      final item = await _repository.requestSeat(_roomId, seatIndex: null);
      state = state.copyWith(myPendingRequestId: item.requestId);
    } catch (e) {
      // No optimistic row. A request the server refused is not pending.
      state = state.copyWith(errorMessage: _errorMessage(e));
    }
  }

  /// Approve a pending request. The server assigns the seat and broadcasts
  /// `seat_approved` + `seat_sync`; this method never mutates seats locally.
  Future<void> approveSpeakerRequest(String requestId) async {
    state = state.copyWith(clearError: true);
    try {
      await _repository.approveSeatRequest(_roomId, requestId);
      // Intentionally no local removal — the broadcast drives it, so every
      // participant converges on the same state at the same moment.
    } catch (e) {
      state = state.copyWith(errorMessage: _errorMessage(e));
    }
  }

  Future<void> rejectSpeakerRequest(String requestId) async {
    state = state.copyWith(clearError: true);
    try {
      await _repository.rejectSeatRequest(_roomId, requestId);
    } catch (e) {
      state = state.copyWith(errorMessage: _errorMessage(e));
    }
  }

  /// Server `message` when present, else a generic fallback. Never invents a
  /// reason — the backend's BusinessException text is the user-facing copy.
  String _errorMessage(Object e) {
    if (e is DioException) {
      final data = e.response?.data;
      if (data is Map && data['message'] is String) return data['message'] as String;
    }
    return 'Something went wrong. Please try again.';
  }
```

- [ ] **Step 5: Rewrite the socket handlers**

Replace the seat-request cases (lines 152-202):

```dart
        case 'video_room.seat_requested':
          // Enriched when available; the panel resolves anything missing via
          // the identity cache rather than inventing a name.
          final reqId = (event.payload['requestId'] ?? '').toString();
          final uId = (event.payload['userId'] ?? '').toString();
          if (reqId.isEmpty || uId.isEmpty) break;
          final identity = RoomIdentity.fromJson(
            uId,
            event.payload['user'] == null
                ? null
                : Map<String, dynamic>.from(event.payload['user'] as Map),
          );
          if (identity != null) {
            ref.read(roomIdentityCacheProvider.notifier).put(identity);
          }
          final existing = state.pendingSpeakerRequests
              .where((r) => r.requestId != reqId)
              .toList();
          state = state.copyWith(pendingSpeakerRequests: [
            ...existing,
            SpeakerRequestItem(
              requestId: reqId,
              userId: uId,
              username: identity?.displayName ?? '',
              avatarUrl: identity?.avatarUrl,
              seatIndex: (event.payload['seatIndex'] as num?)?.toInt() ?? -1,
              requestedAt: DateTime.now(),
            ),
          ]);
          break;

        case 'video_room.seat_approved':
        case 'video_room.seat_rejected':
        case 'video_room.seat_request_failed':
        case 'video_room.seat_request_cancelled':
        case 'video_room.seat_request_expired':
          final reqId = (event.payload['requestId'] ?? '').toString();
          final uId = (event.payload['userId'] ?? '').toString();
          state = state.copyWith(
            pendingSpeakerRequests: state.pendingSpeakerRequests
                .where((r) => r.requestId != reqId)
                .toList(),
            clearMyPendingRequest: reqId == state.myPendingRequestId,
          );
          if (uId.isNotEmpty && reqId == state.myPendingRequestId) {
            state = state.copyWith(
              errorMessage: event.event == 'video_room.seat_rejected'
                  ? 'Your request to speak was declined.'
                  : null,
            );
          }
          break;

        case 'video_room.seat_queue_updated':
          unawaited(fetchPendingSpeakerRequests());
          break;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/`
Expected: PASS. Update `video_room_controller_test.dart` call sites for the new `approveSpeakerRequest(requestId)` signature.

- [ ] **Step 7: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze lib/features/video_room`
Expected: no errors. Confirm `grep -rn "catch (_) {}" lib/features/video_room/presentation/providers/video_room_controller.dart` returns nothing.

---

## Task 10: Identity cache provider with member warming

**Files:**
- Create: `lib/features/video_room/presentation/providers/room_identity_cache.dart`
- Modify: `lib/features/video_room/presentation/providers/video_room_controller.dart` (join path)
- Test: `test/features/video_room/room_identity_cache_test.dart`

**Interfaces:**
- Consumes: `RoomIdentity` (Task 8), `getRoomMembers` (Task 8).
- Produces: `roomIdentityCacheProvider` — a `NotifierProvider<RoomIdentityCache, Map<String, RoomIdentity>>` exposing `put(RoomIdentity)`, `putAll(Iterable<RoomIdentity>)`, `RoomIdentity? peek(String userId)`, and `Future<RoomIdentity?> resolve(String userId)`.

- [ ] **Step 1: Write the failing test**

Create `test/features/video_room/room_identity_cache_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  late ProviderContainer container;

  setUp(() {
    container = ProviderContainer(overrides: [/* fake user repository */]);
  });
  tearDown(() => container.dispose());

  test('peek returns null for an unknown user without any fetch', () {
    final cache = container.read(roomIdentityCacheProvider.notifier);
    expect(cache.peek('nobody'), isNull);
    expect(fakeUserRepo.fetchCount, 0);
  });

  test('putAll warms the cache so resolve needs no fetch', () async {
    final cache = container.read(roomIdentityCacheProvider.notifier);
    cache.putAll([
      const RoomIdentity(userId: 'u1', displayName: 'Rahul', level: 24, vipLevel: 3),
    ]);

    expect(await cache.resolve('u1'), isNotNull);
    expect(fakeUserRepo.fetchCount, 0);
  });

  test('resolve falls back to GET /users/:id exactly once per miss', () async {
    final cache = container.read(roomIdentityCacheProvider.notifier);
    fakeUserRepo.result = const RoomIdentity(userId: 'u9', displayName: 'Ganesh');

    final a = await cache.resolve('u9');
    final b = await cache.resolve('u9');

    expect(a?.displayName, 'Ganesh');
    expect(b?.displayName, 'Ganesh');
    expect(fakeUserRepo.fetchCount, 1);
  });

  test('coalesces concurrent resolves of the same id into one fetch', () async {
    final cache = container.read(roomIdentityCacheProvider.notifier);
    fakeUserRepo.result = const RoomIdentity(userId: 'u9', displayName: 'Ganesh');

    await Future.wait([cache.resolve('u9'), cache.resolve('u9'), cache.resolve('u9')]);

    expect(fakeUserRepo.fetchCount, 1);
  });

  test('returns null and caches nothing when the lookup fails', () async {
    final cache = container.read(roomIdentityCacheProvider.notifier);
    fakeUserRepo.error = Exception('404');

    expect(await cache.resolve('ghost'), isNull);
    expect(cache.peek('ghost'), isNull);
  });

  test('put overwrites a stale entry (profile changed)', () {
    final cache = container.read(roomIdentityCacheProvider.notifier);
    cache.put(const RoomIdentity(userId: 'u1', displayName: 'Old'));
    cache.put(const RoomIdentity(userId: 'u1', displayName: 'New'));
    expect(cache.peek('u1')?.displayName, 'New');
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/room_identity_cache_test.dart`
Expected: FAIL — `roomIdentityCacheProvider` undefined.

- [ ] **Step 3: Create the cache**

Create `lib/features/video_room/presentation/providers/room_identity_cache.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../domain/models/room_identity.dart';

/// In-room display identity, keyed by userId.
///
/// Hybrid model:
///  - SEEDED by enriched backend payloads (seat requests, members, join events)
///    — the fast path, correct on first paint.
///  - WARMED on room entry from `GET :id/members`, so seat requests, gifts, PK
///    and moderation events almost never need a fetch.
///  - FALLBACK to `GET /users/:identifier` only for a genuine miss.
///
/// A failed lookup caches NOTHING and returns null, so the UI shows an initials
/// placeholder. Caching a negative result would freeze that placeholder in
/// place for a user who is merely slow to load.
final roomIdentityCacheProvider =
    NotifierProvider<RoomIdentityCache, Map<String, RoomIdentity>>(
  RoomIdentityCache.new,
);

class RoomIdentityCache extends Notifier<Map<String, RoomIdentity>> {
  /// In-flight lookups, so N widgets asking for the same unknown user during
  /// one frame produce one request rather than N.
  final Map<String, Future<RoomIdentity?>> _inFlight = {};

  @override
  Map<String, RoomIdentity> build() => const {};

  RoomIdentity? peek(String userId) => state[userId];

  void put(RoomIdentity identity) {
    state = {...state, identity.userId: identity};
  }

  void putAll(Iterable<RoomIdentity> identities) {
    if (identities.isEmpty) return;
    state = {...state, for (final i in identities) i.userId: i};
  }

  Future<RoomIdentity?> resolve(String userId) {
    if (userId.isEmpty) return Future.value(null);
    final cached = state[userId];
    if (cached != null) return Future.value(cached);
    return _inFlight.putIfAbsent(userId, () async {
      try {
        final identity =
            await ref.read(userProfileRepositoryProvider).fetchRoomIdentity(userId);
        if (identity != null) put(identity);
        return identity;
      } catch (_) {
        return null;
      } finally {
        _inFlight.remove(userId);
      }
    });
  }
}
```

If no `userProfileRepositoryProvider` with a `fetchRoomIdentity` exists, add that one method to the existing profile repository — it maps `GET /users/:identifier` onto `RoomIdentity`. Do not create a second HTTP client.

- [ ] **Step 4: Warm on room entry**

In `video_room_controller.dart`, after the room join succeeds, add:

```dart
    // Warm identity for everyone already in the room, so the Requests panel,
    // join toasts, gift and moderation events resolve from cache instead of
    // issuing a burst of per-user lookups.
    unawaited(_warmIdentityCache());
```

```dart
  Future<void> _warmIdentityCache() async {
    try {
      // NOTE (execution amendment): the method is `getRoomMemberIdentities`,
      // NOT `getRoomMembers`. A `getRoomMembers` returning `VideoRoomMember`
      // already existed (VR-17) with live call sites in the controller and two
      // settings pages; the plan's original name collided with it.
      final members = await _repository.getRoomMemberIdentities(_roomId);
      ref.read(roomIdentityCacheProvider.notifier).putAll(members);
    } catch (_) {
      // Warming is an optimisation; a failure just means lazy resolution.
    }
  }
```

Also seed on join events, in the `video_room.user_joined` case:

```dart
          if (joinedId.isNotEmpty && joinedUser.isNotEmpty) {
            ref.read(roomIdentityCacheProvider.notifier).put(
                  RoomIdentity(
                      userId: joinedId,
                      displayName: joinedUser,
                      avatarUrl: joinedAvatar),
                );
          }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/room_identity_cache_test.dart`
Expected: PASS — 6 tests.

- [ ] **Step 6: Verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze lib/features/video_room`
Expected: no errors.

---

## Task 11: Extract the profile sheets and requests panel, bound to real data

**Files:**
- Create: `lib/features/video_room/presentation/widgets/profile/host_public_profile_sheet.dart`
- Create: `lib/features/video_room/presentation/widgets/profile/host_self_profile_sheet.dart`
- Create: `lib/features/video_room/presentation/widgets/seats/speaker_requests_panel.dart`
- Modify: `lib/features/video_room/presentation/screens/video_room_live_screen.dart:348-350, 416-418, 2480-2845, 2845-3139`

**Interfaces:**
- Consumes: `roomIdentityCacheProvider` (Task 10), `RoomIdentity` (Task 8), the new controller signatures (Task 9).
- Produces: `showHostPublicProfileSheet(BuildContext, WidgetRef, {required String hostUserId})`, `showHostSelfProfileSheet(BuildContext, WidgetRef)`, `SpeakerRequestsPanel({required List<SpeakerRequestItem> requests, required bool seatAvailable, required void Function(String) onApprove, required void Function(String) onReject})`.

**Behaviour-preserving:** move the existing widget trees verbatim. The only changes are the data bindings named below. No layout, spacing, colour, or navigation changes.

- [ ] **Step 1: Extract the public profile sheet**

Move the body of `_showHostPublicProfileSheet` (2480-2844) into `host_public_profile_sheet.dart` unchanged, then apply exactly these bindings:

```dart
// BEFORE (line 2486-2488): fell back to the VIEWER'S OWN avatar, so a viewer
// tapping the host saw their own face.
//   final String? hostAvatar = room.hostAvatarUrl?.isNotEmpty == true
//       ? room.hostAvatarUrl
//       : ref.read(profileControllerProvider).value?.avatarUrl;
// AFTER: host identity only; null renders AppAvatar's initials placeholder.
final RoomIdentity? host = ref.watch(roomIdentityCacheProvider)[hostUserId];
final String? hostAvatar =
    room.hostAvatarUrl?.isNotEmpty == true ? room.hostAvatarUrl : host?.avatarUrl;
```

Replace the three hardcoded values:

| Line | Before | After |
|---|---|---|
| 2592 | `'200'` (coins) | `profile.statistics.coinsReceived` from the awaited `GET /users/:identifier` |
| 2658 | `'32'` (following) | `profile.statistics.followingCount` |
| 2688 | `'Level: VIP'` | `host?.isVip == true ? 'VIP ${host!.vipLevel}' : 'Level ${host?.level ?? 1}'` |

Load the full profile with a `FutureProvider.family` on `hostUserId` calling `GET /users/:identifier`; show the existing sheet chrome with shimmer placeholders while it resolves — do not block the sheet from opening.

- [ ] **Step 2: Extract the self profile sheet**

Move `_showHostSelfProfileSheet` (2845 onward) into `host_self_profile_sheet.dart` verbatim. It already reads `profileControllerProvider` (correct — this is the host's own profile). Change nothing but the file location and the function's visibility.

- [ ] **Step 3: Extract the requests panel**

Move the requests-panel widget tree into `speaker_requests_panel.dart`. Each row binds:

```dart
final identity = ref.watch(roomIdentityCacheProvider)[request.userId];
final String display = request.username.isNotEmpty
    ? request.username
    : (identity?.displayName ?? '');
// Empty display => AppAvatar initials placeholder + a muted "Loading…" label.
// NEVER 'Audience User'.
if (display.isEmpty) {
  ref.read(roomIdentityCacheProvider.notifier).resolve(request.userId);
}
```

Show level, VIP badge, verification tick and the request timestamp from `identity`. Wire Approve/Reject to `onApprove(request.requestId)` / `onReject(request.requestId)`.

Gate Approve on seat availability:

```dart
// §11: with no free seat, approving would make the server throw SEAT_FULL,
// mark the request FAILED and DEQUEUE it — costing the requester their queue
// position and one of three retry attempts. Disabling keeps it PENDING and
// queued until a seat frees.
onPressed: seatAvailable ? () => onApprove(request.requestId) : null,
```

with a `'No speaker seats available'` helper line when `seatAvailable` is false.

- [ ] **Step 3a (AMENDMENT — added during execution): restore the "Request Sent" state**

Task 9 replaced the per-seat `pendingRequestedSeatIndex` with a single server-truthed
`state.myPendingRequestId`, because a request no longer names a seat. That left
`pendingRequestedSeatIndex`, `cancelSpeakerRequest`, and the live screen's per-seat pending
highlight **dead** — nothing sets them any more. Spec §6 requires "Display **Request Sent**
while waiting", so the waiting state must be re-bound, not dropped.

Rebind it to the server-truthed field:

```dart
// §6: "Request Sent" while waiting. Driven by the SERVER's request id, not a
// local optimistic flag — so the badge clears only when the server actually
// resolves the request (approved / rejected / failed / cancelled / expired),
// and every device agrees on when it is showing.
final bool hasPendingRequest = state.myPendingRequestId != null;
```

- The "Request to Speak" button shows `Request Sent` and is disabled while
  `hasPendingRequest` is true. This also satisfies §6's "Prevent duplicate requests"
  at the UI layer (the server enforces it independently with `DUPLICATE_SEAT_REQUEST`).
- The per-seat pending highlight is **removed**, not rebound: a request no longer targets a
  seat, so highlighting one specific seat would be a lie.

**Exact dead-reader inventory** (from the Task 9 review — delete or rebind each, don't guess):

| Location | State | Action |
|---|---|---|
| `video_room_state.dart:84` `isRequestPending` | dead; itself unread anywhere in `lib/` | delete |
| `video_room_live_screen.dart:802` `isPending: state.pendingRequestedSeatIndex == (i + 1)` | badge can never render | delete the per-seat pending arg |
| `video_room_live_screen.dart:809` `else if (state.pendingRequestedSeatIndex == seat.seatIndex)` | **unreachable** — gated the "Request already sent! Waiting for host approval…" snackbar | **rebind to `hasPendingRequest`**, see below |
| `video_room_controller.dart:571` `cancelSpeakerRequest()` | no-op, zero call sites | delete |
| `video_room_state.dart` `pendingRequestedSeatIndex` | nothing sets it | delete once the above are gone |

Line 809 must be **rebound, not deleted**. Today, re-tapping a seat you already requested falls
through to `_showRequestToSpeakSheet` again, and `requestSeat`'s `myPendingRequestId != null` guard
then silently no-ops the resubmission — the user taps and *nothing happens at all*. That is worse
than the bug being fixed. Rebind it:

```dart
// §6 "Prevent duplicate requests" — with feedback. The controller already
// refuses a second request while one is pending; without this branch that
// refusal is silent and the user just sees a dead tap.
} else if (hasPendingRequest) {
  ScaffoldMessenger.of(context).showSnackBar(
    const SnackBar(content: Text('Request already sent! Waiting for host approval…')),
  );
  return;
}
```

- [ ] **Step 4: Delegate from the live screen**

In `video_room_live_screen.dart`, replace the four call sites (348-350, 416-418) with calls to the extracted functions, passing `room.hostUserId`. Delete the now-empty private methods. Compute `seatAvailable` as `state.room!.seats.any((s) => s.userId == null && !s.isLocked)`.

- [ ] **Step 5: Verify no hardcoded identity remains**

Run:
```bash
cd /Users/lt611-18/soulzaa-mobile && grep -rn "Audience User\|'Level: VIP'\|joined the room'" lib/features/video_room/ | grep -v "\.g\.dart"
```
Expected: only the `'$name joined the room'` interpolation (which is now fed real names). No `Audience User`, no `Level: VIP`.

- [ ] **Step 6: Run tests and verify (no commit)**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/ && flutter analyze lib/features/video_room`
Expected: all green, no analyzer errors. `video_room_live_screen.dart` should now be materially under 3139 lines.

---

## Task 12: Full-stack verification

**Files:** none modified — this task only runs and records.

- [ ] **Step 1: Backend full suite**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npm run lint && npx jest`
Expected: exit 0 on all three; zero failures; total ≥ the count recorded in Task 6 Step 5.

- [ ] **Step 2: Mobile full suite**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze && flutter test`
Expected: no analyzer errors; all tests pass.

- [ ] **Step 3: Confirm the drift guard actually guards**

Temporarily add `'video_room:seat_approved'` back to `videoRoomSocketEventNames`, run
`flutter test test/features/video_room/video_room_socket_events_test.dart`, confirm it
**FAILS**, then remove it again and confirm it passes. A guard that cannot fail is not a guard.

- [ ] **Step 4: Manual smoke checklist**

Two devices, one host and one viewer:

1. Viewer joins → host sees "<real name> joined the room", not "User joined".
2. Viewer taps host avatar → host's real name, avatar, level, VIP badge. **Confirm the viewer does not see their own avatar.**
3. Host taps own avatar → self-profile sheet, not the public one.
4. Viewer taps "Request to Speak" → host's Requests panel shows the viewer's real name, avatar, level, VIP badge within a second, with no refresh.
5. Viewer requests twice → second attempt shows "You already have a pending seat request."
6. Host approves → viewer appears on the next free seat with video on **both** devices, no rejoin.
7. Host rejects another request → row disappears; that viewer stays in the audience and is told.
8. Fill every seat, then request → host's Approve is disabled with "No speaker seats available"; the row stays pending.
9. A speaker leaves → seat frees on both devices; the host can now approve the pending request into it.
10. Host edits their display name/avatar elsewhere → within ~60 s the room reflects it.

- [ ] **Step 5: Report**

State which of the 10 smoke steps passed, with the actual observed behaviour for any that did not. Do not report completion unless steps 1-3 are green.

---

## Self-Review

**Spec coverage:** every §4 subsection maps to a task — §4.1 → Tasks 1-6, §4.2 → Task 7, §4.3 → Tasks 8-9, §4.4 → Task 10, §4.5 → Task 11. §5 error handling is covered by Task 9 (`_errorMessage`) and Task 11 (Approve gating). §6 testing is distributed across every task plus Task 12.

**Placeholder scan:** no TBD/TODO. Two intentional "match the existing harness" instructions (Task 8 Step 1, Task 9 Step 1) point at named existing files rather than describing fixtures abstractly — the fake-Dio and controller harnesses already exist and inventing parallel ones would violate the reuse constraint.

**Type consistency:** `PublicIdentity` (backend) ↔ `RoomIdentity` (Flutter) field names align — `displayName`, `avatarUrl`, `username`, `level`, `vipLevel`, `verified`. `VideoRoomIdentityCache.resolve` returns `Map<string, PublicIdentity>` in Tasks 2/4/5/6 consistently. `approveSpeakerRequest(String requestId)` is single-arg in both Task 9's definition and Task 11's call site.

**Known signature changes** requiring call-site updates: `requestSeat` `void` → `SpeakerRequestItem` (Task 8), `approveSpeakerRequest` 3-arg → 1-arg (Task 9), `VideoRoomSeatRequestService` / `VideoRoomMemberService` / `VideoRoomSeatSocketListener` each gain a trailing constructor parameter (Tasks 4/5/6).
