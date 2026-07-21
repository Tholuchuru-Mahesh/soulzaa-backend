# Video Room — Phase 7: Enterprise Role & Permission Engine (VR-7)

Status: **Approved** (brainstorming, 2026-07-21)
Depends on: VR-1 (domain schema: `video_room_roles`), VR-2 (`VideoRoomPermissionService`),
VR-3 (membership), VR-4 (seat engine), VR-5 (media engine), VR-6 (viewer mode)

## 1. Objective

Complete the Video Room authorization story. The decision engine already exists and is
already the only place permissions are checked — VR-7 does **not** rebuild it. It closes
the seven gaps that six phases of building *on top of* the engine left behind:

> **The engine is sound; the management surface around it was never built, and one of its
> inputs silently never expires.**

Everything the brief asks for (dynamic roles, hierarchy, temporary permissions, Redis
cache, REST + socket authorization, events, audit, monitoring) is delivered by **extending
the existing matrix + grants model**, with **zero new tables, zero new migrations, and one
small generic addition to shared infra.**

## 2. Locked design decisions (brainstorming, 2026-07-21)

1. **Permission model = code matrix + grants table — extended, not replaced.** The brief's
   six-table engine (`Role`/`Permission`/`RolePermission`/`UserRole`/`TemporaryPermission`/
   `PermissionOverride`) is **rejected**. It contradicts the explicit VR-1 decision, forks
   Video Rooms away from Audio Rooms permanently, turns every check into a join, and serves
   no requirement in the PRD — which defines a fixed Owner/Admin/Speaker/Audience role set.
   The brief's own instruction to "reuse existing authorization components and extend the
   current architecture" outranks its generic table checklist. **Tables added: 0.**
2. **ADMIN tightens to the PRD.** `production.txt:3364-3372` states admins CANNOT edit the
   room profile, change the password, add/remove admins, or change the category. The
   current matrix violates all four. VR-7 corrects it, and — critically — **deletes the
   coarse `assertCanManage` gate** in favour of a `MANAGE_ROOM` permission, because a
   coarse gate sitting beside a fine matrix always wins where they overlap.
3. **Ownership = log-backed history + auto-succession.** Mirror the Audio Room transfer
   (lock → active-member check → previous owner demoted to ADMIN → `ownerId` updated),
   with history in the existing append-only `video_room_logs` (`OWNERSHIP_TRANSFERRED` is
   already in the enum, unused). "Owner recovery" = auto-promote the highest-ranking active
   member when the owner is removed or the room is orphaned. **No reclaim window** — it
   would let ownership change without the sitting owner's consent.
4. **Cache = per-room monotonic version, O(1) invalidation.** A cached decision embeds the
   version it was resolved under; a role change `INCR`s the version and instantly orphans
   every entry for that room regardless of size. Revocation latency is **0 ms**. Matches the
   versioned-stage idiom already used by VR-2/4/5. Rejected: per-user keys + a tracked
   member set (room-wide invalidation degrades to O(cached members) exactly in the hot rooms
   that matter), and TTL-only (a revoked admin keeps acting for the length of the TTL).
5. **Socket stays outbound-only.** Every VR phase is REST-in → `EVENT_BUS` →
   `VideoRoomSocketListener` broadcast-out; the `/video-room` namespace has zero
   `@SubscribeMessage` handlers. The brief's `assignRole`/`transferOwnership` socket
   *commands* become REST routes; its *notifications* become broadcasts.
6. **Recording, warn, and view-reports permissions are dropped.** Their features are
   explicitly out of scope for this phase ("Do NOT implement: Recording / Moderation
   Business Logic"). A permission with no enforcement point is dead code.
7. **`HOST` is removed from grantable roles.** It collides with `resolveEffectiveRole`
   deriving HOST from seat occupancy; a grantable HOST could hold the role with no seat,
   silently diverging from the seat stage that VR-4/5 treat as authoritative.
8. **`GRANT_ROLES` is owner-only**, so admins cannot appoint moderators either. Strict PRD
   reading ("only the Room Owner can appoint Admins"); a one-line matrix change if the
   product later wants admins to appoint moderators.

## 3. The gaps VR-7 closes

| # | Gap | Evidence |
|---|---|---|
| 1 | **No role assignment surface.** `VideoRoomRolesRepository.grant()`/`.revoke()` have **zero callers** — dead code since VR-1. No endpoints, no service. | grep: only module registration + `find()` reference the repo |
| 2 | **No ownership transfer.** Audio Rooms has it; Video Rooms has only the enum value and a comment. | `TRANSFER_OWNERSHIP` appears in 2 files, both comments |
| 3 | **Expired grants never expire.** `find()` is a bare `findUnique` on the compound key with **no time predicate** — a temporary ADMIN grant works forever. Live security bug. | `video-room-roles.repository.ts:48-52` |
| 4 | **No permission cache.** Every check = 2 Postgres round-trips; `assertOutranks` = 4. Re-resolved per member on room broadcasts. | permission service constructor |
| 5 | **Role audit never written.** `VideoRoomLogAction.ROLE_CHANGED` and `ModerationActionType.ROLE_GRANTED`/`ROLE_REVOKED` exist with zero writers. | schema vs. grep |
| 6 | **Admin matrix contradicts the PRD** (see decision 2). | `production.txt:3364-3372` |
| 7 | **No 25-admin cap.** PRD mandates it; nothing enforces it. | grep found no cap |

## 4. Reuse map (what already exists — do NOT recreate)

| Concern | Existing symbol (reused verbatim unless noted) |
|---|---|
| Authorization decision point | `VideoRoomPermissionService` — already consumed by 6 services / ~20 call sites |
| Effective-role resolution | `resolveEffectiveRole` (owner → grant → seat-derived → null) |
| Hierarchy guard | `authorityRank` + `assertOutranks` |
| Platform-admin bypass | `isPlatformAdmin` (PlatformRole ADMIN / SUPER_ADMIN) |
| Grants persistence | `VideoRoomRolesRepository` + `video_room_roles` table (incl. unused `expiresAt`) |
| Assign-role request contract | `GrantVideoRoomRoleDto` — written in VR-1 for this phase, still unconsumed |
| Audit trail | `video_room_logs` (`ROLE_CHANGED`, `OWNERSHIP_TRANSFERRED`) + `video_room_moderation_actions` (`ROLE_GRANTED`, `ROLE_REVOKED`) |
| Redis primitives | `CacheService.{get,set,del,increment}`, `LockService.withLock` |
| Versioned-state idiom | `VideoRoomStateService` (monotonic `version` under a per-room lock) |
| Realtime fan-out | `EVENT_BUS` → `VideoRoomSocketListener` → `/video-room` namespace |
| Scheduled sweeps | `scheduler/` monitors (session / seat / media) |
| Errors | `BusinessException` + `ERROR_CODES` (no custom exception classes exist anywhere in this codebase) |
| Metrics | `VideoRoomsMetrics` on the shared `MetricsService` registry |
| Ownership transfer reference implementation | `AudioRoomsService.transferOwnership` / `removeOwner` |

## 5. Permission model

### 5.1 Enum — one new value

The brief's ~27 owner permissions map onto the existing 16-value enum. Exactly one is net-new:

| Brief permission | Maps to |
|---|---|
| Manage Room · Update Room · Manage Room Settings · Delete Room | **`MANAGE_ROOM` (new)** |
| Manage/Transfer/Lock/Unlock Seats · Approve/Reject Requests | `MANAGE_SEATS` |
| Remove Participants | `MANAGE_PARTICIPANTS` |
| Mute Participants | `MUTE_USERS` / `ROOM_MUTE` |
| Ban / Unban Users | `BLOCK_USERS` (VR-1: no ban feature; block is the bar) |
| Assign/Remove Admin · Assign/Remove Moderator | `GRANT_ROLES` |
| Change Theme · Change Background | `CHANGE_THEME` |
| Pin Announcement | `MANAGE_ANNOUNCEMENTS` |
| Invite Members | `INVITE_USERS` |
| View Statistics | `VIEW_ANALYTICS` |
| Close Room | `CLOSE_ROOM` |
| Transfer Ownership | `TRANSFER_OWNERSHIP` |
| Start/Stop Recording | **dropped** (out of scope, decision 6) |
| Warn Participant · View Reports · View Members | **dropped** (out of scope, decision 6) |

### 5.2 Matrix

```
OWNER      : all 17 permissions
ADMIN      : MANAGE_SEATS, MANAGE_PARTICIPANTS, INVITE_USERS, KICK_USERS,
             BLOCK_USERS, MUTE_USERS, ROOM_MUTE, PIN_MESSAGES,
             MANAGE_ANNOUNCEMENTS, VIEW_ANALYTICS, START_PK
MODERATOR  : KICK_USERS, BLOCK_USERS, MUTE_USERS, ROOM_MUTE,
             PIN_MESSAGES, MANAGE_ANNOUNCEMENTS
HOST / PARTICIPANT / VIEWER : ∅  (media rights stay seat-derived)
```

Owner-only, by subtraction: `MANAGE_ROOM`, `LOCK_ROOM`, `CHANGE_THEME`, `GRANT_ROLES`,
`TRANSFER_OWNERSHIP`, `CLOSE_ROOM`.

### 5.3 Hierarchy

Ranks are unchanged (`OWNER 5 > ADMIN 4 > MODERATOR 3 > HOST 2 > PARTICIPANT 1 > VIEWER 0`).
Higher roles inherit lower permissions **by construction** — each role's set is a superset
of the one below it, verified by an explicit test rather than a runtime inheritance walk.

### 5.4 Deleting `assertCanManage`

`assertCanManage` is replaced by `assertPermission(actor, room, MANAGE_ROOM)`. All 6 call
sites in `video-room-lifecycle.service.ts` keep their shape; only the answer for ADMIN
changes. This is the change that actually enforces the PRD — tightening the matrix alone
would leave room-profile editing wide open, because `update` never consulted the matrix.

## 6. Role assignment — `VideoRoomRoleService` (new)

Validation chain, in order, before any write:

1. Actor holds `GRANT_ROLES` (owner-only) — else `VIDEO_ROOM_FORBIDDEN`
2. Target is an **active member** of the room — else `VIDEO_ROOM_NOT_MEMBER`
3. Requested role ∈ `{ADMIN, MODERATOR}` — `OWNER` is transferred, never assigned — else `VIDEO_ROOM_ROLE_INVALID`
4. `rank(actor) > rank(requestedRole)` — else `VIDEO_ROOM_INVALID_HIERARCHY`
5. `rank(actor) > rank(target's current effective role)` — else `VIDEO_ROOM_INVALID_HIERARCHY`
6. Actor ≠ target (no self-grant) — else `VIDEO_ROOM_INVALID_HIERARCHY`
7. `ADMIN` grant count `< 25` (PRD cap) — else `VIDEO_ROOM_ROLE_LIMIT_EXCEEDED`
8. Target does not already hold the requested role — else `VIDEO_ROOM_DUPLICATE_ROLE`

Then, in order: upsert grant → write `VideoRoomLog(ROLE_CHANGED)` → write
`ModerationAction(ROLE_GRANTED)` → bump permission version → publish `RoleAssignedEvent`.

`remove` runs 1, 2 (target must hold a grant, else `VIDEO_ROOM_ROLE_NOT_FOUND`), 5, and
refuses to revoke `OWNER` (transfer instead). `update` is assign-with-a-different-role and
shares the same chain — not a separate path.

> **LEARNING-CONTRIBUTION POINT.** Step 5 — "actor must outrank the target's *current*
> role" — is the anti-escalation predicate, and it has more than one defensible shape
> (strict outrank vs. allowing equals to act on each other, whether platform moderators
> bypass it, whether an owner demoting themselves is legal). The signature will be prepared
> with the surrounding context so the policy call is made deliberately, following the
> `VIEWER_CAPABILITIES` precedent in `video-room-viewer-permissions.ts`.

## 7. Ownership — `VideoRoomOwnershipService` (new)

`transfer(actor, roomId, dto)` under `video-room:transfer:{roomId}`:

```
assert TRANSFER_OWNERSHIP (owner-only)
target must be an ACTIVE member          -> VIDEO_ROOM_NOT_MEMBER
target != current owner                  -> VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED
previous owner -> ADMIN grant
room.ownerId = newOwnerId
log OWNERSHIP_TRANSFERRED { previousOwnerId, newOwnerId }
bump permission version
publish OwnershipTransferredEvent
```

`recoverOwner(roomId)` — the brief's "Owner Recovery". Promotes the highest
`authorityRank` active member to owner, demoting the departed owner; if there is no
successor, closes the room. The caller never self-promotes.

Its trigger is **explicit, not inferred**: VR-7 exposes it as
`POST /video-rooms/:id/owner/recover`, restricted to platform staff via the existing
`@Roles(PlatformRole.ADMIN, PlatformRole.SUPER_ADMIN)` decorator, plus a public service
method that later phases (moderation, room reaping) can call. VR-7 deliberately wires **no
automatic trigger** — an owner leaving a room is normal and reversible, so auto-succession
on `leave` would hand rooms away from owners who are simply reconnecting.

**Only one owner exists at any time**, enforced structurally: `VideoRoom.ownerId` is a
single column and `resolveEffectiveRole` checks it before any grant.

## 8. Temporary roles

`video_room_roles.expiresAt` already exists and is already persisted. Three changes:

1. `find()` → **`findActive()`**, filtering `expiresAt IS NULL OR expiresAt > now()`. This
   alone closes gap 3 — lazy expiry is the *correctness* guarantee.
2. `VideoRoomRoleMonitor` (new, in the existing `scheduler/` folder alongside the session /
   seat / media monitors) sweeps expired grants: deletes them, bumps each affected room's
   version, writes `ModerationAction(ROLE_REVOKED)`, publishes `TemporaryRoleExpiredEvent`.
   The sweeper exists for events + audit + cleanup, **not** for correctness.
3. `hasTemporaryRole(room, userId)` reports whether the caller's grant carries an expiry,
   so clients can render "Temporary Admin — expires in 2h".

This delivers Temporary Admin / Temporary Moderator / Expiration Time / Automatic
Revocation / Audit History with zero new tables.

## 9. Redis cache — `VideoRoomPermissionCache` (new)

```
video-room:perm:ver:{roomId}       -> 42                              (INCR)
video-room:perm:{roomId}:{userId}  -> { ver, role, permissions[] }    TTL 300s

read       : MGET [verKey, entryKey] -> hit iff entry.ver === ver
invalidate : INCR verKey                       O(1), any room size
```

**Fail-closed by construction.** A hit requires two independently-stored values to agree,
so any Redis anomaly — eviction, flush, cross-instance skew, a version key that resets —
produces disagreement, and disagreement means a database read. It is not possible for an
anomaly to extend a revoked grant.

Shared-infra addition: `CacheService.mget<T>(keys: string[]): Promise<(T | null)[]>` — one
generic method keeping a check at a single round trip. `increment()` already stores `"42"`,
which `JSON.parse` reads back as a number, so no special-casing is needed.

Invalidation points: role assign / remove / update, temporary-role expiry, ownership
transfer, owner recovery.

**Seat changes deliberately do not invalidate.** Seats churn constantly in an active room,
so bumping the version on every seat transition would thrash the cache for the whole room.
The staleness this admits is bounded and harmless: seat-derived roles (`HOST` 2 /
`PARTICIPANT` 1) carry an **empty permission set**, so a stale entry can never grant a
management permission. The only observable effect is on `authorityRank`, where a stale
entry can misreport a rank in the 0–2 band — always below `MODERATOR` (3), so it can
neither confer management authority nor shield a user from a moderator's action. Bounded by
the 300 s entry TTL.

## 10. Authorization engine surface

Kept verbatim (20 call sites untouched): `resolveEffectiveRole`, `hasPermission`,
`assertPermission`, `authorityRank`, `assertOutranks`.

Added: `hasRole`, `hasAnyPermission`, `hasAllPermissions`, `hasTemporaryRole`,
`resolveCapabilities`.

Removed: `assertCanManage` (→ `MANAGE_ROOM`).

The brief's `validatePermission()` and `authorize()` **are** the existing
`assertPermission` — no aliases are added for them.

## 11. Contracts

### REST — on the actual `/video-rooms/:id` convention (not the brief's `/video-room/:roomId`)

| Route | Permission | Returns |
|---|---|---|
| `GET /video-rooms/:id/roles` | active member | grants + effective roles |
| `GET /video-rooms/:id/permissions` | public to members | permission catalogue + matrix |
| `POST /video-rooms/:id/roles/assign` | `GRANT_ROLES` | updated grant |
| `POST /video-rooms/:id/roles/remove` | `GRANT_ROLES` | 200 |
| `PATCH /video-rooms/:id/roles/update` | `GRANT_ROLES` | updated grant |
| `POST /video-rooms/:id/owner/transfer` | `TRANSFER_OWNERSHIP` | updated room |
| `POST /video-rooms/:id/owner/recover` | platform ADMIN / SUPER_ADMIN | updated room, or 200 if closed |
| `GET /video-rooms/:id/me/permissions` | authenticated | effective role + capability set |

Global `JwtAuthGuard`; state-changing routes carry `@NotGuest()`; `ParseUuidPipe` on ids;
full Swagger (`@ApiOperation`, `@ApiResponse` per status, examples). Controllers contain
**no** authorization logic — they delegate to the services, per the existing VR convention.

### Socket — outbound only

```
video_room.role_assigned         -> room
video_room.role_removed          -> room
video_room.role_updated          -> room
video_room.ownership_transferred -> room
video_room.permission_updated    -> affected user only
```

### Events

`RoleAssignedEvent`, `RoleRemovedEvent`, `RoleUpdatedEvent`, `TemporaryRoleGrantedEvent`,
`TemporaryRoleExpiredEvent`, `OwnershipTransferredEvent`.

The brief's separate `PermissionGranted`/`PermissionRevoked` have **no referent** in a
role-only model — granting a role *is* granting its permissions. Clients receive
`permission_updated` instead of a phantom event pair.

### Errors — `BusinessException` + `ERROR_CODES` (platform convention)

| Brief exception | Realisation |
|---|---|
| `RoleNotFoundException` | `VIDEO_ROOM_ROLE_NOT_FOUND` (404) |
| `PermissionDeniedException` | `VIDEO_ROOM_FORBIDDEN` (403) — **existing** |
| `PermissionNotFoundException` | `VIDEO_ROOM_ROLE_INVALID` (400) |
| `OwnershipTransferException` | `VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED` (409) |
| `DuplicateRoleException` | `VIDEO_ROOM_DUPLICATE_ROLE` (409) |
| `InvalidRoleHierarchyException` | `VIDEO_ROOM_INVALID_HIERARCHY` (403) |
| `TemporaryPermissionException` | `VIDEO_ROOM_ROLE_INVALID` (400) |
| (PRD admin cap) | `VIDEO_ROOM_ROLE_LIMIT_EXCEEDED` (409) |

Six new codes; `VIDEO_ROOM_FORBIDDEN` is reused.

### DTOs

`GrantVideoRoomRoleDto` (existing, narrowed to ADMIN/MODERATOR), `RemoveVideoRoomRoleDto`,
`UpdateVideoRoomRoleDto`, `TransferVideoRoomOwnershipDto`, `VideoRoomRoleResponseDto`,
`VideoRoomPermissionResponseDto`, `MyVideoRoomPermissionsResponseDto`.

## 12. Monitoring

Added to `VideoRoomsMetrics`:

```
video_rooms_role_assignments_total{role,action}
video_rooms_permission_checks_total{result}
video_rooms_permission_denials_total{permission}
video_rooms_ownership_transfers_total
video_rooms_temporary_roles_total{action}
video_rooms_authorization_duration_seconds        (histogram)
video_rooms_permission_cache_hits_total
video_rooms_permission_cache_misses_total
```

## 13. Testing

- **Matrix tests** — every role's set, plus an explicit inheritance assertion (each role's
  set ⊇ the role below it), plus a PRD-conformance test naming the four things admins must
  not do.
- **Repository tests** — `findActive` honours `expiresAt` at, before, and after the boundary;
  `countByRole`; `listExpired`.
- **Permission service tests** — resolution precedence, platform bypass, cache hit / miss /
  version-mismatch, all five new predicates.
- **Cache tests** — version bump orphans entries; missing version key fails closed to a miss.
- **Role service tests** — each of the 8 validation steps rejects, plus the happy path,
  plus the 25-admin boundary (24 → allowed, 25 → rejected).
- **Ownership tests** — transfer, previous-owner demotion, non-member target, self-transfer,
  auto-succession with and without a successor.
- **Monitor tests** — expired grants swept, events published, versions bumped.
- **Controller tests** — every route's auth delegation, DTO validation, status codes.
- **Regression** — the ~12 existing specs referencing `VideoRoomMemberRole.ADMIN` are
  updated to the tightened matrix.

## 14. Out of scope

Chat, gifts, treasure boxes, wallet, PK battles, rankings, moderation business logic,
notifications, analytics processing, recording. Per-permission override rows, custom
runtime-defined roles, and reclaimable ownership are explicitly rejected (decisions 1, 3).

## 15. Definition of done

- Zero new tables, zero migrations.
- `tsc` clean, `eslint` clean, module boundaries clean.
- Full video-room suite green with no regressions in the wider project suite.
- No git commits or pushes — the working tree is handed over as-is.
