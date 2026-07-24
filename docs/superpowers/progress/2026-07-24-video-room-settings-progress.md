# VR-17 Video Room Settings — SDD Progress Ledger

Plan: docs/superpowers/plans/2026-07-24-video-room-settings.md
Mode: subagent-driven, NO GIT (per-task diffs via file snapshots, not commits)
Backend: /Users/lt611-18/soulzaa-backend   Mobile: /Users/lt611-18/soulzaa-mobile

## Status
(Tasks appended here as reviews come back clean. Trust this file over recollection.)

## Backend baseline (pre-phase, captured 2026-07-24)
Test Suites: 4 failed, 361 passed, 365 total
Tests:       9 failed, 4116 passed, 4125 total

PRE-EXISTING failures (NOT regressions — do not attribute to VR-17):
  - src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts   <-- in OUR module, watch closely
  - src/modules/wallet/repositories/wallet.repository.spec.ts
  - src/modules/wallet/services/wallet-ledger.spec.ts
  - src/modules/wallet/services/wallet.service.spec.ts

## Task log
Task 1: complete (settings event + socket constant). Review: spec OK, quality Approved.
  MINOR (deferred to final review): video-room.events.spec.ts:14 uses `as never` for the
  settings stub; a narrower `as unknown as VideoRoomSettingsView` would fail loudly if a
  later edit asserted on shape. Originates from the plan's own example test code.
Task 2: implemented (settings service map + fail-whole gating), review pending.
  OPEN ISSUE (must fix in Task 4): `seatApprovalRequired` is NOT declared on
  UpdateVideoRoomSettingsDto (schema-only, added VR-8). Without it the DTO whitelist
  drops the field and the "Auto-Accept Seat Requests" toggle silently no-ops.
  Resolution: Task 4 adds `@ApiPropertyOptional() @IsOptional() @IsBoolean() seatApprovalRequired?: boolean`
  to that DTO. Safe: the DTO is referenced by no live endpoint until Task 4 wires it.
Task 2: COMPLETE. Review: spec OK; 1 Important (plan-mandated error-code/status mismatch)
  -> escalated to owner -> chose VALIDATION_ERROR + 400 (keeps 403 reserved for
  "role changed", which the mobile controller keys its permission refetch on).
  Fix applied + verified (8/8 jest, tsc 0, eslint 0). Plan file updated to match.
  MINORS deferred to final review: (a) unused EVENT_BUS injection until Task 3 wires it;
  (b) no-op-patch "publishes nothing" assertion is vacuous until Task 3;
  (c) rejection path only exercised via maxDurationMinutes, other 8 excluded fields
      covered only by static array-membership assertions.
Task 3: implemented (dual publish: RoomSettingsUpdatedEvent always + ChatModeChangedEvent
  when allowChat/slowModeSeconds in patch). 11/11 jest, tsc 0. Review pending.
  NOTE A: video-room-socket.listener.ts:54-55 has 2 PRE-EXISTING prettier errors
    (room_ended / room:closed emit calls). Task 5 edits that file and its lint gate
    will trip on them -> Task 5 must run eslint --fix on that file.
  NOTE B: a Task 3 subagent ran `git diff HEAD` despite the no-git rule. Read-only,
    tree unaffected. Dispatch wording hardened for later tasks.
  NOTE C: eslint --fix rewrapped one Task-2 spec line; verified assertion unchanged.
Task 3: COMPLETE. Review: spec OK. 2 Important:
  (1) full-snapshot test was vacuous (toBeDefined would pass for the delta too) -> FIXED,
      now objectContaining({allowChat:false, slowModeSeconds:30}) - fields absent from the
      {allowGifts:false} patch, so a delta regression now fails the test. +publish count/order.
  (2) ChatModeChangedEvent construction now duplicated 3x (plan-mandated) -> DEFERRED.
      Fixing needs refactors inside video-room-chat-settings.service.ts and
      video-room-moderation.service.ts, which the owner's "no changes outside Video Room
      Settings" constraint forbids. A helper used only by the new service would not
      reduce the count. Raise at final review.
  MINORS deferred: imports placed mid-file in spec; NonNullable<> cast on toSettingsView.
Task 4: implemented (PATCH :id/settings + module reg + seatApprovalRequired added to DTO).
  Controller spec 12/12, settings service 11/11, tsc 0. Review pending.
  KNOWN TRANSIENT RED: video-room-socket.listener.spec.ts fails from Task 1 onward.
    Cause: that spec has a COMPLETENESS test iterating VIDEO_ROOM_SOCKET_EVENTS and
    asserting each has a handler. Task 1 added SETTINGS_UPDATED; Task 5 adds the
    subscription. Expected red for Tasks 1-4, MUST be green after Task 5.
    -> Gate for Task 5: this suite must pass.
Task 4: COMPLETE. Review: spec OK, quality Approved, no Critical/Important.
  Closed the seatApprovalRequired DTO gap (all 13 writable fields now on the DTO;
  rejected fields deliberately left in place). Module DI + test-assertion depth
  independently verified by reviewer against source.
  MINORS -> folded into Task 5: stale "returns 501" JSDoc on UpdateVideoRoomSettingsDto;
  curly apostrophe in the new @ApiOperation summary.
Task 5: COMPLETE. Review: spec OK, quality Approved, ZERO findings.
  Healed the transient red (listener spec 16/16). Completeness test assertions +
  BUS_ONLY allowlist verified untouched. Also fixed 2 pre-existing prettier errors,
  the stale "returns 501" DTO JSDoc, and the curly apostrophe.
  >>> PHASE A COMPLETE: PATCH /video-rooms/:id/settings is live, per-field gated,
      dual-publishing, and broadcasting video_room.settings_updated to the room.
Task 6: COMPLETE. Review: 1 Important (plan-mandated) — route hardcoded `undefined` for the
  `ip` audit param while sibling MANAGE_SEATS routes (lock/unlock) wire @Ip(). Would have
  logged ip:undefined on every seat.layout_changed audit record. FIXED: @Ip() ip wired and
  forwarded; both wiring tests now assert a real IP string. 21/21 green, tsc 0, eslint 0.
  Controller override of plan text reported to owner.
  MINOR deferred: dto/index.ts barrel export added (outside brief's file list; harmless,
  matches folder convention, no consumer imports via barrel).
Task 7: implemented. allowInvite guard on invite() (seat invite). Implementer flagged that
  inviteToRoom() would remain unguarded -> real hole (room invitations deliberately bypass
  the room password, so "Allow Invites: OFF" would still admit outsiders to a locked room).
  Controller decided to close it: guard added to inviteToRoom() too, via a file-local
  private helper assertInvitesAllowed(roomId, message) with path-specific messages.
  47/47 spec green (41 original + 6 new), tsc 0, eslint 0. Review pending.
Task 7: COMPLETE. Review: spec OK, quality Approved, zero Critical/Important.
  Both invite paths guarded via file-local assertInvitesAllowed helper; permission-precedence
  affirmatively tested (mock-reject + getSettings-never-called); harness default allowInvite:true
  so the 41 legacy tests still exercise the enabled path. 47/47.
Task 8: implemented. allowAnnouncements guard on create+update via file-local
  assertAnnouncementsAllowed. `remove` DELIBERATELY unguarded (disabling announcements must
  not trap existing ones) and pinned by a test so it cannot be quietly guarded later.
  Spec 8 -> 14 tests, all green. tsc 0, eslint 0. Review pending.
Task 8: COMPLETE. Review: spec OK, Approved, zero Critical/Important.
  remove() left unguarded + pinned. Permission-before-policy pinned. Harness default true.
  8 -> 14 tests. Reviewer independently confirmed the helper mirrors Task 7's shape.
Task 9: IMPLEMENTED + controller-verified, **PEER REVIEW NOT RUN** (owner asked to stop at 9).
  allowReporting guard on report() only (single call site -> inline, no helper).
  Verified by controller: exactly one getSettings call in the service (line 98, inside report);
  reviewReport / listReports / createSystemReport all unguarded, each pinned by a named test
  (spec lines 375, 428, 490); abuse-vector comment present (spec 483-488) explaining that
  gating createSystemReport would let a room owner blind auto-moderation in their own room;
  harness default { allowReporting: true } so the 20 legacy tests stay honest. 26/26 green.
  >>> ON RESUME: run the Task 9 peer review FIRST (package not yet built).

=========================================================================
STOPPED AT OWNER'S REQUEST AFTER TASK 9.  RESUME AT TASK 10.
=========================================================================

STATE: Tasks 1-8 complete (implemented + peer-reviewed + findings fixed).
       Task 9 implemented + controller-verified, peer review outstanding.
       Tasks 10-24 not started. NOTHING COMMITTED - all changes in working tree.

BACKEND IS FUNCTIONALLY COMPLETE FOR PHASES A+B AND 3 OF 4 GUARD TASKS:
  - PATCH /video-rooms/:id/settings   live, per-field permission gated, fail-whole
  - POST  /video-rooms/:id/seats/layout  live (exposes the orphaned configureLayout)
  - video_room.settings_updated broadcasting to the room
  - allowInvite / allowAnnouncements / allowReporting now genuinely enforced

RESUME CHECKLIST:
  1. Peer-review Task 9 (build package from snapshots/task-9 vs working tree).
  2. Task 10 (media guards). CRITICAL: verify which media entry points actually exist
     before writing guards. allowBeauty + allowCameraSwitch have routes
     (POST :id/media/beauty, :id/media/camera/switch). allowScreenShare and
     allowRecording were NEVER confirmed to have service methods — if absent, do NOT
     invent endpoints; document them as deferred (owner's explicit instruction).
  3. Tasks 11-24 are all MOBILE (/Users/lt611-18/soulzaa-mobile). No backend work left
     except whatever Task 10 defers.
  4. Mobile baseline not yet captured — run `flutter test` + `flutter analyze` in
     soulzaa-mobile BEFORE Task 11 so regressions are attributable.

DEFERRED / OPEN ITEMS FOR THE FINAL REVIEW:
  - ChatModeChangedEvent construction now duplicated 3x (chat-settings, moderation,
    settings services). Fixing needs edits to two out-of-scope services -> owner's
    "no changes outside Video Room Settings" rule blocks it. Owner decision needed.
  - Minor: `as never` cast in video-room.events.spec.ts:14 (from plan's example code).
  - Minor: dto/index.ts barrel export added in Task 6 (outside brief's file list; harmless).
  - Minor: Task 8 update() runs the policy gate before assertExists, so updating a
    non-existent announcement while disabled returns 403 rather than 404.
  - Minor: permission-before-policy ordering test covers create() but not update() (Task 8).

=========================================================================
TASK 10 COMPLETE — BACKEND (Tasks 1-10) IS DONE.  STOPPED AGAIN AT OWNER REQUEST.
=========================================================================
Task 10: COMPLETE. Review: spec OK, Approved, zero Critical/Important.
  SCOPE NARROWED ON EVIDENCE: verified only 2 of the 4 media flags are enforceable.
    allowBeauty      -> setBeauty (media.service:778)   + POST :id/media/beauty      GUARDED
    allowCameraSwitch-> switchCamera (media.service:593)+ POST :id/media/camera/switch GUARDED
    allowScreenShare -> NO method, NO route  -> DEFERRED, nothing invented
    allowRecording   -> NO method, NO route  -> DEFERRED, nothing invented
  CONSEQUENCE: removed allowScreenShare/allowRecording from WRITABLE_SETTINGS_FIELDS and
  SETTINGS_FIELD_PERMISSION (13 -> 11 writable fields). They now hit the generic rejection
  path (VALIDATION_ERROR/400) like the other deferred fields. DTO still declares them
  (runtime rejection is the designed behaviour). Rationale recorded in the doc comment.
  Media spec 35->40, settings spec 11->13. Guard ordering (assertSeated before policy) pinned.

FINAL BACKEND STATE (verified 2026-07-24):
  tsc 0 errors | eslint src/modules/video-rooms 0 problems
  Full suite: 4 failed / 363 passed / 367 suites; 9 failed / 4158 passed / 4167 tests
  vs BASELINE 4 failed / 361 passed / 365 suites; 9 failed / 4116 passed / 4125 tests
  => +2 suites, +42 passing tests, ZERO REGRESSIONS (identical 4 pre-existing failures)

SHIPPED SETTINGS SURFACE (final, all enforced):
  PATCH /video-rooms/:id/settings  -> 11 writable fields, per-field permission, fail-whole
    allowChat, slowModeSeconds            (ROOM_MUTE)
    allowAnnouncements                    (MANAGE_ANNOUNCEMENTS)
    seatApprovalRequired                  (MANAGE_SEATS)
    allowPk                               (START_PK)
    allowGifts, allowTreasure             (MANAGE_TREASURE)
    allowInvite, allowReporting,
    allowBeauty, allowCameraSwitch        (MANAGE_PARTICIPANTS)
  POST /video-rooms/:id/seats/layout -> hostSeatCount + guestSeatCount (MANAGE_SEATS)
  Broadcast: video_room.settings_updated (+ ChatModeChangedEvent on chat-policy fields)

REMAINING WORK: Task 9 peer review (outstanding), Tasks 11-24 (all mobile), final review.

Task 9: PEER REVIEW COMPLETE (run on resume). Spec OK, quality Approved, zero Critical/Important.
  Reviewer verified: single getSettings call site (inside report only); all three exclusions
  (reviewReport / listReports / createSystemReport) pinned by tests that would fail if guarded;
  abuse-vector comment present; inline guard (no over-abstraction for one call site);
  harness default { allowReporting: true }; disabled-path asserts error code AND non-persistence.
  Reviewer raised one ⚠️ (couldn't see the region before requireRoom from the diff hunks).
  CONTROLLER RESOLVED IT: report() order is self-report check -> requireRoom ->
  assertActiveMember -> policy guard. All validation precedes policy. Correct.
  MINORS deferred to final review: (a) reviewReport/listReports pins don't also assert
  getSettings was never called (cosmetic — the resolves-assertion already catches a guard);
  (b) guard fails OPEN when getSettings returns falsy (matches the prescribed pattern used
  by all four guards; a missing settings row reads as "allowed"). Same fail-open shape exists
  in Tasks 7, 8 and 10 — worth one consistent decision at the final review.

>>> ALL 10 BACKEND TASKS NOW COMPLETE AND PEER-REVIEWED. <<<
    Remaining: Tasks 11-24 (all mobile), then the final whole-branch review.
