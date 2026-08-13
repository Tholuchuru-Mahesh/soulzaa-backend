# Moderator Role — Backend Gap Analysis & Implementation Spec

**Scope:** Backend only (`soulzaa-backend`, NestJS + Prisma). Does not cover the Flutter mobile app UI or any other frontend.
**Date:** 2026-08-13
**Source spec:** Soulzaaa Role Management & Functional Requirements, Section 5 (Moderator)
**Method:** 6 parallel research agents audited the backend against the spec, citing exact file:line evidence. A second pass of 4 parallel verification agents independently re-read every cited file to confirm, correct, or refute each claim. A third reconciliation pass then cross-checked the exported list against the original ~60-item detailed audit and found 6 real findings that had been silently dropped during consolidation — those are folded back in below (marked "reconciliation addition"), bringing the total to 39 items. Of the 33 originally-verified claims, all checked out with only minor corrections; the 6 reconciliation additions were not independently re-verified by a fresh agent pass (they're carried over from the original detailed audit) — treat them as slightly lower-confidence than the other 33 until spot-checked.

All file paths are relative to the repo root (`soulzaa-backend`). Line numbers reflect the code as of 2026-08-13 — if a cited file has since changed, re-grep the symbol name rather than trusting the line number blindly.

---

## Executive Summary — top gaps

1. **Anonymity is broken in practice.** The spec's central promise — "Moderator identity must never be exposed" — fails at the point of action. Muting/kicking/banning in Audio and Video Rooms broadcasts the real `moderatorId` to every room occupant over the socket. No anonymized system message exists anywhere.
2. **Live Stream moderation doesn't enforce against regular viewers.** Mute/kick/ban only write a log row for non-host targets — there's no join/viewer-session concept to enforce against. (Host-targeted ban/kick does work — it force-ends the stream.)
3. **Video Room moderation ignores the platform Moderator role entirely — in 6 places.** A platform Moderator gets zero automatic video-room access unless a room owner manually grants an unrelated in-room role.
4. **No temp-ban feature in Video Rooms** — only a permanent blacklist exists.
5. **Region restriction isn't enforced where it matters** — the filter exists but is never applied inside the actual moderation-action controllers.
6. **The central audit log isn't wired to moderation actions** — mute/kick/ban never call `AuditLogService`.
7. **The 3-level internal warning/suspension system doesn't suspend anyone** — `isSuspended()` is dead code with exactly one reference in the whole repo (its own definition).
8. **Investigation Recording never triggers for Video Room moderation** *(reconciliation addition)* — the spec's "no moderation action without automatic evidence" guarantee only holds for Audio Rooms and Live Streams; Video Room mute/kick/ban leaves zero evidence trail.

**Also notable:** moderator warning permissions (`moderator.warning.issue/view/resolve`) are held by no role except Super Admin's wildcard — not even regular Admin.

**Confirmed correctly implemented (not gaps, verified independently):** financial/wallet/revenue restrictions, platform config restrictions (Games/VIP/Gifts/Frames/Themes/Badges), and role-approval restrictions. Moderator's RBAC permission array (`src/modules/authorization/constants/rbac-permissions.constants.ts` ~1816-1833) is a clean, minimal allowlist with no leakage into any of these.

---

## Verified Pending List (39 items)

### 🔴 Critical
1. **Anonymity leak** — real `moderatorId` broadcast to room occupants via socket on every mute/kick/ban (Audio + Video Rooms). Zero anonymization exists anywhere.
2. **Live Stream moderation doesn't enforce against non-host targets** — mute/kick/ban only log an action; only host-targeted ban/kick has a real effect (ends the stream). No join/viewer-session concept exists to enforce against anyone else. No ban expiry field.
3. **Video Room ignores the platform Moderator role in 6 places** — `video-room-permission.service.ts:225-229`, `video-room-chat-policy.service.ts:284`, `video-room-member.service.ts:525`, `video-room-moderation.service.ts:986`, `video-room-query.service.ts:133`, `video-room-role.service.ts:276`. Audio Rooms already does this correctly at `room-permission.service.ts:34`.
4. **No temp ban in Video Rooms** — only a permanent block/blacklist exists (`VideoRoomBlock` has no `expiresAt`).
5. **Region restriction not enforced at the moderation-action layer** — the filter exists in `workforce-scope.service.ts` but only `mobile-workforce` module uses it.
6. **Central `AuditLogService` not wired to moderation actions** — audio-rooms keeps its own `moderation_actions` table, but none of the three surfaces write to the cross-cutting audit system Admin/Super Admin actually review.
7. **Level-3 moderator suspension is dead code** — `isSuspended()` has exactly one reference in the whole repo: its own definition.
8. *(reconciliation addition)* **Investigation Recording never wired into Video Room moderation** — only Audio Rooms and Live Streams trigger `beginRecording`/`completeRecording`; a Video Room mute/kick/ban leaves no automatic evidence at all, contradicting the spec's core recording guarantee.

### 🟠 High
9. No dedicated Staff Portal login — one shared `/auth/login` for every role.
10. 2FA service fully built, never called from login.
11. Device Verification only alerts, never blocks login.
12. No IP verification/allow-list at login anywhere, for any role.
13. Failed login attempts live in Redis only — no durable/queryable record, no status column.
14. Device Change Workflow is single-tier (one `moderator.device.review` permission), not Manager-then-Admin; new device isn't auto-registered on approval, only the old one is soft-deleted.
15. `ShiftActiveGuard` is applied to Audio Rooms and Live Streams but genuinely absent from every Video Room moderation route.
16. Shift End reminder is fully unimplemented — doc comment claims it exists, no code creates it.
17. No dedicated Reports module: category enums lack explicit Hate Speech/Bullying/Threats/Sexual Content/Inappropriate Content values (loosely covered by existing ones); review is free-text with no recommend→execute workflow; `REPORT_ESCALATED` is a dead constant — no severity-based routing to Official/Manager/Admin exists.
18. **Moderator warning permissions are almost entirely Super-Admin-only** — `moderator.warning.issue/view/resolve` aren't granted to Admin *or* Country Manager, only reachable via Super Admin's `'*'` wildcard. Need to grant Admin (issue/resolve) and Country Manager (Level-2 review) explicitly, not just add a Manager gate.
19. *(reconciliation addition)* **No moderator-initiated "Escalate critical violations" action** — the spec lists this as a direct moderator capability for Video Room (and implicitly Live Stream) moderation. Only automatic, system-triggered escalation exists for Audio/Video Rooms (on blocked-word severity); Live Streams have no escalation mechanism of any kind.

### 🟡 Medium
20. Shift countdown computed but never merged into the dashboard payload.
21. No assignee field on reports/rooms/streams — "Assigned Reports/Queue/Rooms/Streams" dashboard sections have nothing to query.
22. No region-scoped Live Monitoring endpoint for moderators; no Active Live Streams counter exists anywhere, even platform-wide.
23. `falseModerationCount`, `avgResolutionMinutes`, `taskCompletionRate` are schema columns only — never written or read anywhere in code. No investigation-accuracy or avg-response-time logic exists at all.
24. Of 8 possible `recordAction` types, only `KICK`/`BAN` fire from Audio Rooms; `WARN`/`MUTE` don't; Live Streams cover all four generically; report-related and `ROOM_VISITED` types are never called by anything (no reports module exists to call them).
25. No "Overdue" concept anywhere in the tasks module; no combined Assigned/Completed/Pending/Overdue+% endpoint.
26. Task-assignment notifications bypass the real `NotificationService.create()` dispatch pipeline (direct `prisma.notification.create` — no push/socket delivery).
27. Only 3 of 8 moderator notification types are ever constructed (`MODERATOR_SHIFT_STARTING`, `MODERATOR_TASK_ASSIGNED`, `MODERATOR_WARNING_ISSUED`); 6 are dead, including `MODERATOR_SHIFT_ENDING`.
28. `AuditLog` model lacks `targetUserId`/`roomId`/`region`/`violationReason`/parsed device-browser-OS fields — only generic `actorId/action/resource/resourceId/details(JSON)`.
29. `audit.view` granted to Admin + Country Manager + Super Admin — spec says Admin/Super Admin only.
30. `investigation.recording.view` reachable only via Super Admin's wildcard — regular Admin genuinely lacks it.
31. *(reconciliation addition)* **Live Stream's moderation-action log isn't filterable by target user** — `GET :id/moderation/actions` returns every action for the stream, with no way to scope it to one user.
32. *(reconciliation addition)* **Investigation Recording stores metadata only** — no actual video/media asset reference field (`recordingUrl`/`mediaId`-style column); only numeric duration and text fields exist.
33. *(reconciliation addition)* **No moderator-specific "Official Messages / Manager Instructions / System Announcements" notification types** — only generic shared `ANNOUNCEMENT`/`SYSTEM` types exist, identical to what regular users get.

### 🟢 Low
34. Moderators (and Admin/Super Admin) can currently be followed and friend-requested — only list *display* filters them out, not the follow/request creation path itself.
35. No backend enforcement suppressing badge/frame/customId for moderators — convention only.
36. Real-identity lookup (`workforce.detail.view`) held by Admin + Country Manager + Official, not Admin/Super Admin only; separately, any hidden-account holder (including another Moderator) can view another hidden profile via `viewerIsStaff`.
37. Raw presence/viewer-count endpoints in Video Rooms count moderators/hidden accounts; only identity-resolved display lists filter them.
38. "One session per moderator" is really just the global `SESSION_MAX_CONCURRENT` cap (**default 5**, env-configured, `src/config/env.validation.ts:170`), applied identically to every user — no moderator-specific override.
39. *(reconciliation addition)* **Staff login only supports Email, not Username** — the spec explicitly lists "Username / Email" as valid identifiers; there is currently no username field in the login flow at all.

---

## Implementation Prompt (verified, corrected, reconciled — 39 tasks)

Run one phase per branch/PR, not all at once — this matches the codebase's existing pattern of small, reviewable, test-covered changes (see `docs/superpowers/plans/` for examples of how prior features here were phased). Task numbers below match the pending-list numbers above 1:1.

```
Context: soulzaa-backend is a NestJS + Prisma backend. This spec is the
output of a three-pass process (initial audit -> independent verification
-> completeness reconciliation against the original findings), all citing
exact file:line evidence, of the "Moderator" role from Soulzaaa Role
Management & Functional Requirements section 5. Tasks 1-7, 9-18, 20-30,
and 34-38 were independently re-verified against the live code. Tasks 8,
19, 31, 32, 33, and 39 are reconciliation additions carried over from the
original audit without a second independent re-read — spot-check them
first if anything looks off. Every citation reflects the codebase as of
2026-08-13 — if a file has since moved, re-grep the symbol name, don't
trust the line number blindly. Follow this repo's existing conventions
(check sibling services/controllers/guards in the same module before
adding new patterns). Use TDD — write/extend tests alongside each change,
mirroring the .spec.ts pattern already used next to every service. Do not
introduce a generic cross-module abstraction unless a task explicitly
calls for it. Scope is backend only — no Flutter/mobile UI work.

=== PHASE 1 — CRITICAL ===

1. Anonymize moderator identity in moderation broadcasts.
   - src/modules/audio-rooms/services/moderation.service.ts emits
     MemberMutedEvent/MemberKickedEvent/MemberBannedEvent with
     moderatorId: actor.id at lines 344-353 (mute), ~154-161 (kick),
     ~264-273 (ban); src/modules/audio-rooms/listeners/
     moderation-socket.listener.ts:34-55 broadcasts these verbatim to
     every socket in the room via sockets.emitToNamespaceRoom.
   - src/modules/video-rooms/events/video-room-moderation.events.ts has
     moderatorId at lines 46 (base interface), 110, 121, 138; broadcast
     via src/modules/video-rooms/listeners/
     video-room-moderation-socket.listener.ts:40-58,62-70,83-91.
   - Fix: when the actor holds PlatformRole.MODERATOR, replace the
     outbound socket payload's identity with the existing
     SYSTEM_MODERATOR_ID sentinel pattern already used for automated
     moderation (grep for SYSTEM_MODERATOR_ID to find its current usage
     and reuse the same masking convention), and add a human-readable
     system message ("A moderator muted this user for violating
     community guidelines.") to the broadcast payload. The real actor id
     must still be persisted to the DB action tables and (once Phase 1
     task 6 lands) the audit log — only the outbound broadcast to room
     members is anonymized. Also check GET endpoints that return
     moderatorId in history/log responses (moderation.service.ts's
     RoomKickView, video-rooms' /moderation/history, /muted-users,
     /blacklisted-users) — confirm these stay behind moderation
     permissions (they already do) so this doesn't leak there too.
   - Add tests asserting the socket payload never contains a real
     moderator's id/username when the actor's platform role is
     MODERATOR, for both audio and video rooms.

2. Live Stream moderation: enforce against non-host targets.
   - src/modules/live-streaming/services/live-stream.service.ts
     moderateUser() (lines 101-161) currently only has a real effect
     when the target is the host (lines 149-158, force-ends the stream
     on BAN/KICK). There is no viewer/join session to enforce
     mute/kick/ban against for anyone else, and no join endpoint exists
     anywhere in the module.
   - Add a join/leave (viewer presence) endpoint and session tracking to
     live-stream.controller.ts, mirroring the pattern in
     src/modules/video-rooms (join endpoint + presence tracking). Once
     viewer sessions exist, implement real MUTE (suppress the target's
     chat/audio in the stream) and real KICK (force-disconnect the
     target's viewer session) against non-host targets.
   - Add a duration/expiry field to the ban path (mirror
     ModerationBanType from prisma/schema/audio_rooms_moderation.prisma)
     — the current live_stream_moderation_actions model
     (prisma/schema/introspected.prisma:18-32) has no expiresAt column.
   - Apply the anonymized-broadcast rule from Task 1 to any new
     join/viewer-facing system messages.

3. Give platform Moderators automatic Video Room moderation access —
   fix all 6 locations, not just one:
   - src/modules/video-rooms/services/video-room-permission.service.ts
     isPlatformAdmin() (lines 225-229) — only checks
     PlatformRole.ADMIN/SUPER_ADMIN.
   - src/modules/video-rooms/services/video-room-chat-policy.service.ts:284
   - src/modules/video-rooms/services/video-room-member.service.ts:525
   - src/modules/video-rooms/services/video-room-moderation.service.ts:986
   - src/modules/video-rooms/services/video-room-query.service.ts:133
   - src/modules/video-rooms/services/video-room-role.service.ts:276
   - Mirror the exact pattern already correct in
     src/modules/audio-rooms/services/room-permission.service.ts:34,
     which does `roles.includes(PlatformRole.MODERATOR)` as part of its
     staff-bypass check — add the equivalent
     PlatformRole.MODERATOR check to all 6 video-room call sites so a
     platform Moderator gets MUTE_USERS/KICK_USERS/BLOCK_USERS
     automatically, without granting LOCK_ROOM/CLOSE_ROOM (must stay
     owner/admin-only — already correctly enforced, covered by
     video-room-permission.service.spec.ts:148, do not regress it).

4. Add a temporary ban to Video Rooms.
   - src/modules/video-rooms/dto/moderation.dto.ts's
     BlockVideoRoomUserDto (lines 74-84) has only userId + reason.
   - prisma/schema/video_rooms_moderation.prisma's VideoRoomBlock model
     (lines 32-49) has status/liftedBy/liftedAt for manual lifting but
     no expiresAt.
   - Add type: TEMPORARY | PERMANENT + durationMinutes to the DTO,
     expiresAt to the model, and expiry handling in
     video-room-moderation.service.ts's createBlock/liftBlock, mirroring
     ModerationBanType's resolveExpiry pattern from the audio-rooms
     moderation.service.ts/dto.

5. Enforce region restriction inside moderation actions.
   - src/modules/mobile-workforce/services/workforce-scope.service.ts's
     userScopeFilter (lines 62-91) is the only region-scope logic in the
     codebase and is used exclusively inside
     mobile-workforce.service.ts.
   - Inject the same scope check into audio-rooms/services/
     moderation.service.ts, video-rooms/services/
     video-room-moderation.service.ts, and live-streaming/services/
     live-stream.service.ts: before executing mute/kick/ban, resolve the
     target room/stream's region and verify it's within the acting
     moderator's assigned regions/RoleScope (reuse
     WorkforceScopeService directly rather than reimplementing it),
     throwing ForbiddenException otherwise.

6. Wire moderation actions into the central audit log.
   - src/modules/authorization/services/audit-log.service.ts logAction()
     (lines 26-49) and the @AuditLogAction decorator/interceptor
     (src/modules/authorization/interceptors/audit-log.interceptor.ts)
     currently have zero references anywhere in moderation.service.ts,
     video-room-moderation.service.ts, or live-stream.service.ts — note
     audio-rooms does already keep its own moderation_actions table via
     repo.appendAction(), so this is about ALSO surfacing these events
     in the cross-cutting AuditLog Admin/Super Admin actually review,
     not building audit capture from scratch.
   - Add @AuditLogAction (or a direct logAction call) to every
     mute/kick/ban/warn code path across all three surfaces.

7. Enforce Level-3 moderator suspension.
   - src/modules/moderator-warning/services/moderator-warning.service.ts
     isSuspended() (lines 107-116) has exactly one reference in the
     whole repo — its own definition. There is no guard file in
     src/modules/moderator-warning at all.
   - Add a guard (mirror src/modules/moderator-shift/guards/
     shift-active.guard.ts's structure) that calls isSuspended() for the
     acting moderator and throws ForbiddenException on
     mute/kick/ban/warn actions when true. Apply it alongside
     ShiftActiveGuard on all moderation controllers, including Video
     Rooms once Phase 2 task 15 adds shift gating there.

8. (Reconciliation addition) Wire automatic investigation recording into
   Video Room moderation.
   - src/modules/audio-rooms/services/moderation.service.ts (lines
     140,147,250,257) and src/modules/live-streaming/services/
     live-stream.service.ts (lines 108,136) call beginRecording/
     completeRecording from src/modules/investigation-recording/
     services/investigation-recording.service.ts on every mute/kick/ban.
     video-room-moderation.service.ts has zero references to this
     service — grep-confirm before starting.
   - Add the same beginRecording (on action start) / completeRecording
     (on action completion) calls to video-room-moderation.service.ts's
     mute/kick/block flows, populating moderatorId, targetUserId,
     roomId, regionId, violationReason, actionTaken exactly as the
     audio-rooms/live-streaming call sites do.
   - Add a test asserting a video-room mute/kick/block creates an
     InvestigationRecording row, mirroring the equivalent existing test
     for audio-rooms or live-streaming if one exists.

=== PHASE 2 — HIGH ===

9. Staff Portal login flow. Add a distinct route (e.g.
   POST /staff/auth/login) reusing auth.service.ts's loginWithPassword
   logic (src/modules/auth/services/auth.service.ts:118-141) as its own
   entry point, scoped to staff roles, so staff-only requirements below
   can be enforced without touching the regular user login path.

10. Wire 2FA into staff login. src/modules/admin-identity/services/
    admin-2fa.service.ts (lines 25-84, fully working TOTP) is registered
    as a provider in admin-identity.module.ts:27 but injected nowhere.
    Inject it into the new staff login flow (Task 9): after password
    check, require a valid TOTP code before issuing a session for any
    staff role.

11. Make Device Verification block login for staff. device.service.ts's
    maybeFlagSuspicious (lines 104-153) always returns a boolean and is
    read nowhere in session.service.ts's resolveDevice (lines 235-245) —
    login proceeds regardless. For staff roles specifically, require the
    device to already be bound (reuse moderator-device-binding.service.ts
    assertSingleDevice, lines 23-48) and reject login from an unbound
    device, directing the user to the device-change flow.

12. Implement IP Verification for staff login. No allow-list/pre-login
    IP check exists anywhere in the codebase today (the only IP logic,
    session.service.ts's assertNotHijacked lines 252-273, runs on
    refresh() only, comparing against the session's own prior IP, not an
    allow-list). Add a verified/allow-listed IP concept for staff
    accounts and check it at the new staff login endpoint.

13. Persist failed login attempts. login-security.service.ts's
    recordFailure (lines 50-58) only writes to Redis via
    CacheService.increment/.set. Extend SessionHistory
    (prisma/schema/session.prisma:26-43) — whose SessionEventType enum
    (lines 45-53) currently has no failed/rejected value — with a
    FAILED_LOGIN / status concept, and write a row there (not just
    Redis) for every staff login failure.

14. Two-step Device Change Workflow.
    moderator-device-change.controller.ts currently gates request
    (moderator.device.request, lines 39,51), approve (line 66), and
    reject (line 78) all with the single permission
    moderator.device.review. moderator-device-binding.service.ts's
    approveDeviceChange (lines 87-130) soft-deletes the old device
    (lines 97-109) but never creates/activates a new UserDevice row.
    Add a MANAGER_REVIEW -> ADMIN_APPROVAL stage sequence (mirror
    RoleRequestStage / STAGE_ORDER from
    src/modules/role-requests/constants/role-request.constants.ts:20-24
    and the canActAtStage check in
    role-request-routing.service.ts:60-81), and on final Admin approval,
    auto-register the new device from newDeviceInfo instead of requiring
    a separate registration step.

15. Apply ShiftActiveGuard + the new suspension guard (Phase 1 task 7)
    to Video Room moderation routes in
    video-rooms-moderation.controller.ts — currently has zero references
    to ShiftActiveGuard anywhere, unlike audio-rooms/controllers/
    moderation.controller.ts:44,70,95,120 and
    live-streaming/controllers/live-stream.controller.ts:84.

16. Shift End reminder. shift-reminder.scheduler.ts has exactly one
    @Cron method, sendShiftStartingReminders (line 30, fires
    MODERATOR_SHIFT_STARTING). Add a matching ending-reminder method
    (mirror ModeratorShiftService.getUpcomingShifts,
    moderator-shift.service.ts:197-216, with an equivalent
    getEndingSoonShifts) that fires the already-defined
    MODERATOR_SHIFT_ENDING (prisma/schema/notification.prisma:265)
    ~15 minutes before shift end — matching what the scheduler's own
    (currently false) doc comment at line 9 already claims.

17. Reports Management improvements.
    - Add HATE_SPEECH, BULLYING, THREATS, SEXUAL_CONTENT,
      INAPPROPRIATE_CONTENT to ReportReason
      (prisma/schema/audio_rooms_moderation.prisma:175-184) and
      VideoRoomReportReason (prisma/schema/video_rooms_moderation.prisma:
      155-163) as explicit values instead of folding them into OTHER/
      HARASSMENT/ABUSE.
    - Add a recommendedAction field (WARNING/MUTE/KICK/BAN, nullable) to
      ReviewReportDto (audio-rooms/dto/moderation.dto.ts:102-112,
      video-rooms/dto/moderation.dto.ts:203-219) distinct from the
      existing free-text resolution field, and from reviewReport()
      (audio-rooms/services/moderation.service.ts:443-474) actually
      executing an action.
    - Implement real severity-based escalation: when a report is marked
      high-severity, route/notify Official/Manager/Admin based on
      region+severity, and call
      moderatorPerformanceService.recordAction(moderatorId,
      'REPORT_ESCALATED') when it happens — this action type is already
      defined (moderator-performance.service.ts:11,17,46,91) but is
      never invoked by anything today.

18. Fix moderator-warning permissions — the actual gap is bigger than
    "add a Manager gate": moderator.warning.issue/view/resolve
    (defined at rbac-permissions.constants.ts:1519-1522) are currently
    granted to NO role except SUPER_ADMIN's '*' wildcard (line 1586) —
    not even ADMIN has them; MODERATOR only holds the self-scoped
    moderator.warning.view.self (line 1828). Grant ADMIN
    moderator.warning.issue + moderator.warning.resolve explicitly, and
    grant COUNTRY_MANAGER a new moderator.warning.review permission that
    Level-2 warnings require before taking effect (analogous to the
    role-request approval chain).

19. (Reconciliation addition) Add a moderator-initiated "Escalate
    critical violations" action.
    - Today, escalation is entirely automatic/system-triggered: audio-
      rooms' chat.service.ts recordViolation (~lines 723-736) escalates
      only on a blocked-word severity match; video-rooms' chat filter
      does the same (video-room-chat.service.ts ~242-243); live-
      streaming has no escalation code path at all.
    - Add an explicit "escalate" endpoint alongside mute/kick/ban on
      audio-rooms/controllers/moderation.controller.ts and the video-
      rooms moderation controller, and a new one on
      live-stream.controller.ts, that lets a moderator flag a case as
      critical and route it to Official/Manager/Admin (reuse the
      severity-routing logic being built in Task 17 for reports, since
      this is conceptually the same escalation target, just triggered
      from a live room/stream instead of an already-filed report).
      Record the action via moderatorPerformanceService.recordAction
      (see Task 24) and apply the same shift/suspension/region guards as
      other moderation actions (Tasks 7, 15, 5).

=== PHASE 3 — MEDIUM ===

20. Merge shift countdown into the dashboard. Have
    MobileWorkforceService.moderatorDashboard
    (mobile-workforce.service.ts:151-176, currently returns the raw
    shift row from prisma.moderatorShift.findFirst) also call
    ModeratorShiftService.shiftStatus (moderator-shift.service.ts:
    159-193) and include nextShiftStartsInSeconds in the response.

21. Add an assignee field to RoomReport
    (prisma/schema/audio_rooms_moderation.prisma:109-129, currently has
    reviewedBy post-action only, no pre-action assignee) and its
    video-room equivalent, so "Assigned Reports/Investigation
    Queue/Assigned Rooms/Streams" dashboard sections have something real
    to query.

22. Add a region-scoped Live Monitoring endpoint for moderators. Today
    activeAudioRooms/activeVideoRooms only exist platform-wide in
    src/infra/ops/ops-dashboard.service.ts:46-47,153-154 (also mirrored
    platform-wide, not moderator-facing, in
    dashboard-operations.service.ts:27-28), and no Active Live Streams
    counter exists anywhere, even platform-wide — add one, then scope
    all three counts by the moderator's assigned region.

23. Wire up falseModerationCount, avgResolutionMinutes, and
    taskCompletionRate (prisma/schema/moderator_performance.prisma:
    13,14,16 — currently pure schema stubs, no read/write anywhere in
    src). falseModerationCount needs an "action overturned by Admin"
    concept; avgResolutionMinutes needs report-creation-to-resolution
    timing (depends on Phase 2 task 17's real report workflow);
    taskCompletionRate needs a target-setting mechanism. Also add
    avgResponseTime and daily/weekly/monthly targets, none of which
    exist today in any form.

24. Wire recordAction (moderator-performance.service.ts:37-75, accepts
    WARN|MUTE|KICK|BAN|REPORT_REVIEWED|REPORT_RESOLVED|REPORT_ESCALATED|
    ROOM_VISITED) into: audio-rooms' WARN/MUTE paths (today only
    KICK/BAN call it, at moderation.service.ts:151,261);
    moderator-warning.service.ts's issueWarning (never calls it at all);
    the new escalate action from Task 19; and the Reports Management
    flow from Phase 2 task 17 (REPORT_REVIEWED/RESOLVED/ESCALATED and
    ROOM_VISITED currently have zero callers anywhere since no reports
    module invokes them).

25. Add "Overdue" computation and a combined Assigned/Completed/Pending/
    Overdue+% endpoint to src/modules/tasks (zero "overdue" references
    exist there today) — compute overdue as assignments past their due
    date without COMPLETED status.

26. Route moderator-task-assignment.service.ts's notification write
    (lines 50-60, currently a direct prisma.notification.create) through
    NotificationService.create() (notification.service.ts:81-102) so it
    publishes NotificationCreatedEvent for real push/socket delivery
    instead of only appearing in a DB-backed inbox query.

27. Wire up the 6 dead notification types: MODERATOR_SHIFT_ENDING (via
    Phase 2 task 16), MODERATOR_TASK_DUE_SOON, MODERATOR_HIGH_PRIORITY_
    REPORT, MODERATOR_REPORT_ASSIGNED, MODERATOR_EMERGENCY_REQUEST,
    MODERATOR_POLICY_UPDATE — at their natural trigger points (task
    due-soon cron, high-priority report creation from Phase 2 task 17,
    report assignment from task 21, an emergency-request endpoint for
    Officials/Managers, a policy-update broadcast endpoint for Admins).

28. Extend the AuditLog model (prisma/schema/rbac.prisma:166-187,
    currently actorId/actorRole/action/resource/resourceId/details(Json)
    /ipAddress/userAgent/status/createdAt/evidenceId/liveStreamId) with
    targetUserId, roomId, and region columns, and parse browser/OS out
    of the combined userAgent string into their own fields.

29. Remove COUNTRY_MANAGER's audit.view grant
    (rbac-permissions.constants.ts:1780) — spec requires Admin/Super
    Admin only (ADMIN's grant at line 1740 stays).

30. Grant ADMIN the investigation.recording.view permission in
    rbac-permissions.constants.ts — today it's reachable only through
    SUPER_ADMIN's '*' wildcard (line 1586); ADMIN's full array (lines
    1593-1741) genuinely lacks it.

31. (Reconciliation addition) Make Live Stream's moderation-action log
    filterable by target user. GET :id/moderation/actions
    (live-stream.controller.ts, ~lines 102-107) currently returns every
    action for the stream with no query param to scope it — add a
    targetUserId query filter, mirroring the equivalent filtered views
    already present in audio-rooms/video-rooms moderation controllers.

32. (Reconciliation addition) Add an actual media/recording-asset
    reference to Investigation Recording. prisma/schema/
    investigation_recording.prisma (lines 1-25) currently has
    moderatorId, targetUserId, roomId, liveStreamId, regionId,
    violationReason, actionTaken, durationSeconds, evidenceId — no
    field pointing at an actual video/audio asset. Add a recordingUrl
    (or mediaId referencing wherever recorded media is stored — check
    src/infra/storage for the existing asset-storage pattern to reuse)
    and wire the recording pipeline to populate it once a real
    server-side capture mechanism exists. Coordinate with whoever owns
    the actual audio/video capture infrastructure (Agora/Zego, see
    src/infra/agora, src/infra/zego) since this task depends on that
    plumbing existing, not just the DB field.

33. (Reconciliation addition) Add moderator-specific notification types
    for Official Messages, Manager Instructions, and System
    Announcements, distinct from the generic ANNOUNCEMENT/SYSTEM types
    in prisma/schema/notification.prisma:233,235 that are currently
    shared with regular end users. Wire creation points for each: an
    Official/Manager-facing "send instruction to assigned moderators"
    endpoint, and an Admin-facing "broadcast policy/system update to all
    moderators" endpoint.

=== PHASE 4 — LOW ===

34. Enforce moderator (and Admin/Super Admin) anonymity in
    FollowService.follow() (src/modules/social/services/
    follow.service.ts:36-66) and FriendsService.sendRequest()
    (src/modules/social/services/friends.service.ts:53-115): reject with
    the existing "not found"-style response used elsewhere for hidden
    accounts when the target has isHiddenAccount true
    (HIDDEN_ROLES = ['SUPER_ADMIN','ADMIN','MODERATOR'] in
    src/modules/admin-identity/services/admin-identity.service.ts:18).

35. Decide and implement badge/frame/customId suppression for
    moderators. Note: resolvePublicIdentities
    (profile.service.ts:233-268) doesn't currently return
    badge/frame/customId fields at all in its public shape — figure out
    where those fields DO get serialized (full profile view, not the
    lightweight identity resolver) and add isHiddenAccount-based
    suppression there.

36. Restrict workforce.detail.view to ADMIN + SUPER_ADMIN only — remove
    it from COUNTRY_MANAGER (line 1760) and OFFICIAL (line 1799) in
    rbac-permissions.constants.ts. Separately, tighten viewerIsStaff
    (profile.service.ts:188-192, currently `return
    viewer?.isHiddenAccount ?? false`) so it doesn't let one Moderator
    view another hidden (staff) profile — restrict to
    ADMIN/SUPER_ADMIN roles specifically, not "any hidden account."

37. Filter hidden/moderator accounts out of raw presence counts in
    VideoRoomViewerQueryService (countAudience,
    video-room-viewer-query.service.ts:35-50) and
    VideoRoomMemberService.listPresence (video-room-member.service.ts:
    366-372) — both currently return raw DB/Redis counts with no
    isHiddenAccount filter, unlike the identity-resolved display path.

38. Add a moderator-specific session-limit override. session.manager.ts's
    enforceConcurrentLimit (lines 137-145) uses a single global
    SESSION_MAX_CONCURRENT (default 5, src/config/env.validation.ts:170)
    for every user with zero role branching — add a lower override
    (e.g. 1) specifically for accounts holding PlatformRole.MODERATOR.

39. (Reconciliation addition) Add username-based login. The spec lists
    "Username / Email" as valid staff login identifiers; the current
    login (auth.service.ts:118-141, and the new staff login from Task 9)
    only accepts email. Add a username field to the User model if one
    doesn't already exist (grep prisma/schema/users.prisma first — a
    displayName/handle field may already serve this purpose and just
    need wiring into the login lookup instead of a new column), and
    accept either identifier in the staff login DTO.

For each task: write/extend tests first, keep changes scoped to the files
named, and don't introduce new shared abstractions unless a task
explicitly calls for it (e.g. task 17's report-category/recommendation
work should stay per-surface, matching the existing audio-rooms/
video-rooms split, unless you hit real duplication implementing it).
```
