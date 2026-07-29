# Video Room Settings Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the video-room settings schema, API contract and client model tell the same truth — without adding product features.

**Architecture:** Four independent changes over the settings contract layer. A shared `requireSettings()` helper on `VideoRoomsRepository` replaces eight duplicated fail-open guards. `isRoomMuted` becomes a real mic-mute state written only by `muteAll`/`unmuteAll`, delivered to clients through the existing `settings_updated` broadcast. The settings DTO and the API response are trimmed to only implemented fields, each pinned by a drift-guard test.

**Tech Stack:** NestJS 11 + Prisma (backend, Jest), Flutter + Riverpod (mobile, `flutter test`).

**Spec:** `docs/superpowers/specs/2026-07-29-video-room-settings-integrity-design.md`

## Global Constraints

- **NO GIT COMMANDS.** Standing project rule: never run `git` (add/commit/reset/stash) without explicit approval. Each task ends with a verification checkpoint, not a commit. Committing is one decision at the very end.
- **ZERO DATABASE MIGRATION.** Retired columns stay in Postgres, inert. Never edit `prisma/schema/video_rooms.prisma` in this plan.
- **NO ZEGO / RTC CHANGES.** In `video-room-media.service.ts` only the two lines inside `assertMediaAllowed` that fetch and null-check the settings row may change. No publishing, subscribing, stream binding, encoder, transport, or media-pipeline code is touched. No other method in that file is modified.
- **NO NEW FEATURES.** Join approval, share/follow enforcement, auto-end, chat-policy UI, moderation surfaces and cover image belong to sub-projects B–D.
- **`isRoomMuted` means mic-mute only**, written *only* by Mute All / Unmute All. It must NOT be added to `WRITABLE_SETTINGS_FIELDS`.
- **`allowViewerChat` stays internal** — still written as a `chatMode` mirror, removed only from the public API and the client model.
- **Retained in the API response:** `isRoomMuted`, `hostSeatCount`, `guestSeatCount`.
- **Removed from the API response (8):** `allowScreenShare`, `allowRecording`, `allowViewerChat`, `joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`, `maxDurationMinutes`.
- **The 11 writable fields** (unchanged): `allowChat`, `slowModeSeconds`, `allowAnnouncements`, `seatApprovalRequired`, `allowPk`, `allowGifts`, `allowTreasure`, `allowInvite`, `allowReporting`, `allowBeauty`, `allowCameraSwitch`.
- **Existing tests are UPDATED, never deleted.**
- Backend tests: `npx jest <path>`. Mobile tests: `flutter test <path>` from `/Users/lt611-18/soulzaa-mobile`.
- Pre-existing unrelated failures: 67 `tsc` errors in the `attendance` module and `countryId` drift from commit `24a9583`. Do not fix; do not let them mask new errors.

---

## File Structure

**Backend** (`/Users/lt611-18/soulzaa-backend`)

| File | Responsibility | Task |
|---|---|---|
| `src/common/exceptions/error-codes.ts` | Add `VIDEO_ROOM_SETTINGS_MISSING` | 1 |
| `src/modules/video-rooms/repositories/video-rooms.repository.ts` | Add `requireSettings()` | 1 |
| `src/modules/video-rooms/repositories/video-rooms.repository.spec.ts` | Cover the helper | 1 |
| 7 service files (chat-policy, gift-context.handler, pk-validation, treasure, seat-invitation, report, announcement) | Adopt `requireSettings()` | 2 |
| `src/modules/video-rooms/services/video-room-media.service.ts` | Adopt `requireSettings()` in `assertMediaAllowed` **only** | 3 |
| `src/modules/video-rooms/services/video-room-moderation.service.ts` | Write `isRoomMuted`; publish `RoomSettingsUpdatedEvent` | 4 |
| `src/modules/video-rooms/dto/update-video-room-settings.dto.ts` | Trim 22 → 11 | 5 |
| `src/modules/video-rooms/dto/update-video-room-settings.dto.spec.ts` | **New** — drift guard | 5 |
| `src/modules/video-rooms/entities/video-room-detail.view.ts` | Trim 8 from `VideoRoomSettingsView` | 6 |
| `src/modules/video-rooms/mappers/video-room-detail.mapper.ts` | Trim 8 from `toSettingsView` | 6 |
| `src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts` | Update existing assertions | 6 |

**Mobile** (`/Users/lt611-18/soulzaa-mobile`)

| File | Responsibility | Task |
|---|---|---|
| `lib/features/video_room/domain/models/video_room_settings.dart` | Trim 8 fields | 7 |
| `test/features/video_room/video_room_settings_test.dart` | Update existing assertions | 7 |
| `lib/features/video_room/presentation/widgets/settings/video_room_settings_hub.dart` | `'Mics muted'`; drop `isRoomMuted` from `kSectionSummaryFields` | 8 |
| `lib/features/video_room/presentation/widgets/settings/sections/mic_camera_page.dart` | Correct the doc comment | 8 |
| `test/features/video_room/settings_hub_test.dart` | Cover the summary | 8 |

---

## Task 1: `requireSettings()` foundation

**Files:**
- Modify: `src/common/exceptions/error-codes.ts:155` (VIDEO_ROOM lifecycle block)
- Modify: `src/modules/video-rooms/repositories/video-rooms.repository.ts:243-257`
- Test: `src/modules/video-rooms/repositories/video-rooms.repository.spec.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `VideoRoomsRepository.requireSettings(roomId: string): Promise<VideoRoomSettings>` — resolves the row or throws `BusinessException(ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING, 'Room settings are missing.', HttpStatus.INTERNAL_SERVER_ERROR)`. Tasks 2 and 3 consume this. `ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING` is a new string constant.

- [ ] **Step 1: Write the failing test**

Add to `video-rooms.repository.spec.ts`, inside the existing top-level `describe`:

```ts
describe('requireSettings', () => {
  it('returns the settings row when it exists', async () => {
    const row = { roomId: 'room-1', allowGifts: true } as never;
    prisma.videoRoomSettings.findUnique.mockResolvedValue(row);

    await expect(repo.requireSettings('room-1')).resolves.toBe(row);
  });

  // A missing row is a data-integrity fault, not a policy decision: the row is
  // created transactionally with the room. Reporting it as "feature disabled"
  // would send a host to toggle a setting that cannot fix it.
  it('throws VIDEO_ROOM_SETTINGS_MISSING when the row is absent', async () => {
    prisma.videoRoomSettings.findUnique.mockResolvedValue(null);

    await expect(repo.requireSettings('room-1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  });
});
```

Add the imports the spec needs if absent: `import { HttpStatus } from '@nestjs/common';` and `import { ERROR_CODES } from 'src/common/exceptions/error-codes';`.

> **Note:** `BusinessException` exposes `errorCode`, **not** `.code`. Asserting `.code` silently passes against `undefined`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/repositories/video-rooms.repository.spec.ts -t "requireSettings"`
Expected: FAIL — `repo.requireSettings is not a function`.

- [ ] **Step 3: Add the error code**

In `src/common/exceptions/error-codes.ts`, in the `// ---- Video Room lifecycle (VR-2) ----` block beside `VIDEO_ROOM_FORBIDDEN`:

```ts
  /** Settings row absent for an existing room — data-integrity fault (500). */
  VIDEO_ROOM_SETTINGS_MISSING: 'VIDEO_ROOM_SETTINGS_MISSING',
```

- [ ] **Step 4: Implement `requireSettings`**

In `video-rooms.repository.ts`, directly after `getSettings` (line 245):

```ts
  /**
   * `getSettings` for callers that cannot proceed without the row.
   *
   * The row is created transactionally with the room, so absence is a
   * data-integrity fault rather than a policy state. Guards that treated a
   * missing row as "allowed" opened every gate at once and silently; this
   * makes that condition loud instead.
   */
  async requireSettings(roomId: string): Promise<VideoRoomSettings> {
    const settings = await this.getSettings(roomId);
    if (!settings) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        'Room settings are missing.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return settings;
  }
```

Add imports at the top of the repository if absent: `HttpStatus` from `@nestjs/common`, `BusinessException` and `ERROR_CODES` following the import style already used by sibling services.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/repositories/video-rooms.repository.spec.ts -t "requireSettings"`
Expected: PASS (2 tests).

- [ ] **Step 6: Checkpoint**

Run: `npx jest src/modules/video-rooms/repositories/video-rooms.repository.spec.ts`
Expected: whole file green, no pre-existing case regressed. **Do not commit.**

---

## Task 2: Adopt `requireSettings()` in the seven non-media guards

**Files (each Modify + its co-located spec):**
- `src/modules/video-rooms/services/video-room-chat-policy.service.ts:72-73` — `allowChat`
- `src/modules/video-rooms/services/video-room-gift-context.handler.ts:98-99` — `allowGifts`
- `src/modules/video-rooms/services/video-room-pk-validation.service.ts:106-107` — `allowPk`
- `src/modules/video-rooms/services/video-room-treasure.service.ts:240-241` — `allowTreasure`
- `src/modules/video-rooms/services/video-room-seat-invitation.service.ts:588-589` — `allowInvite`
- `src/modules/video-rooms/services/video-room-report.service.ts:98-99` — `allowReporting`
- `src/modules/video-rooms/services/video-room-announcement.service.ts:185-186` — `allowAnnouncements`

**Interfaces:**
- Consumes: `VideoRoomsRepository.requireSettings(roomId)` from Task 1.
- Produces: no new signatures. Existing 403 behaviour and error codes are unchanged; only the missing-row path changes.

- [ ] **Step 1: Write the failing tests**

All seven spec files exist. Add one case to each, using that service's own public entry point — the method whose existing "flag disabled → 403" test already exercises this guard:

| Spec file | Entry point to invoke | Guard reached |
|---|---|---|
| `video-room-chat-policy.service.spec.ts` | `service.assertCanSend(actor, 'room-1', input)` | `allowChat` |
| `video-room-gift-context.handler.spec.ts` | `handler.validate(req)` | `allowGifts` |
| `video-room-pk-validation.service.spec.ts` | `service.assertCanCreate(actor, 'room-1', dto)` | `allowPk` |
| `video-room-treasure.service.spec.ts` | `service.create(actor, 'room-1', {})` | `allowTreasure` |
| `video-room-seat-invitation.service.spec.ts` | `service.invite(actor, 'room-1', ...)` | `allowInvite` |
| `video-room-report.service.spec.ts` | `service.report(actor, 'room-1', dto)` | `allowReporting` |
| `video-room-announcement.service.spec.ts` | `service.create(actor, 'room-1', { content: 'hi' })` | `allowAnnouncements` |

Reuse the argument values from the neighbouring disabled-flag test in the same file rather than inventing fixtures — those already satisfy every earlier gate (membership, permission, live-room), so the settings guard is genuinely the failure point.

```ts
// Guard hardening: a missing settings row must NOT read as "allowed".
it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
  rooms.requireSettings.mockRejectedValue(
    new BusinessException(
      ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      'Room settings are missing.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    ),
  );

  // e.g. announcement service — substitute the row from the table above.
  await expect(
    service.create(actor, 'room-1', { content: 'hi' }),
  ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING });
});
```

In every one of the seven specs, the `rooms` mock must gain a `requireSettings` jest fn. Where the existing mock resolves `getSettings`, mirror it:

```ts
const rooms = {
  // ...existing members left untouched...
  getSettings: jest.fn().mockResolvedValue(settingsRow),
  requireSettings: jest.fn().mockResolvedValue(settingsRow),
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-policy.service.spec.ts src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts src/modules/video-rooms/services/video-room-pk-validation.service.spec.ts src/modules/video-rooms/services/video-room-treasure.service.spec.ts src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts src/modules/video-rooms/services/video-room-report.service.spec.ts src/modules/video-rooms/services/video-room-announcement.service.spec.ts`

Expected: the seven new cases FAIL — the services still call `getSettings`, so the rejection is never triggered.

- [ ] **Step 3: Convert the seven guards**

Each is a two-line change. Apply this transformation at every site:

```ts
// BEFORE
const settings = await this.rooms.getSettings(roomId);
if (settings && !settings.allowX) {

// AFTER
const settings = await this.rooms.requireSettings(roomId);
if (!settings.allowX) {
```

Exact per-site details:

| File | Local variable / room id expression | Flag |
|---|---|---|
| `video-room-chat-policy.service.ts` | `roomId` | `allowChat` |
| `video-room-gift-context.handler.ts` | `roomId` | `allowGifts` |
| `video-room-pk-validation.service.ts` | `roomId` | `allowPk` |
| `video-room-treasure.service.ts` | `roomId` | `allowTreasure` |
| `video-room-seat-invitation.service.ts` | `roomId` | `allowInvite` |
| `video-room-report.service.ts` | **`ref.id`** (not `roomId`) | `allowReporting` |
| `video-room-announcement.service.ts` | `roomId` | `allowAnnouncements` |

Leave every `throw new BusinessException(...)` body, error code and HTTP status exactly as-is.

- [ ] **Step 4: Correct the two stale comments**

`video-room-pk-validation.service.ts:103-105` currently reads:

```ts
    // Gate 5: room settings may turn PK off even while the feature is
    // globally enabled. A room with no settings row (should not happen in
    // practice) defaults to allowed, matching the treasure-engine precedent.
```

Replace the second sentence, because the behaviour it documents is now the opposite:

```ts
    // Gate 5: room settings may turn PK off even while the feature is
    // globally enabled. A room with no settings row is a data-integrity fault
    // and raises VIDEO_ROOM_SETTINGS_MISSING rather than defaulting to allowed.
```

Scan the other six sites for any comment asserting missing-row-means-allowed and correct it the same way.

- [ ] **Step 5: Run tests to verify they pass**

Run the same seven-file jest command from Step 2.
Expected: PASS, including every pre-existing disabled-flag 403 case.

- [ ] **Step 6: Checkpoint**

Run: `npx jest src/modules/video-rooms`
Expected: no regressions across the module. **Do not commit.**

---

## Task 3: Adopt `requireSettings()` in `assertMediaAllowed`

Separated from Task 2 deliberately: it is the only change inside the media service, and it carries the hard no-RTC constraint, so it deserves its own review gate.

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-media.service.ts:873-874` (inside `assertMediaAllowed` only)
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomsRepository.requireSettings(roomId)` from Task 1.
- Produces: nothing new. `assertMediaAllowed(roomId, flag, message)` keeps its signature and its `'allowBeauty' | 'allowCameraSwitch'` parameter type.

- [ ] **Step 1: Write the failing test**

In `video-room-media.service.spec.ts`:

```ts
// The two media policy flags are the only settings reads in this service.
// A missing row must not silently permit beauty/camera-switch.
it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
  rooms.requireSettings.mockRejectedValue(
    new BusinessException(
      ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      'Room settings are missing.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    ),
  );

  await expect(service.setBeauty(actor, 'room-1', { smooth: 1 } as never))
    .rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING });
});
```

Add `requireSettings: jest.fn().mockResolvedValue(settingsRow)` to the spec's `rooms` mock, mirroring its existing `getSettings`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts -t "SETTINGS_MISSING"`
Expected: FAIL — `setBeauty` still resolves, because `assertMediaAllowed` calls `getSettings`.

- [ ] **Step 3: Change exactly two lines**

In `assertMediaAllowed` only:

```ts
  private async assertMediaAllowed(
    roomId: string,
    flag: 'allowBeauty' | 'allowCameraSwitch',
    message: string,
  ): Promise<void> {
    const settings = await this.rooms.requireSettings(roomId);   // was getSettings
    if (!settings[flag]) {                                       // was: settings && !settings[flag]
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_FORBIDDEN, message, HttpStatus.FORBIDDEN);
    }
  }
```

**Nothing else in this file changes.** Do not touch `mutateStage`, `commit`, `forceMute`, `getMediaState`, `resolveSeatIndex`, `assertSeated`, or any publish/subscribe/stream-binding code.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts`
Expected: PASS, whole file green.

- [ ] **Step 5: Verify the no-RTC constraint**

Run: `git diff --stat src/modules/video-rooms/services/video-room-media.service.ts`
Expected: exactly one file, **2 insertions / 2 deletions**. Any larger diff means the constraint was violated — revert and redo.

> This is a read-only `git diff` for verification. Do not stage or commit.

- [ ] **Step 6: Checkpoint**

Run: `npx jest src/modules/video-rooms`
Expected: no regressions. **Do not commit.**

---

## Task 4: `isRoomMuted` written by Mute All / Unmute All, with broadcast

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-moderation.service.ts` (`muteAll` ~453-505, `unmuteAll` ~515-560)
- Test: `src/modules/video-rooms/services/video-room-moderation.service.spec.ts`

**Interfaces:**
- Consumes: `RoomSettingsUpdatedEvent` from `../events/video-room.events`, payload `{ roomId: string; actorId: string; changed: string[]; settings: VideoRoomSettingsView }`; `toSettingsView` from `../mappers/video-room-detail.mapper`.
- Produces: no new signatures. `muteAll`/`unmuteAll` keep `(actor, roomId, channels?, requestMeta?) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `video-room-moderation.service.spec.ts`:

```ts
describe('mute-all settings state', () => {
  it('sets isRoomMuted when the mic channel is included', async () => {
    await service.muteAll(actor, 'room-1', ['mic']);

    expect(rooms.updateSettings).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({ isRoomMuted: true }),
    );
  });

  // Chat state is carried by chatMode; isRoomMuted is the mic signal only.
  it('leaves isRoomMuted untouched for a chat-only mute', async () => {
    await service.muteAll(actor, 'room-1', ['chat']);

    const patch = rooms.updateSettings.mock.calls[0][1];
    expect(patch).not.toHaveProperty('isRoomMuted');
    expect(patch).toMatchObject({ chatMode: VideoRoomChatMode.READ_ONLY });
  });

  it('writes both channels in ONE updateSettings call', async () => {
    await service.muteAll(actor, 'room-1', ['chat', 'mic']);

    expect(rooms.updateSettings).toHaveBeenCalledTimes(1);
    expect(rooms.updateSettings).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({
        chatMode: VideoRoomChatMode.READ_ONLY,
        isRoomMuted: true,
      }),
    );
  });

  it('clears isRoomMuted on unmuteAll of the mic channel', async () => {
    await service.unmuteAll(actor, 'room-1', ['mic']);

    expect(rooms.updateSettings).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({ isRoomMuted: false }),
    );
  });
});

describe('mute-all broadcast', () => {
  const settingsEvents = () =>
    published.filter((e) => e.name === VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);

  it('publishes RoomSettingsUpdatedEvent after muteAll', async () => {
    await service.muteAll(actor, 'room-1', ['mic']);

    expect(settingsEvents()).toHaveLength(1);
    expect(settingsEvents()[0].payload).toMatchObject({
      roomId: 'room-1',
      actorId: actor.id,
    });
    expect(settingsEvents()[0].payload.settings.isRoomMuted).toBe(true);
  });

  it('publishes RoomSettingsUpdatedEvent after unmuteAll', async () => {
    await service.unmuteAll(actor, 'room-1', ['mic']);

    expect(settingsEvents()).toHaveLength(1);
    expect(settingsEvents()[0].payload.settings.isRoomMuted).toBe(false);
  });

  it('lists exactly the written fields in `changed`', async () => {
    await service.muteAll(actor, 'room-1', ['chat', 'mic']);

    expect([...settingsEvents()[0].payload.changed].sort()).toEqual(
      ['allowViewerChat', 'chatMode', 'isRoomMuted'].sort(),
    );
  });

  // An empty patch must not produce a phantom settings broadcast.
  it('does not publish when no channel writes settings', async () => {
    await service.muteAll(actor, 'room-1', []);

    expect(settingsEvents()).toHaveLength(0);
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });
});
```

The spec's `rooms.updateSettings` mock must resolve a full settings row so `toSettingsView` can project it — reuse the spec's existing settings fixture and spread the patch over it:

```ts
updateSettings: jest.fn().mockImplementation(async (_roomId, data) => ({
  ...settingsRow,
  ...data,
})),
```

> Assert only `settings.isRoomMuted`, never the whole `settings` object shape — Task 6 removes eight keys from that view and a whole-shape assertion here would break then.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-moderation.service.spec.ts -t "mute-all"`
Expected: FAIL — mic-only mutes call `updateSettings` zero times, and no `SETTINGS_UPDATED` event is published.

- [ ] **Step 3: Restructure `muteAll`**

Replace the `chat`-only settings write inside the lock with a single computed patch:

```ts
    let updatedSettings: VideoRoomSettings | null = null;
    let changedFields: string[] = [];

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      // ONE settings write covering both channels. Previously only the `chat`
      // branch wrote, so a mic-only mute changed no persisted state at all —
      // which is why the client had no mute flag to read back.
      const patch: Prisma.VideoRoomSettingsUpdateInput = {};
      if (chans.includes('chat')) {
        patch.chatMode = VideoRoomChatMode.READ_ONLY;
        // Mirrors VideoRoomChatSettingsService's deprecated-column upkeep.
        patch.allowViewerChat = false;
      }
      if (chans.includes('mic')) {
        patch.isRoomMuted = true;
      }

      changedFields = Object.keys(patch);
      if (changedFields.length > 0) {
        updatedSettings = await this.rooms.updateSettings(ref.id, patch);
      }

      if (chans.includes('mic')) {
        const stage = await this.media.getMediaState(actor, ref.id);
        for (const participant of stage.participants) {
          const role = await this.permissions.resolveEffectiveRole(ref, participant.userId);
          if (role && ELEVATED_VIDEO_ROOM_ROLES.includes(role)) continue;
          await this.media.forceMute(actor, ref.id, {
            targetUserId: participant.userId,
            muted: true,
          });
        }
      }

      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId: null,
        action: VideoRoomModerationActionType.ROOM_MUTED,
        metadata: this.auditMetadata({ channels: chans }, requestMeta),
      });
    });
```

The existing local `chatSettings` is replaced by `updatedSettings`. Pass `updatedSettings` to the existing `publishChatModeChanged(ref, actor, updatedSettings, requestMeta)` call so its behaviour is unchanged.

- [ ] **Step 4: Publish the settings event in `muteAll`**

After the lock, beside the existing publishes:

```ts
    await this.bus.publish(
      new RoomModerationUpdatedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        channels: chans,
        muted: true,
      }),
    );
    await this.publishChatModeChanged(ref, actor, updatedSettings, requestMeta);

    // muteAll bypasses VideoRoomSettingsService (which gates on owner-only
    // MANAGE_ROOM and would wrongly 403 ADMIN/MODERATOR), so it inherits that
    // service's duty to announce the settings row it just wrote. Without this,
    // no client reconciling from `settings_updated` ever learns the room muted.
    if (updatedSettings) {
      await this.bus.publish(
        new RoomSettingsUpdatedEvent({
          roomId: ref.id,
          actorId: actor.id,
          changed: changedFields,
          settings: toSettingsView(updatedSettings) as NonNullable<
            ReturnType<typeof toSettingsView>
          >,
        }),
      );
    }
```

Add imports: `RoomSettingsUpdatedEvent` from `../events/video-room.events`, `toSettingsView` from `../mappers/video-room-detail.mapper`, and `Prisma` / `VideoRoomSettings` from `@prisma/client` if not already present.

- [ ] **Step 5: Apply the mirror image to `unmuteAll`**

Identical restructure with the inverse values:

```ts
      const patch: Prisma.VideoRoomSettingsUpdateInput = {};
      if (chans.includes('chat')) {
        patch.chatMode = VideoRoomChatMode.NORMAL;
        patch.allowViewerChat = true;
      }
      if (chans.includes('mic')) {
        patch.isRoomMuted = false;
      }
```

and the same post-lock `RoomSettingsUpdatedEvent` publish block, unchanged apart from operating on `unmuteAll`'s locals.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-moderation.service.spec.ts`
Expected: PASS. Every pre-existing `RoomModerationUpdatedEvent` and `ChatModeChangedEvent` assertion must still pass untouched.

- [ ] **Step 7: Checkpoint**

Run: `npx jest src/modules/video-rooms`
Expected: no regressions. **Do not commit.**

---

## Task 5: Trim the settings DTO to the writable set, with a drift guard

**Files:**
- Modify: `src/modules/video-rooms/dto/update-video-room-settings.dto.ts`
- Create: `src/modules/video-rooms/dto/update-video-room-settings.dto.spec.ts`
- Test: `src/modules/video-rooms/services/video-room-settings.service.spec.ts` (only if a case patches a now-removed field)

**Interfaces:**
- Consumes: `WRITABLE_SETTINGS_FIELDS` from `../services/video-room-settings.service`.
- Produces: `UpdateVideoRoomSettingsDto` with exactly 11 optional properties. Any code assigning a removed field stops compiling — that is the intended signal.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/dto/update-video-room-settings.dto.spec.ts`:

```ts
import { getMetadataStorage } from 'class-validator';
import { WRITABLE_SETTINGS_FIELDS } from '../services/video-room-settings.service';
import { UpdateVideoRoomSettingsDto } from './update-video-room-settings.dto';

/**
 * The DTO and WRITABLE_SETTINGS_FIELDS were maintained independently and
 * drifted to 22-vs-11: eleven fields passed validation and then hard-400'd at
 * the service. Swagger advertised all 22. This pins them together so the next
 * divergence fails here instead of in a client.
 *
 * class-validator's public metadata API is used rather than Nest's
 * `swagger/apiModelPropertiesArray` internals: every field carries
 * `@IsOptional()` plus a type validator, and nest-cli.json declares no Swagger
 * CLI plugin, so all decorators are explicit.
 */
describe('UpdateVideoRoomSettingsDto', () => {
  it('declares exactly the writable settings fields', () => {
    const declared = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(UpdateVideoRoomSettingsDto, '', false, false)
        .map((m) => m.propertyName),
    );

    expect([...declared].sort()).toEqual([...WRITABLE_SETTINGS_FIELDS].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/update-video-room-settings.dto.spec.ts`
Expected: FAIL — the declared set has 22 entries against 11 expected.

- [ ] **Step 3: Rewrite the DTO**

Replace the whole class body with exactly the 11 writable fields:

```ts
/**
 * Patch a room's configurable settings. Every field is optional (a partial
 * update), per-field permission gated by VideoRoomSettingsService.
 *
 * THIS CLASS MUST STAY EQUAL TO `WRITABLE_SETTINGS_FIELDS` — pinned by
 * update-video-room-settings.dto.spec.ts. It is deliberately NOT a mirror of
 * the VideoRoomSettings table: a field belongs here only once it has an
 * enforcing guard, so the API never advertises a setting that does nothing.
 *
 * NOT HERE, on purpose:
 *  - `hostSeatCount` / `guestSeatCount` — real, but edited through
 *    `POST /video-rooms/:id/seats/layout` (video-rooms-seats.controller.ts).
 *  - `isRoomMuted` — runtime state written only by mute-all/unmute-all.
 *  - `allowViewerChat` — internal mirror of `chatMode`, never client-writable.
 *  - `allowScreenShare` / `allowRecording` — no implementation exists.
 *  - `joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`,
 *    `maxDurationMinutes` — unenforced; they return with their guards in
 *    sub-projects B and C.
 */
export class UpdateVideoRoomSettingsDto {
  // ---- Chat ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowChat?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_SLOW_MODE_MAX_SECONDS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_SLOW_MODE_MAX_SECONDS)
  slowModeSeconds?: number;

  // ---- Economy / interactive ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowGifts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowTreasure?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowPk?: boolean;

  // ---- Media policy (gates, not media transport) ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowBeauty?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowCameraSwitch?: boolean;

  // ---- Social ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowInvite?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowReporting?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowAnnouncements?: boolean;

  /**
   * VR-8 column, VR-17 wire-up: when true a freed seat waits for owner/admin
   * approval; when false the front of the seat queue is auto-promoted.
   */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() seatApprovalRequired?: boolean;
}
```

Remove the now-unused `VIDEO_ROOM_MAX_SEATS` import; keep `VIDEO_ROOM_SLOW_MODE_MAX_SECONDS`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/dto/update-video-room-settings.dto.spec.ts`
Expected: PASS.

- [ ] **Step 5: Repair any settings-service spec that patched a removed field**

Run: `npx jest src/modules/video-rooms/services/video-room-settings.service.spec.ts`

If a case constructs a DTO with a removed field to assert the 400 path, it no longer compiles. Do not delete it — the rejection path still matters for untyped clients. Cast the payload at the boundary and keep the assertion:

```ts
await expect(
  service.update(actor, 'room-1', { allowScreenShare: true } as unknown as UpdateVideoRoomSettingsDto),
).rejects.toMatchObject({ errorCode: ERROR_CODES.VALIDATION_ERROR });
```

- [ ] **Step 6: Checkpoint**

Run: `npx jest src/modules/video-rooms && npx tsc --noEmit -p tsconfig.json 2>&1 | grep video-rooms`
Expected: tests green; no `video-rooms` type errors. **Do not commit.**

---

## Task 6: Trim the API response and update the mapper spec

**Files:**
- Modify: `src/modules/video-rooms/entities/video-room-detail.view.ts:12-42` (`VideoRoomSettingsView`)
- Modify: `src/modules/video-rooms/mappers/video-room-detail.mapper.ts:11-36` (`toSettingsView`)
- Test: `src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `VideoRoomSettingsView` with 14 properties — the 11 writable, plus `isRoomMuted`, `hostSeatCount`, `guestSeatCount`. Task 4's broadcast and Task 7's mobile model both depend on this shape.

- [ ] **Step 1: Update the existing mapper spec (it currently pins the old shape)**

In `video-room-detail.mapper.spec.ts`:

1. In `it('carries the row values through unchanged')` (~line 73), **delete only** the `maxDurationMinutes: 120,` line from the `toMatchObject`. Keep `hostSeatCount: 6` and `guestSeatCount: 2` — both are retained.

2. In `it('does not leak internal chat-tuning or audit columns')` (~line 90), extend the array so the removal becomes a pinned invariant:

```ts
    for (const internal of [
      'roomId',
      'chatMode',
      'chatMaxMessageLength',
      'chatMaxAttachments',
      'chatRateLimitPerMinute',
      'metadata',
      'createdAt',
      'updatedAt',
      // Retired 2026-07-29: stored but unenforced, so no longer advertised.
      // They return with their guards in sub-projects B and C.
      'allowScreenShare',
      'allowRecording',
      'allowViewerChat',
      'joinApprovalRequired',
      'allowJoinRequest',
      'allowShare',
      'allowFollow',
      'maxDurationMinutes',
    ]) {
      expect(view).not.toHaveProperty(internal);
    }
```

3. Add a case pinning what must survive:

```ts
  // isRoomMuted is real as of the mute-all wiring; seat counts are real and
  // edited via the seats endpoint. All three must keep reaching the client.
  it('retains isRoomMuted and the seat layout', () => {
    const view = toSettingsView(settingsRow());

    expect(view).toMatchObject({
      isRoomMuted: expect.any(Boolean),
      hostSeatCount: 6,
      guestSeatCount: 2,
    });
  });
```

Leave `it('projects every field the settings endpoint can write')` untouched — it is driven off `WRITABLE_SETTINGS_FIELDS` and is the guard against over-trimming.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts`
Expected: FAIL — the eight retired keys are still present on the view.

- [ ] **Step 3: Trim `VideoRoomSettingsView`**

Delete these eight properties from the interface: `allowViewerChat`, `allowScreenShare`, `allowRecording`, `joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`, `maxDurationMinutes`. Keep everything else, including the `seatApprovalRequired` doc comment. Add above the interface:

```ts
/**
 * Client-safe projection of the per-room settings row (drops audit/timestamps).
 *
 * Contains ONLY settings that are implemented today. Columns that exist but are
 * unenforced are deliberately absent — advertising them told clients the room
 * could do things it cannot. They return with their guards in sub-projects B/C.
 */
```

- [ ] **Step 4: Trim `toSettingsView`**

Delete the corresponding eight lines from the returned object literal (`video-room-detail.mapper.ts:15`, `:22-28`, `:32`). The function keeps its `VideoRoomSettings | null` parameter and null short-circuit.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Run: `npx jest src/modules/video-rooms && npx tsc --noEmit -p tsconfig.json 2>&1 | grep video-rooms`
Expected: tests green; no `video-rooms` type errors. If a consumer referenced a removed field, `tsc` names it — fix the consumer, do not restore the field. **Do not commit.**

---

## Task 7: Trim the mobile settings model

**Files:**
- Modify: `/Users/lt611-18/soulzaa-mobile/lib/features/video_room/domain/models/video_room_settings.dart`
- Test: `/Users/lt611-18/soulzaa-mobile/test/features/video_room/video_room_settings_test.dart`

**Interfaces:**
- Consumes: the 14-field `VideoRoomSettingsView` wire shape from Task 6.
- Produces: `VideoRoomSettings` with the eight retired fields gone; `isRoomMuted`, `hostSeatCount`, `guestSeatCount` retained. `readBool(String)` / `setBool(String, bool)` keep their signatures.

- [ ] **Step 1: Update the existing model test**

In `video_room_settings_test.dart`, remove the eight retired keys from the `fromJson` fixture map (lines ~9-26: `allowViewerChat`, `allowScreenShare`, `allowRecording`, `joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`, `maxDurationMinutes`) and delete the assertions that read them (`expect(settings.maxDurationMinutes, isNull)` ~line 35, the `maxDurationMinutes: 120` copyWith case ~line 112, and its `expect(restored.maxDurationMinutes, 120)` ~line 118).

Add a case pinning the accessors' tolerance, since the wire may still carry retired keys from an older server:

```dart
test('ignores retired wire keys and keeps the live ones', () {
  final settings = VideoRoomSettings.fromJson(<String, dynamic>{
    'allowChat': true,
    'isRoomMuted': true,
    'hostSeatCount': 6,
    'guestSeatCount': 2,
    // Retired server-side; a stale server may still send them.
    'allowScreenShare': true,
    'maxDurationMinutes': 120,
  });

  expect(settings.isRoomMuted, isTrue);
  expect(settings.hostSeatCount, 6);
  expect(settings.guestSeatCount, 2);
  // Unknown keys must not crash the string-keyed accessors.
  expect(settings.readBool('allowScreenShare'), isNull);
  expect(settings.setBool('allowScreenShare', false), same(settings));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/video_room_settings_test.dart`
Expected: FAIL — `readBool('allowScreenShare')` still returns a bool because the field is still in `toJson`.

- [ ] **Step 3: Remove the eight fields from the model**

In `video_room_settings.dart`, delete each of `allowViewerChat`, `allowScreenShare`, `allowRecording`, `joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`, `maxDurationMinutes` from **all five** places:

1. the constructor parameter list (~lines 30-40),
2. the `final` field declarations (~lines 42-63),
3. the `fromJson` body (~lines 85-108),
4. the `toJson` map (~lines 112-133),
5. the `copyWith` parameter list and its body (~line 150 onward).

Keep `isRoomMuted`, `hostSeatCount`, `guestSeatCount` in all five. Update the class doc comment:

```dart
/// Client mirror of the server's `VideoRoomSettingsView`.
///
/// Carries ONLY settings the server implements. Fields that exist as columns
/// but have no enforcement were removed on 2026-07-29; they return alongside
/// their guards. `isRoomMuted` is mic-mute runtime state, written by
/// mute-all/unmute-all and never PATCH-writable.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/video_room_settings_test.dart`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze lib/features/video_room && flutter test test/features/video_room`
Expected: no analyzer errors; video_room tests green. Any widget referencing a removed field surfaces here — fix the widget, do not restore the field. **Do not commit.**

---

## Task 8: Mobile hub summary and doc correction

**Files:**
- Modify: `/Users/lt611-18/soulzaa-mobile/lib/features/video_room/presentation/widgets/settings/video_room_settings_hub.dart:113` and `:139`
- Modify: `/Users/lt611-18/soulzaa-mobile/lib/features/video_room/presentation/widgets/settings/sections/mic_camera_page.dart:10-25`
- Test: `/Users/lt611-18/soulzaa-mobile/test/features/video_room/settings_hub_test.dart`

**Interfaces:**
- Consumes: `VideoRoomSettings.isRoomMuted` from Task 7.
- Produces: `summaryFor(SettingsSection.micCamera, settings)` returns `'Mics muted'` when `isRoomMuted`, else `null`.

- [ ] **Step 1: Write the failing test**

In `settings_hub_test.dart`:

```dart
group('Mic & Camera summary', () {
  // Before this change the summary read isRoomMuted, which nothing ever wrote,
  // so the row stayed blank even with every mic muted.
  test('reports muted mics', () {
    final settings = const VideoRoomSettings().copyWith(isRoomMuted: true);

    expect(summaryFor(SettingsSection.micCamera, settings), 'Mics muted');
  });

  test('reports nothing when mics are live', () {
    final settings = const VideoRoomSettings().copyWith(isRoomMuted: false);

    expect(summaryFor(SettingsSection.micCamera, settings), isNull);
  });

  // isRoomMuted is not PATCH-writable, so it can never be a pending wire key;
  // listing it would make the row show "Updating…" for a state that never pends.
  test('does not track isRoomMuted as a pending summary field', () {
    expect(
      kSectionSummaryFields[SettingsSection.micCamera] ?? const <String>[],
      isNot(contains('isRoomMuted')),
    );
  });
});
```

Match the file's existing construction idiom for `VideoRoomSettings` if it differs from `const VideoRoomSettings()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/settings_hub_test.dart`
Expected: FAIL — summary returns `'Room muted'`, and `kSectionSummaryFields` still contains `isRoomMuted`.

- [ ] **Step 3: Fix the summary label**

`video_room_settings_hub.dart:112-113`:

```dart
    case SettingsSection.micCamera:
      // Mic-only by design: chat state is surfaced by the Audience Permissions
      // summary via chatMode, so tracking it here too would duplicate it.
      return settings.isRoomMuted ? 'Mics muted' : null;
```

- [ ] **Step 4: Remove the dead pending entry**

`video_room_settings_hub.dart:127-140` — delete the `SettingsSection.micCamera: <String>['isRoomMuted'],` entry. The map tracks PATCH-in-flight wire keys and `isRoomMuted` is never PATCHed. Leave the other three entries.

- [ ] **Step 5: Correct the mic_camera_page doc comment**

Replace the stale `Mute everyone` bullet (`mic_camera_page.dart:17-21`):

```dart
///  * **Mute everyone** is an ACTION, not a toggle.
///    `POST :id/moderation/mute-all` force-mutes each participant's mic and,
///    on the `chat` channel, sets `chatMode: READ_ONLY`. Since 2026-07-29 it
///    also writes `settings.isRoomMuted`, so the mic half IS readable — the hub
///    renders "Mics muted" from it. It stays two explicit actions rather than a
///    toggle because the two channels are independent.
```

Also update the `DELIBERATELY ABSENT` paragraph to note that `allowScreenShare` / `allowRecording` are no longer part of the settings payload at all.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter test test/features/video_room/settings_hub_test.dart`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze lib/features/video_room && flutter test test/features/video_room`
Expected: analyzer clean; all video_room tests green. **Do not commit.**

---

## Task 9: Full regression verification

**Files:** none modified — verification only.

**Interfaces:**
- Consumes: every preceding task.
- Produces: the evidence needed to decide on committing.

- [ ] **Step 1: Backend suite**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest 2>&1 | tail -25`
Expected: all suites pass. Record the total against the pre-change baseline; the count should rise by the new cases only.

- [ ] **Step 2: Backend types**

Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: **67** — the documented pre-existing count. Higher means this work introduced errors.

Then confirm none are ours:

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "video-rooms"`
Expected: no output.

- [ ] **Step 3: Backend lint**

Run: `cd /Users/lt611-18/soulzaa-backend && npm run lint`
Expected: clean (`--max-warnings 0`).

- [ ] **Step 4: Mobile suite and analyzer**

Run: `cd /Users/lt611-18/soulzaa-mobile && flutter analyze && flutter test 2>&1 | tail -15`
Expected: analyzer clean; all tests pass.

- [ ] **Step 5: Confirm the no-RTC constraint held**

Run: `cd /Users/lt611-18/soulzaa-backend && git diff --stat src/modules/video-rooms/services/video-room-media.service.ts`
Expected: **2 insertions, 2 deletions.** Anything more must be justified or reverted.

- [ ] **Step 6: Confirm zero migration**

Run: `cd /Users/lt611-18/soulzaa-backend && git status --short prisma/`
Expected: **no output.** Any change under `prisma/` violates the zero-migration constraint.

- [ ] **Step 7: Report and stop**

Summarise: tests added, tests updated, suite totals before/after, and the two constraint checks. **Do not commit.** Ask whether to commit and, if so, on which branch.

---

## Requirement Coverage

| Spec requirement | Task |
|---|---|
| §4.1 `isRoomMuted` mic-only, written only by mute-all/unmute-all | 4 |
| §4.2 `RoomSettingsUpdatedEvent` published on those writes | 4 |
| §4.3 DTO trimmed 22 → 11 | 5 |
| §4.3 Drift guard via `class-validator` metadata | 5 |
| §4.3 Response trimmed by 8; `isRoomMuted`/seat counts retained | 6 |
| §4.4 `requireSettings()` + `VIDEO_ROOM_SETTINGS_MISSING` | 1 |
| §4.4 Applied to 7 non-media guards | 2 |
| §4.4 Applied to `assertMediaAllowed`, no RTC changes | 3, 9 |
| §4.5 Hub summary `'Mics muted'` | 8 |
| §4.5 `isRoomMuted` out of `kSectionSummaryFields` | 8 |
| §4.5 Mobile model trimmed; accessors verified safe | 7 |
| §4.5 `mic_camera_page` doc corrected | 8 |
| §5 Error code added, 500 status | 1 |
| §6 Mute channel matrix | 4 |
| §6 Broadcast-after-mute tests | 4 |
| §6 Existing mapper-spec tests updated, not deleted | 6 |
| §6 Existing mobile model test updated, not deleted | 7 |
| §6 Regression bar | 9 |
| §8 Zero migration | 9 |
