# Moderator Portal — Reports & Report Details — Design

Status: Approved for implementation planning
Scope: First sub-project of "implement business logic for the moderator portal, page by page." Covers only the Reports list screen and the Report Details screen (backend + Flutter). Rooms, Tasks, and other moderator-portal pages are out of scope here.

## 1. Problem

The Moderator Portal's Reports list and Report Details screens (Flutter, `soulzaa-mobile/lib/features/moderator/`) are backed by placeholder logic:

- `MobileWorkforceService.moderationQueue()` fabricates `priority` by room type (video always "Highest", audio always "Medium") regardless of the actual violation, omits `LiveStreamReport` entirely, and fabricates `ruleViolated` codes that don't correspond to any real catalog.
- `MobileWorkforceService.actionReport()` — the backing call for the 6 Report Details action buttons (Warn/Mute/Kick/Ban/Escalate/Close false report) — only flips the report row's `status` column. It never actually mutes/kicks/bans/warns the target user, never checks shift-active or suspension state, never writes an audit log, and never starts an investigation recording. This directly contradicts moderatorrole.txt: "No moderation action should exist without automatic system-generated evidence" and "Outside the shift: Cannot mute users / kick users / ban users."
- The Report Details screen (`moderator_report_details_screen.dart`) is not reachable from any route, its model (`ModeratorReport`) is missing 9 fields the screen renders, and it calls `submitReportDecision()`, a method that doesn't exist anywhere in the Flutter codebase. Its error handling also swallows every exception and shows a fake success message regardless of outcome.

Meanwhile, the *real* moderation machinery — investigation recording, audit logging, region-scope enforcement, anonymized room broadcast, shift/suspension gating, Ban→Official-approval routing — already exists, fully built and tested, per room type:

- `src/modules/audio-rooms/services/moderation.service.ts` (`reviewReport`, `dismissReport`, `escalateViolation`)
- `src/modules/video-rooms/services/video-room-report.service.ts` (`reviewReport`, `dismissReport`) + `src/modules/video-rooms/services/video-room-moderation.service.ts` (`escalateViolation`)
- `src/modules/live-streaming/services/live-stream-report.service.ts` (`reviewReport`) + `src/modules/live-streaming/services/live-stream.service.ts` (`escalateViolation`)

None of this is wired into the mobile Moderator Portal API today.

## 2. Goals

- Reports list and Report Details show real data: real priority, real rule-violated reference, real region, real previous-report count, real evidence state.
- The 6 action buttons on Report Details actually execute — via the existing per-surface `reviewReport`/`dismissReport`/`escalateViolation` services, never by hand-rolling mute/kick/ban logic again.
- Shift-active and suspension gating apply to report actions taken from the mobile portal, matching what already applies to the same actions taken through the room-level moderation controllers.
- Report Details becomes reachable, functional, and honest about failures (no more fake-success-on-error).

## 3. Non-goals

- No changes to `moderateParticipant` (the Rooms page's quick-action endpoint) — separate sub-project.
- No Prisma schema changes. `RoomReport`/`VideoRoomReport`/`LiveStreamReport` gain no new columns; priority and rule-violated are computed, not persisted.
- No new investigation-recording infrastructure — reuse `InvestigationRecordingService` as-is.
- No change to the Ban→Official-approval workflow itself (`ModerationApprovalService`) — Report Details' "Ban" button feeds into it exactly as the room-level moderation controllers already do.

## 4. Architecture: façade over the authoritative services

`MobileWorkforceService` stops mutating report rows directly. Each of the 3 new/changed methods below resolves which of the 3 tables (`RoomReport` / `VideoRoomReport` / `LiveStreamReport`) a given `reportId` belongs to (sequential `findUnique` lookups — cheap, and UUID collision across tables is not a real risk), then either reads via that surface's repository or delegates the write to that surface's service.

New constructor dependencies on `MobileWorkforceService`:
```
private readonly audioModeration: ModerationService,               // audio-rooms
private readonly videoReports: VideoRoomReportService,              // video-rooms
private readonly videoModeration: VideoRoomModerationService,       // video-rooms (escalateViolation only)
private readonly liveStreamReports: LiveStreamReportService,        // live-streaming
private readonly liveStream: LiveStreamService,                     // live-streaming (escalateViolation only)
private readonly investigationRecording: InvestigationRecordingService,
private readonly auditLog: AuditLogService,                         // for getAuditLogsForTarget gating check only if needed
```
All should be `@Optional()` the same way `shiftService`/`warnings` already are on this class, so the module keeps booting in test contexts that don't wire every dependency — but the actual behavior when a dependency is missing should be a clear error on the write path (report action), not a silent no-op, since a silent no-op here means "moderator clicked Ban and nothing happened."

`MobileWorkforceModule` (or wherever `MobileWorkforceService` is currently provided) needs `AudioRoomsModule`, `VideoRoomsModule`, `LiveStreamingModule`, and `InvestigationRecordingModule` as imports (exporting the services above) to satisfy DI. Check for circular-import risk given these are large feature modules — if `AudioRoomsModule`/etc. already depend indirectly on `MobileWorkforceModule` (e.g. via `WorkforceScopeService`, which several of them already inject), resolve by importing only the specific providers needed rather than the whole feature module, or via `forwardRef` if unavoidable.

## 5. Endpoint 1 — `GET /mobile/workforce/moderation/queue` (existing path)

Query params unchanged (`limit`, default 25, cap 50 as today — no server-side filter/sort params added since the Flutter list screen filters/sorts entirely client-side against the whole fetched page, per its existing `filteredReportsProvider`).

Changes to `moderationQueue()`:
- Add `LiveStreamReport` as a third source alongside `RoomReport`/`VideoRoomReport`, scoped by `reporterId` the same way the other two already are.
- `priority` computed via `deriveReportPriority(reason)` (new shared util, §7.1) instead of the room-type-based hardcode.
- `ruleViolated` computed via `deriveRuleViolated(reason)` (new shared util, §7.2) instead of `${reasonText} (3.1|2.4)`.
- `region` resolved for live-stream reports the same way audio/video already are, via `hostId → user.locationState.name`.
- `status`: `'Under review'` for PENDING, `'Resolved'` for REVIEWED/ACTIONED/DISMISSED (collapses the 3 closed states to one label — matches the Flutter tab filter, which only distinguishes open vs. closed).
- Response shape (JSON keys) is otherwise unchanged from today — no Flutter model changes needed for the list screen itself, only for Report Details (§8).

## 6. Endpoint 2 — `GET /mobile/workforce/reports/:reportId` (new)

New controller route + new `MobileWorkforceService.reportDetails(userId, reportId)` method.

Resolution: look up `reportId` in `RoomReport`, then `VideoRoomReport`, then `LiveStreamReport` (first hit wins). 404 (`REPORT_NOT_FOUND`) if none match. Then:

- `assertModeratorInScope(userId, ownerId/hostId)` (reuse `WorkforceScopeService`, same call every action already makes) — 403 if the report's room/stream owner falls outside the caller's region scope. A moderator should not be able to read report detail for a report outside their assigned region by guessing a UUID.
- Load reporter + target user (`username`, `fullName`).
- Load room/stream (`name`/`title`, owner/host id) → region via existing state-resolution pattern.
- `previousReportCount`: count of reports (any status, excluding this reportId) against the same `targetUserId` across all 3 tables.
- `ruleViolated`, `priority` via the same shared utils as endpoint 1.
- **Evidence** (§7.3): via `InvestigationRecordingService.getCaseView(targetUserId)`, filtered to this report's `roomId`/`liveStreamId`, most recent row. Two states:
  - No matching recording yet (report still PENDING, no action taken) → `evidenceStatus: 'pending'`, `evidenceId: null`, `evidenceNote: 'No moderation action has been taken yet — evidence is captured automatically when an action is recorded.'`
  - A recording exists → `evidenceStatus: 'captured'`, `evidenceId` (the real `EVD-...` id), `evidenceType: 'System evidence'`, `evidenceNote: 'Automatically captured by the system'`, `capturedAt`.
  - `canViewFullEvidence: boolean` — `true` only if the caller holds `investigation.recording.view` OR `audit.view` (check via the existing `RbacPermissionsGuard`'s permission-resolution path / injected permission-check service — confirm exact helper during implementation; do not hand-roll a second RBAC check). When `false`, omit `recordingUrl`/any audit-trail detail from the response even if `getCaseView` returned it — the gate is server-side, not just a UI banner.
- `shiftActive`: from `ModeratorShiftService.shiftStatus(userId).isActive` if the service is injected, else `false`.
- `canTakeAction`: `shiftActive && !suspended && report.status === 'PENDING'` (`suspended` via `ModeratorWarningService.isSuspended(userId)` if injected). This is the single field the Flutter screen should trust for enabling/disabling the 6 action tiles — it must not recompute this client-side.
- `assignedTime`: `report.assignedAt` formatted, falling back to `createdAt` if never explicitly assigned (matches existing `moderationQueue` formatting convention).

No new guard beyond the controller-level `RequirePermissions('mobile.workforce.view')` — this is a read.

## 7. Shared business-logic utilities

New file: `src/modules/mobile-workforce/services/report-classification.util.ts` (pure functions, no DI, unit-testable in isolation).

### 7.1 `deriveReportPriority(reason: string): 'Highest priority' | 'Medium priority' | 'Low priority'`

- Highest: `THREATS`, `SEXUAL_CONTENT`, `ADULT_CONTENT` — the Highest tier is anchored on the one real severity signal that already exists in the codebase (`HIGH_PRIORITY_REPORT_REASONS = [THREATS, SEXUAL_CONTENT]`, duplicated 3x today), extended with `ADULT_CONTENT` since it's the same category under a different enum name on `RoomReport`.
- Medium: `HARASSMENT`, `HATE_SPEECH`, `BULLYING`, `ABUSE`, `FAKE_PROFILE`, `FAKE_ACCOUNT`, `INAPPROPRIATE_CONTENT`, `LIVE_STREAM_VIOLATION`, `COMMUNITY_GUIDELINE_VIOLATION`, `USER`, `MESSAGE`.
- Low: `SPAM`, `FRAUD`, `COPYRIGHT`, `OTHER`.
- Unmapped/unknown reason string → `'Medium priority'` (safe middle default, never silently drop to Low).

### 7.2 `deriveRuleViolated(reason: string): string`

Static reason → rule-code label table, e.g.:
- `SEXUAL_CONTENT`/`ADULT_CONTENT` → `"Sexual content & nudity (3.1)"`
- `INAPPROPRIATE_CONTENT` → `"Inappropriate content (3.2)"`
- `HATE_SPEECH` → `"Hate speech & discrimination (2.1)"`
- `HARASSMENT`/`BULLYING` → `"Harassment & bullying (2.2)"`
- `THREATS` → `"Threats & violence (2.3)"`
- `ABUSE` → `"Platform abuse (4.1)"`
- `SPAM`/`FRAUD` → `"Spam & fraudulent activity (4.2)"`
- `FAKE_PROFILE`/`FAKE_ACCOUNT` → `"Fake profile & impersonation (1.1)"`
- `COPYRIGHT` → `"Copyright infringement (5.1)"`
- `LIVE_STREAM_VIOLATION` → `"Live stream policy violation (6.1)"`
- `COMMUNITY_GUIDELINE_VIOLATION`/`USER`/`MESSAGE` → `"Community guideline violation (6.2)"`
- `OTHER`/unmapped → `"Other community guideline violation (7.1)"`

This is a fixed reference table (same reason always maps to the same code), not per-record fabrication — an honest improvement over today's "always .1 or .4 regardless of actual reason," but still a codebase-defined catalog, not an externally-sourced legal document. Document this distinction in the code comment so nobody mistakes it for a real compliance catalog later.

### 7.3 Evidence resolution helper

`resolveReportEvidence(targetUserId, roomId, liveStreamId, canViewFull): {evidenceStatus, evidenceId, evidenceType, evidenceNote, capturedAt}` — wraps the `getCaseView` call + filter + the two-state shaping described in §6. Shared between endpoint 2 (single report) — list endpoint does not need per-row evidence (it's not shown on the list screen).

## 8. Endpoint 3 — `POST /mobile/workforce/reports/:reportId/decision` (existing path)

Route gains `@UseGuards(ShiftActiveGuard, SuspendedGuard)` at the method level (the controller-level guards stay `JwtAuthGuard`/`RbacPermissionsGuard` for all routes; these two are additive on this route only, matching the pattern already used on every audio/video/live-stream moderation controller route).

Request body: `{ action: string; note: string }`. `note` is now validated non-empty server-side (400 `NOTE_REQUIRED` if blank/whitespace) — client-side validation in Flutter is a UX nicety, not a substitute for server enforcement.

`actionReport(userId, reportId, {action, note}, requestMeta)`:

1. Resolve the report across the 3 tables (shared resolver from §6/§9).
2. `assertModeratorInScope` (same as endpoint 2).
3. Normalize `action` (case-insensitive, trim) → one of `WARN | MUTE | KICK | BAN | ESCALATE | CLOSE_FALSE_REPORT`. Unknown value → 400 `UNKNOWN_ACTION`.
4. Build `RoomActor` from `@CurrentUser() user: AuthenticatedUser` → `{id: user.id, roles: user.roles}`.
5. Dispatch by normalized action AND resolved room type:

   | Action | Audio | Video | Live stream |
   |---|---|---|---|
   | WARN/MUTE/KICK/BAN | `audioModeration.reviewReport(actor, roomId, reportId, {status:'ACTIONED', resolution:note, recommendedAction:'WARNING'\|'MUTE'\|'KICK'\|'BAN'})` | `videoReports.reviewReport(actor, roomId, reportId, {status:'ACTIONED', resolutionAction:note, recommendedAction:'WARNING'\|'MUTE'\|'KICK'\|'BAN'})` | `liveStreamReports.reviewReport({reportId, streamId, moderatorId:actor.id, status:'ACTIONED', resolution:note, recommendedAction:'WARN'\|'MUTE'\|'KICK'\|'BAN'}, requestMeta)` — **note the live-stream DTO uses `'WARN'`, not `'WARNING'`** |
   | CLOSE_FALSE_REPORT | `audioModeration.dismissReport(actor, roomId, reportId, note)` | `videoReports.dismissReport(actor, roomId, reportId, note)` | `liveStreamReports.reviewReport({reportId, streamId, moderatorId:actor.id, status:'DISMISSED', resolution:note})` (no separate dismiss method exists for live streams) |
   | ESCALATE | `reviewReport(..., {status:'REVIEWED', resolution:note})` then `audioModeration.escalateViolation(actor, roomId, targetUserId, note, severity)` | same, then `videoModeration.escalateViolation(actor, roomId, targetUserId, note, severity)` | `reviewReport({..., status:'REVIEWED', resolution:note})` then `liveStream.escalateViolation(streamId, actor.id, targetUserId, note, severity)` |

   `severity = deriveReportPriority(report.reason) === 'Highest priority' ? 'CRITICAL' : 'HIGH'`.

6. `BAN` does not immediately ban — `reviewReport`'s internal handling routes it to `ModerationApprovalService.propose()` for Official sign-off, same as the room-level moderation controllers. The response should reflect this (`status: 'pending_approval'`) rather than implying the ban already happened, so the Flutter success message can say the right thing.
7. Response: `{success: true, reportId, action: normalizedAction, outcome}` where `outcome` is `'executed' | 'pending_approval' | 'dismissed' | 'escalated'`.

Errors (`REPORT_NOT_FOUND`, `REPORT_ALREADY_REVIEWED` from a concurrent double-submit, `NOTE_REQUIRED`, `UNKNOWN_ACTION`, scope 403, shift/suspension 403 from the guards) propagate as their existing exception types — no new error-handling framework needed, this is Nest's standard exception filter behavior already used everywhere else in these services.

## 9. Shared report-resolution helper

`resolveReportContext(reportId): {roomType: 'audio'|'video'|'stream', roomId, targetUserId, reporterId, reason, status, createdAt, assignedAt}` — one private method on `MobileWorkforceService`, used by all three endpoints, doing the sequential 3-table lookup once so the logic isn't copy-pasted three times.

## 10. Flutter changes

`lib/features/moderator/`:

- **`data/models/moderator_report.dart`** — add optional fields: `assignedTime`, `targetUserName`, `targetUserId`, `region`, `evidenceStatus`, `evidenceId`, `evidenceType`, `evidenceNote`, `ruleViolated`, `userReportCount` (rename/reuse to match test file's existing expectation), `shiftActive` (bool), `canTakeAction` (bool), `canViewFullEvidence` (bool). List-screen JSON won't populate the detail-only fields — all default sensibly (nulls / `false` / `'0 previous reports'`) so the existing list-screen usage of this model is unaffected.
- **`data/moderator_remote_data_source.dart`** — add:
  - `Future<ModeratorReport> getReportDetails(String reportId)` → `GET /mobile/workforce/reports/$reportId`.
  - `Future<Map<String, dynamic>> submitReportDecision({required String reportId, required String action, required String note})` → `POST /mobile/workforce/reports/$reportId/decision`, body `{action, note}`. Returns the parsed response (`outcome` matters for the success message) rather than `void`.
- **`presentation/screens/moderator_report_details_screen.dart`**:
  - On open, fetch fresh detail via `getReportDetails(report.id)` (nav arg becomes the report id or a summary object, not a fully-hydrated `ModeratorReport` — the screen shouldn't trust a possibly-stale list-item for shift/evidence/scope state).
  - Bind "Shift active"/tile-enabled state to `detail.canTakeAction` instead of hardcoded text; when `false`, disable the 6 action tiles and show why (shift inactive / suspended / already reviewed).
  - Bind Evidence section to `evidenceStatus`/`evidenceId`/`evidenceType`/`evidenceNote`; only render the "higher officials" banner + suppress any recording link when `!canViewFullEvidence`.
  - Bind "Report count(user)" to `userReportCount`.
  - Fix `_submitAction`: call the real `submitReportDecision`; on error, surface the actual error message in a red snackbar and do **not** pop the screen (currently pops + shows fake success on any exception — this is a real correctness bug independent of the missing backend, worth fixing regardless).
  - On success, `ref.invalidate(moderatorReportsProvider)` before popping, so the list re-fetches and reflects the new status.
- **`core/routing/route_paths.dart` / `app_router.dart`** — register `moderatorReportDetails` route.
- **`presentation/screens/moderator_reports_screen.dart`** — change `_ReportCard`'s tap handler from the cosmetic local bottom-sheet to `Navigator.push`-ing the (now-registered) Report Details route.

## 11. Testing plan

Backend (Jest, matching existing spec conventions in this codebase):
- `mobile-workforce.service.spec.ts`: extend for `moderationQueue` (live-stream inclusion, real priority/rule-violated), new tests for `reportDetails` (3-table resolution, scope 403, evidence two-state shaping, gating on `canViewFullEvidence`), new tests for `actionReport` (correct delegation per action × room-type matrix in §8, note-required 400, unknown-action 400, scope 403).
- `report-classification.util.spec.ts`: pure unit tests for `deriveReportPriority`/`deriveRuleViolated` covering every enum value across all 3 reason enums (cheap, high-value — these are pure functions).
- Controller-level: confirm `ShiftActiveGuard`/`SuspendedGuard` reject appropriately on the decision route (mirrors existing guard tests on the audio/video/live-stream moderation controllers).

Flutter:
- Update `test/features/moderator/moderator_report_details_screen_test.dart` (already asserts the 9 fields — this becomes a real passing test instead of asserting against a broken model) to also cover the fixed error-handling path and the `canTakeAction`-driven tile disabling.
- Extend `moderator_remote_data_source_test.dart` for the two new methods.
- Manual verification: `flutter analyze` clean, then run the app and walk the golden path (open Reports → tap a card → Report Details loads real data → submit an action → list refreshes) plus the edge cases (shift inactive disables actions, empty note blocked, network failure shows a real error).

## 12. Risks / open items for implementation

- **DI wiring / circular imports** (§4) — several of the target services live in large feature modules that may already depend on `WorkforceScopeService`. Needs a careful import graph check during implementation; may require exporting only specific providers rather than whole modules.
- **Permission check for `canViewFullEvidence`** (§6) — confirm the exact reusable helper for "does this user hold permission X" outside of the guard/decorator context (a plain service call, not a route guard) rather than hand-rolling a second RBAC path.
- **Live-stream `recommendedAction` literal mismatch** (`'WARN'` vs `'WARNING'`) — easy to get wrong; the dispatch table in §8 must map per-surface, not use one shared constant.
- **`InvestigationRecordingService` being non-`@Optional()` on `LiveStreamService`** (per earlier research) — confirm it's already satisfied in whatever module wiring `MobileWorkforceModule` ends up importing, so live-stream action dispatch doesn't fail at construction time.
