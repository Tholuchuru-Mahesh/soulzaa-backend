# Moderator Region Scope Enforcement

**Date:** 2026-08-16
**Repos touched:** `soulzaa-backend`, `soulzaa-superadmins`

## Problem

The Moderator provisioning work (this session, earlier) added a region picker that
conflated two things that must stay separate:

- **Profile geography** (`User.countryId/stateId/regionId`) — a self/admin-reported
  location, not an authorization boundary.
- **Operational moderation scope** (`RoleScope` rows on the Moderator's `UserRole`) —
  the actual set of regions a Moderator is authorized to act in.

A Moderator's profile region and their assigned work region(s) can legitimately
differ (example: profile = Bengaluru, operational scope = Bengaluru + Vijayawada).
Provisioning must only ever write `RoleScope`; it must never touch the profile FKs.

Separately, an audit (this session) of the existing scope-enforcement primitive found
it live in most — but not all — of the places the Moderator specification
(`moderatorrole.txt`) requires it: *"Moderators can operate only within assigned
regions... Only assigned regional reports, rooms, live streams, and users are
visible."* This spec closes those gaps and adds the region-reassignment flow the
provisioning UI needs (add/remove one or more regions after creation, not just at
creation time).

## Current state (verified in code, not assumed)

### The real enforcement primitive

`GeographicScopeResolver.isWithinScope()` (`src/modules/authorization/services/geographic-scope-resolver.service.ts:81`)
is unused — zero callers anywhere in `src/`. The primitive actually wired into
production is `WorkforceScopeService.assertModeratorInScope(moderatorId, regionId)`
(`src/modules/mobile-workforce/services/workforce-scope.service.ts:135`):

```ts
async assertModeratorInScope(moderatorId: string, regionId: string | null): Promise<void> {
  if (!regionId) return;                              // no region on target ⇒ permit
  if (await this.isUnrestricted(moderatorId)) return;  // ADMIN/SUPER_ADMIN/GLOBAL scope ⇒ permit
  const filter = await this.userScopeFilter(moderatorId);
  if (!('OR' in filter)) return;
  const isMatched = filter.OR.some((clause) => clause.regionId === regionId);
  if (!isMatched) throw new ForbiddenException('You are not authorized to perform moderation in this region.');
}
```

It reads `RoleScope` (via `GeographicScopeResolver.getUserScopes`), not
`User.regionId` — already the correct source of truth. This spec builds on it rather
than reviving `isWithinScope`. `isUnrestricted()` short-circuits for ADMIN/SUPER_ADMIN
by role name, or anyone holding a `GLOBAL`-type `RoleScope` row, so calling it from a
shared code path used by multiple actor types (see Investigation Recording below)
cannot incorrectly restrict Admins or system-triggered actions.

### Where it's already enforced

Audio rooms, video rooms, and live streams all call `assertModeratorInScope` from a
shared prereq helper before **kick / ban / mute / warn / escalate**:

```ts
// src/modules/audio-rooms/services/moderation.service.ts:1143-1163 (assertModerationPrereqs)
// src/modules/video-rooms/services/video-room-moderation.service.ts:1135-1157 (assertPrereqs)
// src/modules/live-streaming/services/live-stream.service.ts:136-144 (moderateUser)
if (this.scopeService) {
  const room = await this.rooms.findRoomRow(roomId);   // or .findById / getStream
  if (room?.region) {                                   // or room?.regionId for LiveStream
    await this.scopeService.assertModeratorInScope(actor.id, room.region);
  }
}
```

`scopeService` is `@Optional()`-injected in all three but resolves in production
because `AudioRoomsModule` / `VideoRoomsModule` / `LiveStreamingModule` all import
`MobileWorkforceModule`, which exports `WorkforceScopeService`.

**Region field shape differs per domain** — not a bug, just something enforcement
code must adapt to: `AudioRoom.region` and `VideoRoom.region` are plain
`String?` (a snapshot, no FK); `LiveStream.regionId` is `String? @db.Uuid` (FK-shaped).
Both feed the same `assertModeratorInScope(actorId, regionId)` call — the Region's
`id` is what `RoleScope.regionId` stores, so `AudioRoom.region`/`VideoRoom.region`
must actually hold a Region **id** string despite the generic field name (confirmed by
the existing doc comments: *"snapshots the owner's assigned Region"*).

### Gaps (write actions with no region check today)

1. **Restorative actions bypass it entirely**: `unkick`, `unban`, `unmute` (audio,
   `moderation.service.ts`), `unblacklist`, `unmute` (video,
   `video-room-moderation.service.ts`) — permission-only, by an explicit "restorative,
   no check" code comment that evidently didn't intend to drop the region check too.

2. **Report/appeal lifecycle has almost no region in scope, let alone a check.** None
   of the three report tables carries a region column — it's always a join through
   the parent room/stream. Per method, what's currently loaded:

   | Surface | Method | Room/stream row loaded today? |
   |---|---|---|
   | Audio (`moderation.service.ts`) | `assignReport` (614), `addReportNotes` (713), `dismissReport` (731), `resolveAppeal` (872) | No |
   | Audio | `reviewReport` (642) | Only inside the `BAN` sub-branch (696) |
   | Video (`video-room-report.service.ts`) | `assignReport` (312), `addReportNotes` (256), `dismissReport` (275) | Room *is* fetched via `requireRoom()`, but `region` is dropped when building `PermissionRoomRef {id, ownerId}` |
   | Video | `reviewReport` (163) | Only inside the `BAN` sub-branch (228), via a second fetch |
   | Live (`live-stream-report.service.ts`) | `addNotes` (167) | No |
   | Live | `reviewReport` (94) | Only inside the `BAN` sub-branch (120) |

   (Video rooms has no appeal mechanism; live streaming has no `assignReport`/`dismissReport`.)

3. **`ModerationApprovalService.decide()` (the Official's ban approval) has no region
   check** — an Official can approve/reject a proposed ban for any region.

4. **Investigation Recording has no independent enforcement.**
   `InvestigationRecordingModule` doesn't import `MobileWorkforceModule` at all. In
   practice this is currently harmless — all 9 real call sites of `beginRecording`
   (audio kick/ban/mute/warn, video kick/blacklist/mute/warn, live `moderateUser`) sit
   behind an already-scope-checked entry point, including the async
   approval-listener re-entry paths, which call back into the same scoped methods.
   But there's no defense-in-depth if a future caller reaches it directly.

5. **Dashboard report counts are scoped by the wrong thing.**
   `MobileWorkforceService.regionalDailyActivity()` (L336-403) filters
   `roomReport.count` by `reporterId: {in: inScopeUserIds}` — the *reporter's* own
   profile-location scope — not by the region of the room/stream the report is about.
   A Bengaluru-scoped Moderator could see a report on a Chennai room (if a
   Bengaluru-located user happened to file it) and miss a report on a Bengaluru room
   (filed by someone elsewhere). Per the Moderator spec, the target resource's region
   must be authoritative here. Also: this method only counts `roomReport` — 
   `videoRoomReport`/`liveStreamReport` aren't included in the "assigned reports"
   figure at all today.

6. **Socket.IO: no gap, because there's nothing to gate.** Confirmed by inventory —
   every `@WebSocketGateway`/`@SubscribeMessage` in the repo (`base.gateway.ts`,
   `video-room-chat.gateway.ts`, `casino.gateway.ts`) handles presence, chat relay,
   typing indicators, or game moves. No inbound socket event performs mute/kick/ban
   anywhere. Sockets only rebroadcast results that were already decided over REST
   (`moderation-socket.listener.ts` et al.). Closing the REST gaps above is
   sufficient; no socket-side work is needed.

7. **Dashboard region *filtering* itself is correct today** —
   `MobileWorkforceService.moderatorDashboard()` → `myScope()` →
   `GeographicScopeResolver.getUserScopes()` / `WorkforceScopeService.userScopeFilter()`
   already read `RoleScope`, not `User.regionId`. Only the report-count query (point 5)
   needs fixing.

### No reusable "assign multiple regions" primitive exists

`RoleService.assignRoleScope`/`removeRoleScope` (`role.service.ts:209-245`) are
single-row CRUD. `WorkforceAssignmentService.transferWorkforce` is the closest
existing pattern but is delete-all-then-create-one, not a diff, and only supports a
single target scope. Nothing in the codebase reconciles a `RoleScope[]` against a
target `regionId[]` — this is new.

### Test infrastructure

`prisma/seed-e2e-fixtures.ts` already seeds a real `MODERATOR` user with a real
`RoleScope` row (region `BLR`), but nothing wires it into a runnable suite:
`test/jest-e2e.json` only discovers `test/app.e2e-spec.ts` (a health-check smoke
test), there's no `seed:e2e` npm script, and
`src/modules/mobile-workforce/geographic-scope.e2e-spec.ts` — despite its name — is a
mocked unit spec that isn't collected by either `npm test` or `npm run test:e2e`.
A dedicated `soulzaa_e2e` Postgres (port 5433) + Redis are configured
(`.env.e2e`) and confirmed running locally right now. This spec builds a real,
runnable e2e suite on that existing (but currently disconnected) foundation.

## Goals

1. `RoleScope` is the sole authorization boundary for Moderator operational access;
   `User.regionId`/profile geography is never read for that purpose and is never
   written by Moderator region assignment.
2. A Moderator can be assigned one or more operational regions, addable/removable
   after creation, without needing to re-provision the account.
3. Every region-sensitive write action a Moderator can reach — including the ones
   found unguarded in the audit — enforces `RoleScope` server-side.
4. Dashboard/report visibility is scoped by the target resource's region, not the
   reporter's.
5. Real, runnable e2e tests prove all of the above against the local `soulzaa_e2e`
   database — not just mocked unit tests.

## Non-goals

- No new database tables. No `moderator_region`/`moderator_allowed_regions`/etc.
  Reuse `Country → State → Region` + `RoleScope` exactly as they exist today.
- No requirement that a Moderator's profile region match their operational region(s).
- No declarative `RegionScopeGuard`. The existing convention is an imperative
  `assertModeratorInScope` call inside each service's own prereq chain — this spec
  extends that convention to the missing call sites rather than replacing it.
- No change to Socket.IO — confirmed nothing to change there (see Gap 6 above).
- No change to the *unrestricted* dashboard/report queue used by Admin/Super Admin
  (`dashboard-moderation` module) — that's a deliberate platform-wide view, out of
  scope here.

## Design

### 1. Region reconciliation — `setModeratorRegions`

New method (on `ModeratorProvisioningService`, since it already owns the Moderator's
`UserRole` lifecycle):

```ts
setModeratorRegions(userId: string, regionIds: string[], actorId: string):
  Promise<{ regionIds: string[] }>
```

Steps: assert actor is Admin/Super Admin → resolve+validate every `regionIds` entry
(exists, region/state/country all active — same checks as today's single-region
path) → find-or-create the Moderator's `UserRole` (`roleService.assignRoleByName`,
already idempotent) → load its current `REGION`-type `RoleScope` rows → diff against
the target set → `roleService.assignRoleScope(...)` for additions,
`roleService.removeRoleScope(scopeId)` for removals → return the resulting region id
list. `assignRoleScope` already invalidates the auth cache per call, so no extra
cache step is needed.

New endpoint: `PUT /admin-identity/moderators/:id/regions`, body `{ regionIds: string[] }`,
gated on `admin.identity.manage` (same permission as provisioning), calling this
method. This is the single path both creation and later editing go through.

### 2. Provisioning changes

`CreateModeratorDto.regionId: string` becomes `regionIds: string[]` (min length 1).
`createModerator()` stops calling `UserLocationService.assignLocation()` — it never
touches `User.countryId/stateId/regionId`. After creating/promoting the user, it
calls `setModeratorRegions(userId, dto.regionIds, actorId)` instead of the old
inline single-`RoleScope` block.

**Revised per review:** the free-text `User.country` field is also no longer derived
from the assigned region(s). Deriving *any* profile field from operational scope is
exactly the coupling this spec is meant to eliminate — `country` has no defined
consumer that requires it to be populated at provisioning time, so the correct fix is
to stop setting it here, not to pick a "safer" derivation. New-user creation omits
`country` entirely from the `createIdentity` call (it's already optional on
`CreateIdentityInput`); the promote-existing-user path stops touching `country` too,
leaving whatever the account already had untouched. If profile geography is ever
wanted for a Moderator, it goes through the existing, separate `UserLocationService`/
`user-location.controller.ts` flow — never through region/shift provisioning.

### 3. Closing the enforcement gaps

All additions reuse `WorkforceScopeService.assertModeratorInScope(actorId, regionValue)`,
injected the same way as the existing call sites (see §3a for the one change to that
injection — required, not `@Optional()`) — no new guard type, same call shape
throughout.

- **Restorative actions** (audio `unkick`/`unban`/`unmute`, video
  `unblacklist`/`unmute`): add the same room-fetch + scope check
  `assertModerationPrereqs`/`assertPrereqs` already does for their forward
  counterparts.
- **Report/appeal lifecycle**: each method in the gap table above gains a room/stream
  fetch (or, for video, the fetch already happens in `requireRoom()` — extend what it
  returns rather than adding a second query) followed by
  `assertModeratorInScope(actor.id, region)`. `reviewReport` on all three surfaces
  gets this unconditionally at the top, not only inside the `BAN` sub-branch, so
  WARN/MUTE/KICK recommendations and outright dismissals are covered too (they
  currently rely on re-entering an already-scoped method, which happens to work for
  WARN/MUTE/KICK but not for a bare dismiss/notes-only review).
- **`ModerationApprovalService.decide()`**: the pending proposal already carries
  enough information to resolve back to its originating room/stream (it was created
  by `propose()` from a scoped context) — `decide()` resolves that region and calls
  `assertModeratorInScope(officialId, region)` before honoring the approval/rejection.
  Exact field to key off is confirmed at implementation time by reading
  `ModerationApprovalService`'s proposal record shape.
- **Investigation Recording**: `InvestigationRecordingModule` adds
  `MobileWorkforceModule` to its `imports`; `InvestigationRecordingService` gets a
  required `private readonly scopeService: WorkforceScopeService` (see §3a — not
  `@Optional()`, since this is a brand-new injection with no legacy test dependency
  on its absence) and calls `assertModeratorInScope` inside `beginRecording()` when a
  region is resolvable for the target room/stream — defense-in-depth, not a new
  primary boundary (per your requirement A). Since every real caller already passed a
  scope check to get there, this cannot introduce a new rejection path for any
  legitimate caller; it only protects against a future direct caller that skips the
  existing gate.

### 3a. Two failure-mode safeguards (added per review)

**Null target region — verified, not blindly changed.** Read
`WorkforceScopeService` in full to trace this precisely rather than assume. Two
distinct "missing" cases exist, and only one is a permit-by-default:

- *Actor has zero `RoleScope` rows* (a Moderator never assigned any region) — already
  fails closed today. `assertModeratorInScope` checks `isUnrestricted(moderatorId)`
  (line 137) **before** calling `userScopeFilter`; a non-unrestricted actor always
  gets `userScopeFilter`'s `{ OR: clauses }` branch (line 101), never the bare `{}`
  unrestricted-shortcut (line 74) — so a scopeless Moderator gets `{ OR: [] }`, which
  matches nothing and correctly throws. The `if (!('OR' in filter)) return;` guard
  inside `assertModeratorInScope` (line 141) is dead code in practice for this
  method (the case it guards against can't be reached once `isUnrestricted` already
  filtered it out one line above) — worth a comment noting that, not a functional
  fix.
- *Target resource has no region snapshot* (`room.region`/`stream.regionId` is
  `null`) — `if (!regionId) return` (line 136) permits unconditionally. This is a
  pre-existing, intentional safety valve (documented in the `AudioRoom`/`VideoRoom`
  schema comments) for rooms that predate region-tagging, and every currently-working
  kick/ban/mute/warn path already relies on it. **Not changed by this spec** — doing
  so would be an unrelated, riskier behavior change to already-shipped functionality,
  and the review comment explicitly asks not to blindly touch the shared method.

  What *is* new: every added call site (restorative actions, report/appeal methods,
  investigation recording, approval `decide()`) resolves region from the *same*
  parent room/stream that the resource's own primary moderation actions already use
  — so the safety valve applies consistently per-resource (a room with no region
  snapshot behaves the same for `kick` and `unkick` alike), not as a new bypass
  specific to any of the newly-added actions.

  The actual risk worth guarding against is a *lookup bug* masquerading as a
  legitimate null region — e.g. code that resolves `room?.region` in a way that
  silently defaults to `null` when the room lookup itself failed, rather than the
  room genuinely having no region. Each new call site must fetch its parent
  room/stream with an existence check that throws `NotFoundException` when the
  parent can't be resolved, *before* reaching the scope check — never treat "lookup
  failed" and "lookup succeeded with a null region" as the same thing. This becomes
  an explicit test requirement (see Testing strategy).

**`@Optional()` scope service — tightened to fail closed on missing wiring.** The
real fail-open risk isn't inside `assertModeratorInScope` (which already
distinguishes unrestricted actors from scope-restricted ones correctly) — it's the
`if (this.scopeService) { ... }` wrapper around every call site. If
`WorkforceScopeService` is ever not resolvable (a future refactor drops the
`MobileWorkforceModule` import), that condition is false and the entire check —
including the part that would have caught an actual Moderator — silently no-ops.
Fix: `WorkforceScopeService` becomes a **required** (non-`@Optional()`) constructor
dependency in every module that gates a Moderator-reachable action —
`AudioRoomsModule`, `VideoRoomsModule`, `LiveStreamingModule`,
`InvestigationRecordingModule` (which already needs `MobileWorkforceModule` added
per §3), and confirm `ModerationApprovalService`'s existing injection (it already
calls `resolveEscalationRecipients` unconditionally in `propose()`, so it's likely
already required there — verify at implementation time). Making it required doesn't
change behavior for ADMIN/SUPER_ADMIN/GLOBAL-scope/system callers at all — that
bypass lives inside `assertModeratorInScope` itself and is untouched — it only
converts "module wiring silently breaks → everyone permitted" into "module wiring
breaks → application fails to boot," a strictly safer failure mode. This is a
mechanical, low-risk change: every module that needs it already imports
`MobileWorkforceModule` in production today; only the injection's optionality
changes.

### 4. Dashboard report-count fix

`regionalDailyActivity()`'s report counts change from `reporterId: {in: inScopeUserIds}`
to filtering by the report's parent room/stream region — mirroring how the
room/stream counts in the same method already work, rather than the reporter-location
mechanism. `videoRoomReport` and `liveStreamReport` counts are added alongside the
existing `roomReport` count so "assigned reports" reflects all three surfaces, matching
the Moderator spec's dashboard description (Assigned Reports is not audio-only).

### 5. Frontend (`soulzaa-superadmins`)

- Provisioning form: region field becomes a multi-select (checkbox list, same
  flattened `geography.tree()` source as today) instead of a single dropdown;
  submits `regionIds: string[]`.
- Moderator Directory: each row gets a "Regions" action opening the same multi-select,
  pre-checked with the moderator's current regions (fetched from... — see open
  question below), calling `PUT /admin-identity/moderators/:id/regions` on save.

### 6. Seed data

Extend `prisma/seed-rbac.ts` with at least one more state+region (e.g. Vijayawada
under Andhra Pradesh) beyond the existing Bengaluru/Karnataka row, so multi-region
assignment and DENY-case tests are meaningful — matching the scenarios below. A third
region (e.g. Chennai/Tamil Nadu) is needed purely as an "unassigned, must be denied"
fixture.

### 7. E2E tests

Add an npm `seed:e2e` script that runs `seed-rbac` then `seed-e2e-fixtures` against
`DATABASE_URL` from `.env.e2e`. Extend `seed-e2e-fixtures.ts` with: the extra
regions from §6, one `AudioRoom` (or equivalent) per region (Bengaluru, Vijayawada,
Chennai), and a `RoleScope` set for the seeded `MODERATOR` covering Bengaluru +
Vijayawada only. New `test/moderator-region-scope.e2e-spec.ts`, boot the real
`AppModule` against the live `soulzaa_e2e` DB (`test/app.e2e-spec.ts`'s existing
pattern), log in as the seeded moderator for a real JWT, and assert with supertest:

| # | Scenario | Assertion |
|---|---|---|
| 1 | Moderator profile region = Bengaluru, operational scope = Bengaluru | profile untouched by region assignment; access allowed in Bengaluru |
| 2 | Operational scope = Bengaluru + Vijayawada | both allowed |
| 3 | Access Bengaluru room | 2xx |
| 4 | Access Vijayawada room | 2xx |
| 5 | Access Chennai room | 403 |
| 6 | Remove Vijayawada via `PUT .../regions` | subsequent Vijayawada access → 403 |
| 7 | REST moderation ops (kick/ban/mute/warn + the restorative actions from Gap 1) | scoped correctly per region |
| 8 | Report ops (assign/dismiss/notes/review from Gap 2) | scoped correctly per region |
| 9 | Restorative ops specifically | scoped (regression guard for Gap 1) |
| 10 | Official approval `decide()` | scoped to the proposal's region (Gap 3) |
| 11 | Investigation recording | doesn't bypass region auth; doesn't break legitimate Admin path (Gap 4) |
| 12 | Dashboard data (`moderatorDashboard`) | restricted to Bengaluru + Vijayawada only |

## Open questions for plan-time verification (not blocking spec approval)

- Exact field `ModerationApprovalService`'s proposal record uses to recover the
  originating region for `decide()` — confirm shape when implementing that file.
- Exact Prisma relation name from `RoomReport`/`VideoRoomReport`/`LiveStreamReport`
  back to their parent room/stream, to write the dashboard's region-filtered `count`
  query.
- How the admin panel fetches a moderator's *current* regions to pre-populate the
  "Regions" edit multi-select (list moderators' scopes — likely a small addition to
  `listModerators`, or a per-moderator `GET .../regions` read, decided at
  implementation time).
- Whether `ModerationApprovalService`'s existing `WorkforceScopeService` injection is
  already required or still `@Optional()` — confirm and make required if not, per §3a.
- Whether any existing unit spec for `moderation.service.ts` /
  `video-room-moderation.service.ts` / `live-stream.service.ts` constructs the service
  with `scopeService` omitted entirely (relying on `@Optional()`'s runtime absence,
  not just a falsy mock) — if so, that spec needs a mock supplied once the dependency
  becomes required. Expected to be zero based on the audit (existing specs already
  inject a mock and assert on it), but confirm before flipping `@Optional()` off.

## Testing strategy

- Unit specs for `setModeratorRegions` (diff logic: add-only, remove-only, mixed,
  no-op) and for each newly-added `assertModeratorInScope` call site, matching the
  existing convention in `moderation.service.spec.ts` / `video-room-moderation.service.spec.ts`
  (inject a mock `scopeService`, assert it's called with the right `(actorId, region)`,
  assert rejection propagates).
- **Regression test, zero-scope actor fails closed**: a Moderator `UserRole` with no
  `RoleScope` rows at all is rejected by `assertModeratorInScope` for any non-null
  target region — locks in the trace in §3a so a future edit to
  `userScopeFilter`/`isUnrestricted` can't silently reopen it.
- **Failed-lookup-is-not-null-region test**, per new call site: when the parent
  room/stream can't be resolved, the method throws `NotFoundException` and
  `assertModeratorInScope` is never reached — never falls through to a silent permit.
- **Required-dependency test**: for each module made non-`@Optional()` in §3a, a test
  proving the module fails to compile/instantiate without `MobileWorkforceModule`
  imported (a Nest `Test.createTestingModule` compile failure is sufficient — no need
  to boot the full app), so the fail-closed guarantee is itself under test rather than
  asserted only in prose.
- The new real e2e suite (§7) is the primary proof for the 12 scenarios — unit specs
  alone were explicitly ruled insufficient for this feature.
