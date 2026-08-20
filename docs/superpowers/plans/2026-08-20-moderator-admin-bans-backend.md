# Moderator/Admin Portal Ban & Warning Enforcement — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the backend gaps identified in `docs/superpowers/specs/2026-08-20-moderator-admin-portal-bans-design.md` — a login-time gate + branded notification for the existing 24h individual ban (`PlatformUserBan`), a fully new and fully separate Broad Ban mechanism (own model/service/guard), and a shared Extend-Ban capability for both ban types.

**Architecture:** Reuse `PlatformBanService`/`PlatformUserBan` unchanged except for two additions (a login-time check, an extend method, and a notification emit). Add a new, independent `BroadBanService`/`BroadBan` pair living alongside it in the same `platform-moderation` module (same module folder, separate files/classes/table — never sharing state with `PlatformUserBan`). Wire `BroadBanService`'s creation-only guard into the three room-create call sites without touching the existing `PlatformBanService` guard already present at all six create/start/join call sites.

**Tech Stack:** NestJS, Prisma (Postgres), Redis, Jest (manual mocks, not `TestingModule` — see existing `platform-ban.service.spec.ts`).

## Global Constraints

- Ban duration is fixed at 24 hours for both `PlatformUserBan` (unchanged) and the new `BroadBan` — no duration picker on either moderator-facing ban form.
- `BroadBan` must never write to `PlatformUserBan`, and issuing a Broad ban must never trigger the account-wide login block. The two ban types share only the "Soulzaa Official" notification label and the room-teardown event pipeline (`RoomEndedEvent`/`RoomClosedEvent`), never ban state.
- The Broad-ban reason field is free text (mirrors the existing `BanUserGloballyDto.reason` convention) — the "selectable reason" requirement is a frontend dropdown over this field, not a new backend enum. Do not add reason-enum validation to the DTO.
- `assertNotGloballyBanned` (Item 1's existing enforcement at all six create/start/join call sites) is not modified anywhere in this plan.
- The sender label `"Soulzaa Official"` is a single shared string constant, never a real user/DB row.
- Follow the existing manual-mock Jest pattern used in `platform-ban.service.spec.ts` for every new/modified service test in this plan — do not introduce `Test.createTestingModule` where the surrounding file doesn't already use it.

---

## File Structure

New files:
- `src/common/constants/moderation-sender.constant.ts` — the shared `"Soulzaa Official"` label.
- `src/modules/platform-moderation/dto/ban-broad.dto.ts` — `BanBroadDto` (reason, description, proofUrl).
- `src/modules/platform-moderation/dto/extend-ban.dto.ts` — `ExtendBanDto` (additionalHours), shared by both ban types.
- `src/modules/platform-moderation/dto/list-broad-bans.dto.ts` — `ListBroadBansDto`, mirrors `ListPlatformBansDto`.
- `src/modules/platform-moderation/repositories/broad-ban.repository.ts` + `.spec.ts`
- `src/modules/platform-moderation/services/broad-ban.service.ts` + `.spec.ts`

Modified files:
- `prisma/schema/platform_moderation.prisma` — add `BroadBanStatus` enum + `BroadBan` model.
- `src/common/exceptions/error-codes.ts` — add `ACCOUNT_BANNED`.
- `src/infra/storage/storage.constants.ts` — add `BROAD_BAN_EVIDENCE` category.
- `src/modules/platform-moderation/services/platform-ban.service.ts` + `.spec.ts` — notify-on-ban, `extendBan()`.
- `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts` — extend endpoint + broad-ban admin endpoints.
- `src/modules/platform-moderation/platform-moderation.module.ts` — register the new repository/service.
- `src/modules/auth/services/auth.service.ts` + `.spec.ts` — login-time ban gate.
- `src/modules/auth/auth.module.ts` — import `PlatformModerationModule`.
- `src/modules/audio-rooms/services/audio-rooms.service.ts` — Broad-ban creation guard.
- `src/modules/audio-rooms/controllers/moderation.controller.ts` — Broad Ban endpoint.
- `src/modules/audio-rooms/dto/moderation.dto.ts` — re-export `BanBroadDto` for controller use (see Task 13).
- `src/modules/video-rooms/services/video-room-lifecycle.service.ts` — Broad-ban creation guard.
- `src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts` — Broad Ban endpoint.
- `src/modules/live-streaming/services/live-stream.service.ts` — Broad-ban creation guard.
- `src/modules/live-streaming/controllers/live-stream.controller.ts` — Broad Ban endpoint.

---

### Task 1: Shared sender constant + `ACCOUNT_BANNED` error code

**Files:**
- Create: `src/common/constants/moderation-sender.constant.ts`
- Modify: `src/common/exceptions/error-codes.ts`

**Interfaces:**
- Produces: `MODERATION_SENDER_NAME` (string constant, value `'Soulzaa Official'`), `ERROR_CODES.ACCOUNT_BANNED` (string `'ACCOUNT_BANNED'`).

- [ ] **Step 1: Create the sender constant**

```ts
// src/common/constants/moderation-sender.constant.ts
/** Display name attached to every ban/warning notification a user or Broad
 * owner receives. Not a real user row — purely a label carried on
 * notification payloads (mirrors how system chat messages already render
 * under a fixed sentinel label with no backing profile). */
export const MODERATION_SENDER_NAME = 'Soulzaa Official';
```

- [ ] **Step 2: Add the error code**

In `src/common/exceptions/error-codes.ts`, immediately after the existing `ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',` line, add:

```ts
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
```

- [ ] **Step 3: Commit**

```bash
git add src/common/constants/moderation-sender.constant.ts src/common/exceptions/error-codes.ts
git commit -m "feat: add Soulzaa Official sender constant and ACCOUNT_BANNED error code"
```

---

### Task 2: `PlatformBanService` notifies the target with the "Soulzaa Official" message on ban

**Files:**
- Modify: `src/modules/platform-moderation/services/platform-ban.service.ts`
- Test: `src/modules/platform-moderation/services/platform-ban.service.spec.ts`

**Interfaces:**
- Consumes: `MODERATION_SENDER_NAME` (Task 1), existing `sockets.emitToUserEverywhere(userId, event, payload)`.
- Produces: `banUser()` now emits socket event `'platform-ban.account-banned'` with `{ sender, reason, expiresAt }` before the delayed full disconnect. Later tasks (mobile) listen for this event name.

- [ ] **Step 1: Write the failing test**

Add to the `describe('banUser', ...)` block in `platform-ban.service.spec.ts`, after the existing "creates the ban row..." test:

```ts
    it('notifies the target with the Soulzaa Official ban message before the delayed disconnect', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
      });

      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        'target-1',
        'platform-ban.account-banned',
        expect.objectContaining({
          sender: 'Soulzaa Official',
          reason: 'harassment',
          expiresAt: '2026-08-19T00:00:00.000Z',
        }),
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- platform-ban.service.spec.ts -t "notifies the target"`
Expected: FAIL — `emitToUserEverywhere` was not called with `'platform-ban.account-banned'`.

- [ ] **Step 3: Implement**

In `platform-ban.service.ts`, add the import:

```ts
import { MODERATION_SENDER_NAME } from 'src/common/constants/moderation-sender.constant';
```

In `banUser()`, immediately after the `await this.redis.set(...)` call and before the `await this.endActiveRoomsFor(...)` call, add:

```ts
    this.sockets.emitToUserEverywhere(input.targetUserId, 'platform-ban.account-banned', {
      sender: MODERATION_SENDER_NAME,
      reason,
      expiresAt: expiresAt.toISOString(),
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- platform-ban.service.spec.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/modules/platform-moderation/services/platform-ban.service.ts src/modules/platform-moderation/services/platform-ban.service.spec.ts
git commit -m "feat: notify banned user with Soulzaa Official message on platform ban"
```

---

### Task 3: `PlatformBanService.extendBan()`

**Files:**
- Modify: `src/modules/platform-moderation/services/platform-ban.service.ts`
- Test: `src/modules/platform-moderation/services/platform-ban.service.spec.ts`

**Interfaces:**
- Consumes: `PlatformBanRepository.findById`, a new `PlatformBanRepository.extend(id, expiresAt)` method (added in this task).
- Produces: `PlatformBanService.extendBan(adminId: string, banId: string, additionalHours: number): Promise<PlatformUserBan>` — later consumed by the admin controller (Task 4) and, eventually, the Admin Portal's "Extend Ban" button (Plan C).

- [ ] **Step 1: Write the failing repository test**

Add to `src/modules/platform-moderation/repositories/platform-ban.repository.spec.ts` (read the file first to match its existing mock-prisma setup style), a test asserting:

```ts
  it('extends an existing ban to a new expiry', async () => {
    prisma.platformUserBan.update.mockResolvedValue({ id: 'ban-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') });
    const result = await repo.extend('ban-1', new Date('2026-08-20T00:00:00.000Z'));
    expect(prisma.platformUserBan.update).toHaveBeenCalledWith({
      where: { id: 'ban-1' },
      data: { expiresAt: new Date('2026-08-20T00:00:00.000Z') },
    });
    expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- platform-ban.repository.spec.ts -t "extends an existing ban"`
Expected: FAIL — `repo.extend is not a function`.

- [ ] **Step 3: Add the repository method**

In `platform-ban.repository.ts`, add after `lift()`:

```ts
  extend(id: string, expiresAt: Date): Promise<PlatformUserBan> {
    return this.prisma.platformUserBan.update({
      where: { id },
      data: { expiresAt },
    });
  }
```

- [ ] **Step 4: Run repository test to verify it passes**

Run: `npm test -- platform-ban.repository.spec.ts`
Expected: PASS

- [ ] **Step 5: Write the failing service test**

Add to `platform-ban.service.spec.ts`, a new `describe('extendBan', ...)` block:

```ts
  describe('extendBan', () => {
    it('rejects a ban that is not ACTIVE', async () => {
      repo.findById.mockResolvedValue({ id: 'ban-1', status: 'LIFTED', targetUserId: 'target-1' });
      await expect(service.extendBan('admin-1', 'ban-1', 24)).rejects.toThrow('not active');
    });

    it('pushes expiresAt forward by additionalHours from the CURRENT expiry, re-primes the Redis TTL, and notifies the target', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
      try {
        repo.findById.mockResolvedValue({
          id: 'ban-1',
          status: 'ACTIVE',
          targetUserId: 'target-1',
          reason: 'harassment',
          expiresAt: new Date('2026-08-19T00:00:00.000Z'),
        });
        repo.extend = jest.fn().mockResolvedValue({
          id: 'ban-1',
          status: 'ACTIVE',
          targetUserId: 'target-1',
          reason: 'harassment',
          expiresAt: new Date('2026-08-20T00:00:00.000Z'),
        });

        const result = await service.extendBan('admin-1', 'ban-1', 24);

        expect(repo.extend).toHaveBeenCalledWith('ban-1', new Date('2026-08-20T00:00:00.000Z'));
        expect(redis.set).toHaveBeenCalledWith(
          'platform-ban:user:target-1',
          expect.any(String),
          'EX',
          expect.any(Number),
        );
        expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
          'target-1',
          'platform-ban.account-banned',
          expect.objectContaining({
            sender: 'Soulzaa Official',
            reason: 'harassment',
            expiresAt: '2026-08-20T00:00:00.000Z',
          }),
        );
        expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
      } finally {
        jest.useRealTimers();
      }
    });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- platform-ban.service.spec.ts -t "extendBan"`
Expected: FAIL — `service.extendBan is not a function`.

- [ ] **Step 7: Implement**

In `platform-ban.service.ts`, add after `unbanUser()`:

```ts
  async extendBan(adminId: string, banId: string, additionalHours: number): Promise<PlatformUserBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      throw new BadRequestException('This ban is not active.');
    }

    const newExpiresAt = new Date(ban.expiresAt.getTime() + additionalHours * 3600 * 1000);
    const extended = await this.repo.extend(banId, newExpiresAt);

    const ttlSeconds = Math.max(1, Math.floor((newExpiresAt.getTime() - Date.now()) / 1000));
    await this.redis.set(
      banRedisKey(ban.targetUserId),
      JSON.stringify({ reason: ban.reason, expiresAt: newExpiresAt.toISOString() }),
      'EX',
      ttlSeconds,
    );

    this.sockets.emitToUserEverywhere(ban.targetUserId, 'platform-ban.account-banned', {
      sender: MODERATION_SENDER_NAME,
      reason: ban.reason,
      expiresAt: newExpiresAt.toISOString(),
    });

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_ISSUED',
      roomType: ban.roomType,
      roomId: ban.originRoomId,
      targetUserId: ban.targetUserId,
      reason: `Extended by ${additionalHours}h`,
    });

    return extended;
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- platform-ban.service.spec.ts platform-ban.repository.spec.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/modules/platform-moderation/services/platform-ban.service.ts src/modules/platform-moderation/services/platform-ban.service.spec.ts src/modules/platform-moderation/repositories/platform-ban.repository.ts src/modules/platform-moderation/repositories/platform-ban.repository.spec.ts
git commit -m "feat: add PlatformBanService.extendBan"
```

---

### Task 4: `ExtendBanDto` + admin extend endpoint for individual bans

**Files:**
- Create: `src/modules/platform-moderation/dto/extend-ban.dto.ts`
- Modify: `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts`
- Test: `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts` (create if it does not already exist — check first with `find src/modules/platform-moderation/controllers -name "*.spec.ts"`; if none exists, follow the manual-mock pattern from `platform-ban.service.spec.ts` for a thin controller test)

**Interfaces:**
- Consumes: `PlatformBanService.extendBan` (Task 3).
- Produces: `ExtendBanDto { additionalHours: number }`, reused as-is by Task 8's Broad-ban extend endpoint.

- [ ] **Step 1: Create the shared DTO**

```ts
// src/modules/platform-moderation/dto/extend-ban.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ExtendBanDto {
  @ApiProperty({ description: 'Hours to add to the ban\'s current expiry.', minimum: 1 })
  @IsInt()
  @Min(1)
  additionalHours!: number;
}
```

- [ ] **Step 2: Write the failing controller test**

Create `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts`:

```ts
import { PlatformModerationAdminController } from './platform-moderation-admin.controller';

describe('PlatformModerationAdminController', () => {
  let bans: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let broadBans: Record<string, jest.Mock>;
  let controller: PlatformModerationAdminController;

  beforeEach(() => {
    bans = {
      list: jest.fn().mockResolvedValue([[], 0]),
      unbanUser: jest.fn(),
      extendBan: jest.fn().mockResolvedValue({ id: 'ban-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') }),
    };
    audit = { list: jest.fn().mockResolvedValue([[], 0]) };
    broadBans = {
      list: jest.fn().mockResolvedValue([[], 0]),
      liftBroadBan: jest.fn(),
      extendBroadBan: jest.fn(),
    };
    controller = new PlatformModerationAdminController(bans as never, audit as never, broadBans as never);
  });

  describe('extendBan', () => {
    it('delegates to PlatformBanService.extendBan with the admin id, ban id, and additional hours', async () => {
      const result = await controller.extendBan(
        { id: 'admin-1' } as never,
        'ban-1',
        { additionalHours: 24 },
      );
      expect(bans.extendBan).toHaveBeenCalledWith('admin-1', 'ban-1', 24);
      expect(result.id).toBe('ban-1');
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- platform-moderation-admin.controller.spec.ts`
Expected: FAIL — constructor takes 2 args currently (missing `broadBans`), `extendBan` method doesn't exist.

- [ ] **Step 4: Implement the endpoint**

In `platform-moderation-admin.controller.ts`, add the import and endpoint:

```ts
import { ExtendBanDto } from '../dto/extend-ban.dto';
```

Add after the existing `lift()` method:

```ts
  @Post('bans/:id/extend')
  extendBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ExtendBanDto,
  ) {
    return this.bans.extendBan(user.id, id, dto.additionalHours);
  }
```

(The constructor's third parameter, `broadBans: BroadBanService`, and the Broad-ban endpoints that use it, are added in Task 8 — for this task, keep the constructor as-is with the two existing parameters; Step 2's test's third mock argument will be unused until Task 8 wires it in, so temporarily pass only `bans` and `audit` to match the current two-parameter constructor. Revisit this constructor call in Task 8.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- platform-moderation-admin.controller.spec.ts`
Expected: PASS for the `extendBan` test (ignore the `broadBans`-dependent tests, added in Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/modules/platform-moderation/dto/extend-ban.dto.ts src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts
git commit -m "feat: add admin endpoint to extend an individual user's platform ban"
```

---

### Task 5: Login-time ban gate in `AuthService`

**Files:**
- Modify: `src/modules/auth/services/auth.service.ts`
- Modify: `src/modules/auth/services/auth.service.spec.ts`
- Modify: `src/modules/auth/auth.module.ts`

**Interfaces:**
- Consumes: `PlatformBanService` — needs a new read-only method added in this task: `PlatformBanService.getActiveBan(userId: string): Promise<{ reason: string; expiresAt: string } | null>` (does not throw, unlike `assertNotGloballyBanned` — `AuthService` needs the details to build its own typed error).
- Produces: `AuthService` now rejects login for a banned user with `BusinessException(ERROR_CODES.ACCOUNT_BANNED, ...)`.

- [ ] **Step 1: Add the non-throwing lookup to `PlatformBanService`**

In `platform-ban.service.ts`, add after `assertNotGloballyBanned()`:

```ts
  async getActiveBan(userId: string): Promise<{ reason: string; expiresAt: string } | null> {
    const raw = await this.redis.get(banRedisKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as { reason: string; expiresAt: string };
  }
```

Add a test for it in `platform-ban.service.spec.ts`, in a new `describe('getActiveBan', ...)` block:

```ts
  describe('getActiveBan', () => {
    it('returns null when there is no active ban', async () => {
      redis.get.mockResolvedValue(null);
      expect(await service.getActiveBan('target-1')).toBeNull();
    });

    it('returns the reason and expiry when a ban is active', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ reason: 'harassment', expiresAt: '2026-08-19T00:00:00.000Z' }));
      expect(await service.getActiveBan('target-1')).toEqual({
        reason: 'harassment',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    });
  });
```

Run: `npm test -- platform-ban.service.spec.ts -t "getActiveBan"` — verify it fails first (method doesn't exist), then implement, then verify it passes.

- [ ] **Step 2: Write the failing `AuthService` test**

In `auth.service.spec.ts`, add a new mock in the `beforeEach`:

```ts
    const platformBans = { getActiveBan: jest.fn().mockResolvedValue(null) };
```

Update the `service = new AuthService(...)` call to append `platformBans as never` as a 12th argument (after `roleSource`):

```ts
    service = new AuthService(
      users,
      bus,
      social,
      otp,
      sessions as unknown as ISessionService,
      repo,
      passwords as unknown as PasswordService,
      security as unknown as LoginSecurityService,
      firebase as unknown as FirebaseService,
      config,
      roleSource,
      undefined,
      undefined,
      undefined,
      undefined,
      platformBans as never,
    );
```

(The four `undefined`s occupy `admin2fa`, `deviceBinding`, `staffIpAllowlist`, `notifications` — all `@Optional()` and unused by these tests today; `platformBans` becomes the sixteenth constructor parameter, added at the very end in Step 4.)

Add a new test inside `describe('loginWithPassword'` — read the file first to find that describe block and an existing passing test to copy the arrange/act shape from, then add:

```ts
    it('rejects login for a user with an active platform ban', async () => {
      users.findByEmail.mockResolvedValue(makeIdentity());
      repo.getCredential = jest.fn().mockResolvedValue({ passwordHash: 'HASH' });
      passwords.verify.mockResolvedValue(true);
      roleSource.getRoleNames.mockResolvedValue(['USER']);
      platformBans.getActiveBan.mockResolvedValue({
        reason: 'harassment',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });

      await expect(
        service.loginWithPassword({ email: 'aditya@example.com', password: 'Str0ng@Pass' }, {}),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_BANNED' });
    });
```

(Match the exact mocking calls already used by a neighboring passing `loginWithPassword` test in this file for `repo.getCredential`/`passwords.verify` — read that test first and mirror its setup precisely, since the mock shapes above are illustrative of the assertion, not a guaranteed match to this file's existing helper conventions.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- auth.service.spec.ts -t "active platform ban"`
Expected: FAIL — login succeeds instead of throwing (or the file fails to compile because the 16th constructor arg doesn't exist yet).

- [ ] **Step 4: Implement**

In `auth.service.ts`:

Add the import:

```ts
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
```

Add the new optional constructor parameter, at the very end of the parameter list:

```ts
    @Optional() private readonly platformBans?: PlatformBanService,
```

Add a new private method, next to `assertActive`:

```ts
  private async assertNotBanned(user: UserIdentity): Promise<void> {
    if (!this.platformBans) return;
    const ban = await this.platformBans.getActiveBan(user.id);
    if (ban) {
      throw new BusinessException(
        ERROR_CODES.ACCOUNT_BANNED,
        `Your account is banned until ${ban.expiresAt} for: ${ban.reason}`,
        HttpStatus.FORBIDDEN,
      );
    }
  }
```

Call `await this.assertNotBanned(user);` immediately after each of the six existing `this.assertActive(user);` call sites in `auth.service.ts` (lines 201, 250, 402, 429, 437, 493 as of this plan's writing — re-locate them by searching for `this.assertActive(user)` since line numbers shift as earlier tasks in this plan are applied).

- [ ] **Step 5: Wire the module dependency**

In `auth.module.ts`, add the import and register it:

```ts
import { PlatformModerationModule } from 'src/modules/platform-moderation/platform-moderation.module';
```

Add `PlatformModerationModule` to the `imports: [AdminIdentityModule, DeviceModule]` array, making it `imports: [AdminIdentityModule, DeviceModule, PlatformModerationModule]`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- auth.service.spec.ts platform-ban.service.spec.ts`
Expected: PASS (including every pre-existing test in `auth.service.spec.ts` — the new constructor parameter is `@Optional()` so no other call site breaks)

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/services/auth.service.ts src/modules/auth/services/auth.service.spec.ts src/modules/auth/auth.module.ts src/modules/platform-moderation/services/platform-ban.service.ts src/modules/platform-moderation/services/platform-ban.service.spec.ts
git commit -m "feat: block login for platform-banned users with a typed ACCOUNT_BANNED error"
```

---

### Task 6: `BroadBan` Prisma model + migration

**Files:**
- Modify: `prisma/schema/platform_moderation.prisma`

**Interfaces:**
- Produces: `BroadBanStatus` enum (`ACTIVE`, `LIFTED`, `EXPIRED`), `BroadBan` model — consumed by Task 7's repository.

- [ ] **Step 1: Add the enum and model**

Append to `prisma/schema/platform_moderation.prisma`:

```prisma
enum BroadBanStatus {
  ACTIVE
  LIFTED
  EXPIRED
}

/// A ban targeting one specific room ("Broad") and its owner — fully
/// independent of PlatformUserBan (which bans a user account-wide). Ends
/// that one room now and blocks only the owner's future room CREATION for
/// 24h; the owner can still log in and join other rooms normally. Never
/// references PlatformUserBan and is never written to by PlatformBanService.
model BroadBan {
  id          String         @id @default(uuid()) @db.Uuid
  roomId      String         @db.Uuid
  roomType    PlatformRoomType
  ownerId     String         @db.Uuid
  moderatorId String         @db.Uuid
  reason      String
  description String?
  proofUrl    String?
  status      BroadBanStatus @default(ACTIVE)
  bannedAt    DateTime       @default(now())
  expiresAt   DateTime
  liftedAt    DateTime?
  liftedBy    String?        @db.Uuid

  @@index([ownerId, status])
  @@index([status, expiresAt])
  @@map("broad_bans")
}
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_broad_ban`
Expected: Creates `prisma/migrations/<timestamp>_add_broad_ban/migration.sql` containing `CREATE TYPE "BroadBanStatus"` and `CREATE TABLE "broad_bans"`, and regenerates the Prisma client (`BroadBan`, `BroadBanStatus` now importable from `@prisma/client`).

- [ ] **Step 3: Commit**

```bash
git add prisma/schema/platform_moderation.prisma prisma/migrations
git commit -m "feat: add BroadBan model, independent of PlatformUserBan"
```

---

### Task 7: `BroadBanRepository`

**Files:**
- Create: `src/modules/platform-moderation/repositories/broad-ban.repository.ts`
- Create: `src/modules/platform-moderation/repositories/broad-ban.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`prisma.broadBan.*`, generated by Task 6's migration).
- Produces: `BroadBanRepository` with `create`, `findById`, `lift`, `extend`, `list` — mirrors `PlatformBanRepository`'s shape exactly (Task 8's service depends on these exact names).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/platform-moderation/repositories/broad-ban.repository.spec.ts
import { BroadBanRepository } from './broad-ban.repository';

describe('BroadBanRepository', () => {
  let prisma: { broadBan: Record<string, jest.Mock> };
  let repo: BroadBanRepository;

  beforeEach(() => {
    prisma = {
      broadBan: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    repo = new BroadBanRepository(prisma as never);
  });

  it('creates a broad ban row', async () => {
    prisma.broadBan.create.mockResolvedValue({ id: 'bb-1' });
    const input = {
      roomId: 'room-1',
      roomType: 'AUDIO_ROOM' as const,
      ownerId: 'owner-1',
      moderatorId: 'mod-1',
      reason: 'abuse',
      description: 'repeated abusive language',
      proofUrl: 'https://example.com/proof.png',
      expiresAt: new Date('2026-08-19T00:00:00.000Z'),
    };
    const result = await repo.create(input);
    expect(prisma.broadBan.create).toHaveBeenCalledWith({ data: input });
    expect(result.id).toBe('bb-1');
  });

  it('finds a broad ban by id', async () => {
    prisma.broadBan.findUnique.mockResolvedValue({ id: 'bb-1' });
    const result = await repo.findById('bb-1');
    expect(prisma.broadBan.findUnique).toHaveBeenCalledWith({ where: { id: 'bb-1' } });
    expect(result?.id).toBe('bb-1');
  });

  it('lifts a broad ban', async () => {
    prisma.broadBan.update.mockResolvedValue({ id: 'bb-1', status: 'LIFTED' });
    const result = await repo.lift('bb-1', 'admin-1');
    expect(prisma.broadBan.update).toHaveBeenCalledWith({
      where: { id: 'bb-1' },
      data: expect.objectContaining({ status: 'LIFTED', liftedBy: 'admin-1' }),
    });
    expect(result.status).toBe('LIFTED');
  });

  it('extends a broad ban to a new expiry', async () => {
    prisma.broadBan.update.mockResolvedValue({ id: 'bb-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') });
    const result = await repo.extend('bb-1', new Date('2026-08-20T00:00:00.000Z'));
    expect(prisma.broadBan.update).toHaveBeenCalledWith({
      where: { id: 'bb-1' },
      data: { expiresAt: new Date('2026-08-20T00:00:00.000Z') },
    });
    expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
  });

  it('lists broad bans with pagination', async () => {
    prisma.broadBan.findMany.mockResolvedValue([{ id: 'bb-1' }]);
    prisma.broadBan.count.mockResolvedValue(1);
    const [rows, total] = await repo.list({ status: 'ACTIVE' as const }, 0, 20);
    expect(prisma.broadBan.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      skip: 0,
      take: 20,
      orderBy: { bannedAt: 'desc' },
    });
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- broad-ban.repository.spec.ts`
Expected: FAIL — module `./broad-ban.repository` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/modules/platform-moderation/repositories/broad-ban.repository.ts
import { Injectable } from '@nestjs/common';
import { BroadBan, BroadBanStatus, PlatformRoomType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateBroadBanInput {
  roomId: string;
  roomType: PlatformRoomType;
  ownerId: string;
  moderatorId: string;
  reason: string;
  description?: string | null;
  proofUrl?: string | null;
  expiresAt: Date;
}

export interface ListBroadBansFilter {
  status?: BroadBanStatus;
  ownerId?: string;
}

@Injectable()
export class BroadBanRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateBroadBanInput): Promise<BroadBan> {
    return this.prisma.broadBan.create({ data: input });
  }

  findById(id: string): Promise<BroadBan | null> {
    return this.prisma.broadBan.findUnique({ where: { id } });
  }

  lift(id: string, liftedBy: string): Promise<BroadBan> {
    return this.prisma.broadBan.update({
      where: { id },
      data: { status: BroadBanStatus.LIFTED, liftedBy, liftedAt: new Date() },
    });
  }

  extend(id: string, expiresAt: Date): Promise<BroadBan> {
    return this.prisma.broadBan.update({
      where: { id },
      data: { expiresAt },
    });
  }

  async list(
    filter: ListBroadBansFilter,
    skip: number,
    limit: number,
  ): Promise<[BroadBan[], number]> {
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
    };
    return Promise.all([
      this.prisma.broadBan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { bannedAt: 'desc' },
      }),
      this.prisma.broadBan.count({ where }),
    ]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- broad-ban.repository.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/platform-moderation/repositories/broad-ban.repository.ts src/modules/platform-moderation/repositories/broad-ban.repository.spec.ts
git commit -m "feat: add BroadBanRepository"
```

---

### Task 8: `BroadBanService` — ban, guard, lift, extend

**Files:**
- Create: `src/modules/platform-moderation/services/broad-ban.service.ts`
- Create: `src/modules/platform-moderation/services/broad-ban.service.spec.ts`

**Interfaces:**
- Consumes: `BroadBanRepository` (Task 7), `PlatformModerationAuditService.record` (existing, reused as-is), `SocketManager.emitToNamespaceRoom`/`emitToUserEverywhere` (existing), `IEventBus.publish`, `RoomEndedEvent`/`RoomClosedEvent` (existing), `MODERATION_SENDER_NAME` (Task 1), `PrismaService`.
- Produces:
  - `banBroad(input: { moderatorId: string; roomId: string; roomType: PlatformRoomType; reason: string; description?: string; proofUrl?: string }): Promise<BroadBan>`
  - `assertNotBroadBanned(ownerId: string): Promise<void>` — throws `ForbiddenException` if active. Consumed by Tasks 9–11 (the three create-site guards).
  - `liftBroadBan(adminId: string, banId: string): Promise<BroadBan>`
  - `extendBroadBan(adminId: string, banId: string, additionalHours: number): Promise<BroadBan>`
  - `list(filter, skip, limit)`

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/platform-moderation/services/broad-ban.service.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { BroadBanService } from './broad-ban.service';

describe('BroadBanService', () => {
  let repo: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let sockets: Record<string, jest.Mock>;
  let prisma: {
    audioRoom: Record<string, jest.Mock>;
    videoRoom: Record<string, jest.Mock>;
    liveStream: Record<string, jest.Mock>;
  };
  let bus: Record<string, jest.Mock>;
  let service: BroadBanService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({
        id: 'bb-1',
        roomId: 'room-1',
        ownerId: 'owner-1',
        reason: 'abuse',
        expiresAt: new Date('2026-08-19T00:00:00.000Z'),
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'bb-1',
        status: 'ACTIVE',
        ownerId: 'owner-1',
        reason: 'abuse',
        roomId: 'room-1',
        roomType: 'AUDIO_ROOM',
        expiresAt: new Date('2026-08-19T00:00:00.000Z'),
      }),
      lift: jest.fn().mockResolvedValue({ id: 'bb-1', status: 'LIFTED' }),
      extend: jest.fn().mockResolvedValue({ id: 'bb-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') }),
      list: jest.fn().mockResolvedValue([[], 0]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    prisma = {
      audioRoom: {
        findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1', createdAt: new Date('2026-08-18T22:00:00.000Z') }),
        update: jest.fn().mockResolvedValue({}),
      },
      videoRoom: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      liveStream: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new BroadBanService(
      repo as never,
      audit as never,
      redis as never,
      sockets as never,
      prisma as never,
      bus as never,
    );
  });

  describe('banBroad', () => {
    it('rejects an empty reason', async () => {
      await expect(
        service.banBroad({ moderatorId: 'mod-1', roomId: 'room-1', roomType: 'AUDIO_ROOM', reason: '   ' }),
      ).rejects.toThrow('reason');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a room that no longer exists', async () => {
      prisma.audioRoom.findUnique.mockResolvedValue(null);
      await expect(
        service.banBroad({ moderatorId: 'mod-1', roomId: 'room-1', roomType: 'AUDIO_ROOM', reason: 'abuse' }),
      ).rejects.toThrow('not found');
    });

    it('creates the ban row keyed to the room owner, sets a creation-only Redis flag, ends the room, and notifies everyone in it', async () => {
      await service.banBroad({
        moderatorId: 'mod-1',
        roomId: 'room-1',
        roomType: 'AUDIO_ROOM',
        reason: 'abuse',
        description: 'repeated abusive language',
        proofUrl: 'https://example.com/proof.png',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'room-1',
          roomType: 'AUDIO_ROOM',
          ownerId: 'owner-1',
          moderatorId: 'mod-1',
          reason: 'abuse',
          description: 'repeated abusive language',
          proofUrl: 'https://example.com/proof.png',
        }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        'broad-ban:creation:owner-1',
        expect.any(String),
        'EX',
        86400,
      );
      expect(prisma.audioRoom.update).toHaveBeenCalledWith({
        where: { id: 'room-1' },
        data: expect.objectContaining({ status: 'OFFLINE' }),
      });
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        '/audio-room',
        'room-1',
        'broad-ban.room-banned',
        expect.objectContaining({ sender: 'Soulzaa Official', reason: 'abuse' }),
      );
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'audio_room.ended' }));
    });
  });

  describe('assertNotBroadBanned', () => {
    it('does nothing when there is no active creation ban', async () => {
      redis.get.mockResolvedValue(null);
      await expect(service.assertNotBroadBanned('owner-1')).resolves.toBeUndefined();
    });

    it('throws when the owner has an active creation ban', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ reason: 'abuse', expiresAt: '2026-08-19T00:00:00.000Z', roomId: 'room-1' }));
      await expect(service.assertNotBroadBanned('owner-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('liftBroadBan', () => {
    it('clears the Redis flag and lifts the ban', async () => {
      const result = await service.liftBroadBan('admin-1', 'bb-1');
      expect(redis.del).toHaveBeenCalledWith('broad-ban:creation:owner-1');
      expect(repo.lift).toHaveBeenCalledWith('bb-1', 'admin-1');
      expect(result.status).toBe('LIFTED');
    });
  });

  describe('extendBroadBan', () => {
    it('pushes expiresAt forward, re-primes Redis, and notifies the owner directly', async () => {
      const result = await service.extendBroadBan('admin-1', 'bb-1', 24);
      expect(repo.extend).toHaveBeenCalledWith('bb-1', new Date('2026-08-20T00:00:00.000Z'));
      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        'owner-1',
        'broad-ban.room-banned',
        expect.objectContaining({ sender: 'Soulzaa Official', reason: 'abuse' }),
      );
      expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- broad-ban.service.spec.ts`
Expected: FAIL — module `./broad-ban.service` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/modules/platform-moderation/services/broad-ban.service.ts
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { BroadBan, PlatformRoomType, RoomStatus, VideoRoomStatus, LiveStreamStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { MODERATION_SENDER_NAME } from 'src/common/constants/moderation-sender.constant';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { RoomEndedEvent } from 'src/modules/audio-rooms/events/audio-room.events';
import { RoomClosedEvent } from 'src/modules/video-rooms/events/video-room.events';
import { BroadBanRepository, type ListBroadBansFilter } from '../repositories/broad-ban.repository';
import { PlatformModerationAuditService } from './platform-moderation-audit.service';

export interface BanBroadInput {
  moderatorId: string;
  roomId: string;
  roomType: PlatformRoomType;
  reason: string;
  description?: string;
  proofUrl?: string;
}

const BROAD_BAN_DURATION_SECONDS = 86400;

export function broadBanCreationRedisKey(ownerId: string): string {
  return `broad-ban:creation:${ownerId}`;
}

/**
 * Bans one specific room ("Broad") and blocks its owner from creating a NEW
 * room while the ban is active. Fully independent of PlatformBanService /
 * PlatformUserBan — never reads or writes that table, and an active Broad
 * ban never blocks login or joining other rooms (only room creation, at the
 * three create call sites this service's assertNotBroadBanned is wired into).
 */
@Injectable()
export class BroadBanService {
  private readonly logger = new Logger(BroadBanService.name);

  constructor(
    private readonly repo: BroadBanRepository,
    private readonly audit: PlatformModerationAuditService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly sockets: SocketManager,
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async banBroad(input: BanBroadInput): Promise<BroadBan> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('A ban reason is required.');
    }

    const owner = await this.resolveRoomOwner(input.roomType, input.roomId);
    if (!owner) {
      throw new BadRequestException('Room not found.');
    }

    const expiresAt = new Date(Date.now() + BROAD_BAN_DURATION_SECONDS * 1000);
    const ban = await this.repo.create({
      roomId: input.roomId,
      roomType: input.roomType,
      ownerId: owner.ownerId,
      moderatorId: input.moderatorId,
      reason,
      description: input.description ?? null,
      proofUrl: input.proofUrl ?? null,
      expiresAt,
    });

    await this.redis.set(
      broadBanCreationRedisKey(owner.ownerId),
      JSON.stringify({ reason, expiresAt: expiresAt.toISOString(), roomId: input.roomId }),
      'EX',
      BROAD_BAN_DURATION_SECONDS,
    );

    await this.endRoomAndNotify(input.roomType, input.roomId, owner.ownerId, owner.createdAt, reason, expiresAt);

    void this.audit.record({
      moderatorId: input.moderatorId,
      action: 'BAN_ISSUED',
      roomType: input.roomType,
      roomId: input.roomId,
      targetUserId: owner.ownerId,
      reason,
    });

    return ban;
  }

  async assertNotBroadBanned(ownerId: string): Promise<void> {
    const raw = await this.redis.get(broadBanCreationRedisKey(ownerId));
    if (!raw) return;
    const { reason, expiresAt } = JSON.parse(raw) as { reason: string; expiresAt: string };
    throw new ForbiddenException(
      `You cannot create a new Broad until ${expiresAt} for: ${reason}`,
    );
  }

  async liftBroadBan(adminId: string, banId: string): Promise<BroadBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Broad ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      return ban;
    }

    await this.redis.del(broadBanCreationRedisKey(ban.ownerId));
    const lifted = await this.repo.lift(banId, adminId);

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_LIFTED',
      roomType: ban.roomType,
      roomId: ban.roomId,
      targetUserId: ban.ownerId,
    });

    return lifted;
  }

  async extendBroadBan(adminId: string, banId: string, additionalHours: number): Promise<BroadBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Broad ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      throw new BadRequestException('This Broad ban is not active.');
    }

    const newExpiresAt = new Date(ban.expiresAt.getTime() + additionalHours * 3600 * 1000);
    const extended = await this.repo.extend(banId, newExpiresAt);

    const ttlSeconds = Math.max(1, Math.floor((newExpiresAt.getTime() - Date.now()) / 1000));
    await this.redis.set(
      broadBanCreationRedisKey(ban.ownerId),
      JSON.stringify({ reason: ban.reason, expiresAt: newExpiresAt.toISOString(), roomId: ban.roomId }),
      'EX',
      ttlSeconds,
    );

    this.sockets.emitToUserEverywhere(ban.ownerId, 'broad-ban.room-banned', {
      sender: MODERATION_SENDER_NAME,
      reason: ban.reason,
      expiresAt: newExpiresAt.toISOString(),
    });

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_ISSUED',
      roomType: ban.roomType,
      roomId: ban.roomId,
      targetUserId: ban.ownerId,
      reason: `Extended by ${additionalHours}h`,
    });

    return extended;
  }

  list(filter: ListBroadBansFilter, skip: number, limit: number) {
    return this.repo.list(filter, skip, limit);
  }

  private async resolveRoomOwner(
    roomType: PlatformRoomType,
    roomId: string,
  ): Promise<{ ownerId: string; createdAt: Date } | null> {
    if (roomType === 'AUDIO_ROOM') {
      const room = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true, createdAt: true },
      });
      return room;
    }
    if (roomType === 'VIDEO_ROOM') {
      const room = await this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true, createdAt: true },
      });
      return room;
    }
    const stream = await this.prisma.liveStream.findUnique({
      where: { id: roomId },
      select: { streamerId: true, createdAt: true },
    });
    return stream ? { ownerId: stream.streamerId, createdAt: stream.createdAt } : null;
  }

  /**
   * Ends the one targeted room now and notifies everyone still connected to
   * it (including the owner — a room-wide broadcast reaches them too, unlike
   * a per-member eject which deliberately skips the owner; see
   * PlatformBanService.endActiveRoomsFor's identical note). Every failure
   * path is caught internally so it can never fail the ban itself. Live
   * Stream gets a status-only flip with no real-time broadcast, at parity
   * with PlatformBanService's existing handling for Live Stream (that gap
   * pre-dates this change and is not introduced by it).
   */
  private async endRoomAndNotify(
    roomType: PlatformRoomType,
    roomId: string,
    ownerId: string,
    createdAt: Date,
    reason: string,
    expiresAt: Date,
  ): Promise<void> {
    const payload = {
      roomId,
      sender: MODERATION_SENDER_NAME,
      reason,
      expiresAt: expiresAt.toISOString(),
    };
    const durationSeconds = Math.floor((Date.now() - createdAt.getTime()) / 1000);

    try {
      if (roomType === 'AUDIO_ROOM') {
        await this.prisma.audioRoom.update({
          where: { id: roomId },
          data: { status: RoomStatus.OFFLINE, endedAt: new Date() },
        });
        this.sockets.emitToNamespaceRoom('/audio-room', roomId, 'broad-ban.room-banned', payload);
        await this.bus.publish(new RoomEndedEvent({ roomId, actorId: ownerId, ownerId, durationSeconds }));
      } else if (roomType === 'VIDEO_ROOM') {
        await this.prisma.videoRoom.update({
          where: { id: roomId },
          data: { status: VideoRoomStatus.OFFLINE, endedAt: new Date() },
        });
        this.sockets.emitToNamespaceRoom('/video-room', roomId, 'broad-ban.room-banned', payload);
        await this.bus.publish(new RoomClosedEvent({ roomId, actorId: ownerId, ownerId, durationSeconds }));
      } else {
        await this.prisma.liveStream.update({
          where: { id: roomId },
          data: { status: LiveStreamStatus.ENDED, endedAt: new Date() },
        });
      }
    } catch (e) {
      this.logger.error(`Failed to end broad-banned room ${roomId}: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- broad-ban.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/platform-moderation/services/broad-ban.service.ts src/modules/platform-moderation/services/broad-ban.service.spec.ts
git commit -m "feat: add BroadBanService, fully independent of PlatformBanService"
```

---

### Task 9: Wire `assertNotBroadBanned` into `audio-rooms.service.ts` create()

**Files:**
- Modify: `src/modules/audio-rooms/services/audio-rooms.service.ts`
- Test: `src/modules/audio-rooms/services/audio-rooms.service.spec.ts` (locate the existing platform-ban test in this file first — search for `assertNotGloballyBanned` — and mirror its exact mocking style for the new assertion)

**Interfaces:**
- Consumes: `BroadBanService.assertNotBroadBanned` (Task 8) — inject as a new `@Optional()` constructor dependency, mirroring how `platformBans` (`PlatformBanService`) is already injected into this service.

- [ ] **Step 1: Write the failing test**

In `audio-rooms.service.spec.ts`, find the existing test(s) covering the `platformBans.assertNotGloballyBanned` call inside `create()` and add a sibling test:

```ts
    it('rejects room creation when the actor has an active Broad-ban creation restriction', async () => {
      broadBans.assertNotBroadBanned.mockRejectedValue(new ForbiddenException('creation restricted'));
      await expect(service.create(actor, dto)).rejects.toThrow('creation restricted');
    });
```

(Adapt `actor`/`dto` to whatever variable names the surrounding `describe('create'` block already uses — read it first. Add `broadBans = { assertNotBroadBanned: jest.fn().mockResolvedValue(undefined) };` to the file's `beforeEach`, and pass `broadBans as never` into `new AudioRoomsService(...)` at the same position you'll add the parameter in Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- audio-rooms.service.spec.ts -t "Broad-ban creation restriction"`
Expected: FAIL — either a compile error (extra constructor arg unused) or the rejection never happens.

- [ ] **Step 3: Implement**

In `audio-rooms.service.ts`, add the import:

```ts
import { BroadBanService } from 'src/modules/platform-moderation/services/broad-ban.service';
```

Add a new `@Optional()` constructor parameter next to the existing `platformBans` one (match its exact style — locate `private readonly platformBans` in the constructor and add immediately after it):

```ts
    @Optional() private readonly broadBans?: BroadBanService,
```

In `create()`, immediately after the existing block:

```ts
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }
```

add:

```ts
    if (this.broadBans) {
      await this.broadBans.assertNotBroadBanned(actor.id);
    }
```

(Deliberately not gated on `isModeratorActor` — re-check against the spec: Broad Ban only needs to block the room's owner from creating a new one; a moderator acting on their own behalf to create a room is a separate concern already handled identically to how the existing `platformBans` check treats moderators, so mirror that exact `!isModeratorActor` guard here too for consistency — use `if (!isModeratorActor && this.broadBans) { ... }`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- audio-rooms.service.spec.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add src/modules/audio-rooms/services/audio-rooms.service.ts src/modules/audio-rooms/services/audio-rooms.service.spec.ts
git commit -m "feat: block audio room creation for an active Broad-ban owner"
```

---

### Task 10: Wire `assertNotBroadBanned` into `video-room-lifecycle.service.ts` create()

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-lifecycle.service.ts`
- Test: `src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts` (locate this file first — if it doesn't exist, check `video-room-member.service.spec.ts` for the module's manual-mock conventions and mirror them)

**Interfaces:**
- Consumes: `BroadBanService.assertNotBroadBanned` (Task 8).

- [ ] **Step 1: Write the failing test**

Mirror Task 9 Step 1 exactly, targeting `VideoRoomLifecycleService.create()` instead — find its existing `platformBans.assertNotGloballyBanned` test and add the sibling `broadBans.assertNotBroadBanned` rejection test next to it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- video-room-lifecycle.service.spec.ts -t "Broad-ban"`
Expected: FAIL

- [ ] **Step 3: Implement**

Same pattern as Task 9 Step 3: add the `BroadBanService` import, add `@Optional() private readonly broadBans?: BroadBanService,` next to the existing `platformBans` parameter, and in `create()` add, right after the existing `platformBans.assertNotGloballyBanned` block:

```ts
    if (!isModeratorActor && this.broadBans) {
      await this.broadBans.assertNotBroadBanned(actor.id);
    }
```

Do **not** add this to `activate()` (the "start/go live" method) — Broad Ban only restricts creation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- video-room-lifecycle.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-lifecycle.service.ts src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts
git commit -m "feat: block video room creation for an active Broad-ban owner"
```

---

### Task 11: Wire `assertNotBroadBanned` into `live-stream.service.ts` createStream()

**Files:**
- Modify: `src/modules/live-streaming/services/live-stream.service.ts`
- Test: `src/modules/live-streaming/services/live-stream.service.spec.ts`

**Interfaces:**
- Consumes: `BroadBanService.assertNotBroadBanned` (Task 8).

- [ ] **Step 1: Write the failing test**

Mirror Task 9 Step 1, targeting `LiveStreamService.createStream()` — find its existing `platformBans.assertNotGloballyBanned` test in `live-stream.service.spec.ts` and add the sibling test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- live-stream.service.spec.ts -t "Broad-ban"`
Expected: FAIL

- [ ] **Step 3: Implement**

Same pattern: add the `BroadBanService` import, add `@Optional() private readonly broadBans?: BroadBanService,` next to `platformBans`, and in `createStream()`, right after the existing block:

```ts
    if (!isModeratorActor && this.broadBans) {
      await this.broadBans.assertNotBroadBanned(input.hostId);
    }
```

Do **not** add this check to `joinStream()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- live-stream.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/live-streaming/services/live-stream.service.ts src/modules/live-streaming/services/live-stream.service.spec.ts
git commit -m "feat: block live stream creation for an active Broad-ban owner"
```

---

### Task 12: `BanBroadDto` + storage category for proof uploads

**Files:**
- Create: `src/modules/platform-moderation/dto/ban-broad.dto.ts`
- Modify: `src/infra/storage/storage.constants.ts`

**Interfaces:**
- Produces: `BanBroadDto { reason: string; description?: string; proofUrl?: string }`, `STORAGE_CATEGORIES.BROAD_BAN_EVIDENCE`. Consumed by Tasks 13–15 (the three Broad Ban controller endpoints) and by Plan B (mobile) for the presign/confirm upload call.

- [ ] **Step 1: Create the DTO**

```ts
// src/modules/platform-moderation/dto/ban-broad.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

/** Mirrors BanUserGloballyDto's free-text reason convention — the "selectable
 * reason" requirement is a frontend dropdown over this field, not a new
 * backend enum (the three room types each have their own report-reason
 * enum, so no single enum could type this field across all three anyway). */
export class BanBroadDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'URL returned by POST /storage/confirm for the BROAD_BAN_EVIDENCE category.' })
  @IsOptional()
  @IsUrl()
  proofUrl?: string;
}
```

- [ ] **Step 2: Add the storage category**

In `storage.constants.ts`, add to `STORAGE_CATEGORIES` (after `KYC_DOCUMENT`):

```ts
  // Proof attached to a moderator's Broad Ban action. Never processed by the
  // media worker, for the same reason KYC scans aren't: re-encoding would
  // alter evidence a reviewer is meant to judge as-is.
  BROAD_BAN_EVIDENCE: 'broad-ban-evidence',
```

Add the matching policy to `STORAGE_POLICIES` (after the `KYC_DOCUMENT` entry):

```ts
  [STORAGE_CATEGORIES.BROAD_BAN_EVIDENCE]: {
    prefix: STORAGE_CATEGORIES.BROAD_BAN_EVIDENCE,
    isImage: false,
    allowedMime: ['image/jpeg', 'image/png', 'application/pdf'],
    maxSizeBytes: 10 * MB,
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/platform-moderation/dto/ban-broad.dto.ts src/infra/storage/storage.constants.ts
git commit -m "feat: add BanBroadDto and BROAD_BAN_EVIDENCE storage category"
```

(No test file for this task: the DTO is exercised end-to-end by Tasks 13–15's controller tests, and `STORAGE_CATEGORIES`/`STORAGE_POLICIES` are plain data consumed by the already-existing, already-tested `UploadService` — read `src/infra/storage/upload.service.spec.ts` if one exists and confirm it iterates `STORAGE_POLICIES` generically; if so, the new entry is covered automatically and no new test is needed.)

---

### Task 13: Broad Ban endpoint on the audio-room moderation controller

**Files:**
- Modify: `src/modules/audio-rooms/controllers/moderation.controller.ts`
- Test: `src/modules/audio-rooms/controllers/moderation.controller.spec.ts` (locate this file first — if absent, check for an integration spec covering this controller and mirror its style)

**Interfaces:**
- Consumes: `BroadBanService.banBroad` (Task 8), `BanBroadDto` (Task 12).
- Produces: `POST rooms/:id/moderation/broad-ban`.

- [ ] **Step 1: Write the failing test**

```ts
  describe('broadBan', () => {
    it('delegates to BroadBanService.banBroad with the room id, moderator id, and DTO fields', async () => {
      permissions.assertCanModerate = jest.fn().mockResolvedValue(undefined);
      broadBans.banBroad = jest.fn().mockResolvedValue({ id: 'bb-1' });
      const result = await controller.broadBan(
        { id: 'mod-1', roles: ['MODERATOR'] } as never,
        'room-1',
        { reason: 'abuse', description: 'repeated abuse', proofUrl: 'https://x/proof.png' },
      );
      expect(permissions.assertCanModerate).toHaveBeenCalledWith('room-1', { id: 'mod-1', roles: ['MODERATOR'] });
      expect(broadBans.banBroad).toHaveBeenCalledWith({
        moderatorId: 'mod-1',
        roomId: 'room-1',
        roomType: 'AUDIO_ROOM',
        reason: 'abuse',
        description: 'repeated abuse',
        proofUrl: 'https://x/proof.png',
      });
      expect(result.id).toBe('bb-1');
    });
  });
```

(Add this inside the existing `describe('ModerationController', ...)` block in whatever spec file already covers this controller — locate it first and match its existing `permissions`/mock setup exactly rather than redeclaring one; if the file constructs `controller` with `new ModerationController(moderation, platformBans, permissions)`, add a fourth `broadBans` mock and constructor argument to match Step 3's change.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- moderation.controller.spec.ts -t "broadBan"`
Expected: FAIL — `controller.broadBan is not a function`.

- [ ] **Step 3: Implement**

Add the imports:

```ts
import { BroadBanService } from 'src/modules/platform-moderation/services/broad-ban.service';
import { BanBroadDto } from 'src/modules/platform-moderation/dto/ban-broad.dto';
```

Add `private readonly broadBans: BroadBanService,` to the constructor, after `platformBans`.

Add the endpoint after `banGlobally()`:

```ts
  @Post(':id/moderation/broad-ban')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban this Broad (room): end it now, evict everyone, block the owner from creating a new one for 24 hours' })
  async broadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: BanBroadDto,
  ) {
    const actor = this.actor(user);
    await this.permissions.assertCanModerate(roomId, actor);
    return this.broadBans.banBroad({
      moderatorId: user.id,
      roomId,
      roomType: 'AUDIO_ROOM',
      reason: dto.reason,
      description: dto.description,
      proofUrl: dto.proofUrl,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- moderation.controller.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/audio-rooms/controllers/moderation.controller.ts src/modules/audio-rooms/controllers/moderation.controller.spec.ts
git commit -m "feat: add Broad Ban endpoint to audio-room moderation controller"
```

---

### Task 14: Broad Ban endpoint on the video-room moderation controller

**Files:**
- Modify: `src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-moderation.controller.spec.ts`

**Interfaces:**
- Consumes: `BroadBanService.banBroad` (Task 8), `BanBroadDto` (Task 12).
- Produces: `POST video-rooms/:id/moderation/broad-ban`.

- [ ] **Step 1: Write the failing test**

Mirror Task 13 Step 1, adjusted for this controller's existing constructor shape (`moderation, reports, query, platformBans` — add `broadBans` as a fifth) and its `moderation.assertCanModerate(actor, roomId)` call style (note the argument order differs from the audio-room controller's `permissions.assertCanModerate(roomId, actor)` — match this file's own existing `banGlobally` test exactly).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- video-rooms-moderation.controller.spec.ts -t "broadBan"`
Expected: FAIL

- [ ] **Step 3: Implement**

Add the imports (`BroadBanService`, `BanBroadDto`, same paths as Task 13), add `private readonly broadBans: BroadBanService,` to the constructor after `platformBans`, and add after `banGlobally()`:

```ts
  @Post(':id/moderation/broad-ban')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban this Broad (room): end it now, evict everyone, block the owner from creating a new one for 24 hours' })
  async broadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: BanBroadDto,
  ) {
    const actor = this.actor(user);
    await this.moderation.assertCanModerate(actor, roomId);
    return this.broadBans.banBroad({
      moderatorId: user.id,
      roomId,
      roomType: 'VIDEO_ROOM',
      reason: dto.reason,
      description: dto.description,
      proofUrl: dto.proofUrl,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- video-rooms-moderation.controller.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts src/modules/video-rooms/controllers/video-rooms-moderation.controller.spec.ts
git commit -m "feat: add Broad Ban endpoint to video-room moderation controller"
```

---

### Task 15: Broad Ban endpoint on the live-stream controller

**Files:**
- Modify: `src/modules/live-streaming/controllers/live-stream.controller.ts`
- Test: `src/modules/live-streaming/controllers/live-stream.controller.spec.ts`

**Interfaces:**
- Consumes: `BroadBanService.banBroad` (Task 8), `BanBroadDto` (Task 12).
- Produces: `POST live-streams/:id/moderation/broad-ban`.

- [ ] **Step 1: Write the failing test**

Mirror Task 13 Step 1, adjusted for this controller's constructor (`service, reports, platformBans` — add `broadBans` as a fourth) and its permission model: this controller relies on `@RequirePermissions('live.stream.moderate')` rather than a manual `assertCanModerate` call inside the handler (see the existing `banGlobally` for the exact pattern to mirror — no explicit permission-service call needed in the method body here).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- live-stream.controller.spec.ts -t "broadBan"`
Expected: FAIL

- [ ] **Step 3: Implement**

Add the imports, add `private readonly broadBans: BroadBanService,` to the constructor after `platformBans`, and add after `banGlobally()`:

```ts
  @Post(':id/moderation/broad-ban')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Ban this Broad (stream): end it now, evict everyone, block the host from creating a new one for 24 hours' })
  async broadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) streamId: string,
    @Body() dto: BanBroadDto,
  ) {
    return this.broadBans.banBroad({
      moderatorId: user.id,
      roomId: streamId,
      roomType: 'LIVE_STREAM',
      reason: dto.reason,
      description: dto.description,
      proofUrl: dto.proofUrl,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- live-stream.controller.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/live-streaming/controllers/live-stream.controller.ts src/modules/live-streaming/controllers/live-stream.controller.spec.ts
git commit -m "feat: add Broad Ban endpoint to live-stream controller"
```

---

### Task 16: Admin endpoints — list / revoke / extend Broad bans

**Files:**
- Create: `src/modules/platform-moderation/dto/list-broad-bans.dto.ts`
- Modify: `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts`
- Modify: `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts` (created in Task 4)

**Interfaces:**
- Consumes: `BroadBanService.list`, `.liftBroadBan`, `.extendBroadBan` (Task 8), `ExtendBanDto` (Task 4).
- Produces: `GET admin/moderation/broad-bans`, `POST admin/moderation/broad-bans/:id/revoke`, `POST admin/moderation/broad-bans/:id/extend` — consumed by Plan C (Admin Portal Banned Broads UI).

- [ ] **Step 1: Create the list DTO**

```ts
// src/modules/platform-moderation/dto/list-broad-bans.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BroadBanStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class ListBroadBansDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BroadBanStatus })
  @IsOptional()
  @IsEnum(BroadBanStatus)
  status?: BroadBanStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}
```

- [ ] **Step 2: Write the failing tests**

Add to `platform-moderation-admin.controller.spec.ts` (created in Task 4 — this task finally wires the third constructor argument that Task 4 left unused):

```ts
  describe('broad bans', () => {
    it('lists broad bans with pagination', async () => {
      const result = await controller.listBroadBans({ page: 1, limit: 20 } as never);
      expect(broadBans.list).toHaveBeenCalledWith({ status: undefined, ownerId: undefined }, 0, 20);
      expect(result).toBeDefined();
    });

    it('revokes a broad ban', async () => {
      broadBans.liftBroadBan.mockResolvedValue({ id: 'bb-1', status: 'LIFTED' });
      const result = await controller.revokeBroadBan({ id: 'admin-1' } as never, 'bb-1');
      expect(broadBans.liftBroadBan).toHaveBeenCalledWith('admin-1', 'bb-1');
      expect(result.status).toBe('LIFTED');
    });

    it('extends a broad ban', async () => {
      broadBans.extendBroadBan.mockResolvedValue({ id: 'bb-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') });
      const result = await controller.extendBroadBan({ id: 'admin-1' } as never, 'bb-1', { additionalHours: 24 });
      expect(broadBans.extendBroadBan).toHaveBeenCalledWith('admin-1', 'bb-1', 24);
      expect(result.id).toBe('bb-1');
    });
  });
```

Update the `beforeEach`'s `controller = new PlatformModerationAdminController(bans as never, audit as never, broadBans as never);` — this line already exists from Task 4 with the third argument prepared but previously unused by the (then two-parameter) controller; Step 3 below makes the controller actually accept it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- platform-moderation-admin.controller.spec.ts`
Expected: FAIL — controller constructor only takes 2 params; `listBroadBans`/`revokeBroadBan`/`extendBroadBan` don't exist.

- [ ] **Step 4: Implement**

In `platform-moderation-admin.controller.ts`, add the imports:

```ts
import { BroadBanService } from '../services/broad-ban.service';
import { ListBroadBansDto } from '../dto/list-broad-bans.dto';
```

Update the constructor to accept the third dependency:

```ts
  constructor(
    private readonly bans: PlatformBanService,
    private readonly audit: PlatformModerationAuditService,
    private readonly broadBans: BroadBanService,
  ) {}
```

Add the three endpoints after `extendBan()` (from Task 4):

```ts
  @Get('broad-bans')
  async listBroadBans(@Query() q: ListBroadBansDto) {
    const skip = q.skip ?? Math.max(0, ((q.page ?? 1) - 1) * (q.limit ?? 20));
    const limit = q.limit ?? 20;
    const [rows, total] = await this.broadBans.list(
      { status: q.status, ownerId: q.ownerId },
      skip,
      limit,
    );
    return buildPaginated(rows, total, q.page ?? 1, limit);
  }

  @Post('broad-bans/:id/revoke')
  revokeBroadBan(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.broadBans.liftBroadBan(user.id, id);
  }

  @Post('broad-bans/:id/extend')
  extendBroadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ExtendBanDto,
  ) {
    return this.broadBans.extendBroadBan(user.id, id, dto.additionalHours);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- platform-moderation-admin.controller.spec.ts`
Expected: PASS (all tests, including Task 4's `extendBan` test)

- [ ] **Step 6: Commit**

```bash
git add src/modules/platform-moderation/dto/list-broad-bans.dto.ts src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts
git commit -m "feat: add admin list/revoke/extend endpoints for Broad bans"
```

---

### Task 17: Register `BroadBanRepository`/`BroadBanService` in the module and wire consumers

**Files:**
- Modify: `src/modules/platform-moderation/platform-moderation.module.ts`
- Modify: `src/modules/audio-rooms/audio-rooms.module.ts` (or wherever `AudioRoomsService` is provided — confirm by grepping for where `PlatformBanService` is currently imported into this module, and add `BroadBanService`/`PlatformModerationModule` the same way)
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/live-streaming/live-streaming.module.ts`

**Interfaces:**
- Produces: `BroadBanService` resolvable everywhere `PlatformBanService` already is.

- [ ] **Step 1: Export `BroadBanService` from `platform-moderation.module.ts`**

Add `BroadBanRepository` to `providers`, add `BroadBanService` to both `providers` and `exports` (alongside the existing `PlatformBanService, PlatformModerationAuditService`):

```ts
  providers: [
    // ...existing entries...
    BroadBanRepository,
    BroadBanService,
  ],
  exports: [PlatformBanService, PlatformModerationAuditService, BroadBanService],
```

Add the two imports at the top of the file.

- [ ] **Step 2: Confirm `PlatformModerationModule` is already imported by the three room modules**

Run: `grep -n "PlatformModerationModule\|PlatformBanService" src/modules/audio-rooms/audio-rooms.module.ts src/modules/video-rooms/video-rooms.module.ts src/modules/live-streaming/live-streaming.module.ts`

Since `ModerationController`, `AudioRoomsService`, `VideoRoomsModerationController`, `VideoRoomLifecycleService`, `LiveStreamController`, and `LiveStreamService` already inject `PlatformBanService` today (confirmed in Tasks 9, 10, 11, 13, 14, 15's existing code), each of these three modules must already import `PlatformModerationModule` (directly or via a re-export) — if the grep confirms this, no module-import change is needed here at all, since `BroadBanService` is now exported from that same module (Step 1) and Nest resolves it through the existing import automatically.

If the grep shows a module importing `PlatformBanService` through some other indirection (e.g., a shared "moderation" barrel module) rather than importing `PlatformModerationModule` directly, add `PlatformModerationModule` to that module's `imports` array instead, following whatever pattern the existing `PlatformBanService` wiring uses.

- [ ] **Step 3: Run the full affected test suite**

Run: `npm test -- platform-moderation broad-ban audio-rooms.service video-room-lifecycle live-stream.service moderation.controller video-rooms-moderation.controller live-stream.controller auth.service`
Expected: PASS across all files touched by Tasks 1–17.

- [ ] **Step 4: Run the module's own boundary check (if configured)**

Run: `npx dependency-cruiser --config .dependency-cruiser.cjs src`
Expected: No new violations (this repo already runs dependency-cruiser in CI per `.dependency-cruiser.cjs` in the repo root — confirm the new `AuthModule → PlatformModerationModule` and `{audio-rooms,video-rooms,live-streaming} → BroadBanService` edges don't trip an existing boundary rule; if they do, fix per that rule's own guidance rather than bypassing it).

- [ ] **Step 5: Commit**

```bash
git add src/modules/platform-moderation/platform-moderation.module.ts
git commit -m "feat: register and export BroadBanService from platform-moderation module"
```

---

## Self-Review Notes

- **Spec coverage:** Item 1 (login gate: Task 5; branded notification: Task 2) — covered. Item 2 (Broad Ban model/service/guard/endpoints: Tasks 6–15) — covered, including the explicit "fully separate from individual ban" constraint (Task 8's doc comment, Global Constraints). Item 6 & 7 shared extend capability (Tasks 3–4 for individual bans, Task 16 for Broad bans) — covered. Items 3 and 4 (warning sender label, Rooms page cleanup) have no backend component per the spec and are covered entirely in Plan B. Item 5 (Admin Portal Banned Broads UI) and the rest of Item 6/7's UI are covered in Plan C, consuming this plan's Task 16 endpoints.
- **Placeholder scan:** no TBD/TODO; every step includes literal code or an exact command.
- **Type consistency:** `BanBroadInput`/`BanBroadDto`/`BroadBanRepository.CreateBroadBanInput` field names (`roomId, roomType, ownerId, moderatorId, reason, description, proofUrl, expiresAt`) match across Tasks 6–15. `assertNotBroadBanned` name matches from Task 8 through Tasks 9–11. `extendBan`/`extendBroadBan` method names match between services (Tasks 3, 8) and controller (Tasks 4, 16).
