# Video Room — Phase 2: Lifecycle Management (VR-2)

Status: **Approved** (design decisions locked 2026-07-20)
Builds on: VR-0 foundation + VR-1 database domain
Owner module: `src/modules/video-rooms`

---

## 1. Scope

Implement the complete **Video Room lifecycle** on top of the VR-0/VR-1 foundation:
create, get, search, list/discover, update, lock/unlock, activate, close, reopen,
soft-delete, restore, and verify-status. Production-ready: validation, RBAC,
Redis sync, event publishing, audit logging, metrics, tests, Swagger.

**Explicitly NOT in scope** (deferred to later phases, per brief): join/leave,
viewer mode, participants, seats, streaming, camera/mic, beauty, chat, emoji,
gifts, treasure, wallet, PK, notifications, moderation, analytics processing,
recording, ownership transfer (deferred — needs member management).

## 2. Locked design decisions (brainstorming, 2026-07-20)

1. **Map onto the existing schema — NO migration.** The brief's 7-state lifecycle
   and 7 visibility types are reconciled against the VR-1 minimal schema
   (`VideoRoomStatus = OFFLINE|LIVE|ENDED`, `VideoRoomVisibility = PUBLIC|PRIVATE`,
   orthogonal `isLocked`/`passwordHash`/`deletedAt`/`streamingStatus`). Continues
   the "conventions won" decision the product owner locked in VR-0/VR-1, and honors
   this brief's own "do NOT recreate DB models". Lifecycle state is a **computed
   projection**, not a new column. Extended visibility is an **access policy**
   persisted in metadata (enforcement deferred to the join phase).
2. **Rooms per owner: configurable cap, default 1.** New env
   `VIDEO_ROOM_MAX_ROOMS_PER_OWNER` (default 1). `create` throws
   `VIDEO_ROOM_ALREADY_EXISTS` (409) when the owner's non-deleted room count ≥ cap.
   Mirrors Audio's one-room behavior today; tunable later with no migration.
   (VR-1 deliberately left `ownerId` non-unique for exactly this.)
3. **Discovery: durable-signal buckets only.** newest / popular / featured /
   nearby / vip + a trending Redis zset seeded at create. friends/following are
   deferred (no social-graph wiring in this phase; no join/viewer signals yet).
4. **CQRS-ready service decomposition** (SOLID / clean-architecture): split the
   Audio-style monolith into `VideoRoomLifecycleService` (commands),
   `VideoRoomQueryService` (reads), `VideoRoomPermissionService` (RBAC gate), plus
   a pure `video-room-state-transition` helper. `VideoRoomsService` stays thin,
   implementing only the exported `IVideoRoomsService` contract.

## 3. Lifecycle state model (projection over durable columns)

Code-only `VideoRoomLifecycleState` (NOT a Prisma enum), computed in precedence
order:

```
DELETED   ← deletedAt != null
ARCHIVED  ← status=ENDED & metadata.archivedAt present   (recognized; endpoint deferred)
ENDED     ← status=ENDED
PAUSED    ← streamingStatus=PAUSED                        (recognized; belongs to streaming phase)
LOCKED    ← isLocked=true & status=LIVE                   (orthogonal flag; also exposed raw)
ACTIVE    ← status=LIVE
CREATED   ← status=OFFLINE
```

**Transition table** (`VIDEO_ROOM_TRANSITIONS`), enforced by
`assertStatusTransition(from, to)` → throws `VIDEO_ROOM_INVALID_STATE` (409):

| From | To | Command |
|---|---|---|
| OFFLINE | LIVE | activate |
| OFFLINE | ENDED | close |
| LIVE | ENDED | close |
| ENDED | OFFLINE | reopen |

Soft-delete (`deletedAt`) and lock (`isLocked`) are **orthogonal** to `status` —
they are not status transitions; delete is allowed from any non-deleted state,
lock/unlock from any non-terminal state. PAUSED/ARCHIVED are recognized in the
projection + transition helper but have **no Phase-2 endpoint** (PAUSED needs
media; ARCHIVED is a retention concern) — flagged, not stubbed.

## 4. Access policy (extended visibility, stored not enforced)

`VideoRoomAccessPolicy` code enum: `PUBLIC | PRIVATE | PASSWORD | INVITE_ONLY |
FOLLOWERS_ONLY | FRIENDS_ONLY | VIP_ONLY`. Derived/stored as:
- Base `visibility` column stays `PUBLIC | PRIVATE`.
- `PASSWORD` ⇒ `isLocked=true` + `passwordHash` set.
- The richer intent (`INVITE_ONLY`/`FOLLOWERS_ONLY`/`FRIENDS_ONLY`/`VIP_ONLY`) is
  persisted in `VideoRoom.metadata.accessPolicy`. **Enforcement is deferred** to
  the join phase (no join in VR-2). VR-2 stores + echoes it back in the view.

## 5. API surface (base `video-rooms`, keep VR-0 plural path)

| Method | Route | Guard | Service |
|---|---|---|---|
| POST | `/video-rooms` | `@NotGuest` | lifecycle.create |
| GET | `/video-rooms` | auth | query.list |
| GET | `/video-rooms/search` | auth | query.search |
| GET | `/video-rooms/trending` | auth | query.trending |
| GET | `/video-rooms/popular` | auth | query.popular |
| GET | `/video-rooms/featured` | auth | query.featured |
| GET | `/video-rooms/mine` | auth | query.mine |
| GET | `/video-rooms/:id` | auth, uuid | query.getDetail |
| GET | `/video-rooms/:id/status` | auth, uuid | query.verifyStatus |
| PATCH | `/video-rooms/:id` | `@NotGuest`, uuid | lifecycle.update |
| DELETE | `/video-rooms/:id` | `@NotGuest`, uuid | lifecycle.remove (soft) |
| POST | `/video-rooms/:id/activate` | `@NotGuest`, uuid | lifecycle.activate |
| POST | `/video-rooms/:id/close` | `@NotGuest`, uuid | lifecycle.close |
| POST | `/video-rooms/:id/reopen` | `@NotGuest`, uuid | lifecycle.reopen |
| POST | `/video-rooms/:id/lock` | `@NotGuest`, uuid | lifecycle.lock |
| POST | `/video-rooms/:id/unlock` | `@NotGuest`, uuid | lifecycle.unlock |
| POST | `/video-rooms/:id/restore` | `@NotGuest`, uuid | lifecycle.restore |

Static/reference routes (`search`/`trending`/`popular`/`featured`/`mine`) declared
BEFORE `:id` to avoid param capture (Audio convention). `actor(user)` helper →
`RoomActor { id, roles }` passed to every command. All auth is global
(`JwtAuthGuard`); writes add `@NotGuest`.

## 6. Create flow (mirrors Audio `createRoomTx`)

`VideoRoomLifecycleService.create(actor, dto)`, wrapped in
`locks.withLock(videoRoomCreateLockKey(actor.id))`:
1. Enforce room cap: `repo.countActiveByOwner(actor.id) >= maxRoomsPerOwner` →
   `VIDEO_ROOM_ALREADY_EXISTS` (409).
2. Validate category/language if provided (reference existence).
3. Lock/password consistency: `isLocked` (or `PASSWORD` policy) without password →
   `VIDEO_ROOM_CONFIG_INVALID` (400). Hash via bcrypt (`VIDEO_ROOM_PASSWORD_SALT_ROUNDS`).
4. Clamp `maxParticipants`/`maxViewers` to config caps.
5. `repo.createRoomTx(...)` — one `$transaction`: `videoRoom` (+ audit) →
   `videoRoomSettings` (defaults) → `videoRoomStatistics` (defaults) →
   `videoRoomMember` (owner, role OWNER) → `videoRoomRole` (OWNER grant) →
   `videoRoomLog` CREATED.
   **Deviation (as-built):** seat *rows* are NOT materialised in create — that is
   seat management (out of VR-2 scope). The intended layout is recorded in
   `VideoRoomSettings.hostSeatCount/guestSeatCount`; the owner's authority derives
   from `ownerId` + the OWNER grant, not from occupying seat 0. Seat rows land with
   the seat phase.
6. Cache snapshot (`repo.setCachedSnapshot`), seed trending zset
   (`repo.trendingBump`), publish `RoomCreatedEvent`, increment `roomsCreated`
   metric. Return detail view.

Room `id` is DB `@default(uuid())`; `zegoRoomId` stays null (lazily minted on
first media use — VR-2 has no media).

## 7. Mutation flows

- **update**: `permission.assertCanManage(actor, room)` → validate category/language
  → build partial + `changed[]` → `repo.updateRoom` → append UPDATED log (+
  THEME_CHANGED/SETTINGS_CHANGED as applicable) → refresh cache → publish
  `RoomUpdatedEvent({changed})`. `metadata.accessPolicy` updatable here.
- **lock/unlock**: assert `LOCK_ROOM` → set `isLocked` (+ `passwordHash` on lock;
  cleared on unlock) → LOCKED/UNLOCKED log → publish `RoomLockedEvent` → refresh cache.
- **activate**: assert manage → `assertStatusTransition(status, LIVE)` →
  `repo.setStatus(LIVE)` → seat owner (no-op reuse) → set live metric + trending →
  publish `RoomUpdatedEvent({changed:['status']})`.
- **close**: assert `CLOSE_ROOM` → `assertStatusTransition(status, ENDED)` →
  `repo.close` (status ENDED + endedAt) → clear Redis runtime (state/presence/
  trending) → ENDED log → publish `RoomClosedEvent`.
- **reopen**: assert manage → `assertStatusTransition(ENDED, OFFLINE)` →
  `repo.setStatus(OFFLINE, endedAt=null)` → UPDATED log → publish `RoomUpdatedEvent`.
- **remove (soft delete)**: assert `CLOSE_ROOM` (owner/admin) → `repo.softDelete`
  (`auditSoftDelete`) → clear Redis runtime + snapshot + trending → DELETED log →
  publish `RoomDeletedEvent`. History retained (rows kept, `deletedAt` set).
- **restore**: assert manage (owner or platform admin; queries a deleted row) →
  `repo.restore` (clear `deletedAt`, status → OFFLINE) → recover cache snapshot →
  RESTORED/UPDATED log → publish `RoomRestoredEvent`.

## 8. Permissions (RBAC, no hardcoded checks)

`VideoRoomPermissionService`:
- `resolveEffectiveRole(roomId, userId)`: platform admin bypass handled by caller;
  else grant (`VideoRoomRolesRepository.find`) → owner (room.ownerId) → active
  member role → VIEWER/null.
- `assertPermission(actor, room, VideoRoomPermission)`: platform ADMIN/SUPER_ADMIN
  bypass; else `videoRoomRoleHasPermission(effectiveRole, perm)` else
  `VIDEO_ROOM_UNAVAILABLE`/403 (reuse existing code; add `VIDEO_ROOM_FORBIDDEN`).
- `assertCanManage(actor, room)`: convenience = owner OR platform admin OR effective
  ADMIN — the lifecycle gate (mirrors Audio `getManageableRoom`).
Uses the existing `VIDEO_ROOM_PERMISSION_MATRIX` — single source of truth.

## 9. Events / Redis / audit / metrics

- **Events** (add to `events/video-room.events.ts` + `VideoRoomEventService` +
  socket-listener subscriptions; client names already in `VIDEO_ROOM_SOCKET_EVENTS`):
  `RoomUpdatedEvent`, `RoomDeletedEvent`, `RoomLockedEvent`, `RoomRestoredEvent`
  (Created/Closed already exist). Published via `EVENT_BUS`; listener relays to
  `/video-room` namespace — no socket code in services.
- **Redis**: snapshot cache (`videoRoomCacheKey`, `cacheTtlSeconds`); trending zset
  `video-room:trending` (global, bump on create/activate, remove on close/delete);
  state via existing `VideoRoomStateService`; new `videoRoomCreateLockKey(ownerId)`
  + `VIDEO_ROOM_TRENDING_KEY` constants.
- **Audit**: `VideoRoomLog` append-only (existing `appendLog`) on every lifecycle
  action + `createdBy/updatedBy/deletedAt` audit columns via `audit.util`.
- **Metrics**: extend `VideoRoomsMetrics` with counters `video_rooms_created_total`,
  `video_rooms_deleted_total`, `video_rooms_locked_total` (brief's monitoring list);
  reuse existing `setLiveRooms` gauge. API latency/errors already emitted by infra.

## 10. Exceptions (reuse the house pattern)

Reuse `BusinessException(ERROR_CODES.*, msg, HttpStatus.*)`. Add codes:
`VIDEO_ROOM_FORBIDDEN` (403), `VIDEO_ROOM_DELETED` (409),
`VIDEO_ROOM_ALREADY_LOCKED` (409, optional/idempotent). Map brief's requested
exceptions: DuplicateRoom→`VIDEO_ROOM_ALREADY_EXISTS`, NotFound→`VIDEO_ROOM_NOT_FOUND`,
AlreadyLocked→idempotent (no error) or `VIDEO_ROOM_ALREADY_LOCKED`,
InvalidStatus→`VIDEO_ROOM_INVALID_STATE`, Deleted→`VIDEO_ROOM_DELETED`,
Permission→`VIDEO_ROOM_FORBIDDEN`. No per-module exception classes.

## 11. Repository additions (`VideoRoomsRepository`, no new tables)

`createRoomTx(data)`, `updateRoom(id, data, actorId)`, `setLock(id, isLocked,
passwordHash, actorId)`, `setStatus(id, status, actorId, {endedAt})`,
`softDelete(id, actorId)`, `restore(id, actorId)`, `countActiveByOwner(ownerId)`,
`findDeletedById(id)`, `findDetail(id)` (room + settings + statistics), plus
trending zset helpers (`trendingBump`, `trendingRemove`, `trendingTopIds`) and
discovery query methods (`popular` order-by-statistics, `featured`, `nearby`).
Seat layout delegated to `VideoRoomSeatsRepository.createLayout`; owner grant to
`VideoRoomRolesRepository` (or inline in the tx). `VideoRoomStatistics` sort needs
a join/second query (no relation) — `popular` reads statistics then room rows.

## 12. Testing (TDD, co-located `*.spec.ts`)

- `video-room-state-transition.spec.ts` — transition table + projection.
- `video-room-permission.service.spec.ts` — matrix + effective-role + admin bypass.
- `video-rooms.repository.spec.ts` (extend) — createRoomTx nested writes, update,
  lock, softDelete, restore, countActiveByOwner, trending.
- `video-room-lifecycle.service.spec.ts` — create (cap, dup, password), update,
  lock/unlock, activate/close/reopen (valid + invalid transitions), delete/restore,
  event + log + cache assertions.
- `video-room-query.service.spec.ts` — detail (cache-first), list, search facets,
  discovery buckets, verifyStatus projection.
- `video-rooms.controller.spec.ts` — routing, guards, DTO validation, permission
  propagation, status codes.
- Keep all existing tests green (purely additive).

## 13. Implementation order

1. Config env (`VIDEO_ROOM_MAX_ROOMS_PER_OWNER`) + error codes + constants
   (trending key, create-lock key) + state-transition helper + access-policy enum.
2. Repository write methods + tests.
3. Events (+ event service + socket listener) .
4. Permission service + tests.
5. Query service (+ detail view/mapper) + tests.
6. Lifecycle service + tests.
7. Controller + DTOs (list-sort, activate/lock bodies) + tests.
8. Module wiring + metrics extension + README + `.env.example`.
9. Verify: `tsc` + lint + boundaries + full suite green.

## 14. Acceptance criteria

- `pnpm build` (strict) 0 errors; `pnpm lint` 0 warnings; `pnpm boundaries` clean
  (video-rooms depends only on common/infra/its own tree).
- Full lifecycle works end-to-end via the 17 endpoints; each Swagger-documented.
- Redis snapshot + trending in sync; events published; audit logs written;
  RBAC enforced; invalid transitions throw.
- All new specs pass; the existing 806+ suite stays green. No new tables, no
  migration, no stubs (PAUSED/ARCHIVED explicitly flagged as recognized-not-exposed).
