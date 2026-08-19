# Moderator Portal — Reports & Report Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Moderator Portal's Reports list and Report Details screens (backend + Flutter) show real data and actually execute moderation actions, by delegating to the already-built per-room-type moderation services instead of the current placeholder logic.

**Architecture:** `MobileWorkforceService` becomes a façade over the authoritative `ModerationService` (audio), `VideoRoomReportService`/`VideoRoomModerationService` (video), and `LiveStreamReportService`/`LiveStreamService` (live) — resolving which of the 3 report tables a `reportId` belongs to, then delegating reads/writes to that surface. A new `WorkforceScopeModule` is extracted first to break a real circular-import path this delegation would otherwise create.

**Tech Stack:** NestJS + Prisma (backend), Flutter + Riverpod + go_router (mobile), Jest (backend tests), flutter_test (Flutter tests).

**Spec:** [docs/superpowers/specs/2026-08-18-moderator-portal-reports-design.md](../specs/2026-08-18-moderator-portal-reports-design.md)

## Global Constraints

- No Prisma schema changes — priority/rule-violated are computed, not persisted.
- No changes to `moderateParticipant` (out of scope — separate Rooms-page sub-project).
- `note` is required (non-empty) server-side on the decision endpoint, not just client-side.
- The 6 action buttons map to exactly these normalized actions: `WARN | MUTE | KICK | BAN | ESCALATE | CLOSE_FALSE_REPORT`.
- Live-stream's `recommendedAction` literal is `'WARN'`; audio/video's is `'WARNING'` — never share one constant across surfaces for this value.
- New `MobileWorkforceService` dependencies are required (non-`@Optional()`) constructor params — a report action must fail loudly at boot/DI time if misconfigured, never silently no-op when a moderator clicks Ban.
- Flutter: no new test-mocking dependency. Use the existing in-repo convention — a hand-written `implements ModeratorRemoteDataSource` fake class with a `noSuchMethod` fallback (see `test/features/moderator/moderator_reports_screen_test.dart`'s `_FakeReportsDataSource`) — never introduce mockito/mocktail codegen for this feature.

---

## Task 1: Extract `WorkforceScopeModule` and export the mutation services the façade needs

`AudioRoomsModule` and `VideoRoomsModule` are `@Global()`, so once they export the mutation services, `MobileWorkforceService` can inject them directly with no import-graph change. `LiveStreamingModule` and `InvestigationRecordingModule` are **not** global and currently import `MobileWorkforceModule` (for `WorkforceScopeService`) — importing either of them back from `MobileWorkforceModule` would create a cycle. `ModerationApprovalModule` also imports `MobileWorkforceModule` and is itself imported by all three room-type modules, so it's a second cycle path once `LiveStreamingModule` is imported. Fix: extract `WorkforceScopeService` into its own module; redirect all 5 consumers to it instead of the full `MobileWorkforceModule`.

**Files:**
- Create: `src/modules/mobile-workforce/workforce-scope.module.ts`
- Modify: `src/modules/mobile-workforce/mobile-workforce.module.ts`
- Modify: `src/modules/audio-rooms/audio-rooms.module.ts`
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/live-streaming/live-streaming.module.ts`
- Modify: `src/modules/investigation-recording/investigation-recording.module.ts`
- Modify: `src/modules/moderation-approval/moderation-approval.module.ts`
- Test: `src/modules/mobile-workforce/geographic-scope.e2e-spec.ts` (existing — boots the real Nest app; the regression check for this task)

**Interfaces:**
- Produces: `WorkforceScopeModule` exporting `WorkforceScopeService` (unchanged class, unchanged public API — only which Nest module declares it changes).
- Produces: `ModerationService` now exported by `AudioRoomsModule`; `VideoRoomReportService` and `VideoRoomModerationService` now exported by `VideoRoomsModule` (all three usable via constructor injection by class type from any module, since both host modules are `@Global()`).

- [ ] **Step 1: Create `WorkforceScopeModule`**

```typescript
// src/modules/mobile-workforce/workforce-scope.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { WorkforceScopeService } from './services/workforce-scope.service';

/**
 * `WorkforceScopeService` split out of `MobileWorkforceModule` so the audio/
 * video/live-stream moderation modules — and `ModerationApprovalModule` and
 * `InvestigationRecordingModule` — can depend on just the scope service
 * without importing the whole mobile-workforce module. `MobileWorkforceModule`
 * needs to import those same modules for its Reports façade (Task 3+), and
 * Nest module imports can't form a cycle — this is the break point.
 */
@Module({
  imports: [PrismaModule],
  providers: [WorkforceScopeService],
  exports: [WorkforceScopeService],
})
export class WorkforceScopeModule {}
```

- [ ] **Step 2: Point the 5 cycle-causing modules at `WorkforceScopeModule` instead of `MobileWorkforceModule`**

In each of these 5 files, replace the import line and the `imports:` array entry:
```typescript
// Before (in all 5 files):
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
// ...
imports: [ /* ... */, MobileWorkforceModule, /* ... */ ],
```
```typescript
// After (in all 5 files):
import { WorkforceScopeModule } from 'src/modules/mobile-workforce/workforce-scope.module';
// ...
imports: [ /* ... */, WorkforceScopeModule, /* ... */ ],
```
Apply this to:
- `src/modules/audio-rooms/audio-rooms.module.ts` (the `imports:` array shown at lines 100-107)
- `src/modules/video-rooms/video-rooms.module.ts` (lines 214, 240-246)
- `src/modules/live-streaming/live-streaming.module.ts` (lines 9, 26-34)
- `src/modules/investigation-recording/investigation-recording.module.ts` (lines 3, 9)
- `src/modules/moderation-approval/moderation-approval.module.ts` (lines 3, 8)

- [ ] **Step 3: Export the mutation services**

In `src/modules/audio-rooms/audio-rooms.module.ts`, add `ModerationService` to `exports` (it's already a provider there):
```typescript
  exports: [
    AUDIO_ROOMS_SERVICE,
    VOICE_SERVICE,
    MODERATION_SERVICE,
    ModerationService, // NEW — MobileWorkforceService needs the full report/mutation
                        // surface, not just the read-only IModerationService contract
                        // MODERATION_SERVICE exposes.
    AUDIO_ROOM_CHAT_SERVICE,
    PK_BATTLE_SERVICE,
  ],
```

In `src/modules/video-rooms/video-rooms.module.ts`, add both to `exports` (currently just `[VIDEO_ROOMS_SERVICE]`):
```typescript
  exports: [
    VIDEO_ROOMS_SERVICE,
    VideoRoomReportService, // NEW
    VideoRoomModerationService, // NEW — escalateViolation() lives here
  ],
```
(`LiveStreamingModule` already exports `LiveStreamService` and `LiveStreamReportService` — no change needed there beyond Step 2's import swap.)

- [ ] **Step 4: Update `MobileWorkforceModule` to import `WorkforceScopeModule` and re-export it**

```typescript
// src/modules/mobile-workforce/mobile-workforce.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceController } from './controllers/mobile-workforce.controller';
import { ModeratorLiveMonitoringController } from './controllers/moderator-live-monitoring.controller';
import { MobileWorkforceService } from './services/mobile-workforce.service';
import { WorkforceScopeModule } from './workforce-scope.module';

import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';
import { ModeratorWarningModule } from 'src/modules/moderator-warning/moderator-warning.module';
import { LiveStreamingModule } from 'src/modules/live-streaming/live-streaming.module';
import { InvestigationRecordingModule } from 'src/modules/investigation-recording/investigation-recording.module';

/**
 * Mobile console for the operational workforce — Country Manager, Official and
 * Moderator. Business Development is intentionally not wired up yet.
 *
 * Read-only and geographically scoped: `WorkforceScopeService` narrows every
 * query to the caller's assigned territory.
 *
 * The Reports façade (see `MobileWorkforceService.actionReport`/`reportDetails`)
 * delegates to the authoritative per-room-type moderation services. Audio/Video
 * are `@Global()` (`AudioRoomsModule`/`VideoRoomsModule`) so their exports are
 * ambient — no explicit import needed. Live-streaming and investigation
 * recording are not global, so they're imported explicitly here; this only
 * works because both of them (and `ModerationApprovalModule`, which they in
 * turn import) now depend on `WorkforceScopeModule` rather than this module —
 * see `WorkforceScopeModule`'s doc comment for why that split exists.
 */
@Module({
  imports: [
    PrismaModule,
    ModeratorShiftModule,
    ModeratorWarningModule,
    WorkforceScopeModule,
    LiveStreamingModule,
    InvestigationRecordingModule,
  ],
  controllers: [MobileWorkforceController, ModeratorLiveMonitoringController],
  providers: [MobileWorkforceService, WorkforceScopeModule],
  exports: [MobileWorkforceService, WorkforceScopeModule],
})
export class MobileWorkforceModule {}
```

Note: `WorkforceScopeModule` should not be listed under `providers:` (it's a module, not a provider) — remove that line; only `imports`/`exports` need it. Corrected:
```typescript
@Module({
  imports: [
    PrismaModule,
    ModeratorShiftModule,
    ModeratorWarningModule,
    WorkforceScopeModule,
    LiveStreamingModule,
    InvestigationRecordingModule,
  ],
  controllers: [MobileWorkforceController, ModeratorLiveMonitoringController],
  providers: [MobileWorkforceService],
  exports: [MobileWorkforceService, WorkforceScopeModule],
})
export class MobileWorkforceModule {}
```

- [ ] **Step 5: Run the existing e2e spec to confirm no DI/circular-import breakage**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/geographic-scope.e2e-spec.ts`
Expected: PASS (this spec boots the real `AppModule` through Nest's DI container — if any of the 7 file edits above introduced a cycle or a missing export, this fails with a clear Nest `UnknownModulesException`/circular-dependency error, not a silent bug)

Also run the full suites for every module touched, to confirm nothing else regressed:
Run: `npx jest --config jest.config.js src/modules/mobile-workforce src/modules/audio-rooms/services/moderation.service.spec.ts src/modules/video-rooms/services/video-room-report.service.spec.ts src/modules/live-streaming/services/live-stream-report.service.spec.ts src/modules/moderation-approval`
Expected: PASS (all previously-green)

- [ ] **Step 6: Commit**

```bash
git add src/modules/mobile-workforce/workforce-scope.module.ts src/modules/mobile-workforce/mobile-workforce.module.ts src/modules/audio-rooms/audio-rooms.module.ts src/modules/video-rooms/video-rooms.module.ts src/modules/live-streaming/live-streaming.module.ts src/modules/investigation-recording/investigation-recording.module.ts src/modules/moderation-approval/moderation-approval.module.ts
git commit -m "refactor: extract WorkforceScopeModule to unblock mobile-workforce's Reports façade"
```

---

## Task 2: `report-classification.util.ts` — priority and rule-violated reference tables

Pure functions, no DI — the cheapest, highest-value tests in this plan.

**Files:**
- Create: `src/modules/mobile-workforce/services/report-classification.util.ts`
- Test: `src/modules/mobile-workforce/services/report-classification.util.spec.ts`

**Interfaces:**
- Produces: `deriveReportPriority(reason: string): 'Highest priority' | 'Medium priority' | 'Low priority'`
- Produces: `deriveRuleViolated(reason: string): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/modules/mobile-workforce/services/report-classification.util.spec.ts
import { deriveReportPriority, deriveRuleViolated } from './report-classification.util';

describe('deriveReportPriority', () => {
  it.each(['THREATS', 'SEXUAL_CONTENT', 'ADULT_CONTENT'])(
    '%s is Highest priority',
    (reason) => {
      expect(deriveReportPriority(reason)).toBe('Highest priority');
    },
  );

  it.each([
    'HARASSMENT',
    'HATE_SPEECH',
    'BULLYING',
    'ABUSE',
    'FAKE_PROFILE',
    'FAKE_ACCOUNT',
    'INAPPROPRIATE_CONTENT',
    'LIVE_STREAM_VIOLATION',
    'COMMUNITY_GUIDELINE_VIOLATION',
    'USER',
    'MESSAGE',
  ])('%s is Medium priority', (reason) => {
    expect(deriveReportPriority(reason)).toBe('Medium priority');
  });

  it.each(['SPAM', 'FRAUD', 'COPYRIGHT', 'OTHER'])('%s is Low priority', (reason) => {
    expect(deriveReportPriority(reason)).toBe('Low priority');
  });

  it('defaults an unmapped reason to Medium priority, never Low', () => {
    expect(deriveReportPriority('SOME_FUTURE_ENUM_VALUE')).toBe('Medium priority');
  });
});

describe('deriveRuleViolated', () => {
  it('maps SEXUAL_CONTENT and ADULT_CONTENT to the same rule code', () => {
    expect(deriveRuleViolated('SEXUAL_CONTENT')).toBe('Sexual content & nudity (3.1)');
    expect(deriveRuleViolated('ADULT_CONTENT')).toBe('Sexual content & nudity (3.1)');
  });

  it('maps HATE_SPEECH, THREATS, and HARASSMENT/BULLYING to distinct codes', () => {
    expect(deriveRuleViolated('HATE_SPEECH')).toBe('Hate speech & discrimination (2.1)');
    expect(deriveRuleViolated('THREATS')).toBe('Threats & violence (2.3)');
    expect(deriveRuleViolated('HARASSMENT')).toBe('Harassment & bullying (2.2)');
    expect(deriveRuleViolated('BULLYING')).toBe('Harassment & bullying (2.2)');
  });

  it('falls back to a generic code for OTHER or an unmapped reason', () => {
    expect(deriveRuleViolated('OTHER')).toBe('Other community guideline violation (7.1)');
    expect(deriveRuleViolated('SOME_FUTURE_ENUM_VALUE')).toBe(
      'Other community guideline violation (7.1)',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/report-classification.util.spec.ts`
Expected: FAIL with "Cannot find module './report-classification.util'"

- [ ] **Step 3: Implement**

```typescript
// src/modules/mobile-workforce/services/report-classification.util.ts

/**
 * Static reason → severity/rule-code reference tables for the Moderator
 * Portal Reports pages. These replace `mobile-workforce.service.ts`'s old
 * room-type-based fabrication (video always "Highest", audio always
 * "Medium", rule code always ".1"/".4" regardless of reason). The Highest
 * tier is anchored on `HIGH_PRIORITY_REPORT_REASONS` (THREATS, SEXUAL_CONTENT),
 * the one real severity signal duplicated across the audio/video/live-stream
 * report services today — extended with ADULT_CONTENT, the same category
 * under RoomReport's reason enum. `deriveRuleViolated`'s codes are a
 * codebase-defined reference catalog, not an externally sourced compliance
 * document — same reason always maps to the same code, but don't treat the
 * numbers as legally meaningful.
 */

const HIGHEST_PRIORITY_REASONS = new Set(['THREATS', 'SEXUAL_CONTENT', 'ADULT_CONTENT']);

const LOW_PRIORITY_REASONS = new Set(['SPAM', 'FRAUD', 'COPYRIGHT', 'OTHER']);

export function deriveReportPriority(
  reason: string,
): 'Highest priority' | 'Medium priority' | 'Low priority' {
  if (HIGHEST_PRIORITY_REASONS.has(reason)) return 'Highest priority';
  if (LOW_PRIORITY_REASONS.has(reason)) return 'Low priority';
  return 'Medium priority';
}

const RULE_CATALOG: Record<string, string> = {
  SEXUAL_CONTENT: 'Sexual content & nudity (3.1)',
  ADULT_CONTENT: 'Sexual content & nudity (3.1)',
  INAPPROPRIATE_CONTENT: 'Inappropriate content (3.2)',
  HATE_SPEECH: 'Hate speech & discrimination (2.1)',
  HARASSMENT: 'Harassment & bullying (2.2)',
  BULLYING: 'Harassment & bullying (2.2)',
  THREATS: 'Threats & violence (2.3)',
  ABUSE: 'Platform abuse (4.1)',
  SPAM: 'Spam & fraudulent activity (4.2)',
  FRAUD: 'Spam & fraudulent activity (4.2)',
  FAKE_PROFILE: 'Fake profile & impersonation (1.1)',
  FAKE_ACCOUNT: 'Fake profile & impersonation (1.1)',
  COPYRIGHT: 'Copyright infringement (5.1)',
  LIVE_STREAM_VIOLATION: 'Live stream policy violation (6.1)',
  COMMUNITY_GUIDELINE_VIOLATION: 'Community guideline violation (6.2)',
  USER: 'Community guideline violation (6.2)',
  MESSAGE: 'Community guideline violation (6.2)',
};

const DEFAULT_RULE = 'Other community guideline violation (7.1)';

export function deriveRuleViolated(reason: string): string {
  return RULE_CATALOG[reason] ?? DEFAULT_RULE;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/report-classification.util.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce/services/report-classification.util.ts src/modules/mobile-workforce/services/report-classification.util.spec.ts
git commit -m "feat: add reason-to-priority and reason-to-rule-code reference tables for moderator reports"
```

---

## Task 3: Wire new dependencies into `MobileWorkforceService` and add `resolveReportContext`

Plumbing task: gets the constructor and the shared report-lookup helper in place so Tasks 4-6 can build on a stable interface. No behavior change to existing methods.

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- Consumes: `ModerationService` (from `src/modules/audio-rooms/services/moderation.service.ts`), `VideoRoomReportService`/`VideoRoomModerationService` (from `src/modules/video-rooms/services/...`), `LiveStreamReportService`/`LiveStreamService` (from `src/modules/live-streaming/services/...`), `InvestigationRecordingService` (from `src/modules/investigation-recording/services/investigation-recording.service.ts`), `PermissionResolver` (from `src/modules/authorization/services/permission-resolver.service.ts`, `@Global()` — no module import needed).
- Produces: `private async resolveReportContext(reportId: string): Promise<ReportContext>` where
  ```typescript
  type ReportRoomType = 'audio' | 'video' | 'stream';
  interface ReportContext {
    roomType: ReportRoomType;
    roomId: string; // roomId for audio/video, streamId for stream
    reporterId: string;
    targetUserId: string;
    reason: string;
    description: string | null;
    status: string;
    createdAt: Date;
    assignedAt: Date | null;
  }
  ```
  Throws `NotFoundException('Report not found.')` if no table has a matching row.

- [ ] **Step 1: Update the spec file's construction call to supply the 5 new required mocks**

```typescript
// src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
// Add near the top, alongside the existing `prisma`/`scope`/`scopes` mocks:
const audioModeration = {
  reviewReport: jest.fn(),
  dismissReport: jest.fn(),
  escalateViolation: jest.fn(),
};
const videoReports = { reviewReport: jest.fn(), dismissReport: jest.fn() };
const videoModeration = { escalateViolation: jest.fn() };
const liveStreamReports = { reviewReport: jest.fn() };
const liveStream = { escalateViolation: jest.fn() };
const investigationRecording = { getCaseView: jest.fn().mockResolvedValue({ recordings: [], auditLogs: [] }) };
const permissionResolver = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  hasPermission: jest.fn().mockReturnValue(false),
};
```

Also add `assertModeratorInScope: jest.fn().mockResolvedValue(undefined)` to the existing top-level `scope` mock object declared near the top of the file (`const scope = { userScopeFilter: jest.fn(), describeScope: jest.fn() };`), so every describe block shares one working mock instead of each test monkey-patching `(service as any).scope`:

```typescript
const scope = {
  userScopeFilter: jest.fn(),
  describeScope: jest.fn(),
  assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
};
```

Then update the `service = new MobileWorkforceService(...)` call in `beforeEach` to pass all of them positionally after the existing 3 args (`prisma`, `scope`, `scopes`) and before the existing optional trailing args (`undefined` for `shiftService`, `undefined` for `warnings`, matching their current call — see Step 2 for the exact new constructor order).

- [ ] **Step 2: Add the new constructor parameters**

```typescript
// src/modules/mobile-workforce/services/mobile-workforce.service.ts — constructor
import { ModerationService } from 'src/modules/audio-rooms/services/moderation.service';
import { VideoRoomReportService } from 'src/modules/video-rooms/services/video-room-report.service';
import { VideoRoomModerationService } from 'src/modules/video-rooms/services/video-room-moderation.service';
import { LiveStreamReportService } from 'src/modules/live-streaming/services/live-stream-report.service';
import { LiveStreamService } from 'src/modules/live-streaming/services/live-stream.service';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import { NotFoundException } from '@nestjs/common';

// ...

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
    private readonly scopes: GeographicScopeResolver,
    @Optional() private readonly shiftService?: ModeratorShiftService,
    @Optional() private readonly warnings?: ModeratorWarningService,
    private readonly audioModeration?: ModerationService,
    private readonly videoReports?: VideoRoomReportService,
    private readonly videoModeration?: VideoRoomModerationService,
    private readonly liveStreamReports?: LiveStreamReportService,
    private readonly liveStream?: LiveStreamService,
    private readonly investigationRecording?: InvestigationRecordingService,
    private readonly permissionResolver?: PermissionResolver,
  ) {}
```

Note on the trailing `?`: TypeScript requires optional constructor params to come after required ones, and `shiftService`/`warnings` (existing, genuinely `@Optional()` in Nest's DI sense) sit in the middle of the list. Marking the 7 new params with a bare `?` (not `@Optional()`) satisfies TypeScript's ordering rule while Nest still injects them as normal *required* providers — a param only becomes Nest-optional when it carries the `@Optional()` decorator, which none of these 7 do. Read that as "TypeScript-optional to satisfy parameter ordering, but Nest-required" — if any of the 7 modules can't supply its provider, Nest throws at boot, not at first use.

- [ ] **Step 3: Add `resolveReportContext`**

```typescript
// src/modules/mobile-workforce/services/mobile-workforce.service.ts — new private method,
// placed near the other private helpers (e.g. after `resolveUserScope`)

type ReportRoomType = 'audio' | 'video' | 'stream';

interface ReportContext {
  roomType: ReportRoomType;
  roomId: string;
  reporterId: string;
  targetUserId: string;
  reason: string;
  description: string | null;
  status: string;
  createdAt: Date;
  assignedAt: Date | null;
}

  /**
   * Resolves which of the 3 report tables `reportId` belongs to. Sequential
   * lookups are cheap (at most 3 indexed `findUnique` calls) and a UUID
   * collision across tables is not a real risk — every caller in this
   * service (`moderationQueue`, `reportDetails`, `actionReport`) needs this
   * exact resolution, so it lives here once instead of being copy-pasted
   * three times.
   */
  private async resolveReportContext(reportId: string): Promise<ReportContext> {
    const audio = await this.prisma.roomReport.findUnique({ where: { id: reportId } });
    if (audio) {
      return {
        roomType: 'audio',
        roomId: audio.roomId,
        reporterId: audio.reporterId,
        targetUserId: audio.targetUserId,
        reason: audio.reason,
        description: audio.description,
        status: audio.status,
        createdAt: audio.createdAt,
        assignedAt: audio.assignedAt,
      };
    }

    const video = await this.prisma.videoRoomReport.findUnique({ where: { id: reportId } });
    if (video) {
      return {
        roomType: 'video',
        roomId: video.roomId,
        reporterId: video.reporterId,
        targetUserId: video.targetUserId,
        reason: video.reason,
        description: video.description,
        status: video.status,
        createdAt: video.createdAt,
        assignedAt: video.assignedAt,
      };
    }

    const stream = await this.prisma.liveStreamReport.findUnique({ where: { id: reportId } });
    if (stream) {
      return {
        roomType: 'stream',
        roomId: stream.streamId,
        reporterId: stream.reporterId,
        targetUserId: stream.targetUserId,
        reason: stream.reason,
        description: stream.description,
        status: stream.status,
        createdAt: stream.createdAt,
        assignedAt: null,
      };
    }

    throw new NotFoundException('Report not found.');
  }
```

- [ ] **Step 4: Add a focused test for `resolveReportContext` and run the full existing suite**

```typescript
// src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts — new describe block
describe('resolveReportContext', () => {
  it('resolves an audio report and maps roomId from RoomReport', async () => {
    prisma.roomReport.findUnique = jest.fn().mockResolvedValue({
      id: 'r-1', roomId: 'room-1', reporterId: 'u-1', targetUserId: 'u-2',
      reason: 'HARASSMENT', description: null, status: 'PENDING',
      createdAt: new Date('2026-08-18'), assignedAt: null,
    });
    prisma.videoRoomReport.findUnique = jest.fn();
    prisma.liveStreamReport.findUnique = jest.fn();

    const ctx = await (service as any).resolveReportContext('r-1');

    expect(ctx.roomType).toBe('audio');
    expect(ctx.roomId).toBe('room-1');
    expect(prisma.videoRoomReport.findUnique).not.toHaveBeenCalled();
  });

  it('falls through to video, then live-stream, before giving up', async () => {
    prisma.roomReport.findUnique = jest.fn().mockResolvedValue(null);
    prisma.videoRoomReport.findUnique = jest.fn().mockResolvedValue(null);
    prisma.liveStreamReport.findUnique = jest.fn().mockResolvedValue({
      id: 'r-3', streamId: 'stream-1', reporterId: 'u-1', targetUserId: 'u-2',
      reason: 'SPAM', description: null, status: 'PENDING',
      createdAt: new Date('2026-08-18'),
    });

    const ctx = await (service as any).resolveReportContext('r-3');

    expect(ctx.roomType).toBe('stream');
    expect(ctx.roomId).toBe('stream-1');
    expect(ctx.assignedAt).toBeNull();
  });

  it('throws NotFoundException when no table has the id', async () => {
    prisma.roomReport.findUnique = jest.fn().mockResolvedValue(null);
    prisma.videoRoomReport.findUnique = jest.fn().mockResolvedValue(null);
    prisma.liveStreamReport.findUnique = jest.fn().mockResolvedValue(null);

    await expect((service as any).resolveReportContext('missing')).rejects.toThrow(
      'Report not found.',
    );
  });
});
```

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`
Expected: PASS (existing tests still green with the new mocks supplied, plus the 3 new cases)

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "feat: wire per-room-type moderation services into MobileWorkforceService and add resolveReportContext"
```

---

## Task 4: Rewrite `moderationQueue()` — live-stream inclusion, real priority/rule/region

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts` (the `moderationQueue` method)
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- Consumes: `deriveReportPriority`, `deriveRuleViolated` (Task 2).
- Produces: `moderationQueue(userId: string, limit = 25)` — same return shape as today (array of formatted report objects) plus live-stream reports now included, `priority`/`ruleViolated` real, `status` collapsed to `'Under review'`/`'Resolved'`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
describe('moderationQueue — real priority, rule-violated, and live-stream inclusion', () => {
  beforeEach(() => {
    scope.userScopeFilter.mockResolvedValue({});
    prisma.liveStreamReport.findMany = jest.fn().mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
  });

  it('includes live-stream reports alongside audio and video', async () => {
    prisma.roomReport.findMany.mockResolvedValue([]);
    prisma.videoRoomReport.findMany.mockResolvedValue([]);
    prisma.liveStreamReport.findMany.mockResolvedValue([
      {
        id: 'ls-1', streamId: 'stream-1', reporterId: 'u-1', targetUserId: 'u-2',
        reason: 'HATE_SPEECH', description: null, status: 'PENDING',
        createdAt: new Date('2026-08-18T10:00:00Z'), assignedAt: null,
      },
    ]);
    prisma.liveStream = { findMany: jest.fn().mockResolvedValue([{ id: 'stream-1', title: 'Live zone', hostId: 'host-1' }]) };
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-1', username: 'reporter', fullName: 'Reporter' },
      { id: 'u-2', username: 'target', fullName: 'Target' },
      { id: 'host-1', locationState: { name: 'Karnataka' } },
    ]);

    const result = await service.moderationQueue('mod-1');

    expect(result).toHaveLength(1);
    expect(result[0].roomType).toBe('stream');
    expect(result[0].priority).toBe('Medium priority'); // HATE_SPEECH
    expect(result[0].region).toBe('Karnataka');
  });

  it('derives priority from the real reason, not the room type', async () => {
    prisma.roomReport.findMany.mockResolvedValue([
      {
        id: 'ar-1', roomId: 'room-1', reporterId: 'u-1', targetUserId: 'u-2',
        reason: 'THREATS', description: null, status: 'PENDING',
        createdAt: new Date('2026-08-18T10:00:00Z'), assignedAt: null,
      },
    ]);
    prisma.videoRoomReport.findMany.mockResolvedValue([]);
    prisma.audioRoom.findMany.mockResolvedValue([{ id: 'room-1', name: 'Chill vibes', ownerId: 'owner-1' }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-1', username: 'reporter', fullName: 'Reporter' },
      { id: 'u-2', username: 'target', fullName: 'Target' },
      { id: 'owner-1', locationState: null },
    ]);

    const result = await service.moderationQueue('mod-1');

    // Old behavior hardcoded every audio report to "Medium priority" regardless
    // of reason — THREATS must now come back Highest.
    expect(result[0].priority).toBe('Highest priority');
    expect(result[0].ruleViolated).toBe('Threats & violence (2.3)');
  });

  it('collapses REVIEWED/ACTIONED/DISMISSED to "Resolved" and PENDING to "Under review"', async () => {
    prisma.roomReport.findMany.mockResolvedValue([
      { id: 'ar-1', roomId: 'room-1', reporterId: 'u-1', targetUserId: 'u-2', reason: 'SPAM', description: null, status: 'ACTIONED', createdAt: new Date(), assignedAt: null },
    ]);
    prisma.videoRoomReport.findMany.mockResolvedValue([]);
    prisma.audioRoom.findMany.mockResolvedValue([{ id: 'room-1', name: 'Room', ownerId: 'owner-1' }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'owner-1', locationState: null }]);

    const result = await service.moderationQueue('mod-1');

    expect(result[0].status).toBe('Resolved');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts -t "real priority, rule-violated"`
Expected: FAIL (live-stream reports absent from result; priority/ruleViolated not present or wrong)

- [ ] **Step 3: Rewrite `moderationQueue`**

Replace the existing `moderationQueue` method body (currently lines ~133-293 of `mobile-workforce.service.ts`) with:

```typescript
  import { deriveReportPriority, deriveRuleViolated } from './report-classification.util';

  /**
   * Moderation queue for my scope — audio, video, and live-stream reports
   * combined. Priority and rule-violated are derived from the report's real
   * `reason` (Task 2's reference tables), not fabricated per room type.
   */
  async moderationQueue(userId: string, limit = 25) {
    const scopeWhere = await this.scope.userScopeFilter(userId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    let reporterFilter: Record<string, unknown> = {};
    if (!isUnrestricted) {
      const inScope = await this.prisma.user.findMany({
        where: scopeWhere,
        select: { id: true },
      });
      reporterFilter = { reporterId: { in: inScope.map((u) => u.id) } };
    }

    const [audioReports, videoReports, streamReports] = await Promise.all([
      this.prisma.roomReport.findMany({
        where: { ...reporterFilter },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
      this.prisma.videoRoomReport.findMany({
        where: { ...reporterFilter },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
      this.prisma.liveStreamReport.findMany({
        where: { ...reporterFilter },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
    ]);

    const userIds = [
      ...audioReports.map((r) => r.reporterId),
      ...videoReports.map((r) => r.reporterId),
      ...streamReports.map((r) => r.reporterId),
      ...audioReports.map((r) => r.targetUserId),
      ...videoReports.map((r) => r.targetUserId),
      ...streamReports.map((r) => r.targetUserId),
    ];
    const audioRoomIds = audioReports.map((r) => r.roomId);
    const videoRoomIds = videoReports.map((r) => r.roomId);
    const streamIds = streamReports.map((r) => r.streamId);

    const [users, audioRoomsList, videoRoomsList, streamsList] = await Promise.all([
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [],
      audioRoomIds.length > 0
        ? this.prisma.audioRoom.findMany({
            where: { id: { in: audioRoomIds } },
            select: { id: true, name: true, ownerId: true },
          })
        : [],
      videoRoomIds.length > 0
        ? this.prisma.videoRoom.findMany({
            where: { id: { in: videoRoomIds } },
            select: { id: true, name: true, ownerId: true },
          })
        : [],
      streamIds.length > 0
        ? this.prisma.liveStream.findMany({
            where: { id: { in: streamIds } },
            select: { id: true, title: true, hostId: true },
          })
        : [],
    ]);

    const ownerIds = [
      ...audioRoomsList.map((r) => r.ownerId),
      ...videoRoomsList.map((r) => r.ownerId),
      ...streamsList.map((s) => s.hostId),
    ];
    const owners =
      ownerIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, locationState: { select: { name: true } } },
          })
        : [];
    const ownerStateMap = new Map(owners.map((o) => [o.id, o.locationState?.name ?? null]));
    const userMap = new Map(users.map((u) => [u.id, u]));
    const audioRoomMap = new Map(audioRoomsList.map((r) => [r.id, r]));
    const videoRoomMap = new Map(videoRoomsList.map((r) => [r.id, r]));
    const streamMap = new Map(streamsList.map((s) => [s.id, s]));

    const statusLabel = (status: string) => (status === 'PENDING' ? 'Under review' : 'Resolved');
    const codeFor = (prefix: string, id: string) =>
      `${prefix}-${id.substring(0, 4)}-${id.substring(id.length - 4)}`.toUpperCase();
    const humanize = (reason: string) =>
      reason.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
    const assignedTimeFor = (assignedAt: Date | null, createdAt: Date) =>
      new Date(assignedAt ?? createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const formattedReports = [
      ...videoReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const room = videoRoomMap.get(r.roomId);
        return {
          id: r.id,
          reportCode: codeFor('RPT', r.id),
          roomType: 'video',
          roomTitle: room?.name || 'Video room',
          reporterName: reporter?.fullName || reporter?.username || 'Reporter',
          reporterId: r.reporterId.substring(0, 6),
          targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
          targetUserId: r.targetUserId.substring(0, 6),
          region: (room?.ownerId && ownerStateMap.get(room.ownerId)) || 'Unassigned',
          violationReason: humanize(r.reason),
          description: r.description || 'Violation reported in video room.',
          priority: deriveReportPriority(r.reason),
          ruleViolated: deriveRuleViolated(r.reason),
          status: statusLabel(r.status),
          createdAt: r.createdAt.toISOString(),
          evidenceId: codeFor('EV', r.id),
          evidenceType: 'System evidence',
          evidenceNote: 'Automatically captured by the system',
          assignedTime: assignedTimeFor(r.assignedAt, r.createdAt),
        };
      }),
      ...audioReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const room = audioRoomMap.get(r.roomId);
        return {
          id: r.id,
          reportCode: codeFor('RPT', r.id),
          roomType: 'audio',
          roomTitle: room?.name || 'Audio room',
          reporterName: reporter?.fullName || reporter?.username || 'Reporter',
          reporterId: r.reporterId.substring(0, 6),
          targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
          targetUserId: r.targetUserId.substring(0, 6),
          region: (room?.ownerId && ownerStateMap.get(room.ownerId)) || 'Unassigned',
          violationReason: humanize(r.reason),
          description: r.description || 'Violation reported in audio room.',
          priority: deriveReportPriority(r.reason),
          ruleViolated: deriveRuleViolated(r.reason),
          status: statusLabel(r.status),
          createdAt: r.createdAt.toISOString(),
          evidenceId: codeFor('EV', r.id),
          evidenceType: 'System evidence',
          evidenceNote: 'Automatically captured by the system',
          assignedTime: assignedTimeFor(r.assignedAt, r.createdAt),
        };
      }),
      ...streamReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const stream = streamMap.get(r.streamId);
        return {
          id: r.id,
          reportCode: codeFor('RPT', r.id),
          roomType: 'stream',
          roomTitle: stream?.title || 'Live stream',
          reporterName: reporter?.fullName || reporter?.username || 'Reporter',
          reporterId: r.reporterId.substring(0, 6),
          targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
          targetUserId: r.targetUserId.substring(0, 6),
          region: (stream?.hostId && ownerStateMap.get(stream.hostId)) || 'Unassigned',
          violationReason: humanize(r.reason),
          description: r.description || 'Violation reported in live stream.',
          priority: deriveReportPriority(r.reason),
          ruleViolated: deriveRuleViolated(r.reason),
          status: statusLabel(r.status),
          createdAt: r.createdAt.toISOString(),
          evidenceId: codeFor('EV', r.id),
          evidenceType: 'System evidence',
          evidenceNote: 'Automatically captured by the system',
          assignedTime: assignedTimeFor(null, r.createdAt),
        };
      }),
    ];

    return formattedReports;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`
Expected: PASS (new tests plus all pre-existing `moderationQueue`/`regionalDailyActivity`/etc. tests, since the scope-composition and reporter-filter logic is unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "feat: derive real priority/rule-violated and include live-stream reports in the moderation queue"
```

---

## Task 5: `reportDetails()` — new method + evidence resolution + controller route

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Modify: `src/modules/mobile-workforce/controllers/mobile-workforce.controller.ts`
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- Consumes: `resolveReportContext` (Task 3), `deriveReportPriority`/`deriveRuleViolated` (Task 2), `this.investigationRecording.getCaseView(targetUserId)` → `{targetUserId, recordings: InvestigationRecording[], auditLogs}` where each recording has `roomId: string|null, liveStreamId: string|null, evidenceId: string, recordingUrl: string|null, startedAt: Date`, `this.permissionResolver.resolveUserPermissions(userId): Promise<Set<string>>` + `.hasPermission(set, perm): boolean`.
- Produces: `reportDetails(userId: string, reportId: string): Promise<ReportDetailsDto>` — see the response shape in Step 3.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
//
// IMPORTANT: `reportDetails` looks up rooms/streams/users with `findUnique`
// (single record by id), never `findMany` — the base `prisma` mock at the top
// of this file only predefines `findMany` for audioRoom/videoRoom/liveStream
// and no `findUnique` at all for `user`. Every test below must stub
// `findUnique` explicitly, or the implementation throws
// "prisma.X.findUnique is not a function".
describe('reportDetails', () => {
  const usersById: Record<string, { username?: string; fullName?: string; locationState?: { name: string } | null }> = {
    'u-1': { username: 'reporter', fullName: 'Reporter' },
    'u-2': { username: 'target', fullName: 'Target' },
    'owner-1': { locationState: { name: 'Karnataka' } },
  };

  beforeEach(() => {
    prisma.roomReport.findUnique = jest.fn();
    prisma.videoRoomReport.findUnique = jest.fn();
    prisma.liveStreamReport.findUnique = jest.fn();
    prisma.audioRoom.findUnique = jest.fn();
    prisma.videoRoom.findUnique = jest.fn();
    prisma.liveStream.findUnique = jest.fn();
    prisma.user.findUnique = jest
      .fn()
      .mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(usersById[where.id] ?? null),
      );
    prisma.roomReport.count = jest.fn().mockResolvedValue(0);
    prisma.videoRoomReport.count = jest.fn().mockResolvedValue(0);
    prisma.liveStreamReport.count = jest.fn().mockResolvedValue(0);
    scope.userScopeFilter.mockResolvedValue({});
    scope.assertModeratorInScope.mockResolvedValue(undefined);
    permissionResolver.resolveUserPermissions.mockResolvedValue(new Set());
    permissionResolver.hasPermission.mockReturnValue(false);
    investigationRecording.getCaseView.mockResolvedValue({ recordings: [], auditLogs: [] });
  });

  const baseAudioReport = {
    id: 'r-1', roomId: 'room-1', reporterId: 'u-1', targetUserId: 'u-2',
    reason: 'THREATS', description: 'desc', status: 'PENDING',
    createdAt: new Date('2026-08-18T10:30:00Z'), assignedAt: new Date('2026-08-18T10:32:00Z'),
  };

  it('404s when the report id matches no table', async () => {
    prisma.roomReport.findUnique.mockResolvedValue(null);
    prisma.videoRoomReport.findUnique.mockResolvedValue(null);
    prisma.liveStreamReport.findUnique.mockResolvedValue(null);

    await expect(service.reportDetails('mod-1', 'missing')).rejects.toThrow('Report not found.');
  });

  it('shows evidenceId "Pending" with no recording when the report has not been actioned yet', async () => {
    prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
    prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Chill vibes', ownerId: 'owner-1' });

    const detail = await service.reportDetails('mod-1', 'r-1');

    expect(detail.evidenceId).toBe('Pending');
    expect(detail.recordingUrl).toBeNull();
    expect(detail.priority).toBe('Highest priority'); // THREATS
    expect(detail.region).toBe('Karnataka');
    expect(detail.targetUserName).toBe('Target');
  });

  it('shows the real recording once one exists, gated by canViewFullEvidence', async () => {
    prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
    prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Chill vibes', ownerId: 'owner-1' });
    investigationRecording.getCaseView.mockResolvedValue({
      recordings: [
        { roomId: 'room-1', liveStreamId: null, evidenceId: 'EVD-abc123', recordingUrl: 'https://cdn/rec.mp4', startedAt: new Date('2026-08-18T10:35:00Z') },
      ],
      auditLogs: [],
    });

    const withoutPermission = await service.reportDetails('mod-1', 'r-1');
    expect(withoutPermission.evidenceId).toBe('EVD-abc123');
    expect(withoutPermission.recordingUrl).toBeNull();
    expect(withoutPermission.canViewFullEvidence).toBe(false);

    permissionResolver.hasPermission.mockReturnValue(true);
    const withPermission = await service.reportDetails('mod-1', 'r-1');
    expect(withPermission.recordingUrl).toBe('https://cdn/rec.mp4');
    expect(withPermission.canViewFullEvidence).toBe(true);
  });

  it('counts previous reports against the same target user across all 3 tables, excluding this one', async () => {
    prisma.roomReport.findUnique.mockResolvedValue(baseAudioReport);
    prisma.audioRoom.findUnique.mockResolvedValue({ name: 'Room', ownerId: 'owner-1' });
    prisma.roomReport.count.mockResolvedValue(2);
    prisma.videoRoomReport.count.mockResolvedValue(1);
    prisma.liveStreamReport.count.mockResolvedValue(0);

    const detail = await service.reportDetails('mod-1', 'r-1');

    // previousReportCount is a display string ("N previous report(s)"), not a number.
    expect(detail.previousReportCount).toBe('3 previous reports');
    expect(prisma.roomReport.count).toHaveBeenCalledWith({
      where: { targetUserId: 'u-2', id: { not: 'r-1' } },
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts -t "reportDetails"`
Expected: FAIL with "service.reportDetails is not a function"

- [ ] **Step 3: Implement `reportDetails`**

```typescript
// src/modules/mobile-workforce/services/mobile-workforce.service.ts — new public method

  /**
   * Full detail for one report — everything the list payload doesn't carry:
   * target user, region, rule-violated, previous-report count, evidence
   * (gated), and shift/suspension-derived action eligibility.
   */
  async reportDetails(userId: string, reportId: string) {
    const ctx = await this.resolveReportContext(reportId);

    const ownerId = await this.resolveOwnerId(ctx.roomType, ctx.roomId);
    await this.scope.assertModeratorInScope(userId, ownerId);

    const [reporter, targetUser, roomLabel, region, previousReportCount, canViewFullEvidence, shiftActive, suspended] =
      await Promise.all([
        this.prisma.user.findUnique({ where: { id: ctx.reporterId }, select: { username: true, fullName: true } }),
        this.prisma.user.findUnique({ where: { id: ctx.targetUserId }, select: { username: true, fullName: true } }),
        this.resolveRoomLabel(ctx.roomType, ctx.roomId),
        this.resolveRegion(ownerId),
        this.countPreviousReports(ctx.targetUserId, reportId),
        this.canViewFullEvidence(userId),
        this.shiftService ? this.shiftService.shiftStatus(userId).then((s) => s.isActive) : Promise.resolve(false),
        this.warnings ? this.warnings.isSuspended(userId) : Promise.resolve(false),
      ]);

    const evidence = await this.resolveReportEvidence(
      ctx.targetUserId,
      ctx.roomType === 'stream' ? null : ctx.roomId,
      ctx.roomType === 'stream' ? ctx.roomId : null,
      canViewFullEvidence,
    );

    const canTakeAction = shiftActive && !suspended && ctx.status === 'PENDING';

    return {
      id: reportId,
      reportCode: `RPT-${reportId.substring(0, 4)}-${reportId.substring(reportId.length - 4)}`.toUpperCase(),
      roomType: ctx.roomType,
      roomTitle: roomLabel,
      reporterName: reporter?.fullName || reporter?.username || 'Reporter',
      reporterId: ctx.reporterId.substring(0, 6),
      targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
      targetUserId: ctx.targetUserId.substring(0, 6),
      region,
      violationReason: ctx.reason.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()),
      description: ctx.description || '',
      priority: deriveReportPriority(ctx.reason),
      ruleViolated: deriveRuleViolated(ctx.reason),
      status: ctx.status === 'PENDING' ? 'Under review' : 'Resolved',
      createdAt: ctx.createdAt.toISOString(),
      assignedTime: new Date(ctx.assignedAt ?? ctx.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
      previousReportCount: `${previousReportCount} previous report${previousReportCount === 1 ? '' : 's'}`,
      evidenceId: evidence.evidenceId,
      evidenceType: evidence.evidenceType,
      evidenceNote: evidence.evidenceNote,
      recordingUrl: evidence.recordingUrl,
      canViewFullEvidence,
      shiftActive,
      canTakeAction,
    };
  }

  private async resolveOwnerId(roomType: ReportRoomType, roomId: string): Promise<string | null> {
    if (roomType === 'audio') {
      const room = await this.prisma.audioRoom.findUnique({ where: { id: roomId }, select: { ownerId: true } });
      return room?.ownerId ?? null;
    }
    if (roomType === 'video') {
      const room = await this.prisma.videoRoom.findUnique({ where: { id: roomId }, select: { ownerId: true } });
      return room?.ownerId ?? null;
    }
    const stream = await this.prisma.liveStream.findUnique({ where: { id: roomId }, select: { hostId: true } });
    return stream?.hostId ?? null;
  }

  private async resolveRoomLabel(roomType: ReportRoomType, roomId: string): Promise<string> {
    if (roomType === 'audio') {
      const room = await this.prisma.audioRoom.findUnique({ where: { id: roomId }, select: { name: true } });
      return room?.name || 'Audio room';
    }
    if (roomType === 'video') {
      const room = await this.prisma.videoRoom.findUnique({ where: { id: roomId }, select: { name: true } });
      return room?.name || 'Video room';
    }
    const stream = await this.prisma.liveStream.findUnique({ where: { id: roomId }, select: { title: true } });
    return stream?.title || 'Live stream';
  }

  private async resolveRegion(ownerId: string | null): Promise<string> {
    if (!ownerId) return 'Unassigned';
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { locationState: { select: { name: true } } },
    });
    return owner?.locationState?.name ?? 'Unassigned';
  }

  private async countPreviousReports(targetUserId: string, excludeReportId: string): Promise<number> {
    const [audio, video, stream] = await Promise.all([
      this.prisma.roomReport.count({ where: { targetUserId, id: { not: excludeReportId } } }),
      this.prisma.videoRoomReport.count({ where: { targetUserId, id: { not: excludeReportId } } }),
      this.prisma.liveStreamReport.count({ where: { targetUserId, id: { not: excludeReportId } } }),
    ]);
    return audio + video + stream;
  }

  private async canViewFullEvidence(userId: string): Promise<boolean> {
    const permissions = await this.permissionResolver.resolveUserPermissions(userId);
    return (
      this.permissionResolver.hasPermission(permissions, 'investigation.recording.view') ||
      this.permissionResolver.hasPermission(permissions, 'audit.view')
    );
  }

  private async resolveReportEvidence(
    targetUserId: string,
    roomId: string | null,
    liveStreamId: string | null,
    canViewFullEvidence: boolean,
  ): Promise<{ evidenceId: string; evidenceType: string; evidenceNote: string; recordingUrl: string | null }> {
    const caseView = await this.investigationRecording.getCaseView(targetUserId);
    const recording = caseView.recordings.find(
      (r: { roomId: string | null; liveStreamId: string | null }) =>
        (roomId && r.roomId === roomId) || (liveStreamId && r.liveStreamId === liveStreamId),
    );

    if (!recording) {
      return {
        evidenceId: 'Pending',
        evidenceType: 'System evidence',
        evidenceNote:
          'No moderation action has been taken yet — evidence is captured automatically when an action is recorded.',
        recordingUrl: null,
      };
    }

    return {
      evidenceId: recording.evidenceId,
      evidenceType: 'System evidence',
      evidenceNote: 'Automatically captured by the system',
      recordingUrl: canViewFullEvidence ? recording.recordingUrl : null,
    };
  }
```

- [ ] **Step 4: Add the controller route**

```typescript
// src/modules/mobile-workforce/controllers/mobile-workforce.controller.ts
  @ApiOperation({ summary: 'Full detail for one report — evidence, region, target user, action eligibility' })
  @ApiResponse({ status: 200, description: 'Report detail' })
  @Get('reports/:reportId')
  reportDetails(@CurrentUser('id') userId: string, @Param('reportId') reportId: string) {
    return this.service.reportDetails(userId, reportId);
  }
```
Place it directly above the existing `@Post('reports/:reportId/decision')` route for locality.

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/controllers/mobile-workforce.controller.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "feat: add GET /mobile/workforce/reports/:reportId with real evidence, region, and action-eligibility"
```

---

## Task 6: Rewrite `actionReport()` — real dispatch, shift/suspension guards, required note

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Modify: `src/modules/mobile-workforce/controllers/mobile-workforce.controller.ts`
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- Consumes: `resolveReportContext` (Task 3), `deriveReportPriority` (Task 2), `resolveOwnerId(roomType, roomId): Promise<string | null>` (Task 5 — resolves the room/stream's owner/host id for the scope check), `RoomActor` (`{id: string, roles: PlatformRole[]}` from `src/modules/audio-rooms/interfaces/room-actor.interface.ts`), `RequestMetadata` (`src/common/interfaces/request-metadata.interface.ts`).
- Produces: `actionReport(userId, reportId, data: {action: string; note: string}, actorRoles: PlatformRole[], requestMeta?: RequestMetadata): Promise<{success: true; reportId: string; action: string; outcome: 'executed'|'pending_approval'|'dismissed'|'escalated'}>`.

- [ ] **Step 1: Write the failing tests (one per action × representative room type)**

```typescript
// Add to src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
describe('actionReport', () => {
  const actorRoles = ['MODERATOR'] as any;
  const audioCtx = {
    id: 'r-1', roomId: 'room-1', reporterId: 'u-1', targetUserId: 'u-2',
    reason: 'HARASSMENT', description: null, status: 'PENDING',
    createdAt: new Date(), assignedAt: null,
  };

  beforeEach(() => {
    prisma.roomReport.findUnique = jest.fn().mockResolvedValue(audioCtx);
    prisma.videoRoomReport.findUnique = jest.fn().mockResolvedValue(null);
    prisma.liveStreamReport.findUnique = jest.fn().mockResolvedValue(null);
    // resolveOwnerId needs findUnique on whichever table the resolved
    // roomType points to — stub all three so any test (audio, video, or
    // live-stream routing) finds an owner without a "not a function" crash.
    prisma.audioRoom.findUnique = jest.fn().mockResolvedValue({ ownerId: 'owner-1' });
    prisma.videoRoom.findUnique = jest.fn().mockResolvedValue({ ownerId: 'owner-1' });
    prisma.liveStream.findUnique = jest.fn().mockResolvedValue({ hostId: 'owner-1' });
    scope.assertModeratorInScope.mockResolvedValue(undefined);
    audioModeration.reviewReport.mockResolvedValue(undefined);
    audioModeration.dismissReport.mockResolvedValue(undefined);
    audioModeration.escalateViolation.mockResolvedValue(undefined);
  });

  it('rejects a blank note before touching any moderation service', async () => {
    await expect(
      service.actionReport('mod-1', 'r-1', { action: 'Warn', note: '   ' }, actorRoles),
    ).rejects.toThrow('note');
    expect(audioModeration.reviewReport).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized action', async () => {
    await expect(
      service.actionReport('mod-1', 'r-1', { action: 'Nonsense', note: 'x' }, actorRoles),
    ).rejects.toThrow();
  });

  it('Warn calls reviewReport with recommendedAction WARNING on the audio surface', async () => {
    const result = await service.actionReport('mod-1', 'r-1', { action: 'Warn', note: 'be nice' }, actorRoles);

    expect(audioModeration.reviewReport).toHaveBeenCalledWith(
      { id: 'mod-1', roles: actorRoles },
      'room-1',
      'r-1',
      { status: 'ACTIONED', resolution: 'be nice', recommendedAction: 'WARNING' },
    );
    expect(result.outcome).toBe('executed');
  });

  it('Ban reports pending_approval, not executed', async () => {
    const result = await service.actionReport('mod-1', 'r-1', { action: 'Ban', note: 'severe' }, actorRoles);

    expect(audioModeration.reviewReport).toHaveBeenCalledWith(
      expect.anything(), 'room-1', 'r-1',
      { status: 'ACTIONED', resolution: 'severe', recommendedAction: 'BAN' },
    );
    expect(result.outcome).toBe('pending_approval');
  });

  it('"Close false report" calls dismissReport, not reviewReport', async () => {
    const result = await service.actionReport(
      'mod-1', 'r-1', { action: 'Close false report', note: 'not a real violation' }, actorRoles,
    );

    expect(audioModeration.dismissReport).toHaveBeenCalledWith(
      { id: 'mod-1', roles: actorRoles }, 'room-1', 'r-1', 'not a real violation',
    );
    expect(result.outcome).toBe('dismissed');
  });

  it('Escalate reviews the report as REVIEWED then calls escalateViolation with derived severity', async () => {
    const result = await service.actionReport('mod-1', 'r-1', { action: 'Escalate', note: 'urgent' }, actorRoles);

    expect(audioModeration.reviewReport).toHaveBeenCalledWith(
      expect.anything(), 'room-1', 'r-1', { status: 'REVIEWED', resolution: 'urgent' },
    );
    // HARASSMENT is Medium priority -> HIGH severity, not CRITICAL.
    expect(audioModeration.escalateViolation).toHaveBeenCalledWith(
      { id: 'mod-1', roles: actorRoles }, 'room-1', 'u-2', 'urgent', 'HIGH',
    );
    expect(result.outcome).toBe('escalated');
  });

  it('routes to the live-stream surface with recommendedAction WARN (not WARNING)', async () => {
    prisma.roomReport.findUnique.mockResolvedValue(null);
    prisma.liveStreamReport.findUnique.mockResolvedValue({
      id: 'r-2', streamId: 'stream-1', reporterId: 'u-1', targetUserId: 'u-2',
      reason: 'THREATS', description: null, status: 'PENDING', createdAt: new Date(),
    });
    liveStreamReports.reviewReport.mockResolvedValue(undefined);

    await service.actionReport('mod-1', 'r-2', { action: 'Warn', note: 'be nice' }, actorRoles);

    expect(liveStreamReports.reviewReport).toHaveBeenCalledWith(
      {
        reportId: 'r-2', streamId: 'stream-1', moderatorId: 'mod-1',
        status: 'ACTIONED', resolution: 'be nice', recommendedAction: 'WARN',
      },
      undefined,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts -t "actionReport"`
Expected: FAIL (current `actionReport` only calls `prisma.roomReport.updateMany`/`prisma.videoRoomReport.updateMany`, never the injected moderation services)

- [ ] **Step 3: Rewrite `actionReport`**

Replace the existing `actionReport` method entirely:

```typescript
// src/modules/mobile-workforce/services/mobile-workforce.service.ts
import { BadRequestException } from '@nestjs/common';
import type { PlatformRole } from '@prisma/client';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';

type NormalizedAction = 'WARN' | 'MUTE' | 'KICK' | 'BAN' | 'ESCALATE' | 'CLOSE_FALSE_REPORT';

  private normalizeAction(action: string): NormalizedAction {
    const key = action.trim().toUpperCase();
    if (key === 'WARN') return 'WARN';
    if (key === 'MUTE') return 'MUTE';
    if (key === 'KICK') return 'KICK';
    if (key === 'BAN') return 'BAN';
    if (key === 'ESCALATE') return 'ESCALATE';
    if (key === 'CLOSE FALSE REPORT' || key === 'CLOSE_FALSE_REPORT') return 'CLOSE_FALSE_REPORT';
    throw new BadRequestException(`Unrecognized moderation action: "${action}".`);
  }

  /**
   * Action a report (Warn, Mute, Kick, Ban, Escalate, Close false report).
   * Delegates to the authoritative per-room-type moderation service instead
   * of mutating the report row directly — that's what gets us real mute/
   * kick/ban effects, investigation recording, audit logging, and the
   * Ban→Official-approval routing for free.
   */
  async actionReport(
    userId: string,
    reportId: string,
    data: { action: string; note: string },
    actorRoles: PlatformRole[],
    requestMeta?: RequestMetadata,
  ): Promise<{
    success: true;
    reportId: string;
    action: NormalizedAction;
    outcome: 'executed' | 'pending_approval' | 'dismissed' | 'escalated';
  }> {
    const note = data.note?.trim();
    if (!note) {
      throw new BadRequestException('An activity note is required.');
    }
    const normalized = this.normalizeAction(data.action);

    const ctx = await this.resolveReportContext(reportId);
    const ownerId = await this.resolveOwnerId(ctx.roomType, ctx.roomId);
    await this.scope.assertModeratorInScope(userId, ownerId);

    const actor = { id: userId, roles: actorRoles };
    const severity = deriveReportPriority(ctx.reason) === 'Highest priority' ? 'CRITICAL' : 'HIGH';

    if (normalized === 'CLOSE_FALSE_REPORT') {
      if (ctx.roomType === 'audio') {
        await this.audioModeration!.dismissReport(actor, ctx.roomId, reportId, note);
      } else if (ctx.roomType === 'video') {
        await this.videoReports!.dismissReport(actor, ctx.roomId, reportId, note);
      } else {
        await this.liveStreamReports!.reviewReport({
          reportId, streamId: ctx.roomId, moderatorId: userId,
          status: 'DISMISSED' as any, resolution: note,
        });
      }
      return { success: true, reportId, action: normalized, outcome: 'dismissed' };
    }

    if (normalized === 'ESCALATE') {
      if (ctx.roomType === 'audio') {
        await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
          status: 'REVIEWED' as any, resolution: note,
        });
        await this.audioModeration!.escalateViolation(actor, ctx.roomId, ctx.targetUserId, note, severity as any, requestMeta);
      } else if (ctx.roomType === 'video') {
        await this.videoReports!.reviewReport(actor, ctx.roomId, reportId, {
          status: 'REVIEWED' as any, resolutionAction: note,
        } as any, requestMeta);
        await this.videoModeration!.escalateViolation(actor, ctx.roomId, ctx.targetUserId, note, severity as any, requestMeta);
      } else {
        await this.liveStreamReports!.reviewReport({
          reportId, streamId: ctx.roomId, moderatorId: userId,
          status: 'REVIEWED' as any, resolution: note,
        });
        await this.liveStream!.escalateViolation(ctx.roomId, userId, ctx.targetUserId, note, severity as any);
      }
      return { success: true, reportId, action: normalized, outcome: 'escalated' };
    }

    // WARN / MUTE / KICK / BAN — one reviewReport call each, per surface.
    const outcome = normalized === 'BAN' ? 'pending_approval' : 'executed';

    if (ctx.roomType === 'audio') {
      const recommendedAction = normalized === 'WARN' ? 'WARNING' : normalized;
      await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
        status: 'ACTIONED' as any, resolution: note, recommendedAction: recommendedAction as any,
      });
    } else if (ctx.roomType === 'video') {
      const recommendedAction = normalized === 'WARN' ? 'WARNING' : normalized;
      await this.videoReports!.reviewReport(actor, ctx.roomId, reportId, {
        status: 'ACTIONED' as any, resolutionAction: note, recommendedAction: recommendedAction as any,
      } as any, requestMeta);
    } else {
      // Live-stream's DTO literal is 'WARN', not 'WARNING' — do not reuse the
      // audio/video mapping above.
      await this.liveStreamReports!.reviewReport({
        reportId, streamId: ctx.roomId, moderatorId: userId,
        status: 'ACTIONED' as any, resolution: note, recommendedAction: normalized as any,
      }, requestMeta);
    }

    return { success: true, reportId, action: normalized, outcome };
  }
```

Delete the old `moderateParticipant`-adjacent `actionReport` body entirely (the one that called `prisma.roomReport.updateMany`/`prisma.videoRoomReport.updateMany`) — this replaces it, not extends it. Leave `moderateParticipant` itself untouched (out of scope, Global Constraints).

- [ ] **Step 4: Update the controller route**

```typescript
// src/modules/mobile-workforce/controllers/mobile-workforce.controller.ts
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ShiftActiveGuard } from 'src/modules/moderator-shift/guards/shift-active.guard';
import { SuspendedGuard } from 'src/modules/moderator-warning/guards/suspended.guard';

  @ApiOperation({ summary: 'Submit moderation decision on report' })
  @ApiResponse({ status: 200, description: 'Moderation decision applied' })
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @Post('reports/:reportId/decision')
  actionReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reportId') reportId: string,
    @Body() body: { action: string; note: string },
    @RequestMeta() requestMeta: RequestMetadata,
  ) {
    return this.service.actionReport(user.id, reportId, body, user.roles, requestMeta);
  }
```
(This replaces the current `actionReport` route handler, which used `@CurrentUser('id') userId: string` and no guards.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest --config jest.config.js src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`
Expected: PASS

Then re-run Task 1's e2e regression check once more, since the controller now pulls in `ShiftActiveGuard`/`SuspendedGuard`:
Run: `npx jest --config jest.config.js src/modules/mobile-workforce/geographic-scope.e2e-spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/controllers/mobile-workforce.controller.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "feat: delegate report actions to the real moderation services with shift/suspension gating"
```

---

## Task 7 (Flutter): Extend `ModeratorReport` with the Report Details fields

**Files:**
- Modify: `soulzaa-mobile/lib/features/moderator/data/models/moderator_report.dart`

**Interfaces:**
- Produces: `ModeratorReport` gains `assignedTime`, `targetUserName`, `targetUserId`, `region`, `evidenceId`, `evidenceType`, `evidenceNote`, `ruleViolated`, `userReportCount` (all `String`, defaulted), `recordingUrl` (`String?`), `shiftActive`, `canTakeAction`, `canViewFullEvidence` (all `bool`, default `false`).

- [ ] **Step 1: Extend the class and its `fromJson`/`toJson`**

```dart
// soulzaa-mobile/lib/features/moderator/data/models/moderator_report.dart
class ModeratorReport {
  const ModeratorReport({
    required this.id,
    required this.reportCode,
    required this.roomType,
    required this.roomTitle,
    required this.reporterName,
    required this.reporterId,
    required this.violationReason,
    this.description = '',
    required this.priority,
    required this.status,
    required this.createdAt,
    this.assignedTime = '',
    this.targetUserName = '',
    this.targetUserId = '',
    this.region = 'Unassigned',
    this.evidenceId = 'Pending',
    this.evidenceType = 'System evidence',
    this.evidenceNote = '',
    this.ruleViolated = '',
    this.userReportCount = '0 previous reports',
    this.recordingUrl,
    this.shiftActive = false,
    this.canTakeAction = false,
    this.canViewFullEvidence = false,
  });

  final String id;
  final String reportCode;
  final String roomType; // 'video', 'audio', 'stream'
  final String roomTitle;
  final String reporterName;
  final String reporterId;
  final String violationReason;
  final String description;
  final String priority; // 'Highest priority', 'Medium priority', 'Low priority'
  final String status; // 'Under review', 'Solved', 'Escalated'
  final DateTime createdAt;

  // Report Details-only fields — populated by getReportDetails(), not
  // present on the list endpoint's payload.
  final String assignedTime;
  final String targetUserName;
  final String targetUserId;
  final String region;
  final String evidenceId;
  final String evidenceType;
  final String evidenceNote;
  final String ruleViolated;
  final String userReportCount;
  final String? recordingUrl;
  final bool shiftActive;
  final bool canTakeAction;
  final bool canViewFullEvidence;

  factory ModeratorReport.fromJson(Map<String, dynamic> json) {
    return ModeratorReport(
      id: json['id'] as String? ?? '',
      reportCode: json['reportCode'] as String? ?? 'RPT-0000-0000',
      roomType: (json['roomType'] as String? ?? 'video').toLowerCase(),
      roomTitle: json['roomTitle'] as String? ?? 'General Room',
      reporterName: json['reporterName'] as String? ?? 'User',
      reporterId: json['reporterId'] as String? ?? '000000',
      violationReason: json['violationReason'] as String? ?? 'Inappropriate content',
      description: json['description'] as String? ?? '',
      priority: json['priority'] as String? ?? 'Highest priority',
      status: json['status'] as String? ?? 'Under review',
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'].toString()) ?? DateTime.now()
          : DateTime.now(),
      assignedTime: json['assignedTime'] as String? ?? '',
      targetUserName: json['targetUserName'] as String? ?? '',
      targetUserId: json['targetUserId'] as String? ?? '',
      region: json['region'] as String? ?? 'Unassigned',
      evidenceId: json['evidenceId'] as String? ?? 'Pending',
      evidenceType: json['evidenceType'] as String? ?? 'System evidence',
      evidenceNote: json['evidenceNote'] as String? ?? '',
      ruleViolated: json['ruleViolated'] as String? ?? '',
      userReportCount: json['userReportCount'] as String? ?? '0 previous reports',
      recordingUrl: json['recordingUrl'] as String?,
      shiftActive: json['shiftActive'] as bool? ?? false,
      canTakeAction: json['canTakeAction'] as bool? ?? false,
      canViewFullEvidence: json['canViewFullEvidence'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'reportCode': reportCode,
        'roomType': roomType,
        'roomTitle': roomTitle,
        'reporterName': reporterName,
        'reporterId': reporterId,
        'violationReason': violationReason,
        'description': description,
        'priority': priority,
        'status': status,
        'createdAt': createdAt.toIso8601String(),
        'assignedTime': assignedTime,
        'targetUserName': targetUserName,
        'targetUserId': targetUserId,
        'region': region,
        'evidenceId': evidenceId,
        'evidenceType': evidenceType,
        'evidenceNote': evidenceNote,
        'ruleViolated': ruleViolated,
        'userReportCount': userReportCount,
        'recordingUrl': recordingUrl,
        'shiftActive': shiftActive,
        'canTakeAction': canTakeAction,
        'canViewFullEvidence': canViewFullEvidence,
      };
}
```

- [ ] **Step 2: Add a round-trip test**

```dart
// Add to test/features/moderator/moderator_remote_data_source_test.dart
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_report.dart';

// ... inside main(), a new group:
  group('ModeratorReport — detail fields', () {
    test('parses detail-only fields and defaults them sensibly when absent', () {
      final ModeratorReport withDetail = ModeratorReport.fromJson(<String, dynamic>{
        'id': '1',
        'reportCode': 'RPT-1',
        'roomType': 'audio',
        'roomTitle': 'Room',
        'reporterName': 'A',
        'reporterId': '1',
        'violationReason': 'Spam',
        'priority': 'Low priority',
        'status': 'Under review',
        'createdAt': '2026-08-18T10:00:00Z',
        'targetUserName': 'Target',
        'targetUserId': '2',
        'region': 'Karnataka',
        'evidenceId': 'EVD-abc',
        'ruleViolated': 'Spam & fraudulent activity (4.2)',
        'userReportCount': '2 previous reports',
        'shiftActive': true,
        'canTakeAction': true,
        'canViewFullEvidence': false,
      });

      expect(withDetail.targetUserName, 'Target');
      expect(withDetail.region, 'Karnataka');
      expect(withDetail.shiftActive, isTrue);
      expect(withDetail.canTakeAction, isTrue);

      final ModeratorReport listOnly = ModeratorReport.fromJson(<String, dynamic>{
        'id': '1', 'reportCode': 'RPT-1', 'roomType': 'audio', 'roomTitle': 'Room',
        'reporterName': 'A', 'reporterId': '1', 'violationReason': 'Spam',
        'priority': 'Low priority', 'status': 'Under review', 'createdAt': '2026-08-18T10:00:00Z',
      });

      expect(listOnly.shiftActive, isFalse);
      expect(listOnly.canTakeAction, isFalse);
      expect(listOnly.evidenceId, 'Pending');
    });
  });
```

- [ ] **Step 3: Run**

Run: `flutter test test/features/moderator/moderator_remote_data_source_test.dart`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/features/moderator/data/models/moderator_report.dart test/features/moderator/moderator_remote_data_source_test.dart
git commit -m "feat: add Report Details fields to ModeratorReport"
```

---

## Task 8 (Flutter): `ModeratorRemoteDataSource` — `getReportDetails` and `submitReportDecision`

**Files:**
- Modify: `soulzaa-mobile/lib/features/moderator/data/moderator_remote_data_source.dart`

**Interfaces:**
- Produces: `Future<ModeratorReport> getReportDetails(String reportId)`, `Future<Map<String, dynamic>> submitReportDecision({required String reportId, required String action, required String note})`.

- [ ] **Step 1: Add the two methods**

```dart
// soulzaa-mobile/lib/features/moderator/data/moderator_remote_data_source.dart
  /// `GET /mobile/workforce/reports/:reportId` — full detail for one report
  /// (target user, region, evidence, rule violated, action eligibility);
  /// the list endpoint's payload doesn't carry these.
  Future<ModeratorReport> getReportDetails(String reportId) async {
    final Response<dynamic> response = await _dio.get<dynamic>(
      '/mobile/workforce/reports/$reportId',
    );
    return ResponseParser.parse<ModeratorReport>(
      response,
      ModeratorReport.fromJson,
    );
  }

  /// `POST /mobile/workforce/reports/:reportId/decision`. Returns the raw
  /// response map (not void) because `outcome` ('executed' vs
  /// 'pending_approval' vs 'dismissed' vs 'escalated') decides what success
  /// message the caller should show — a Ban doesn't take effect immediately.
  Future<Map<String, dynamic>> submitReportDecision({
    required String reportId,
    required String action,
    required String note,
  }) async {
    final Response<dynamic> response = await _dio.post<dynamic>(
      '/mobile/workforce/reports/$reportId/decision',
      data: <String, dynamic>{'action': action, 'note': note},
    );
    return response.data as Map<String, dynamic>;
  }
```
Add both directly below the existing `getReports` method, before `getLiveMonitoring`.

- [ ] **Step 2: Run static analysis to confirm the new methods compile against `ResponseParser`/`Dio`**

Run: `flutter analyze lib/features/moderator/data/moderator_remote_data_source.dart`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add lib/features/moderator/data/moderator_remote_data_source.dart
git commit -m "feat: add getReportDetails and submitReportDecision to ModeratorRemoteDataSource"
```

---

## Task 9 (Flutter): Register the Report Details route; fetch-then-navigate from the list

Fetch happens in the **list screen's** tap handler (not inside the Details screen) — this keeps `ModeratorReportDetailsScreen` a pure, constructor-driven presentation widget exactly as it is today, so its existing test harness needs no network/provider mocking at all.

**Files:**
- Modify: `soulzaa-mobile/lib/core/routing/route_paths.dart`
- Modify: `soulzaa-mobile/lib/core/routing/app_router.dart`
- Modify: `soulzaa-mobile/lib/features/moderator/presentation/screens/moderator_reports_screen.dart`
- Modify: `soulzaa-mobile/test/features/moderator/moderator_reports_screen_test.dart`

**Interfaces:**
- Consumes: `getReportDetails` (Task 8), `moderatorRemoteDataSourceProvider` (existing), `ModeratorReportDetailsScreen` (existing, unchanged constructor).
- Produces: `RoutePaths.moderatorReportDetails`, `RouteNames.moderatorReportDetails`.

- [ ] **Step 1: Register the route**

```dart
// soulzaa-mobile/lib/core/routing/route_paths.dart — in class RoutePaths, next to the other moderator paths:
  static const String moderatorReportDetails = '/moderator/reports/detail';
```
```dart
// soulzaa-mobile/lib/core/routing/route_paths.dart — in class RouteNames:
  static const String moderatorReportDetails = 'moderatorReportDetails';
```

```dart
// soulzaa-mobile/lib/core/routing/app_router.dart — add to the "Home drill-down
// destinations (pushed above the shell)" section (same section as
// RoutePaths.profile etc, not inside the StatefulShellRoute — Report Details
// is a drill-down push, not a bottom-nav tab):
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_report.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/screens/moderator_report_details_screen.dart';

  GoRoute(
    path: RoutePaths.moderatorReportDetails,
    name: RouteNames.moderatorReportDetails,
    pageBuilder: (BuildContext context, GoRouterState state) => _page(
      ModeratorReportDetailsScreen(report: state.extra! as ModeratorReport),
      state,
    ),
  ),
```

- [ ] **Step 2: Change the list screen's tap handler to fetch-then-navigate**

In `moderator_reports_screen.dart`, `_ReportCard` currently calls `_showReportDetails(context)` (the cosmetic bottom sheet) from `InkWell.onTap`. Replace it:

```dart
// soulzaa-mobile/lib/features/moderator/presentation/screens/moderator_reports_screen.dart
// Change _ReportCard from StatelessWidget to ConsumerWidget so it can read the provider:
class _ReportCard extends ConsumerWidget {
  const _ReportCard({required this.report});

  final ModeratorReport report;

  // ... _getRoomTypeIcon, _getPriorityColor unchanged; delete _showReportDetails entirely ...

  Future<void> _openDetails(BuildContext context, WidgetRef ref) async {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator(color: Color(0xFFD81B60))),
    );
    try {
      final ModeratorReport detail =
          await ref.read(moderatorRemoteDataSourceProvider).getReportDetails(report.id);
      if (context.mounted) {
        Navigator.of(context).pop(); // dismiss the loading dialog
        context.push(RoutePaths.moderatorReportDetails, extra: detail);
      }
    } catch (e) {
      if (context.mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load report: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // ... unchanged body, except:
    child: InkWell(
      onTap: () => _openDetails(context, ref),
      // ...
```
(`report`, `_getRoomTypeIcon`, `_getPriorityColor`, and the rest of `build`'s widget tree are unchanged — only the class declaration line, the `build` method's signature gaining `WidgetRef ref`, the `onTap` callback, and the removed `_showReportDetails` method.) Also delete the now-unused `_showReportDetails` method and its `showModalBottomSheet` body.

Add the import: `import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_providers.dart';`

Also update the two call sites that construct `_ReportCard` (in `ModeratorReportsScreen.build`, the `.map((ModeratorReport r) => _ReportCard(report: r))` line) — no change needed there since `_ReportCard`'s constructor signature is unchanged, only its superclass.

- [ ] **Step 3: Write the failing test for tap-to-navigate**

```dart
// Add to test/features/moderator/moderator_reports_screen_test.dart
class _FakeReportsDataSource implements ModeratorRemoteDataSource {
  _FakeReportsDataSource(this._build, {Future<ModeratorReport> Function(String)? detail});

  final Future<List<ModeratorReport>> Function() _build;
  final Future<ModeratorReport> Function(String)? _detail;

  @override
  Future<List<ModeratorReport>> getReports({int limit = 50}) => _build();

  @override
  Future<ModeratorReport> getReportDetails(String reportId) =>
      _detail != null ? _detail(reportId) : Future<ModeratorReport>.error(Exception('not stubbed'));

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// New test in main():
  testWidgets('tapping a card fetches detail then navigates to Report Details', (
    WidgetTester tester,
  ) async {
    final ModeratorReport detail = ModeratorReport(
      id: '1', reportCode: 'RPT-6354-7384', roomType: 'video', roomTitle: 'Chill vibes',
      reporterName: 'Neha singh', reporterId: '798325', violationReason: 'Inappropriate content',
      priority: 'Highest priority', status: 'Under review', createdAt: DateTime(2026, 5, 13, 10, 30),
      targetUserName: 'Aman verma', targetUserId: '89460', region: 'India - south',
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          moderatorRemoteDataSourceProvider.overrideWithValue(
            _FakeReportsDataSource(
              () => Future<List<ModeratorReport>>.value(<ModeratorReport>[_mockReports.first]),
              detail: (_) => Future<ModeratorReport>.value(detail),
            ),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: GoRouter(
            initialLocation: '/',
            routes: <RouteBase>[
              GoRoute(path: '/', builder: (_, _) => const ModeratorReportsScreen()),
              GoRoute(
                path: RoutePaths.moderatorReportDetails,
                name: RouteNames.moderatorReportDetails,
                builder: (BuildContext context, GoRouterState state) =>
                    ModeratorReportDetailsScreen(report: state.extra! as ModeratorReport),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Inappropriate content'));
    await tester.pump(); // show loading dialog
    await tester.pumpAndSettle(); // let the fetch resolve and navigation happen

    expect(find.text('Report details'), findsOneWidget);
    expect(find.textContaining('Aman verma'), findsOneWidget);
  });
```
Add imports: `package:go_router/go_router.dart`, `package:soulzaa_mobile/core/routing/route_paths.dart`, `package:soulzaa_mobile/features/moderator/presentation/screens/moderator_report_details_screen.dart`.

- [ ] **Step 4: Run to verify it fails, then passes**

Run: `flutter test test/features/moderator/moderator_reports_screen_test.dart`
Expected: FAIL first (route/navigation not wired), then PASS after Steps 1-2 are in place.

- [ ] **Step 5: Commit**

```bash
git add lib/core/routing/route_paths.dart lib/core/routing/app_router.dart lib/features/moderator/presentation/screens/moderator_reports_screen.dart test/features/moderator/moderator_reports_screen_test.dart
git commit -m "feat: fetch full report detail and navigate to Report Details on card tap"
```

---

## Task 10 (Flutter): Bind Report Details to real fields; fix the swallowed-exception bug

**Files:**
- Modify: `soulzaa-mobile/lib/features/moderator/presentation/screens/moderator_report_details_screen.dart`
- Modify: `soulzaa-mobile/test/features/moderator/moderator_report_details_screen_test.dart`

**Interfaces:**
- Consumes: `submitReportDecision` (Task 8), `moderatorReportsProvider` (existing, in `moderator_reports_controller.dart`).

- [ ] **Step 1: Extend the existing widget test with the new behavior**

```dart
// test/features/moderator/moderator_report_details_screen_test.dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/features/moderator/data/moderator_remote_data_source.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_providers.dart';

class _FakeSubmitDataSource implements ModeratorRemoteDataSource {
  _FakeSubmitDataSource(this._submit);

  final Future<Map<String, dynamic>> Function() _submit;

  @override
  Future<Map<String, dynamic>> submitReportDecision({
    required String reportId,
    required String action,
    required String note,
  }) => _submit();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// New tests in main(), alongside the existing render test:
  testWidgets('successful submit shows a real outcome message and refreshes the list', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          moderatorRemoteDataSourceProvider.overrideWithValue(
            _FakeSubmitDataSource(
              () async => <String, dynamic>{'success': true, 'outcome': 'executed'},
            ),
          ),
        ],
        child: MaterialApp(home: ModeratorReportDetailsScreen(report: sampleReport)),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Warn'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Issued warning.');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Submit Moderation Decision'));
    await tester.pump(); // let the SnackBar show before the pop
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.textContaining('recorded'), findsOneWidget);
  });

  testWidgets('failed submit shows the real error and does not pop', (WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          moderatorRemoteDataSourceProvider.overrideWithValue(
            _FakeSubmitDataSource(
              () => Future<Map<String, dynamic>>.error(Exception('Network error')),
            ),
          ),
        ],
        child: MaterialApp(home: ModeratorReportDetailsScreen(report: sampleReport)),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Mute'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Muted for spam.');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Submit Moderation Decision'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // Still on the details screen (did not pop), and the error is real, not "success".
    expect(find.text('Submit Moderation Decision'), findsOneWidget);
    expect(find.textContaining('Network error'), findsOneWidget);
  });

  testWidgets('action tiles are disabled when canTakeAction is false', (WidgetTester tester) async {
    final ModeratorReport inactive = ModeratorReport(
      id: '1', reportCode: 'RPT-1', roomType: 'video', roomTitle: 'Room',
      reporterName: 'A', reporterId: '1', violationReason: 'Spam',
      priority: 'Low priority', status: 'Under review', createdAt: DateTime(2026, 5, 13),
      canTakeAction: false, shiftActive: false,
    );

    await tester.pumpWidget(
      ProviderScope(child: MaterialApp(home: ModeratorReportDetailsScreen(report: inactive))),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Warn'));
    await tester.pumpAndSettle();

    // Tapping a disabled tile must not select it.
    expect(find.text('Please select a moderation action.'), findsNothing);
    await tester.enterText(find.byType(TextField), 'note');
    await tester.tap(find.text('Submit Moderation Decision'));
    await tester.pumpAndSettle();
    expect(find.text('Please select a moderation action.'), findsOneWidget);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `flutter test test/features/moderator/moderator_report_details_screen_test.dart`
Expected: FAIL — submit calls the undefined `submitReportDecision` shape mismatch / tiles aren't disabled / error path still shows fake success

- [ ] **Step 3: Fix `_submitAction` and gate the action tiles**

```dart
// soulzaa-mobile/lib/features/moderator/presentation/screens/moderator_report_details_screen.dart
import 'package:soulzaa_mobile/features/moderator/presentation/controllers/moderator_reports_controller.dart';

  void _handleAction(String actionName) {
    if (!widget.report.canTakeAction) return; // disabled — shift inactive, suspended, or already reviewed
    setState(() {
      _selectedAction = actionName;
    });
  }

  Future<void> _submitAction() async {
    if (_selectedAction == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Please select a moderation action.'),
          backgroundColor: Color(0xFFE53935),
        ),
      );
      return;
    }
    if (_noteController.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Please write an activity note.'),
          backgroundColor: Color(0xFFE53935),
        ),
      );
      return;
    }

    try {
      final Map<String, dynamic> result =
          await ref.read(moderatorRemoteDataSourceProvider).submitReportDecision(
                reportId: widget.report.id,
                action: _selectedAction!,
                note: _noteController.text.trim(),
              );
      if (!mounted) return;
      final String outcome = result['outcome'] as String? ?? 'executed';
      final String message = outcome == 'pending_approval'
          ? 'Ban recorded for ${widget.report.reportCode} — awaiting Official approval.'
          : 'Action "$_selectedAction" recorded for ${widget.report.reportCode}.';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message), backgroundColor: const Color(0xFF2E7D32)),
      );
      ref.invalidate(moderatorReportsProvider);
      await Navigator.of(context).maybePop();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to submit decision: $e'),
          backgroundColor: const Color(0xFFE53935),
        ),
      );
      // Deliberately does not pop — the moderator needs to see the failure
      // and can retry, instead of losing their note on a fake success.
    }
  }
```

Removed the `catch (_) { ...fake success... }` block entirely — that was the pre-existing bug (every network failure showed a green "Decision submitted successfully" toast and popped the screen).

Gate the 6 tiles visually so a disabled report reads as disabled, not just inert:

```dart
// _buildActionTile — add an `enabled` param driven by widget.report.canTakeAction
  Widget _buildActionTile({
    required String title,
    required String subtitle,
    required IconData icon,
    required Color iconColor,
    required bool enabled,
  }) {
    final bool isSelected = _selectedAction == title;

    return GestureDetector(
      onTap: enabled ? () => _handleAction(title) : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
        decoration: BoxDecoration(
          color: !enabled
              ? const Color(0xFFF5F5F5)
              : isSelected
                  ? const Color(0xFFFCE4EC)
                  : Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: isSelected ? const Color(0xFFE91E63) : const Color(0xFFE8E8E8),
            width: isSelected ? 1.5 : 1,
          ),
        ),
        child: Opacity(
          opacity: enabled ? 1.0 : 0.4,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(icon, size: 22, color: iconColor),
              const SizedBox(height: 4),
              Text(title, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold,
                  color: isSelected ? const Color(0xFFE91E63) : Colors.black87),
                  textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis),
              Text(subtitle, style: const TextStyle(fontSize: 8.5, color: Colors.black45),
                  textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
```
And pass `enabled: report.canTakeAction` at each of the 6 `_buildActionTile(...)` call sites in `_buildDetailsAndActionsCard`.

Bind the "Shift active" text (currently hardcoded) to the real field:
```dart
              Flexible(
                child: Text(
                  report.canTakeAction
                      ? 'Shift active  •  You can take action'
                      : report.shiftActive
                          ? 'Report already reviewed'
                          : 'Shift inactive  •  Actions disabled',
                  style: const TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFFE91E63),
                  ),
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                ),
              ),
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `flutter test test/features/moderator/moderator_report_details_screen_test.dart`
Expected: PASS (all 4 tests — the original render test, plus the 3 new ones from Step 1)

- [ ] **Step 5: Run the full moderator feature test suite as a final regression check**

Run: `flutter test test/features/moderator/`
Expected: PASS

Run: `flutter analyze lib/features/moderator/`
Expected: 0 errors (the pre-existing 24 errors documented in the design's research — undefined `submitReportDecision`, missing model fields — are now resolved for the Reports/Report Details pair specifically; unrelated pre-existing errors in Tasks/Rooms screens are out of scope for this plan and may remain)

- [ ] **Step 6: Commit**

```bash
git add lib/features/moderator/presentation/screens/moderator_report_details_screen.dart test/features/moderator/moderator_report_details_screen_test.dart
git commit -m "fix: bind Report Details to real shift/evidence/action-eligibility data and stop showing fake success on submit failure"
```

---

## Manual verification (after all 10 tasks)

1. Backend: `npm run build` (or the project's TS build command) — confirm the whole app still compiles clean.
2. Backend: run the full test suite once — `npx jest --config jest.config.js` — to catch anything Tasks 1-6 might have disturbed outside the files directly touched.
3. Flutter: `flutter analyze` (whole project) and `flutter test` (whole project) for the same reason.
4. Manual walkthrough (per the design's §11): open Reports → confirm live-stream reports now appear and priority varies by reason (not room type) → tap a card → Report Details loads with real target user/region/evidence/rule-violated/report-count → submit an action → snackbar reflects the real outcome → back on the list, pull-to-refresh shows the report's new status. Then: try submitting with an empty note (blocked client-side); try acting on a report while the test moderator account's shift is inactive (tiles disabled, "Shift inactive" text shown); confirm a Ban shows the "awaiting Official approval" message rather than implying an immediate ban.
