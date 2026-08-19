# Moderator Report Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Report Details screen's Ban and Escalate actions match the product spec (Ban executes immediately with realtime enforcement; Escalate always reaches real Admin accounts), fix a real gap in live-stream private warnings, and trim the action grid to the 4 actions the product wants (Warn, Ban, Escalate, Close as false report).

**Architecture:** This is a series of small, surgical changes to already-existing, already-tested machinery — no new subsystem. `PlatformBanService.banUser` (24h ban, realtime eviction, admin visibility) already exists and is called directly instead of routing through the Ban-approval queue. `escalateViolation`'s existing `EMERGENCY`-severity tier already resolves to every ADMIN/SUPER_ADMIN unconditionally, so Escalate just stops deriving severity from report priority and always passes `'EMERGENCY'`. Live-stream's private WARN gets one new `SocketManager` method mirroring the pattern audio/video rooms already use.

**Tech Stack:** NestJS + Prisma (backend), Flutter + Riverpod (moderator app), Jest (backend tests), flutter_test (Flutter tests).

**Spec:** `docs/superpowers/specs/2026-08-19-moderator-report-actions-and-consumer-reporting-design.md` — sections 1-2 (problem/goals), 4 (Ban), 5 (Escalate), 6 (Warn), 8 (Flutter trim). Section 9 (consumer-side Report User UI) is a separate plan (`2026-08-19-consumer-report-user-ui.md`) — it has no dependency on this one.

## Global Constraints

- Ban is a 24h fixed-duration platform ban (`PlatformBanService`'s existing hardcoded `BAN_DURATION_SECONDS`) — no new duration option.
- Never run `prisma migrate dev` in this repo — it diffs the entire schema against migration history and has previously surfaced a full-database-reset prompt over unrelated pre-existing drift. Hand-author the migration SQL file directly instead (Task 1 shows the exact, proven-safe procedure).
- Never run `prisma db execute` (or any command that touches the live shared dev database) without first asking the user for explicit approval — this is a standing project policy, not a per-task judgment call.
- Do not touch Mute/Kick behavior — they keep working exactly as today; only their *tiles on the Report Details screen* are removed.
- Do not touch the severity-tiered `escalateViolation`/`resolveEscalationRecipients` machinery itself — only the one call site in `actionReport`'s ESCALATE branch changes what severity it passes.

---

## Task 1: Thread `reportId` through the platform-ban pipeline

**Files:**
- Modify: `prisma/schema/platform_moderation.prisma`
- Create: `prisma/schema/migrations/20260819020000_platform_user_ban_report_id/migration.sql`
- Modify: `src/modules/platform-moderation/repositories/platform-ban.repository.ts`
- Modify: `src/modules/platform-moderation/services/platform-ban.service.ts`
- Test: `src/modules/platform-moderation/services/platform-ban.service.spec.ts`

**Interfaces:**
- Produces: `BanUserInput.reportId?: string` (optional) — Task 4 passes this when banning from a report.
- Produces: `CreatePlatformBanInput.reportId?: string | null` — internal repository contract.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/platform-moderation/services/platform-ban.service.spec.ts`, inside the existing `describe('banUser', ...)` block (after the existing "creates the ban row..." test):

```typescript
    it('threads an optional reportId through to the ban row when provided', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
        reportId: 'report-1',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ reportId: 'report-1' }),
      );
    });

    it('omits reportId when the caller does not supply one (existing direct-ban callers)', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ reportId: null }),
      );
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- platform-ban.service.spec.ts`
Expected: FAIL — TypeScript compile error, `reportId` does not exist on type `BanUserInput`.

- [ ] **Step 3: Edit the Prisma schema**

In `prisma/schema/platform_moderation.prisma`, inside the `PlatformUserBan` model, add one nullable field (after `originRoomId`, before `status`):

```prisma
model PlatformUserBan {
  id           String             @id @default(uuid()) @db.Uuid
  targetUserId String             @db.Uuid
  moderatorId  String             @db.Uuid
  reason       String
  roomType     PlatformRoomType
  originRoomId String             @db.Uuid
  reportId     String?            @db.Uuid
  status       PlatformBanStatus  @default(ACTIVE)
  bannedAt     DateTime           @default(now())
  expiresAt    DateTime
  liftedAt     DateTime?
  liftedBy     String?            @db.Uuid

  @@index([targetUserId, status])
  @@index([status, expiresAt])
  @@map("platform_user_bans")
}
```

- [ ] **Step 4: Hand-author the migration file**

Do **not** run `prisma migrate dev` — this repo has a standing, confirmed issue where it surfaces unrelated repo-wide schema drift and can prompt a full dev-database reset. Instead, create the migration file directly, matching the exact format of the most recent migration in this same table family (`prisma/schema/migrations/20260819010000_platform_moderation_warning_scope/migration.sql`), which itself just adds one nullable column:

Create `prisma/schema/migrations/20260819020000_platform_user_ban_report_id/migration.sql`:

```sql
-- Adds `reportId` to `platform_user_bans`, so a ban issued directly from a
-- report's "Ban" decision can be traced back to the report that caused it.
-- Nullable and additive — existing direct-ban callers (outside the report
-- flow) simply never set it. No backfill needed for existing rows.

-- AlterTable
ALTER TABLE "platform_user_bans" ADD COLUMN "reportId" TEXT;
```

(Column type is `TEXT`, matching every id/FK column already in this table — see the existing `targetUserId`/`moderatorId`/`originRoomId` columns in `20260818190000_platform_moderation_ban_and_audit/migration.sql` — not `UUID`, despite the schema's `@db.Uuid` attribute; that attribute controls Prisma's validation, not the underlying Postgres column type already established in this repo.)

- [ ] **Step 5: Regenerate the Prisma client (safe — no database access)**

Run: `pnpm prisma:generate`
Expected: succeeds, and `PlatformUserBan`/`CreatePlatformBanInput`-adjacent generated types now include `reportId`.

- [ ] **Step 6: STOP — do not apply the migration to the shared dev database yet**

Do not run `prisma db execute`, `prisma migrate deploy`, or `prisma migrate resolve` against the live dev database in this step. Ask the user for explicit approval first (e.g. via AskUserQuestion), per this repo's standing policy — the committed migration file is sufficient for CI's `prisma-drift` check and for `prisma migrate deploy` in any real deploy pipeline; applying it to the shared dev database right now is a separate, explicit decision for the user to make. If they approve, the proven-safe sequence (used previously in this repo for an isolated additive column) is:
```bash
npx prisma db execute --schema=prisma/schema --file=prisma/schema/migrations/20260819020000_platform_user_ban_report_id/migration.sql
npx prisma migrate resolve --applied 20260819020000_platform_user_ban_report_id
```

- [ ] **Step 7: Update the repository interface**

In `src/modules/platform-moderation/repositories/platform-ban.repository.ts`, update `CreatePlatformBanInput`:

```typescript
export interface CreatePlatformBanInput {
  targetUserId: string;
  moderatorId: string;
  reason: string;
  roomType: PlatformRoomType;
  originRoomId: string;
  reportId?: string | null;
  expiresAt: Date;
}
```

(`create()`'s body is unchanged — it already passes `input` straight through as `data`, so the new field flows through automatically.)

- [ ] **Step 8: Update the service**

In `src/modules/platform-moderation/services/platform-ban.service.ts`, update `BanUserInput`:

```typescript
export interface BanUserInput {
  moderatorId: string;
  targetUserId: string;
  reason: string;
  roomType: PlatformRoomType;
  originRoomId: string;
  reportId?: string;
}
```

And update the `repo.create` call inside `banUser`:

```typescript
    const ban = await this.repo.create({
      targetUserId: input.targetUserId,
      moderatorId: input.moderatorId,
      reason,
      roomType: input.roomType,
      originRoomId: input.originRoomId,
      reportId: input.reportId ?? null,
      expiresAt,
    });
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm test -- platform-ban.service.spec.ts`
Expected: PASS — all tests in the file, including the two new ones.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema/platform_moderation.prisma prisma/schema/migrations/20260819020000_platform_user_ban_report_id/migration.sql src/modules/platform-moderation/repositories/platform-ban.repository.ts src/modules/platform-moderation/services/platform-ban.service.ts src/modules/platform-moderation/services/platform-ban.service.spec.ts
git commit -m "feat(platform-moderation): thread optional reportId through platform bans"
```

---

## Task 2: Add `SocketManager.emitToUserInNamespace`

**Files:**
- Modify: `src/infra/socket/socket.manager.ts`
- Test: `src/infra/socket/socket.manager.spec.ts`

**Interfaces:**
- Produces: `SocketManager.emitToUserInNamespace(namespace: string, userId: string, event: string, payload: unknown): void` — Task 3 uses this for live-stream's private WARN delivery.
- Consumes: existing private `serverForNamespace(namespace: string): Server | undefined` and existing `emitToUser(server: Server, userId: string, event: string, payload: unknown): void`.

- [ ] **Step 1: Write the failing test**

Add to `src/infra/socket/socket.manager.spec.ts` (new top-level `describe`, after the existing `describe('SocketManager — incognito moderator join/leave', ...)` block — same file, same `manager`/`presence` setup is not reused since this is a separate concern; add a fresh `describe` with its own `beforeEach`):

```typescript
describe('SocketManager — namespace-scoped user targeting', () => {
  let manager: SocketManager;

  beforeEach(() => {
    manager = new SocketManager(
      {} as never, // tokenService
      {} as never, // presence
      {} as never, // metrics
      {} as never, // event bus
      {} as never, // roleSource
      new Map() as never, // joinPolicies
    );
  });

  describe('emitToUserInNamespace', () => {
    it('emits only to the target user within the given namespace', () => {
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      const server = { name: '/live', to } as never;
      manager.registerServer(server);

      manager.emitToUserInNamespace('/live', 'user-1', 'user.warned', { reason: 'be nice' });

      expect(to).toHaveBeenCalledWith('user:user-1');
      expect(emit).toHaveBeenCalledWith('user.warned', { reason: 'be nice' });
    });

    it('is a no-op when the namespace has not registered a server yet', () => {
      expect(() =>
        manager.emitToUserInNamespace('/live', 'user-1', 'user.warned', {}),
      ).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- socket.manager.spec.ts`
Expected: FAIL — `manager.emitToUserInNamespace is not a function`.

- [ ] **Step 3: Implement the method**

In `src/infra/socket/socket.manager.ts`, add this method immediately after `disconnectUserInNamespace` (around line 295, right before the `emitToNamespaceRoom` doc comment):

```typescript
  /**
   * Emit an event to one user's sockets within a single namespace only (e.g.
   * `/live`), leaving their sockets on every other namespace — DMs, other
   * rooms, calling, etc. — untouched. Mirrors `disconnectUserInNamespace`'s
   * namespace resolution. A no-op if that namespace has not initialised yet.
   */
  emitToUserInNamespace(namespace: string, userId: string, event: string, payload: unknown): void {
    const server = this.serverForNamespace(namespace);
    if (!server) {
      this.logger.warn(`emitToUserInNamespace: no server for namespace "${namespace}"`);
      return;
    }
    this.emitToUser(server, userId, event, payload);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- socket.manager.spec.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/infra/socket/socket.manager.ts src/infra/socket/socket.manager.spec.ts
git commit -m "feat(socket): add emitToUserInNamespace for targeted per-namespace delivery"
```

---

## Task 3: Fix live-stream WARN private-scope delivery

**Files:**
- Modify: `src/modules/live-streaming/services/live-stream.service.ts`
- Test: `src/modules/live-streaming/services/live-stream.service.spec.ts`

**Interfaces:**
- Consumes: `SocketManager.emitToUserInNamespace` (Task 2).

Context: `LiveStreamService` already injects `NOTIFICATION_SERVICE` (`this.notifications`) but never calls it anywhere in the file — the code comment claiming "the existing private-notification path elsewhere handles it" is stale/wrong. A PRIVATE-scope (the default) WARN currently does nothing at the socket layer. Audio rooms and video rooms already deliver private warnings correctly (targeted socket event, moderator identity replaced by `SYSTEM_MODERATOR_ID`) — this task brings live streams to parity using the exact same shape of payload the ROOM-scope branch already builds.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/live-streaming/services/live-stream.service.spec.ts`, inside the existing `describe('moderateUser — WARN scope', ...)` block (after the existing "scope=PRIVATE (default) does not broadcast to the room" test):

```typescript
    it('scope=PRIVATE (default) sends a targeted, anonymized socket event to just the target user', async () => {
      await subject.moderateUser({
        streamId: STREAM_ID,
        moderatorId: MODERATOR_ID,
        targetUserId: VIEWER_ID,
        action: 'WARN',
        reason: 'be nice',
      });

      expect(sockets.emitToUserInNamespace).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        VIEWER_ID,
        LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
        expect.objectContaining({
          streamId: STREAM_ID,
          moderatorId: SYSTEM_MODERATOR_ID,
          systemMessage: 'be nice',
        }),
      );
    });
```

Also update the `sockets` mock at the top of the file (around line 69) to include the new method:

```typescript
    sockets = {
      disconnectUserInNamespace: jest.fn(),
      emitToNamespaceRoom: jest.fn(),
      emitToUserInNamespace: jest.fn(),
    };
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- live-stream.service.spec.ts`
Expected: FAIL — `sockets.emitToUserInNamespace` was never called (the PRIVATE branch currently does nothing).

- [ ] **Step 3: Implement the fix**

In `src/modules/live-streaming/services/live-stream.service.ts`, replace the WARN branch of `enforceModerationAction` (currently only acts when `input.scope === 'ROOM'`):

```typescript
    if (input.action === 'WARN') {
      const payload = {
        streamId,
        targetUserId: input.targetUserId,
        moderatorId: SYSTEM_MODERATOR_ID,
        systemMessage: input.reason ?? 'A moderator issued a warning.',
      };
      if (input.scope === 'ROOM') {
        this.sockets.emitToNamespaceRoom(
          LIVE_STREAM_NAMESPACE,
          streamId,
          LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
          payload,
        );
      } else {
        this.sockets.emitToUserInNamespace(
          LIVE_STREAM_NAMESPACE,
          input.targetUserId,
          LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
          payload,
        );
      }
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: input.moderatorId,
          action: 'WARNING_SENT',
          roomType: 'LIVE_STREAM',
          roomId: streamId,
          targetUserId: input.targetUserId,
          reason: input.reason,
          scope: input.scope,
        });
      }
      return;
    }
```

Also update the stale doc comment above `enforceModerationAction` (the bullet starting "WARN: an ephemeral `USER_WARNED` socket broadcast...") to reflect the fix:

```typescript
   *  - WARN: an ephemeral `USER_WARNED` socket event, System-attributed.
   *    ROOM scope broadcasts to everyone in the stream; PRIVATE (the
   *    default) targets only the recipient's sockets on `/live`. No durable
   *    row either way — a warning is not a state change.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- live-stream.service.spec.ts`
Expected: PASS — every test in the file, including the pre-existing "scope=PRIVATE (default) does not broadcast to the room" test (still true — it broadcasts to nothing via `emitToNamespaceRoom`, it now targets the user via a different method).

- [ ] **Step 5: Commit**

```bash
git add src/modules/live-streaming/services/live-stream.service.ts src/modules/live-streaming/services/live-stream.service.spec.ts
git commit -m "fix(live-streaming): deliver PRIVATE-scope warnings to the target user's socket"
```

---

## Task 4: `MobileWorkforceService` — Ban executes immediately

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Test: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- Consumes: `PlatformBanService.banUser(input: BanUserInput)` (Task 1's `reportId` field), already injected as `this.platformBans` (no new DI wiring needed — `PlatformModerationModule` is already imported into `MobileWorkforceModule` and `@Optional() platformBans?: PlatformBanService` is already a constructor param, used today by the bans list/unban delegation).

Context: today, hitting "Ban" on a report calls `reviewReport(..., recommendedAction: 'BAN')`, which — for every room type — routes into `ModerationApprovalService`'s pending-approval queue instead of executing. This task carves BAN into its own branch that updates the report status directly (no `recommendedAction`, so the approval-routing code inside `reviewReport` never triggers) and then calls `PlatformBanService.banUser` directly — the exact same call the standalone `POST rooms/:id/moderation/platform-ban/:userId`-family endpoints already make.

- [ ] **Step 1: Write the failing tests**

In `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`:

1. Add a `platformBans` mock near the other mocks (after the `const liveStream = { escalateViolation: jest.fn() };` line, around line 70):

```typescript
  const platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
```

2. Add it as the 13th constructor argument in the shared `beforeEach` (around line 86-99):

```typescript
    service = new MobileWorkforceService(
      prisma as unknown as PrismaService,
      scope as unknown as WorkforceScopeService,
      scopes as unknown as GeographicScopeResolver,
      shiftService as any,
      undefined,
      audioModeration as any,
      videoReports as any,
      videoModeration as any,
      liveStreamReports as any,
      liveStream as any,
      investigationRecording as any,
      permissionResolver as any,
      platformBans as any,
    );
```

3. Replace the existing `'Ban reports pending_approval, not executed'` test (inside `describe('actionReport', ...)`, around line 728) with:

```typescript
    it('Ban executes immediately via PlatformBanService, not the approval queue', async () => {
      const result = await service.actionReport(
        'mod-1',
        'r-1',
        { action: 'Ban', note: 'severe' },
        actorRoles,
      );

      expect(audioModeration.reviewReport).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'room-1',
        'r-1',
        { status: 'ACTIONED', resolution: 'severe' },
      );
      expect(platformBans.banUser).toHaveBeenCalledWith({
        moderatorId: 'mod-1',
        targetUserId: 'u-2',
        reason: 'severe',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
        reportId: 'r-1',
      });
      expect(result.outcome).toBe('executed');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- mobile-workforce.service.spec.ts`
Expected: FAIL — the new assertions don't match today's behavior (`reviewReport` is called with `recommendedAction: 'BAN'` and `platformBans.banUser` is never called; `result.outcome` is `'pending_approval'`).

- [ ] **Step 3: Implement the fix**

In `src/modules/mobile-workforce/services/mobile-workforce.service.ts`:

1. Add the import and a room-type mapping constant near the top of the file (after the `@prisma/client` import block, alongside the other module-level consts like `QUICK_MUTE_DURATION_MINUTES`):

```typescript
import type { PlatformRoomType } from '@prisma/client';
```

```typescript
/** Maps a resolved report's room type to the platform-ban surface's own enum. */
const REPORT_ROOM_TYPE_TO_PLATFORM: Record<ReportRoomType, PlatformRoomType> = {
  audio: 'AUDIO_ROOM',
  video: 'VIDEO_ROOM',
  stream: 'LIVE_STREAM',
};
```

2. Replace the combined "WARN / MUTE / KICK / BAN" block (the block starting with the comment `// WARN / MUTE / KICK / BAN — one reviewReport call each, per surface.` and its `const outcome = normalized === 'BAN' ? 'pending_approval' : 'executed';` line, through its final `return { success: true, reportId, action: normalized, outcome };`) with:

```typescript
    if (normalized === 'BAN') {
      if (!this.platformBans) {
        throw new BadRequestException('Platform ban service is not available.');
      }
      if (ctx.roomType === 'audio') {
        await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
          status: 'ACTIONED' as any,
          resolution: note,
        });
      } else if (ctx.roomType === 'video') {
        await this.videoReports!.reviewReport(
          actor,
          ctx.roomId,
          reportId,
          { status: 'ACTIONED' as any, resolutionAction: note } as any,
          requestMeta,
        );
      } else {
        await this.liveStreamReports!.reviewReport(
          {
            reportId,
            streamId: ctx.roomId,
            moderatorId: userId,
            status: 'ACTIONED' as any,
            resolution: note,
          },
          requestMeta,
        );
      }

      await this.platformBans.banUser({
        moderatorId: userId,
        targetUserId: ctx.targetUserId,
        reason: note,
        roomType: REPORT_ROOM_TYPE_TO_PLATFORM[ctx.roomType],
        originRoomId: ctx.roomId,
        reportId,
      });

      return { success: true, reportId, action: normalized, outcome: 'executed' };
    }

    // WARN / MUTE / KICK — one reviewReport call each, per surface; the
    // target room-type service auto-executes these three immediately. BAN is
    // handled above — it bans immediately via PlatformBanService rather than
    // routing through here, so a report-driven ban never reaches
    // ModerationApprovalService's approval queue.
    if (ctx.roomType === 'audio') {
      const recommendedAction = normalized === 'WARN' ? 'WARNING' : normalized;
      await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
        status: 'ACTIONED' as any,
        resolution: note,
        recommendedAction: recommendedAction as any,
      });
    } else if (ctx.roomType === 'video') {
      const recommendedAction = normalized === 'WARN' ? 'WARNING' : normalized;
      await this.videoReports!.reviewReport(
        actor,
        ctx.roomId,
        reportId,
        {
          status: 'ACTIONED' as any,
          resolutionAction: note,
          recommendedAction: recommendedAction as any,
        } as any,
        requestMeta,
      );
    } else {
      // Live-stream's DTO literal is 'WARN', not 'WARNING' — do not reuse the
      // audio/video mapping above.
      await this.liveStreamReports!.reviewReport(
        {
          reportId,
          streamId: ctx.roomId,
          moderatorId: userId,
          status: 'ACTIONED' as any,
          resolution: note,
          recommendedAction: normalized as any,
        },
        requestMeta,
      );
    }

    return { success: true, reportId, action: normalized, outcome: 'executed' };
  }
```

4. Update the method's return type annotation (drop the now-unreachable `'pending_approval'` literal):

```typescript
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
    outcome: 'executed' | 'dismissed' | 'escalated';
  }> {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- mobile-workforce.service.spec.ts`
Expected: PASS — every test in the file (the WARN, CLOSE_FALSE_REPORT, and live-stream-routing tests are untouched by this change and must still pass unmodified).

- [ ] **Step 5: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "feat(mobile-workforce): report-driven Ban executes immediately via PlatformBanService"
```

---

## Task 5: `MobileWorkforceService` — Escalate always reaches Admin

**Files:**
- Modify: `src/modules/mobile-workforce/services/mobile-workforce.service.ts`
- Test: `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`

**Interfaces:**
- Consumes: existing `escalateViolation(actor, roomId, targetUserId, reason, severity, requestMeta?)` on `ModerationService`/`VideoRoomModerationService`, and `LiveStreamService.escalateViolation(streamId, moderatorId, targetUserId, reason, severity)` — unchanged signatures, only the `severity` argument's value changes at this one call site.

Context: `resolveEscalationRecipients('EMERGENCY', ownerId)` (in `WorkforceScopeService`, unchanged by this task) already resolves unconditionally to every ADMIN/SUPER_ADMIN account, bypassing the Official/Country-Manager territory routing the `HIGH`/`CRITICAL` tiers use. This task makes the report-decision ESCALATE branch always pass `'EMERGENCY'` instead of deriving `HIGH`/`CRITICAL` from report priority, and tags the reason with the report id so the resulting `MODERATION_CASE_ESCALATED` notification (and its audit-log row) identifies which report it came from.

- [ ] **Step 1: Write the failing test**

In `src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts`, replace the existing `'Escalate reviews the report as REVIEWED then calls escalateViolation with derived severity'` test (around line 762) with:

```typescript
    it('Escalate reviews the report as REVIEWED then always escalates at EMERGENCY severity, tagged with the report id', async () => {
      const result = await service.actionReport(
        'mod-1',
        'r-1',
        { action: 'Escalate', note: 'urgent' },
        actorRoles,
      );

      expect(audioModeration.reviewReport).toHaveBeenCalledWith(
        expect.anything(),
        'room-1',
        'r-1',
        { status: 'REVIEWED', resolution: 'urgent' },
      );
      // Always EMERGENCY — resolveEscalationRecipients resolves that tier to
      // every ADMIN/SUPER_ADMIN unconditionally, regardless of report
      // priority (HARASSMENT would otherwise derive to HIGH, not EMERGENCY).
      expect(audioModeration.escalateViolation).toHaveBeenCalledWith(
        { id: 'mod-1', roles: actorRoles },
        'room-1',
        'u-2',
        '[Report #r-1 escalation] urgent',
        'EMERGENCY',
      );
      expect(result.outcome).toBe('escalated');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- mobile-workforce.service.spec.ts`
Expected: FAIL — `escalateViolation` is currently called with `'HIGH'` (HARASSMENT's derived severity) and the plain `'urgent'` reason, not `'EMERGENCY'` and the tagged reason.

- [ ] **Step 3: Implement the fix**

In `src/modules/mobile-workforce/services/mobile-workforce.service.ts`:

1. Remove the now-dead `const severity = deriveReportPriority(ctx.reason) === 'Highest priority' ? 'CRITICAL' : 'HIGH';` line (still inside `actionReport`, right before the `if (normalized === 'CLOSE_FALSE_REPORT')` check) — this block is its only remaining use after the replacement below, and Task 4 already stopped using it for BAN.

2. Replace the `if (normalized === 'ESCALATE') { ... }` block:

```typescript
    if (normalized === 'ESCALATE') {
      // Escalating from a report always reaches every ADMIN/SUPER_ADMIN
      // directly — 'EMERGENCY' is the one severity tier
      // resolveEscalationRecipients resolves unconditionally to
      // getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN']), bypassing the
      // Official/Country-Manager territory routing the other tiers use. The
      // report id is folded into the reason so the resulting
      // MODERATION_CASE_ESCALATED notification (and its audit-log row)
      // identifies which report it came from.
      const escalationReason = `[Report #${reportId} escalation] ${note}`;
      if (ctx.roomType === 'audio') {
        await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
          status: 'REVIEWED' as any,
          resolution: note,
        });
        await this.callEscalateViolation(
          this.audioModeration!,
          actor,
          ctx.roomId,
          ctx.targetUserId,
          escalationReason,
          'EMERGENCY',
          requestMeta,
        );
      } else if (ctx.roomType === 'video') {
        await this.videoReports!.reviewReport(
          actor,
          ctx.roomId,
          reportId,
          {
            status: 'REVIEWED' as any,
            resolutionAction: note,
          } as any,
          requestMeta,
        );
        await this.callEscalateViolation(
          this.videoModeration!,
          actor,
          ctx.roomId,
          ctx.targetUserId,
          escalationReason,
          'EMERGENCY',
          requestMeta,
        );
      } else {
        await this.liveStreamReports!.reviewReport({
          reportId,
          streamId: ctx.roomId,
          moderatorId: userId,
          status: 'REVIEWED' as any,
          resolution: note,
        });
        await this.liveStream!.escalateViolation(
          ctx.roomId,
          userId,
          ctx.targetUserId,
          escalationReason,
          'EMERGENCY',
        );
      }
      return { success: true, reportId, action: normalized, outcome: 'escalated' };
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- mobile-workforce.service.spec.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Verify no unused-import/dead-code lint errors**

Run: `pnpm lint` (or `npx eslint src/modules/mobile-workforce/services/mobile-workforce.service.ts` if `pnpm lint` scopes to the whole repo and is slow)
Expected: clean — `deriveReportPriority` is still imported and used elsewhere in this file (`moderationQueue`, `reportDetails`); only the local `severity` variable was removed, and it had no other references.

- [ ] **Step 6: Commit**

```bash
git add src/modules/mobile-workforce/services/mobile-workforce.service.ts src/modules/mobile-workforce/services/mobile-workforce.service.spec.ts
git commit -m "feat(mobile-workforce): report-driven Escalate always reaches Admin directly"
```

---

## Task 6: Flutter — trim Report Details to 4 actions, fix outcome messaging

**Files:**
- Modify: `soulzaa-mobile/lib/features/moderator/presentation/screens/moderator_report_details_screen.dart`
- Test: `soulzaa-mobile/test/features/moderator/moderator_report_details_screen_test.dart`

**Interfaces:**
- Consumes: `ModeratorRemoteDataSource.submitReportDecision({reportId, action, note}) → Future<Map<String, dynamic>>` — unchanged signature; only the set of `action` values the UI can send, and how the result is interpreted, change.

- [ ] **Step 1: Write the failing tests**

In `soulzaa-mobile/test/features/moderator/moderator_report_details_screen_test.dart`:

1. Replace the moderation-action-buttons assertions in the first test (`'renders report details screen with summary, evidence, and moderation actions'`, around lines 92-98):

```dart
    // Moderation Action buttons — exactly 4: Mute/Kick are not offered here
    // (they remain reachable via the in-room moderation sheet, not report
    // review).
    expect(find.text('Warn'), findsOneWidget);
    expect(find.text('Mute'), findsNothing);
    expect(find.text('Kick'), findsNothing);
    expect(find.text('Ban'), findsOneWidget);
    expect(find.text('Escalate'), findsOneWidget);
    expect(find.text('Close false report'), findsOneWidget);
```

2. In the same test, the submit-flow still taps "Warn" (line ~101) — no change needed there.

3. Replace the second test (`'successful submit shows a real outcome message and refreshes the list'`, around lines 115-145) — it taps "Warn" and asserts `find.textContaining('recorded')`, which no longer matches the new per-action message. Replace the final assertion:

```dart
    expect(find.text('Warning sent to the reported user.'), findsOneWidget);
```

4. Replace the third test (`'failed submit shows the real error and does not pop'`, around lines 147-177) — it taps `find.text('Mute')`, which no longer exists. Change it to tap `'Ban'`:

```dart
    await tester.tap(find.text('Ban'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Banned for repeated harassment.');
```

(keep the rest of that test — `find.byType(TextField)`, the submit tap, and the "did not pop" / "Network error" assertions — unchanged.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `flutter test test/features/moderator/moderator_report_details_screen_test.dart`
Expected: FAIL — Mute/Kick tiles still render today, and the success message is still the generic `'Action "Warn" recorded for ...'` text, not `'Warning sent to the reported user.'`.

- [ ] **Step 3: Implement the fix**

In `soulzaa-mobile/lib/features/moderator/presentation/screens/moderator_report_details_screen.dart`:

1. Replace the two-row, 6-tile moderation-actions grid (the `Row(...)` / `SizedBox(height: 8)` / `Row(...)` block starting around line 606, ending right before `const Divider(height: 24, ...)` at line 673) with a 2x2 grid of exactly the 4 tiles:

```dart
          // 2x2 Grid of Moderation Action Buttons
          Row(
            children: <Widget>[
              Expanded(
                child: _buildActionTile(
                  title: 'Warn',
                  subtitle: 'Issue warning',
                  icon: Icons.warning_rounded,
                  iconColor: const Color(0xFFFFB300),
                  enabled: report.canTakeAction,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildActionTile(
                  title: 'Ban',
                  subtitle: 'Restrict access',
                  icon: Icons.person_off_rounded,
                  iconColor: const Color(0xFFE53935),
                  enabled: report.canTakeAction,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              Expanded(
                child: _buildActionTile(
                  title: 'Escalate',
                  subtitle: 'To admin',
                  icon: Icons.warning_amber_rounded,
                  iconColor: Colors.black87,
                  enabled: report.canTakeAction,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildActionTile(
                  title: 'Close false report',
                  subtitle: 'Mark as false',
                  icon: Icons.cancel_rounded,
                  iconColor: const Color(0xFFE53935),
                  enabled: report.canTakeAction,
                ),
              ),
            ],
          ),
```

2. Add a private message-mapping method (near `_submitAction`, e.g. right after it):

```dart
  String _successMessage() {
    switch (_selectedAction) {
      case 'Warn':
        return 'Warning sent to the reported user.';
      case 'Ban':
        return 'User banned for 24 hours and removed from the room.';
      case 'Escalate':
        return 'Report escalated to admin for review.';
      case 'Close false report':
        return 'Report marked as false and resolved.';
      default:
        return 'Action recorded for ${widget.report.reportCode}.';
    }
  }
```

3. Replace the body of `_submitAction`'s try block (which currently captures `result` and branches on `outcome == 'pending_approval'`):

```dart
    try {
      await ref.read(moderatorRemoteDataSourceProvider).submitReportDecision(
            reportId: widget.report.id,
            action: _selectedAction!,
            note: _noteController.text.trim(),
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_successMessage()), backgroundColor: const Color(0xFF2E7D32)),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `flutter test test/features/moderator/moderator_report_details_screen_test.dart`
Expected: PASS — all 4 tests in the file.

- [ ] **Step 5: Run `flutter analyze` for the whole moderator feature**

Run: `flutter analyze lib/features/moderator/`
Expected: clean — no unused-import or unused-variable warnings from the removed Mute/Kick tiles or the removed `outcome` branching.

- [ ] **Step 6: Commit**

```bash
git add lib/features/moderator/presentation/screens/moderator_report_details_screen.dart test/features/moderator/moderator_report_details_screen_test.dart
git commit -m "feat(moderator): trim Report Details to Warn/Ban/Escalate/Close, fix outcome messaging"
```

(Run this `git add`/`git commit` from the `soulzaa-mobile` working directory, not `soulzaa-backend`.)
