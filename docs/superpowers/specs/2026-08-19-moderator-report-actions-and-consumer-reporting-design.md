# Moderator Portal Report Actions (Warn/Ban/Escalate/Close) + Consumer Report-User UI — Design

Status: Approved for implementation planning
Predecessor: [2026-08-18-moderator-portal-reports-design.md](./2026-08-18-moderator-portal-reports-design.md) (built the Reports list + Report Details screens and the generic `actionReport` decision endpoint this spec modifies).
Scope: (1) Narrow Report Details to exactly 4 moderator actions with corrected semantics — Warn, Ban, Close as false report, Escalate to admin. (2) Give the consumer app (USER role, same `soulzaa-mobile` app) a working "Report user" entry point in audio rooms and video rooms. Live-stream consumer reporting UI is explicitly out of scope (no live-stream viewer screen exists yet in the app).

## 1. Problem

The predecessor spec wired the Report Details screen's 6 action buttons (Warn/Mute/Kick/Ban/Escalate/Close false report) to real backend logic. Three of those six don't match the product's actual requirements:

- **Ban** routes every report-driven ban through `ModerationApprovalService` (an Official must approve before it takes effect). The product requirement is an immediate 24h platform ban — instant, no second reviewer — matching what the standalone `POST rooms/:id/moderation/platform-ban/:userId` endpoint already does outside the report flow.
- **Escalate** routes by severity to Officials/Country-Managers, reaching an actual Admin/Super-Admin only at the top severity or as a scope-fallback. The requirement is that escalating a report always notifies real Admin/Super-Admin accounts directly, with the moderator's and the report's details attached.
- **Warn** is correct for audio rooms today (private, target-only socket delivery with the moderator's identity replaced by a fixed system-actor id) but has not been verified for video rooms and has a known gap for live streams (`enforceModerationAction`'s WARN branch does nothing for the default PRIVATE scope; the comment claims "the existing private-notification path elsewhere handles it" without that path having been traced).
- The Flutter Report Details screen still shows 6 action tiles (Mute/Kick included) when the product only wants 4 (Warn/Ban/Escalate/Close as false report) surfaced here — Mute/Kick remain available through the in-room moderation sheet, just not through report review.

Separately, the consumer side of "a user reports another user" is incomplete:

- Audio rooms have no "report a user" entry point at all — only "report a chat message" (`report_message_sheet.dart`).
- Video rooms have a Report button in the participant profile sheet (`host_public_profile_sheet.dart`), but it's a dead stub: `// TODO: Open report dialog`.
- The backend submission endpoints for both (`POST rooms/:id/moderation/report`, `POST video-rooms/:id/report`) already exist, already require a reason, and need no changes.

## 2. Goals

- Report Details shows exactly 4 actions: Warn, Ban, Escalate to admin, Close as false report.
- Ban executes immediately (24h platform ban, realtime eviction, blocked from creating/joining any room) when triggered from a report, for all three room types — no approval step.
- Escalate always reaches real ADMIN/SUPER_ADMIN accounts with moderator + report detail, persisted so admins can review it later, for all three room types.
- Warn delivers privately to only the target user, with the moderator's identity hidden behind a fixed system-actor id, for all three room types (audio already correct; verify video; fix live-stream).
- Close as false report is unchanged (already correct).
- A member in an audio room or video room can report another user via the existing profile-tap overlay, reusing the existing report-reason sheet UI (generalized, not rebuilt).

## 3. Non-goals

- No live-stream consumer report UI — there is no live-stream viewer screen in `soulzaa-mobile` yet; wiring a Report button into a screen that doesn't exist is a separate, larger feature.
- No changes to Mute/Kick — they stay exactly as the predecessor spec left them, just removed from the Report Details tile grid. They remain reachable via the in-room moderation sheet (`moderation_action_sheet.dart` / `video-rooms-moderation.controller.ts`).
- No changes to the *other* existing severity-tiered escalation path (`escalateViolation` / `WorkforceScopeService.resolveEscalationRecipients`) used outside the report-decision flow (e.g., a moderator escalating a live violation they're actively observing). Only `actionReport`'s ESCALATE branch changes.
- No changes to `ModerationApprovalService` itself — it continues to exist and continues to be used by whatever other callers rely on it (e.g., a direct in-room Ban click via `moderation.controller.ts` outside the report flow, if that still routes through it). Only the report-decision BAN branch stops using it.

## 4. Ban — immediate 24h platform ban from a report

`MobileWorkforceService.actionReport`'s BAN branch currently calls `reviewReport(..., recommendedAction: 'BAN')`, which internally proposes a `ModerationActionApproval` row instead of executing (audio's `reviewReport`, `moderation.service.ts:893-910`; video and live-stream mirror this).

New behavior, for all three room types:

1. Update the report's own status to `ACTIONED` via the existing per-surface method, but **without** `recommendedAction` set (so the approval-routing branch inside `reviewReport` never triggers): audio/video call `reviewReport(actor, roomId, reportId, {status:'ACTIONED', resolution: note})`; live-stream calls `liveStreamReports.reviewReport({reportId, streamId, moderatorId, status:'ACTIONED', resolution: note})`.
2. Call `PlatformBanService.banUser({moderatorId: userId, targetUserId: ctx.targetUserId, reason: note, roomType: <mapped PlatformRoomType>, originRoomId: ctx.roomId, reportId})` directly — the same call the standalone `POST .../moderation/platform-ban/:userId` endpoints already make. This reuses the fully-built, tested 24h ban: Redis-enforced join/create gate, `endActiveRoomsFor`, cross-room-type eviction via `UserGloballyBannedEvent` + the three existing listeners, `disconnectUserEverywhere` after the 3s grace window, audit logging.
3. `MobileWorkforceService` gains a constructor dependency on `PlatformBanService` (`@Optional()`, consistent with its other cross-module deps per the predecessor spec's §4 pattern; a missing dependency must be a clear error on the write path, not a silent no-op).
4. Response `outcome` for BAN becomes `'executed'` (drop the `'pending_approval'` value for this action — it no longer applies to report-driven bans specifically; other callers of `ModerationApprovalService` are untouched and keep using it).

### 4.1 Schema change — trace a ban back to its report

Add a nullable field so admin views can show "this ban came from report X":

```prisma
model PlatformUserBan {
  // ...existing fields...
  reportId String? @db.Uuid
}
```

`BanUserInput` (in `platform-ban.service.ts`) gains an optional `reportId?: string`, threaded through to `PlatformBanRepository.create`. Existing callers (the standalone platform-ban endpoints, which have no report context) simply omit it — no behavior change for them.

## 5. Escalate to admin — reuse the existing EMERGENCY tier, don't build a new path

Today's ESCALATE branch calls `reviewReport(..., {status:'REVIEWED', resolution: note})` then `escalateViolation(actor, roomId, targetUserId, note, severity)` with `severity` derived from report priority (`HIGH`/`CRITICAL`), which routes via `WorkforceScopeService.resolveEscalationRecipients` — Officials/Country-Managers first, Admin only at `EMERGENCY` severity or as a no-coverage fallback.

Investigation during planning found this doesn't need new infrastructure: `resolveEscalationRecipients`'s `EMERGENCY` branch already does exactly `this.roles.getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN'])` — unconditionally every Admin/Super-Admin, no territory matching. And `escalateViolation`'s existing side-effect pipeline (`recordEscalationOutcome`, shared by all three room types via `src/modules/mobile-workforce/services/escalation-recorder.util.ts`) already creates a `MODERATION_CASE_ESCALATED` notification (existing `NotificationType` enum value) for each recipient, carrying `actorId` (the moderator), `entityType`/`entityId` (room type/id), and `data: {targetUserId, reason, severity}` — landing directly in each Admin's existing in-app notification inbox. This already satisfies "goes to the admin... with details of the moderator plus the report."

New behavior: in `actionReport`'s ESCALATE branch, replace the priority-derived `severity` computation with the literal `'EMERGENCY'` when calling `escalateViolation`, for all three room types. Tag the reason string with the report id (matching the existing `buildReportReviewReason`-style convention already used elsewhere in this codebase for embedding a report reference into a free-text reason): `` `[Report #${reportId} escalation] ${note}` `` — this is what ends up in the notification's `data.reason` and the audit log's `violationReason`, so an Admin opening the notification sees which report it came from without a schema change.

No Prisma changes for this section. No new service method, no new controller endpoint. The `reviewReport(REVIEWED)` status update stays exactly as it is today.

## 6. Warn — private, system-attributed delivery, all three room types

- **Audio**: no change. `ModerationService.warn()` with the default `PRIVATE` scope already: queues a `notifyUser` notification with no moderator id in the payload, and publishes `MemberWarnedEvent` → `ModerationSocketListener.anonymize()` swaps `moderatorId` for `SYSTEM_MODERATOR_ID` and adds a `systemMessage` string before emitting to just the target user's socket (`this.user(targetUserId, ...)`, never room-broadcast for PRIVATE scope). This is the reference behavior for the other two.
- **Video**: verify `VideoRoomModerationService`'s equivalent private-warn path mirrors the same anonymize-before-emit pattern (it has the analogous `VIDEO_ROOM_SYSTEM_ACTOR_ID` and `VideoRoomSystemMessageService` building blocks). Fix if the socket listener doesn't already scrub `moderatorId` the same way `ModerationSocketListener.anonymize()` does for audio.
- **Live stream**: this is the real gap. `LiveStreamService.enforceModerationAction`'s WARN branch only acts when `scope === 'ROOM'` (a room-wide broadcast) — PRIVATE (the default, and what report-driven warns use) currently does nothing at the socket layer. Trace what "the existing private-notification path elsewhere" (referenced in the code comment) actually is; if it does not deliver a targeted, system-attributed socket event to the specific target user, add one: `sockets.emitToUser(server, targetUserId, LIVE_STREAM_SOCKET_EVENTS.USER_WARNED, {streamId, moderatorId: SYSTEM_MODERATOR_ID, systemMessage: reason})`, mirroring audio's per-user targeting exactly. Live streams have no chat table, so there is no room-chat system message to also post — the private socket event (plus whatever push-notification path audio/video already use via `notifyUser`) is the full delivery surface.
- No endpoint changes — WARN continues through `actionReport` → `reviewReport(..., recommendedAction: 'WARNING'/'WARN')` exactly as the predecessor spec left it. Only the underlying per-room-type warn behavior is verified/fixed.

## 7. Close as false report

No changes. Already dismisses the report correctly (`dismissReport` / `reviewReport({status:'DISMISSED'})`) across all three room types.

## 8. Flutter — Report Details: trim to 4 actions

`moderator_report_details_screen.dart`:
- Remove the Mute and Kick tiles from the moderation-actions grid; keep Warn, Ban, Escalate, Close false report in a 2x2 layout (currently a 3+3 row split).
- Remove the `outcome == 'pending_approval'` branch from `_submitAction`'s success message (Ban is now immediate) — the success message becomes uniform, driven by `action`/`outcome` as returned (`'User banned for 24 hours.'` for BAN, `'Action recorded.'` otherwise, or similar — exact copy at implementation time).
- No other screen logic changes — `submitReportDecision` keeps sending `{action, note}` to the same endpoint; only the action vocabulary reachable from the UI shrinks.

## 9. Consumer-side "Report user" — audio rooms and video rooms

Both entry points reuse the **same** existing profile-tap overlay each room type already opens, and the **same** underlying report-reason sheet UI (generalized, not duplicated) — no new bottom-sheet mechanism is introduced anywhere in this section.

### 9.1 Shared report-reason sheet

Generalize `soulzaa-mobile/lib/features/audio_room/chat/presentation/widgets/report_message_sheet.dart`'s UI (title + `ChoiceChip` reason grid + optional description `TextField` + submit button, `showModalBottomSheet` host) into a small reusable widget parameterized by:
- `List<T> reasons` + `String Function(T) label`
- `Future<AppFailure?> Function(T reason, String? description) onSubmit`
- title / hint / submit-label strings

`report_message_sheet.dart` becomes a thin wrapper over this shared widget (unchanged behavior/UX, `ChatReportReason` as `T`). A new thin wrapper, `report_user_sheet.dart`, reuses the same shared widget with `T = ReportReason` (audio) or `T = VideoRoomReportReason` (video), submitting via a new use-case call (`POST rooms/:id/moderation/report` / `POST video-rooms/:id/report`) instead of the message-report one.

### 9.2 Audio room entry point

`seat_profile_card_overlay.dart`'s `UserProfileCardOverlay._buildActionButtons` already renders a "Primary Social Action Row" (Gift, Message) for `!isSelf`, and a separately-gated "Moderate" button for users with `RoomPermission.moderateUsers`. Add a "Report" action to this same row (visible to any non-self member, not gated on moderation permission), opening `report_user_sheet.dart` with `roomId` and the resolved `targetUserId`.

### 9.3 Video room entry point

`host_public_profile_sheet.dart` already has a Report button in its action row (`icon: Icons.warning_amber_rounded, label: 'Report'`) with a dead `// TODO: Open report dialog` handler. Replace the TODO with a call to `report_user_sheet.dart` (video variant), passing the room id and target user id already in scope at that call site.

### 9.4 Backend

No changes — `POST rooms/:id/moderation/report` (`ReportDto {targetUserId, reason: ReportReason, description?}`) and `POST video-rooms/:id/report` (`ReportVideoRoomUserDto {targetUserId, reason: VideoRoomReportReason, description?, messageId?}`) already exist, already require a reason, and already feed the moderator-portal queue this spec's other sections operate on.

## 10. Prisma migration summary

One migration, one additive nullable column (no data backfill needed):
- `PlatformUserBan.reportId String? @db.Uuid`

## 11. Testing plan

Backend (Jest):
- `platform-ban.service.spec.ts`: extend `banUser` tests to cover the new optional `reportId` passthrough.
- `mobile-workforce.service.spec.ts`: update BAN-branch tests to assert direct `PlatformBanService.banUser` invocation (no more `ModerationApprovalService.propose` routing) and `outcome: 'executed'`; update ESCALATE-branch tests to assert `escalateViolation` is called with `'EMERGENCY'` (not the priority-derived severity) and a report-tagged reason, for all three room types.
- Live-stream WARN: new test asserting a PRIVATE-scope warn emits a targeted, system-attributed socket event to the target user (whatever the fix in §6 turns out to be).
- Video-room WARN: new/extended test confirming the socket listener anonymizes `moderatorId` the same way audio's does, if it didn't already.

Flutter:
- `moderator_report_details_screen_test.dart`: update to assert exactly 4 tiles render, and that the success-message branch no longer special-cases `pending_approval`.
- New widget test for the generalized report-reason sheet (shared component), exercised via both the message-report and user-report wrappers.
- New test confirming the video-room Report button opens the sheet instead of a no-op.
- Manual verification: `flutter analyze` clean; walk the golden path in both audio and video rooms (tap a participant → Report → pick reason → submit → moderator later sees it in their scoped Reports queue) and the moderator golden path (open a report → Ban → user is evicted in realtime and blocked from rejoining; open another report → Escalate → check the admin audit-log surface shows it).

## 12. Risks / open items for implementation

- **Live-stream WARN's "existing private-notification path elsewhere"** (§6) — confirmed during planning to be dead: `LiveStreamService` injects `NOTIFICATION_SERVICE` but never calls it anywhere in the file. This is a real gap, not a verification no-op — §6's fix is required.
- **Video-room WARN** (§6) — confirmed during planning to already be correct: `VideoRoomModerationSocketListener` anonymizes `moderatorId` and targets only the recipient user, identical to audio's pattern. No code change needed there, only worth a locking-in test if one doesn't already exist.
- **DI wiring for `PlatformBanService` on `MobileWorkforceService`** (§4) — confirmed during planning to already be wired: `PlatformModerationModule` is already imported into `MobileWorkforceModule`, and `MobileWorkforceService` already has an `@Optional() platformBans?: PlatformBanService` constructor param (used today by the bans list/unban delegation). No new module wiring needed — this was the predecessor spec's flagged risk for other services, not this one.
