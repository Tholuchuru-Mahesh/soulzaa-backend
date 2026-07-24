# VR-17 Video Room Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-ready Video Room Settings surface in the Soulzaa Flutter client where every control is enforced server-side, boolean toggles sync live to all participants, and the permission matrix is read from the server.

**Architecture:** Add one missing backend endpoint (`PATCH :id/settings`) with per-field permission gating and a `video_room.settings_updated` broadcast; expose the already-written-but-orphaned `configureLayout` as `POST :id/seats/layout`; add 7 small enforcement guards to existing services. On mobile, replace the 201-line decorative sheet with a permission-filtered hub plus drill-down pages, driven by a settings controller that applies booleans optimistically and reconciles from the socket.

**Tech Stack:** NestJS 10 · Prisma · Socket.IO (Redis adapter) · Jest — Flutter · Riverpod · Dio · flutter_test

**Spec:** `docs/superpowers/specs/2026-07-24-video-room-settings-design.md`

## Global Constraints

- **NO GIT. Ever.** No `git add`, `git commit`, `git checkout`, `git stash`, `git reset`. All work stays in the working tree. The user commits manually after review. Every task ends with a **verification gate**, not a commit.
- **No Prisma migration.** No change to `prisma/schema/*.prisma`.
- **No change** to `VideoRoomPermission` or `VIDEO_ROOM_PERMISSION_MATRIX`. `MANAGE_MEDIA` is NOT created — media flags reuse `MANAGE_PARTICIPANTS`.
- **No change to Audio Rooms.** Reading `GET /audio-rooms/categories` and `/languages` from mobile is read-only reuse and is permitted.
- **No placeholder UI.** Every shipped control must map to an enforced backend behaviour.
- `BusinessException` field is **`.errorCode`**, never `.code`.
- Backend gate after every task: `npx tsc --noEmit` (0 errors) · `npx eslint src --max-warnings 0` · `npx jest <relevant spec>`.
- Mobile gate after every task: `flutter analyze` (0 issues) · `flutter test <relevant test>`.
- Backend repo: `/Users/lt611-18/soulzaa-backend`. Mobile repo: `/Users/lt611-18/soulzaa-mobile`.
- The 6 deferred settings fields (`allowFollow`, `allowShare`, `joinApprovalRequired`, `allowJoinRequest`, `isRoomMuted`, `maxDurationMinutes`) plus `allowViewerChat`, `hostSeatCount`, `guestSeatCount` must be **rejected** by the settings endpoint.

---

## File Structure

### Backend (`src/modules/video-rooms/`)

| File | Responsibility |
|---|---|
| `events/video-room.events.ts` | **MODIFY** — add `SETTINGS_UPDATED` bus name + `RoomSettingsUpdatedEvent` |
| `constants/video-room.constants.ts` | **MODIFY** — add `SETTINGS_UPDATED` socket name |
| `services/video-room-settings.service.ts` | **CREATE** — per-field permission gate, write, dual publish |
| `controllers/video-rooms.controller.ts` | **MODIFY** — `PATCH :id/settings` |
| `controllers/video-rooms-seats.controller.ts` | **MODIFY** — `POST :id/seats/layout` |
| `listeners/video-room-socket.listener.ts` | **MODIFY** — bridge settings event → broadcast |
| `services/video-room-seat-invitation.service.ts` | **MODIFY** — `allowInvite` guard |
| `services/video-room-announcement.service.ts` | **MODIFY** — `allowAnnouncements` guard |
| `services/video-room-report.service.ts` | **MODIFY** — `allowReporting` guard |
| `services/video-room-media.service.ts` | **MODIFY** — 4 media guards |
| `video-rooms.module.ts` | **MODIFY** — register `VideoRoomSettingsService` |

### Mobile (`lib/features/video_room/`)

| File | Responsibility |
|---|---|
| `domain/models/video_room_settings.dart` | **CREATE** — 1:1 mirror of `VideoRoomSettingsView` |
| `domain/models/video_room_permission.dart` | **CREATE** — permission enum + role + parsing |
| `domain/models/video_room_models.dart` | **MODIFY** — delete the fiction fields |
| `domain/repositories/video_room_repository.dart` | **MODIFY** — new method signatures |
| `data/repositories/video_room_repository_impl.dart` | **MODIFY** — fix 6 URLs, add settings/permissions/roles/moderation |
| `data/sources/video_room_socket_service.dart` | **MODIFY** — subscribe new events |
| `presentation/providers/video_room_state.dart` | **MODIFY** — hold settings + permissions |
| `presentation/providers/video_room_settings_controller.dart` | **CREATE** — hybrid apply + rollback |
| `presentation/widgets/settings/widgets/settings_toggle_tile.dart` | **CREATE** — optimistic switch |
| `presentation/widgets/settings/widgets/settings_nav_tile.dart` | **CREATE** — drill-down row |
| `presentation/widgets/settings/widgets/settings_editor_sheet.dart` | **CREATE** — Save/Confirm editor |
| `presentation/widgets/settings/video_room_settings_hub.dart` | **CREATE** — permission-filtered root |
| `presentation/widgets/settings/sections/*.dart` | **CREATE** — 9 drill-down pages |

---

# PHASE A — Backend settings endpoint

### Task 1: Settings event + socket constant

**Files:**
- Modify: `src/modules/video-rooms/events/video-room.events.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts`
- Test: `src/modules/video-rooms/events/video-room.events.spec.ts`

**Interfaces:**
- Consumes: `DomainEvent` from `src/common/events`; existing `VIDEO_ROOM_EVENTS` / `VIDEO_ROOM_SOCKET_EVENTS` const objects.
- Produces: `VIDEO_ROOM_EVENTS.SETTINGS_UPDATED = 'video_room.settings_updated'`; `VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED = 'video_room.settings_updated'`; `class RoomSettingsUpdatedEvent extends DomainEvent<{ roomId: string; actorId: string; changed: string[]; settings: VideoRoomSettingsView }>`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/video-rooms/events/video-room.events.spec.ts` (create the file if absent, importing the same way sibling specs do):

```ts
import { VIDEO_ROOM_EVENTS, RoomSettingsUpdatedEvent } from './video-room.events';
import { VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';

describe('VR-17 settings event', () => {
  it('exposes the bus + socket event name', () => {
    expect(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED).toBe('video_room.settings_updated');
    expect(VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED).toBe('video_room.settings_updated');
  });

  it('carries the full settings snapshot and the changed keys', () => {
    const event = new RoomSettingsUpdatedEvent({
      roomId: 'room-1',
      actorId: 'user-1',
      changed: ['allowGifts'],
      settings: { allowGifts: false } as never,
    });
    expect(event.name).toBe(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);
    expect(event.payload.changed).toEqual(['allowGifts']);
    expect(event.payload.roomId).toBe('room-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room.events.spec.ts`
Expected: FAIL — `RoomSettingsUpdatedEvent` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `constants/video-room.constants.ts`, inside `VIDEO_ROOM_SOCKET_EVENTS`, after the `UPDATED` line:

```ts
  /** VR-17: room settings changed; payload carries the full post-write snapshot. */
  SETTINGS_UPDATED: 'video_room.settings_updated',
```

In `events/video-room.events.ts`, inside `VIDEO_ROOM_EVENTS`, after `UPDATED`:

```ts
  SETTINGS_UPDATED: 'video_room.settings_updated',
```

And after the `RoomUpdatedEvent` class:

```ts
/**
 * VR-17 — a room's configurable settings changed. `settings` is the FULL
 * post-write snapshot (not a delta) so clients replace wholesale, which makes
 * reconciliation idempotent and removes ordering hazards between concurrent
 * admin edits. `changed` lists the keys the patch actually touched, for audit
 * and for clients that want to animate only what moved.
 */
export class RoomSettingsUpdatedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  changed: string[];
  settings: VideoRoomSettingsView;
}> {
  readonly name = VIDEO_ROOM_EVENTS.SETTINGS_UPDATED;
}
```

Add the import at the top of `events/video-room.events.ts`:

```ts
import type { VideoRoomSettingsView } from '../entities/video-room-detail.view';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room.events.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/events src/modules/video-rooms/constants --max-warnings 0`
Expected: no output (0 errors). **Do not commit.**

---

### Task 2: Settings service — field→permission map and fail-whole gating

**Files:**
- Create: `src/modules/video-rooms/services/video-room-settings.service.ts`
- Test: `src/modules/video-rooms/services/video-room-settings.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomsRepository.findById / getSettings / updateSettings`; `VideoRoomPermissionService.assertPermission(actor, room, permission)`; `EVENT_BUS`; `UpdateVideoRoomSettingsDto`; `RoomSettingsUpdatedEvent` (Task 1).
- Produces: `SETTINGS_FIELD_PERMISSION: Record<SettingsField, VideoRoomPermission>`; `WRITABLE_SETTINGS_FIELDS: readonly SettingsField[]`; `class VideoRoomSettingsService` with `update(actor: RoomActor, roomId: string, dto: UpdateVideoRoomSettingsDto): Promise<VideoRoomSettings>`.

This task delivers the map + gating only; the write and publish land in Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-settings.service.spec.ts`:

```ts
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  SETTINGS_FIELD_PERMISSION,
  WRITABLE_SETTINGS_FIELDS,
  VideoRoomSettingsService,
} from './video-room-settings.service';

describe('VideoRoomSettingsService — permission map', () => {
  it('maps every writable field to a permission', () => {
    for (const field of WRITABLE_SETTINGS_FIELDS) {
      expect(SETTINGS_FIELD_PERMISSION[field]).toBeDefined();
    }
  });

  it('gates chat policy on ROOM_MUTE so moderators can act mid-stream', () => {
    expect(SETTINGS_FIELD_PERMISSION.allowChat).toBe(VideoRoomPermission.ROOM_MUTE);
    expect(SETTINGS_FIELD_PERMISSION.slowModeSeconds).toBe(VideoRoomPermission.ROOM_MUTE);
  });

  it('gates media flags on MANAGE_PARTICIPANTS (MANAGE_MEDIA is deliberately not created)', () => {
    expect(SETTINGS_FIELD_PERMISSION.allowBeauty).toBe(VideoRoomPermission.MANAGE_PARTICIPANTS);
    expect(SETTINGS_FIELD_PERMISSION.allowScreenShare).toBe(VideoRoomPermission.MANAGE_PARTICIPANTS);
  });

  it('excludes deprecated, deferred and seat-layout fields', () => {
    const excluded = [
      'allowViewerChat',
      'hostSeatCount',
      'guestSeatCount',
      'allowFollow',
      'allowShare',
      'joinApprovalRequired',
      'allowJoinRequest',
      'isRoomMuted',
      'maxDurationMinutes',
    ];
    for (const field of excluded) {
      expect(WRITABLE_SETTINGS_FIELDS).not.toContain(field);
    }
  });
});

describe('VideoRoomSettingsService.update — gating', () => {
  const room = { id: 'room-1', ownerId: 'owner-1' };
  let rooms: { findById: jest.Mock; getSettings: jest.Mock; updateSettings: jest.Mock };
  let permissions: { assertPermission: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomSettingsService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(room),
      getSettings: jest.fn().mockResolvedValue({ roomId: 'room-1' }),
      updateSettings: jest.fn().mockResolvedValue({ roomId: 'room-1', allowGifts: false }),
    };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomSettingsService(rooms as never, permissions as never, bus as never);
  });

  it('rejects an unknown or deferred field without writing', async () => {
    await expect(
      service.update({ id: 'owner-1', roles: [] }, 'room-1', { maxDurationMinutes: 60 } as never),
    ).rejects.toMatchObject({ errorCode: expect.any(String) });
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });

  it('asserts every distinct permission implied by the patch', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', {
      allowGifts: false,
      allowPk: false,
    });
    const asserted = permissions.assertPermission.mock.calls.map((c) => c[2]);
    expect(asserted).toContain(VideoRoomPermission.MANAGE_TREASURE);
    expect(asserted).toContain(VideoRoomPermission.START_PK);
  });

  it('fails whole: one unauthorized field blocks the entire patch', async () => {
    permissions.assertPermission.mockImplementation((_a, _r, perm) => {
      if (perm === VideoRoomPermission.START_PK) throw new Error('forbidden');
      return Promise.resolve(undefined);
    });
    await expect(
      service.update({ id: 'admin-1', roles: [] }, 'room-1', { allowGifts: false, allowPk: false }),
    ).rejects.toThrow('forbidden');
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });

  it('a no-op patch writes nothing and publishes nothing', async () => {
    const result = await service.update({ id: 'owner-1', roles: [] }, 'room-1', {});
    expect(rooms.updateSettings).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(result).toEqual({ roomId: 'room-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-settings.service.spec.ts`
Expected: FAIL — cannot find module `./video-room-settings.service`.

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/video-rooms/services/video-room-settings.service.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, VideoRoomSettings } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { UpdateVideoRoomSettingsDto } from '../dto/update-video-room-settings.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

/** The settings fields this endpoint may write. Everything else is rejected. */
export const WRITABLE_SETTINGS_FIELDS = [
  'allowChat',
  'slowModeSeconds',
  'allowAnnouncements',
  'seatApprovalRequired',
  'allowPk',
  'allowGifts',
  'allowTreasure',
  'allowInvite',
  'allowReporting',
  'allowBeauty',
  'allowCameraSwitch',
  'allowScreenShare',
  'allowRecording',
] as const;

export type SettingsField = (typeof WRITABLE_SETTINGS_FIELDS)[number];

/**
 * Field → permission required to write it (VR-17).
 *
 * A single request-level gate would be wrong: `VideoRoomChatSettingsService`
 * gates the whole patch on the owner-only `MANAGE_ROOM`, which would 403 Admins
 * on seats/gifts/PK — permissions they legitimately hold. So authorization is
 * resolved per field.
 *
 * `MANAGE_MEDIA` deliberately does not exist. The four media gate flags reuse
 * `MANAGE_PARTICIPANTS`, which already resolves to {OWNER, ADMIN} — the exact
 * intended access, with zero change to the shared permission enum or matrix.
 */
export const SETTINGS_FIELD_PERMISSION: Record<SettingsField, VideoRoomPermission> = {
  allowChat: VideoRoomPermission.ROOM_MUTE,
  slowModeSeconds: VideoRoomPermission.ROOM_MUTE,
  allowAnnouncements: VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
  seatApprovalRequired: VideoRoomPermission.MANAGE_SEATS,
  allowPk: VideoRoomPermission.START_PK,
  allowGifts: VideoRoomPermission.MANAGE_TREASURE,
  allowTreasure: VideoRoomPermission.MANAGE_TREASURE,
  allowInvite: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowReporting: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowBeauty: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowCameraSwitch: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowScreenShare: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowRecording: VideoRoomPermission.MANAGE_PARTICIPANTS,
};

const WRITABLE = new Set<string>(WRITABLE_SETTINGS_FIELDS);

@Injectable()
export class VideoRoomSettingsService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateVideoRoomSettingsDto,
  ): Promise<VideoRoomSettings> {
    const submitted = Object.keys(dto).filter(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );

    const rejected = submitted.filter((key) => !WRITABLE.has(key));
    if (rejected.length > 0) {
      // VALIDATION_ERROR, not VIDEO_ROOM_FORBIDDEN: an unwritable field name is a
      // bad request, not an authorization failure. This keeps 403 reserved for
      // "your role changed" — the signal the mobile controller keys its
      // permission refetch on (Task 18). Collapsing the two would make a
      // client-side field-name bug present as a permission change.
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `These settings cannot be changed here: ${rejected.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const room = await this.loadRoom(roomId);

    if (submitted.length === 0) {
      return (await this.rooms.getSettings(roomId)) as VideoRoomSettings;
    }

    // FAIL WHOLE: assert every distinct permission BEFORE any write, so a
    // partially-authorized patch applies nothing rather than applying in part.
    const required = new Set(
      submitted.map((field) => SETTINGS_FIELD_PERMISSION[field as SettingsField]),
    );
    for (const permission of required) {
      await this.permissions.assertPermission(actor, room, permission);
    }

    const data: Prisma.VideoRoomSettingsUpdateInput = {};
    for (const field of submitted) {
      (data as Record<string, unknown>)[field] = (dto as Record<string, unknown>)[field];
    }

    return this.rooms.updateSettings(roomId, data);
  }

  private async loadRoom(roomId: string) {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-settings.service.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/services/video-room-settings.service.ts --max-warnings 0`
Expected: 0 errors. **Do not commit.**

---

### Task 3: Settings service — dual event publish

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-settings.service.ts`
- Test: `src/modules/video-rooms/services/video-room-settings.service.spec.ts`

**Interfaces:**
- Consumes: `RoomSettingsUpdatedEvent` (Task 1); `ChatModeChangedEvent` from `../events/video-room-chat.events`; `toSettingsView` — export it from `mappers/video-room-detail.mapper.ts` if it is not already exported.
- Produces: `update()` now publishes `RoomSettingsUpdatedEvent` always, plus `ChatModeChangedEvent` when the patch touches `allowChat` or `slowModeSeconds`.

- [ ] **Step 1: Write the failing test**

Append to `video-room-settings.service.spec.ts`:

```ts
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';

describe('VideoRoomSettingsService.update — events', () => {
  const room = { id: 'room-1', ownerId: 'owner-1' };
  let rooms: { findById: jest.Mock; getSettings: jest.Mock; updateSettings: jest.Mock };
  let permissions: { assertPermission: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomSettingsService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(room),
      getSettings: jest.fn().mockResolvedValue({ roomId: 'room-1' }),
      updateSettings: jest.fn().mockResolvedValue({
        roomId: 'room-1',
        allowChat: false,
        slowModeSeconds: 30,
        chatMode: 'NORMAL',
        allowGifts: true,
      }),
    };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomSettingsService(rooms as never, permissions as never, bus as never);
  });

  const publishedNames = () => bus.publish.mock.calls.map((c) => c[0].name);

  it('always publishes the settings event with the full snapshot and changed keys', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', { allowGifts: false });
    expect(publishedNames()).toContain(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);
    const event = bus.publish.mock.calls[0][0];
    expect(event.payload.changed).toEqual(['allowGifts']);
    expect(event.payload.settings).toBeDefined();
    expect(event.payload.actorId).toBe('owner-1');
  });

  it('ADDITIONALLY publishes ChatModeChangedEvent when chat policy is touched', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', { slowModeSeconds: 30 });
    expect(publishedNames()).toContain(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);
    expect(publishedNames()).toContain(VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED);
  });

  it('does NOT publish ChatModeChangedEvent for a non-chat patch', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', { allowGifts: false });
    expect(publishedNames()).not.toContain(VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-settings.service.spec.ts -t "events"`
Expected: FAIL — `bus.publish` was never called.

- [ ] **Step 3: Write minimal implementation**

First, confirm `toSettingsView` is exported from `mappers/video-room-detail.mapper.ts`. If it is declared as `function toSettingsView(...)`, change it to `export function toSettingsView(...)` — no behaviour change.

Then in `video-room-settings.service.ts`, add imports:

```ts
import { ChatModeChangedEvent } from '../events/video-room-chat.events';
import { RoomSettingsUpdatedEvent } from '../events/video-room.events';
import { toSettingsView } from '../mappers/video-room-detail.mapper';
```

Add this constant next to `WRITABLE`:

```ts
/** Fields that also require the chat surface to be told — see `publish` below. */
const CHAT_POLICY_FIELDS = new Set<string>(['allowChat', 'slowModeSeconds']);
```

Replace the final `return this.rooms.updateSettings(roomId, data);` with:

```ts
    const settings = await this.rooms.updateSettings(roomId, data);

    await this.bus.publish(
      new RoomSettingsUpdatedEvent({
        roomId,
        actorId: actor.id,
        changed: submitted,
        settings: toSettingsView(settings) as NonNullable<ReturnType<typeof toSettingsView>>,
      }),
    );

    // THE SECOND PUBLISH is not optional. `allowChat` / `slowModeSeconds` are
    // also owned by VideoRoomChatSettingsService, which we deliberately bypass
    // (it gates on owner-only MANAGE_ROOM and would wrongly 403 ADMIN/MODERATOR
    // — the same reason VideoRoomModerationService.muteAll bypasses it). Having
    // bypassed the service we inherit its duty to announce, exactly as muteAll
    // does via publishChatModeChanged. Skip this and chat clients never learn
    // slow mode turned on, while every persistence test still passes.
    if (submitted.some((field) => CHAT_POLICY_FIELDS.has(field))) {
      await this.bus.publish(
        new ChatModeChangedEvent({
          roomId,
          chatMode: settings.chatMode,
          allowChat: settings.allowChat,
          slowModeSeconds: settings.slowModeSeconds,
          actorId: actor.id,
        }),
      );
    }

    return settings;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-settings.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms --max-warnings 0`
Expected: 0 errors. **Do not commit.**

---

### Task 4: `PATCH :id/settings` route + module registration

**Files:**
- Modify: `src/modules/video-rooms/controllers/video-rooms.controller.ts`
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms.controller.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomSettingsService.update` (Task 3).
- Produces: `PATCH /video-rooms/:id/settings` → `VideoRoomSettings`.

- [ ] **Step 1: Write the failing test**

Append to `video-rooms.controller.spec.ts` (match the existing describe/mocks style in that file):

```ts
describe('VR-17 PATCH :id/settings', () => {
  it('delegates to the settings service with the resolved actor', async () => {
    const settings = { update: jest.fn().mockResolvedValue({ roomId: 'room-1' }) };
    const controller = new VideoRoomsController(
      {} as never, {} as never, {} as never, settings as never,
    );
    const user = { id: 'user-1', roles: [] } as never;

    await controller.updateSettings(user, 'room-1', { allowGifts: false });

    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'room-1',
      { allowGifts: false },
    );
  });
});
```

> Adjust the `new VideoRoomsController(...)` argument list to match the constructor as it exists in the file — add the settings service as the **last** parameter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms.controller.spec.ts -t "VR-17"`
Expected: FAIL — `controller.updateSettings is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `video-rooms.controller.ts` add the import and constructor param:

```ts
import { UpdateVideoRoomSettingsDto } from '../dto/update-video-room-settings.dto';
import { VideoRoomSettingsService } from '../services/video-room-settings.service';
```

```ts
    private readonly settings: VideoRoomSettingsService,
```

Add the route immediately after the existing `@Patch(':id')` handler:

```ts
  @Patch(':id/settings')
  @NotGuest()
  @ApiOperation({
    summary: 'Patch a room’s configurable settings (per-field permission gated)',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'The updated settings row.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Field not writable here.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Missing a required permission.' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateVideoRoomSettingsDto,
  ) {
    return this.settings.update(this.actor(user), id, dto);
  }
```

In `video-rooms.module.ts`, add `VideoRoomSettingsService` to the `providers` array (and to `exports` if sibling settings services are exported).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms --max-warnings 0 && npx jest src/modules/video-rooms`
Expected: 0 errors, full module suite green. **Do not commit.**

---

### Task 5: Socket listener bridge

**Files:**
- Modify: `src/modules/video-rooms/listeners/video-room-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts`

**Interfaces:**
- Consumes: `RoomSettingsUpdatedEvent`, `VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED`.
- Produces: `video_room.settings_updated` broadcast into the `/video-room` namespace room.

- [ ] **Step 1: Write the failing test**

Append to `video-room-socket.listener.spec.ts`, following the existing subscribe-capture pattern in that file:

```ts
it('bridges RoomSettingsUpdatedEvent to video_room.settings_updated', () => {
  const handlers = new Map<string, (e: unknown) => void>();
  const bus = { subscribe: jest.fn((name: string, fn) => handlers.set(name, fn)) };
  const sockets = { emitToNamespaceRoom: jest.fn() };
  new VideoRoomSocketListener(bus as never, sockets as never).onModuleInit();

  const payload = {
    roomId: 'room-1',
    actorId: 'user-1',
    changed: ['allowGifts'],
    settings: { allowGifts: false },
  };
  handlers.get(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED)?.({ payload } as never);

  expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
    VIDEO_ROOM_NAMESPACE,
    'room-1',
    VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED,
    payload,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts -t "settings_updated"`
Expected: FAIL — `emitToNamespaceRoom` not called.

- [ ] **Step 3: Write minimal implementation**

Add the type import alongside the other event type imports:

```ts
  type RoomSettingsUpdatedEvent,
```

Add inside `onModuleInit()`, next to the `RoomUpdatedEvent` subscription:

```ts
    this.bus.subscribe<RoomSettingsUpdatedEvent>(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED, e.payload),
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms`
Expected: 0 errors, module suite green. **Do not commit.**

---

# PHASE B — Seat layout route

### Task 6: `POST :id/seats/layout`

**Files:**
- Modify: `src/modules/video-rooms/controllers/video-rooms-seats.controller.ts`
- Create: `src/modules/video-rooms/dto/seat-layout.dto.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts`

**Interfaces:**
- Consumes: the **existing** `VideoRoomSeatService.configureLayout(actor, roomId, hostSeatCount, guestSeatCount, ip?)` — do NOT modify it.
- Produces: `POST /video-rooms/:id/seats/layout` body `{ hostSeatCount: number; guestSeatCount?: number }` → `SeatStageView`.

> `configureLayout` already preserves occupants, emits `SeatLeftEvent` for displaced users, keeps the settings row in sync, and publishes `SeatUpdatedEvent{reason:'layout_changed'}`. Assert **wiring only** — its behaviour is already covered by `video-room-seat.service.spec.ts`. Do not duplicate those tests.

- [ ] **Step 1: Write the failing test**

```ts
describe('VR-17 POST :id/seats/layout', () => {
  it('delegates to the existing configureLayout', async () => {
    const seats = { configureLayout: jest.fn().mockResolvedValue({ version: 2 }) };
    const controller = new VideoRoomSeatsController(seats as never);
    const user = { id: 'owner-1', roles: [] } as never;

    await controller.configureLayout(user, 'room-1', { hostSeatCount: 8, guestSeatCount: 0 });

    expect(seats.configureLayout).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner-1' }), 'room-1', 8, 0, undefined,
    );
  });

  it('defaults guestSeatCount to 0 when omitted', async () => {
    const seats = { configureLayout: jest.fn().mockResolvedValue({ version: 2 }) };
    const controller = new VideoRoomSeatsController(seats as never);
    await controller.configureLayout({ id: 'o', roles: [] } as never, 'room-1', {
      hostSeatCount: 5,
    });
    expect(seats.configureLayout).toHaveBeenCalledWith(
      expect.anything(), 'room-1', 5, 0, undefined,
    );
  });
});
```

> Adjust the constructor argument list to match the real `VideoRoomSeatsController`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts -t "seats/layout"`
Expected: FAIL — `controller.configureLayout is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/video-rooms/dto/seat-layout.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { VIDEO_ROOM_MAX_SEATS } from '../constants/video-room.constants';

/**
 * VR-17 — reshape the stage. Total seats are `1 + host + guest` (index 0 is the
 * owner), so the service rejects anything above VIDEO_ROOM_MAX_SEATS. The client
 * maps a layout choice N ∈ {4,6,8,9,12} to `hostSeatCount = N - 1`.
 */
export class ConfigureSeatLayoutDto {
  @ApiProperty({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS)
  hostSeatCount!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS)
  guestSeatCount?: number;
}
```

Add to `video-rooms-seats.controller.ts` (import `ConfigureSeatLayoutDto`, and place the route beside `@Post(':id/seats/lock')`):

```ts
  @Post(':id/seats/layout')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reshape the seat layout (owner/admin, MANAGE_SEATS, LIVE room only)',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'The new versioned seat stage.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'SEAT_LAYOUT_INVALID.' })
  configureLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ConfigureSeatLayoutDto,
    @Ip() ip: string,
  ) {
    // `ip` feeds configureLayout's `seat.layout_changed` audit record. The sibling
    // MANAGE_SEATS routes (lock/unlock) wire @Ip() the same way — passing
    // `undefined` here would silently degrade the audit trail for this action.
    return this.seats.configureLayout(
      this.actor(user),
      id,
      dto.hostSeatCount,
      dto.guestSeatCount ?? 0,
      ip,
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms`
Expected: 0 errors, module suite green. **Do not commit.**

---

# PHASE C — Enforcement guards

> Each guard makes a previously write-only column real. Without these, the corresponding toggle would be a placeholder — which the spec forbids.
> **No owner/admin bypass:** these flags express room policy, and whoever can change the flag can simply turn it back on.

### Task 7: `allowInvite` guard

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-seat-invitation.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomsRepository.getSettings(roomId)`.
- Produces: seat-invite entry point throws `VIDEO_ROOM_FORBIDDEN` / 403 when `settings.allowInvite === false`.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses a seat invite when allowInvite is disabled', async () => {
  rooms.getSettings.mockResolvedValue({ allowInvite: false });
  await expect(
    service.invite({ id: 'owner-1', roles: [] } as never, 'room-1', {
      targetUserId: 'user-2',
    } as never),
  ).rejects.toMatchObject({ errorCode: 'VIDEO_ROOM_FORBIDDEN' });
});

it('allows a seat invite when allowInvite is enabled', async () => {
  rooms.getSettings.mockResolvedValue({ allowInvite: true });
  await expect(
    service.invite({ id: 'owner-1', roles: [] } as never, 'room-1', {
      targetUserId: 'user-2',
    } as never),
  ).resolves.toBeDefined();
});
```

> Match the real method name and mock set-up used by the existing spec in this file. If `rooms.getSettings` is not yet on the harness mock, add it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts -t "allowInvite"`
Expected: FAIL — the invite resolves instead of throwing.

- [ ] **Step 3: Write minimal implementation**

Insert immediately after the existing permission assertion in the invite entry point:

```ts
    // VR-17: room policy gate. Deliberately no owner/admin bypass — whoever can
    // flip the flag can simply turn it back on.
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowInvite) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Seat invitations are disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
```

Add `VideoRoomsRepository` to the constructor if absent, plus the `BusinessException` / `ERROR_CODES` / `HttpStatus` imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts`
Expected: PASS, existing tests still green.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms`
Expected: 0 errors, module suite green. **Do not commit.**

---

### Task 8: `allowAnnouncements` guard

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-announcement.service.ts`
- Test: `src/modules/video-rooms/services/video-room-announcement.service.spec.ts`

**Interfaces:** identical shape to Task 7, reading `settings.allowAnnouncements`, guarding **create and update**.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses creating an announcement when allowAnnouncements is disabled', async () => {
  rooms.getSettings.mockResolvedValue({ allowAnnouncements: false });
  await expect(
    service.create({ id: 'owner-1', roles: [] } as never, 'room-1', {
      content: 'hello',
    } as never),
  ).rejects.toMatchObject({ errorCode: 'VIDEO_ROOM_FORBIDDEN' });
});

it('allows creating an announcement when enabled', async () => {
  rooms.getSettings.mockResolvedValue({ allowAnnouncements: true });
  await expect(
    service.create({ id: 'owner-1', roles: [] } as never, 'room-1', {
      content: 'hello',
    } as never),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-announcement.service.spec.ts -t "allowAnnouncements"`
Expected: FAIL — resolves instead of throwing.

- [ ] **Step 3: Write minimal implementation**

```ts
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowAnnouncements) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Announcements are disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-announcement.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms`
Expected: 0 errors. **Do not commit.**

---

### Task 9: `allowReporting` guard

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-report.service.ts`
- Test: `src/modules/video-rooms/services/video-room-report.service.spec.ts`

**Interfaces:** same shape, reading `settings.allowReporting`, guarding report submission only (never review).

- [ ] **Step 1: Write the failing test**

```ts
it('refuses a report when allowReporting is disabled', async () => {
  rooms.getSettings.mockResolvedValue({ allowReporting: false });
  await expect(
    service.report({ id: 'user-1', roles: [] } as never, 'room-1', {
      targetUserId: 'user-2', reason: 'SPAM',
    } as never),
  ).rejects.toMatchObject({ errorCode: 'VIDEO_ROOM_FORBIDDEN' });
});

it('allows a report when enabled', async () => {
  rooms.getSettings.mockResolvedValue({ allowReporting: true });
  await expect(
    service.report({ id: 'user-1', roles: [] } as never, 'room-1', {
      targetUserId: 'user-2', reason: 'SPAM',
    } as never),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-report.service.spec.ts -t "allowReporting"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowReporting) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Reporting is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-report.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms`
Expected: 0 errors. **Do not commit.**

---

### Task 10: 4 media guards

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-media.service.ts`
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts`

**Interfaces:**
- Produces: a private `assertMediaAllowed(roomId, flag, label)` helper used by the beauty, camera-switch, screen-share and recording entry points.

- [ ] **Step 1: Write the failing test**

```ts
describe('VR-17 media policy gates', () => {
  const cases: Array<[string, string, string]> = [
    ['allowBeauty', 'applyBeauty', 'Beauty filters are disabled in this room.'],
    ['allowCameraSwitch', 'switchCamera', 'Camera switching is disabled in this room.'],
    ['allowScreenShare', 'startScreenShare', 'Screen sharing is disabled in this room.'],
    ['allowRecording', 'startRecording', 'Recording is disabled in this room.'],
  ];

  it.each(cases)('refuses %s when disabled', async (flag, method) => {
    rooms.getSettings.mockResolvedValue({ [flag]: false });
    await expect(
      (service as never as Record<string, Function>)[method](
        { id: 'user-1', roles: [] }, 'room-1', {},
      ),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_ROOM_FORBIDDEN' });
  });

  it.each(cases)('permits %s when enabled', async (flag, method) => {
    rooms.getSettings.mockResolvedValue({ [flag]: true });
    await expect(
      (service as never as Record<string, Function>)[method](
        { id: 'user-1', roles: [] }, 'room-1', {},
      ),
    ).resolves.toBeDefined();
  });
});
```

> Replace the four method names with the actual entry points in `video-room-media.service.ts` (find them via the `@Post(':id/media/beauty' | 'camera/switch' | ...)` handlers in `video-rooms-media.controller.ts`). If screen-share or recording has no service method yet, guard only the ones that exist and note the omission in the task report — do **not** invent an endpoint.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts -t "media policy gates"`
Expected: FAIL — resolves instead of throwing.

- [ ] **Step 3: Write minimal implementation**

Add the helper:

```ts
  /**
   * VR-17 room-policy gate for media capabilities. These flags were write-only
   * columns until this phase; without this check the corresponding settings
   * toggles would be placeholders.
   */
  private async assertMediaAllowed(
    roomId: string,
    flag: 'allowBeauty' | 'allowCameraSwitch' | 'allowScreenShare' | 'allowRecording',
    message: string,
  ): Promise<void> {
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings[flag]) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_FORBIDDEN, message, HttpStatus.FORBIDDEN);
    }
  }
```

Call it as the first line of each entry point, e.g.:

```ts
    await this.assertMediaAllowed(roomId, 'allowBeauty', 'Beauty filters are disabled in this room.');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts`
Expected: PASS, existing media tests still green.

- [ ] **Step 5: Verification gate (NO COMMIT) — BACKEND COMPLETE**

Run: `npx tsc --noEmit && npx eslint src --max-warnings 0 && npx jest`
Expected: 0 tsc errors, 0 lint, **full suite green with no regressions against the pre-phase baseline**. Record the pass/fail counts in the task report. **Do not commit.**

---

# PHASE D — Mobile domain layer

*(All remaining tasks run in `/Users/lt611-18/soulzaa-mobile`.)*

### Task 11: `VideoRoomSettings` model

**Files:**
- Create: `lib/features/video_room/domain/models/video_room_settings.dart`
- Test: `test/features/video_room/video_room_settings_test.dart`

**Interfaces:**
- Produces: `class VideoRoomSettings` with the 21 `VideoRoomSettingsView` fields, `fromJson`, `toJson`, `copyWith`, and `static const defaults`.

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_settings.dart';

void main() {
  group('VideoRoomSettings', () {
    test('parses the real VideoRoomSettingsView payload', () {
      final json = <String, dynamic>{
        'allowChat': false,
        'allowViewerChat': true,
        'slowModeSeconds': 30,
        'allowGifts': true,
        'allowTreasure': false,
        'allowPk': true,
        'allowBeauty': true,
        'allowCameraSwitch': false,
        'allowScreenShare': false,
        'allowRecording': false,
        'joinApprovalRequired': false,
        'allowJoinRequest': true,
        'allowShare': true,
        'allowInvite': false,
        'allowFollow': true,
        'allowReporting': true,
        'allowAnnouncements': true,
        'isRoomMuted': false,
        'maxDurationMinutes': null,
        'hostSeatCount': 8,
        'guestSeatCount': 0,
      };

      final settings = VideoRoomSettings.fromJson(json);
      expect(settings.allowChat, false);
      expect(settings.slowModeSeconds, 30);
      expect(settings.hostSeatCount, 8);
      expect(settings.maxDurationMinutes, isNull);
      expect(settings.allowInvite, false);
    });

    test('tolerates a partial payload and unknown keys', () {
      final settings = VideoRoomSettings.fromJson(
        <String, dynamic>{'allowGifts': false, 'somethingNew': 42},
      );
      expect(settings.allowGifts, false);
      expect(settings.allowChat, true); // default preserved
    });

    test('totalSeats derives from hostSeatCount plus the owner seat', () {
      const settings = VideoRoomSettings(hostSeatCount: 8);
      expect(settings.totalSeats, 9);
    });

    test('copyWith replaces only the named field', () {
      const settings = VideoRoomSettings();
      final next = settings.copyWith(allowPk: false);
      expect(next.allowPk, false);
      expect(next.allowGifts, settings.allowGifts);
    });

    test('setBool writes a field by its wire name', () {
      const settings = VideoRoomSettings();
      expect(settings.setBool('allowGifts', false).allowGifts, false);
      expect(settings.setBool('allowPk', false).allowPk, false);
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_settings_test.dart`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `lib/features/video_room/domain/models/video_room_settings.dart`:

```dart
/// Client mirror of the backend `VideoRoomSettingsView` (VR-17).
///
/// Field names match the wire format exactly so `setBool` can address a field
/// by the same key the PATCH body uses — that is what lets one generic toggle
/// tile drive any boolean setting without a per-field switch statement.
///
/// NOTE: only a subset is writable via `PATCH :id/settings`; `hostSeatCount` /
/// `guestSeatCount` are written by `POST :id/seats/layout`, and the deferred
/// fields are read-only here until the backend enforces them.
class VideoRoomSettings {
  const VideoRoomSettings({
    this.allowChat = true,
    this.allowViewerChat = true,
    this.slowModeSeconds = 0,
    this.allowGifts = true,
    this.allowTreasure = true,
    this.allowPk = true,
    this.allowBeauty = true,
    this.allowCameraSwitch = true,
    this.allowScreenShare = false,
    this.allowRecording = false,
    this.joinApprovalRequired = false,
    this.allowJoinRequest = true,
    this.allowShare = true,
    this.allowInvite = true,
    this.allowFollow = true,
    this.allowReporting = true,
    this.allowAnnouncements = true,
    this.isRoomMuted = false,
    this.maxDurationMinutes,
    this.hostSeatCount = 8,
    this.guestSeatCount = 0,
  });

  final bool allowChat;
  final bool allowViewerChat;
  final int slowModeSeconds;
  final bool allowGifts;
  final bool allowTreasure;
  final bool allowPk;
  final bool allowBeauty;
  final bool allowCameraSwitch;
  final bool allowScreenShare;
  final bool allowRecording;
  final bool joinApprovalRequired;
  final bool allowJoinRequest;
  final bool allowShare;
  final bool allowInvite;
  final bool allowFollow;
  final bool allowReporting;
  final bool allowAnnouncements;
  final bool isRoomMuted;
  final int? maxDurationMinutes;
  final int hostSeatCount;
  final int guestSeatCount;

  /// Seat index 0 is the owner, so the stage is `1 + host + guest`.
  int get totalSeats => 1 + hostSeatCount + guestSeatCount;

  static bool _b(Map<String, dynamic> j, String k, bool fallback) =>
      j[k] is bool ? j[k] as bool : fallback;

  static int _i(Map<String, dynamic> j, String k, int fallback) =>
      j[k] is int ? j[k] as int : fallback;

  factory VideoRoomSettings.fromJson(Map<String, dynamic> json) {
    return VideoRoomSettings(
      allowChat: _b(json, 'allowChat', true),
      allowViewerChat: _b(json, 'allowViewerChat', true),
      slowModeSeconds: _i(json, 'slowModeSeconds', 0),
      allowGifts: _b(json, 'allowGifts', true),
      allowTreasure: _b(json, 'allowTreasure', true),
      allowPk: _b(json, 'allowPk', true),
      allowBeauty: _b(json, 'allowBeauty', true),
      allowCameraSwitch: _b(json, 'allowCameraSwitch', true),
      allowScreenShare: _b(json, 'allowScreenShare', false),
      allowRecording: _b(json, 'allowRecording', false),
      joinApprovalRequired: _b(json, 'joinApprovalRequired', false),
      allowJoinRequest: _b(json, 'allowJoinRequest', true),
      allowShare: _b(json, 'allowShare', true),
      allowInvite: _b(json, 'allowInvite', true),
      allowFollow: _b(json, 'allowFollow', true),
      allowReporting: _b(json, 'allowReporting', true),
      allowAnnouncements: _b(json, 'allowAnnouncements', true),
      isRoomMuted: _b(json, 'isRoomMuted', false),
      maxDurationMinutes: json['maxDurationMinutes'] is int
          ? json['maxDurationMinutes'] as int
          : null,
      hostSeatCount: _i(json, 'hostSeatCount', 8),
      guestSeatCount: _i(json, 'guestSeatCount', 0),
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'allowChat': allowChat,
        'allowViewerChat': allowViewerChat,
        'slowModeSeconds': slowModeSeconds,
        'allowGifts': allowGifts,
        'allowTreasure': allowTreasure,
        'allowPk': allowPk,
        'allowBeauty': allowBeauty,
        'allowCameraSwitch': allowCameraSwitch,
        'allowScreenShare': allowScreenShare,
        'allowRecording': allowRecording,
        'joinApprovalRequired': joinApprovalRequired,
        'allowJoinRequest': allowJoinRequest,
        'allowShare': allowShare,
        'allowInvite': allowInvite,
        'allowFollow': allowFollow,
        'allowReporting': allowReporting,
        'allowAnnouncements': allowAnnouncements,
        'isRoomMuted': isRoomMuted,
        'maxDurationMinutes': maxDurationMinutes,
        'hostSeatCount': hostSeatCount,
        'guestSeatCount': guestSeatCount,
      };

  /// Read a boolean field by its wire key. Returns null for a non-boolean key.
  bool? readBool(String field) {
    final value = toJson()[field];
    return value is bool ? value : null;
  }

  /// Return a copy with one boolean field replaced, addressed by wire key.
  /// Unknown keys return `this` unchanged.
  VideoRoomSettings setBool(String field, bool value) {
    final map = toJson();
    if (map[field] is! bool) return this;
    map[field] = value;
    return VideoRoomSettings.fromJson(map);
  }

  VideoRoomSettings copyWith({
    bool? allowChat,
    bool? allowViewerChat,
    int? slowModeSeconds,
    bool? allowGifts,
    bool? allowTreasure,
    bool? allowPk,
    bool? allowBeauty,
    bool? allowCameraSwitch,
    bool? allowScreenShare,
    bool? allowRecording,
    bool? joinApprovalRequired,
    bool? allowJoinRequest,
    bool? allowShare,
    bool? allowInvite,
    bool? allowFollow,
    bool? allowReporting,
    bool? allowAnnouncements,
    bool? isRoomMuted,
    int? maxDurationMinutes,
    int? hostSeatCount,
    int? guestSeatCount,
  }) {
    return VideoRoomSettings(
      allowChat: allowChat ?? this.allowChat,
      allowViewerChat: allowViewerChat ?? this.allowViewerChat,
      slowModeSeconds: slowModeSeconds ?? this.slowModeSeconds,
      allowGifts: allowGifts ?? this.allowGifts,
      allowTreasure: allowTreasure ?? this.allowTreasure,
      allowPk: allowPk ?? this.allowPk,
      allowBeauty: allowBeauty ?? this.allowBeauty,
      allowCameraSwitch: allowCameraSwitch ?? this.allowCameraSwitch,
      allowScreenShare: allowScreenShare ?? this.allowScreenShare,
      allowRecording: allowRecording ?? this.allowRecording,
      joinApprovalRequired: joinApprovalRequired ?? this.joinApprovalRequired,
      allowJoinRequest: allowJoinRequest ?? this.allowJoinRequest,
      allowShare: allowShare ?? this.allowShare,
      allowInvite: allowInvite ?? this.allowInvite,
      allowFollow: allowFollow ?? this.allowFollow,
      allowReporting: allowReporting ?? this.allowReporting,
      allowAnnouncements: allowAnnouncements ?? this.allowAnnouncements,
      isRoomMuted: isRoomMuted ?? this.isRoomMuted,
      maxDurationMinutes: maxDurationMinutes ?? this.maxDurationMinutes,
      hostSeatCount: hostSeatCount ?? this.hostSeatCount,
      guestSeatCount: guestSeatCount ?? this.guestSeatCount,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/video_room_settings_test.dart`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room`
Expected: No issues found. **Do not commit.**

---

### Task 12: `VideoRoomPermission` enum and role

**Files:**
- Create: `lib/features/video_room/domain/models/video_room_permission.dart`
- Test: `test/features/video_room/video_room_permission_test.dart`

**Interfaces:**
- Produces: `enum VideoRoomPermission` (18 values matching the server), `enum VideoRoomRole`, `class VideoRoomPermissions` wrapping `Set<VideoRoomPermission>` with `has()`, `hasAny()`, `fromJson()`.

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_permission.dart';

void main() {
  group('VideoRoomPermissions', () {
    test('parses the GET :id/me/permissions payload', () {
      final perms = VideoRoomPermissions.fromJson(<String, dynamic>{
        'role': 'ADMIN',
        'permissions': <String>['MANAGE_SEATS', 'KICK_USERS', 'START_PK'],
      });
      expect(perms.role, VideoRoomRole.admin);
      expect(perms.has(VideoRoomPermission.manageSeats), true);
      expect(perms.has(VideoRoomPermission.manageRoom), false);
    });

    test('ignores permission strings it does not recognise', () {
      final perms = VideoRoomPermissions.fromJson(<String, dynamic>{
        'role': 'ADMIN',
        'permissions': <String>['MANAGE_SEATS', 'SOMETHING_NEW'],
      });
      expect(perms.has(VideoRoomPermission.manageSeats), true);
      expect(perms.all.length, 1);
    });

    test('hasAny drives union-rule section visibility', () {
      final moderator = VideoRoomPermissions.fromJson(<String, dynamic>{
        'role': 'MODERATOR',
        'permissions': <String>['ROOM_MUTE', 'KICK_USERS'],
      });
      // Audience Permissions is visible to a moderator via ROOM_MUTE alone,
      // even though they lack MANAGE_PARTICIPANTS.
      expect(
        moderator.hasAny(<VideoRoomPermission>[
          VideoRoomPermission.roomMute,
          VideoRoomPermission.manageParticipants,
        ]),
        true,
      );
      expect(moderator.has(VideoRoomPermission.manageParticipants), false);
    });

    test('an unknown role degrades to viewer with no permissions', () {
      final perms = VideoRoomPermissions.fromJson(<String, dynamic>{});
      expect(perms.role, VideoRoomRole.viewer);
      expect(perms.all, isEmpty);
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_permission_test.dart`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```dart
/// Client mirror of the server's video-room permission matrix (VR-17).
///
/// The server is the sole authority; this exists ONLY to shape the UI. Never
/// treat a client-side `has()` as a security boundary — every action is
/// re-checked server-side, and a 403 triggers a permissions refetch.
enum VideoRoomPermission {
  manageRoom('MANAGE_ROOM'),
  manageSeats('MANAGE_SEATS'),
  manageParticipants('MANAGE_PARTICIPANTS'),
  kickUsers('KICK_USERS'),
  blockUsers('BLOCK_USERS'),
  muteUsers('MUTE_USERS'),
  roomMute('ROOM_MUTE'),
  pinMessages('PIN_MESSAGES'),
  grantRoles('GRANT_ROLES'),
  changeTheme('CHANGE_THEME'),
  lockRoom('LOCK_ROOM'),
  manageAnnouncements('MANAGE_ANNOUNCEMENTS'),
  startPk('START_PK'),
  manageTreasure('MANAGE_TREASURE'),
  viewAnalytics('VIEW_ANALYTICS'),
  inviteUsers('INVITE_USERS'),
  transferOwnership('TRANSFER_OWNERSHIP'),
  closeRoom('CLOSE_ROOM');

  const VideoRoomPermission(this.wire);
  final String wire;

  static VideoRoomPermission? tryParse(String value) {
    for (final p in VideoRoomPermission.values) {
      if (p.wire == value) return p;
    }
    return null;
  }
}

enum VideoRoomRole {
  owner('OWNER'),
  admin('ADMIN'),
  moderator('MODERATOR'),
  host('HOST'),
  participant('PARTICIPANT'),
  viewer('VIEWER');

  const VideoRoomRole(this.wire);
  final String wire;

  static VideoRoomRole parse(Object? value) {
    for (final r in VideoRoomRole.values) {
      if (r.wire == value) return r;
    }
    return VideoRoomRole.viewer;
  }
}

/// The current user's effective role and permission set inside one room.
class VideoRoomPermissions {
  const VideoRoomPermissions({
    this.role = VideoRoomRole.viewer,
    this.all = const <VideoRoomPermission>{},
  });

  final VideoRoomRole role;
  final Set<VideoRoomPermission> all;

  bool has(VideoRoomPermission permission) => all.contains(permission);

  /// True when ANY of [permissions] is held. This is the union rule that drives
  /// hub section visibility: a Moderator holds ROOM_MUTE but not
  /// MANAGE_PARTICIPANTS, and must still see the Audience Permissions section.
  bool hasAny(List<VideoRoomPermission> permissions) =>
      permissions.any(all.contains);

  bool get isOwner => role == VideoRoomRole.owner;

  factory VideoRoomPermissions.fromJson(Map<String, dynamic> json) {
    final raw = json['permissions'];
    final parsed = <VideoRoomPermission>{};
    if (raw is List) {
      for (final item in raw) {
        final p = VideoRoomPermission.tryParse(item.toString());
        if (p != null) parsed.add(p);
      }
    }
    return VideoRoomPermissions(
      role: VideoRoomRole.parse(json['role']),
      all: parsed,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/video_room_permission_test.dart`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room`
Expected: No issues found. **Do not commit.**

---

### Task 13: Remove the client-side fiction from `video_room_models.dart`

**Files:**
- Modify: `lib/features/video_room/domain/models/video_room_models.dart`
- Modify: `test/features/video_room/video_room_models_test.dart`

**Interfaces:**
- Produces: `VideoRoomSettings` (the old fictional class) **deleted** from this file — the real one from Task 11 replaces it. `VideoRoom.settings` retyped to the new `VideoRoomSettings`. `UpdateVideoRoomInput` reduced to fields `PATCH :id` actually accepts, with a `toJson()` that drops nothing it claims to send.

- [ ] **Step 1: Write the failing test**

Replace the `VideoRoomSettings.fromJson and copyWith default values` test in `video_room_models_test.dart` with:

```dart
    test('UpdateVideoRoomInput sends every field it declares', () {
      const input = UpdateVideoRoomInput(
        name: 'New name',
        description: 'New description',
        categoryId: 'cat-1',
        language: 'English',
        maxParticipants: 12,
      );
      final json = input.toJson();
      expect(json['name'], 'New name');
      expect(json['description'], 'New description');
      expect(json['categoryId'], 'cat-1');
      expect(json['language'], 'English');
      expect(json['maxParticipants'], 12);
    });

    test('UpdateVideoRoomInput omits unset fields entirely', () {
      const input = UpdateVideoRoomInput(name: 'Only name');
      final json = input.toJson();
      expect(json.keys.toList(), <String>['name']);
    });

    test('VideoRoom no longer carries a client-side password', () {
      final room = VideoRoom.fromJson(<String, dynamic>{
        'id': 'vid_1',
        'name': 'Room',
        'settings': <String, dynamic>{'allowGifts': false},
      });
      expect(room.settings.allowGifts, false);
      expect(room.toJson().containsKey('password'), false);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_models_test.dart`
Expected: FAIL — `categoryId` is not a parameter of `UpdateVideoRoomInput`.

- [ ] **Step 3: Write minimal implementation**

In `video_room_models.dart`:

1. **Delete** the entire fictional `VideoRoomSettings` class (the one with `password`, `rules`, `ageRestriction`, `layoutMode`, `backgroundTheme`, `maxSeats`).
2. **Delete** `enum VideoLayoutMode` and the `_parseLayoutMode` helper.
3. Add at the top: `import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_settings.dart';` and re-export it so existing imports keep working: `export 'package:soulzaa_mobile/features/video_room/domain/models/video_room_settings.dart';`
4. Replace `UpdateVideoRoomInput` with:

```dart
/// Fields `PATCH /video-rooms/:id` actually accepts. Every declared field is
/// serialised — the previous version collected toggles the UI set and then
/// silently dropped them, which is why the old settings sheet did nothing.
class UpdateVideoRoomInput {
  const UpdateVideoRoomInput({
    this.name,
    this.description,
    this.imageKey,
    this.categoryId,
    this.language,
    this.visibility,
    this.tags,
    this.maxParticipants,
  });

  final String? name;
  final String? description;
  final String? imageKey;
  final String? categoryId;
  final String? language;
  final String? visibility;
  final List<String>? tags;
  final int? maxParticipants;

  Map<String, dynamic> toJson() => <String, dynamic>{
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (imageKey != null) 'imageKey': imageKey,
        if (categoryId != null) 'categoryId': categoryId,
        if (language != null) 'language': language,
        if (visibility != null) 'visibility': visibility,
        if (tags != null) 'tags': tags,
        if (maxParticipants != null) 'maxParticipants': maxParticipants,
      };
}
```

5. In `VideoRoom.toJson()`, remove any `password` key. In `CreateVideoRoomInput`, drop `backgroundTheme` and `ageRestriction` if they are only consumed by deleted code.

Fix every resulting compile error in `create_video_room_screen.dart`, `video_room_controller.dart` and `video_room_live_screen.dart` by removing references to the deleted fields. Do **not** add replacement UI here — Phase G rebuilds it.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/`
Expected: PASS, all video_room tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze`
Expected: No issues found across the whole app. **Do not commit.**

---

# PHASE E — Mobile data layer

### Task 14: Repository — settings, permissions, seat layout

**Files:**
- Modify: `lib/features/video_room/domain/repositories/video_room_repository.dart`
- Modify: `lib/features/video_room/data/repositories/video_room_repository_impl.dart`
- Test: `test/features/video_room/video_room_repository_test.dart`

**Interfaces:**
- Produces:
  - `Future<VideoRoomSettings> updateSettings(String roomId, Map<String, dynamic> patch)`
  - `Future<VideoRoomPermissions> getMyPermissions(String roomId)`
  - `Future<void> configureSeatLayout(String roomId, {required int hostSeatCount, int guestSeatCount = 0})`
  - `Future<List<Map<String, dynamic>>> getCategories()` / `getLanguages()`

- [ ] **Step 1: Write the failing test**

Create `test/features/video_room/video_room_repository_test.dart` using `dio` with a `DioAdapter`-style mock, or a hand-rolled fake matching the harness in `test/support/widget_harness.dart`:

```dart
    test('updateSettings PATCHes :id/settings and parses the response', () async {
      final captured = <String, dynamic>{};
      final repo = buildRepo(onPatch: (path, data) {
        captured['path'] = path;
        captured['data'] = data;
        return <String, dynamic>{'data': <String, dynamic>{'allowGifts': false}};
      });

      final settings = await repo.updateSettings('room-1', {'allowGifts': false});

      expect(captured['path'], '/video-rooms/room-1/settings');
      expect(captured['data'], <String, dynamic>{'allowGifts': false});
      expect(settings.allowGifts, false);
    });

    test('getMyPermissions reads the server matrix', () async {
      final repo = buildRepo(onGet: (path) => <String, dynamic>{
            'data': <String, dynamic>{
              'role': 'ADMIN',
              'permissions': <String>['MANAGE_SEATS'],
            },
          });
      final perms = await repo.getMyPermissions('room-1');
      expect(perms.role, VideoRoomRole.admin);
      expect(perms.has(VideoRoomPermission.manageSeats), true);
    });

    test('configureSeatLayout posts host/guest counts', () async {
      final captured = <String, dynamic>{};
      final repo = buildRepo(onPost: (path, data) {
        captured['path'] = path;
        captured['data'] = data;
        return <String, dynamic>{'data': <String, dynamic>{}};
      });
      await repo.configureSeatLayout('room-1', hostSeatCount: 8);
      expect(captured['path'], '/video-rooms/room-1/seats/layout');
      expect(captured['data'], <String, dynamic>{'hostSeatCount': 8, 'guestSeatCount': 0});
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_repository_test.dart`
Expected: FAIL — `updateSettings` is not defined.

- [ ] **Step 3: Write minimal implementation**

Add to the abstract repository, then implement:

```dart
  @override
  Future<VideoRoomSettings> updateSettings(
    String roomId,
    Map<String, dynamic> patch,
  ) async {
    final response = await _dio.patch<Map<String, dynamic>>(
      '/video-rooms/$roomId/settings',
      data: patch,
    );
    final data = response.data?['data'] ?? response.data ?? <String, dynamic>{};
    return VideoRoomSettings.fromJson(data as Map<String, dynamic>);
  }

  @override
  Future<VideoRoomPermissions> getMyPermissions(String roomId) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/video-rooms/$roomId/me/permissions',
    );
    final data = response.data?['data'] ?? response.data ?? <String, dynamic>{};
    return VideoRoomPermissions.fromJson(data as Map<String, dynamic>);
  }

  @override
  Future<void> configureSeatLayout(
    String roomId, {
    required int hostSeatCount,
    int guestSeatCount = 0,
  }) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/seats/layout',
      data: <String, dynamic>{
        'hostSeatCount': hostSeatCount,
        'guestSeatCount': guestSeatCount,
      },
    );
  }

  @override
  Future<List<Map<String, dynamic>>> getCategories() => _referenceList('/audio-rooms/categories');

  @override
  Future<List<Map<String, dynamic>>> getLanguages() => _referenceList('/audio-rooms/languages');

  /// Shared platform reference data (`room_categories` / `room_languages`).
  /// Video rooms already reference these by value; reading the audio-rooms
  /// public routes is reuse, NOT an audio-room change.
  Future<List<Map<String, dynamic>>> _referenceList(String path) async {
    final response = await _dio.get<Map<String, dynamic>>(path);
    final data = response.data?['data'];
    if (data is List) {
      return data.whereType<Map<String, dynamic>>().toList();
    }
    return <Map<String, dynamic>>[];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/video_room_repository_test.dart`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room && flutter test test/features/video_room/`
Expected: No issues, all tests pass. **Do not commit.**

---

### Task 15: Fix the 6 broken repository URLs

**Files:**
- Modify: `lib/features/video_room/data/repositories/video_room_repository_impl.dart:204-231`
- Modify: `lib/features/video_room/domain/repositories/video_room_repository.dart`
- Modify: `lib/features/video_room/presentation/providers/video_room_controller.dart:373,399,421,428,433,438`
- Test: `test/features/video_room/video_room_repository_test.dart`

**Interfaces:**
- Produces corrected signatures:
  - `requestSeat(String roomId, {int? seatIndex})` → `POST :id/seats/request`
  - `leaveSeat(String roomId)` → `POST :id/viewer/demote` (self)
  - `muteUser(String roomId, String targetUserId, bool mute)` → `POST :id/moderation/mute` / `unmute`
  - `lockSeat(String roomId, int seatIndex, bool lock)` → `POST :id/seats/lock` / `unlock`
  - `kickUser(String roomId, String targetUserId)` → `POST :id/moderation/kick`
  - `banUser(String roomId, String targetUserId)` → `POST :id/moderation/blacklist`
  - `unbanUser(String roomId, String targetUserId)` → `DELETE :id/moderation/blacklist/:userId`

> **Blast radius is verified and contained:** all callers live in `features/video_room/`. Audio Room uses a different repository (`audio_room/in_room/data/repositories/seat_actions_repository_impl.dart`) on the `/rooms/...` prefix and must NOT be touched.

- [ ] **Step 1: Write the failing test**

```dart
    test('seat and moderation calls use the real backend routes', () async {
      final paths = <String>[];
      final repo = buildRepo(onPost: (path, data) {
        paths.add(path);
        return <String, dynamic>{'data': <String, dynamic>{}};
      });

      await repo.requestSeat('r1', seatIndex: 3);
      await repo.lockSeat('r1', 3, true);
      await repo.lockSeat('r1', 3, false);
      await repo.kickUser('r1', 'u2');
      await repo.banUser('r1', 'u2');
      await repo.muteUser('r1', 'u2', true);

      expect(paths, <String>[
        '/video-rooms/r1/seats/request',
        '/video-rooms/r1/seats/lock',
        '/video-rooms/r1/seats/unlock',
        '/video-rooms/r1/moderation/kick',
        '/video-rooms/r1/moderation/blacklist',
        '/video-rooms/r1/moderation/mute',
      ]);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_repository_test.dart -n "real backend routes"`
Expected: FAIL — paths contain `/video-rooms/r1/seats/3/request` etc.

- [ ] **Step 3: Write minimal implementation**

Replace lines 204-231 of `video_room_repository_impl.dart`:

```dart
  @override
  Future<void> requestSeat(String roomId, {int? seatIndex}) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/seats/request',
      data: <String, dynamic>{if (seatIndex != null) 'seatIndex': seatIndex},
    );
  }

  /// Leaving the stage is "return to the audience" server-side.
  @override
  Future<void> leaveSeat(String roomId) async {
    await _dio.post<dynamic>('/video-rooms/$roomId/viewer/demote', data: <String, dynamic>{});
  }

  @override
  Future<void> lockSeat(String roomId, int seatIndex, bool lock) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/seats/${lock ? 'lock' : 'unlock'}',
      data: <String, dynamic>{'seatIndex': seatIndex},
    );
  }

  @override
  Future<void> muteUser(String roomId, String targetUserId, bool mute) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/moderation/${mute ? 'mute' : 'unmute'}',
      data: <String, dynamic>{'targetUserId': targetUserId},
    );
  }

  @override
  Future<void> kickUser(String roomId, String targetUserId) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/moderation/kick',
      data: <String, dynamic>{'targetUserId': targetUserId},
    );
  }

  @override
  Future<void> banUser(String roomId, String targetUserId) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/moderation/blacklist',
      data: <String, dynamic>{'targetUserId': targetUserId},
    );
  }

  @override
  Future<void> unbanUser(String roomId, String targetUserId) async {
    await _dio.delete<dynamic>('/video-rooms/$roomId/moderation/blacklist/$targetUserId');
  }
```

Update the abstract repository signatures to match, then fix the 6 call sites in `video_room_controller.dart` (`muteSeat` becomes `muteUser` taking the seat's `userId`; `leaveSeat` drops its index argument) and the 5 call sites in `video_room_live_screen.dart`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze`
Expected: No issues found. Report in the task summary that the live screen's seat-action sheet (Request Seat / Leave / Mute / Kick) was **broken in production before this task** and is now repaired. **Do not commit.**

---

### Task 16: Socket subscriptions for settings, roles and moderation

**Files:**
- Modify: `lib/features/video_room/data/sources/video_room_socket_service.dart:141-167`
- Test: `test/features/video_room/video_room_socket_events_test.dart`

**Interfaces:**
- Produces: `VideoRoomSocketService.events` additionally emits `video_room.settings_updated`, `video_room.role_assigned`, `video_room.role_removed`, `video_room.role_updated`, `video_room.seat_updated` (already present), and the camelCase moderation events `userKicked`, `userBlacklisted`, `userUnblacklisted`, `userMuted`, `userUnmuted`, `roomModerationUpdated`.

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/data/sources/video_room_socket_service.dart';

void main() {
  test('subscribes to the VR-17 settings, role and moderation events', () {
    // videoRoomSocketEventNames is the extracted constant list the service uses.
    expect(videoRoomSocketEventNames, contains('video_room.settings_updated'));
    expect(videoRoomSocketEventNames, contains('video_room.role_assigned'));
    expect(videoRoomSocketEventNames, contains('video_room.role_removed'));
    expect(videoRoomSocketEventNames, contains('video_room.role_updated'));
    // Moderation events use camelCase names, NOT the dotted domain convention.
    expect(videoRoomSocketEventNames, contains('userKicked'));
    expect(videoRoomSocketEventNames, contains('userBlacklisted'));
    expect(videoRoomSocketEventNames, contains('userMuted'));
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_socket_events_test.dart`
Expected: FAIL — `videoRoomSocketEventNames` is undefined.

- [ ] **Step 3: Write minimal implementation**

Extract the inline list in `_listenEvents()` to a top-level constant and extend it:

```dart
/// Every socket event the video-room feature listens for.
///
/// Two vocabularies coexist on purpose and must both be present:
///  - dotted `video_room.*` — the domain fan-out (VIDEO_ROOM_SOCKET_EVENTS)
///  - camelCase — the moderation surface's own names
///    (VIDEO_ROOM_MODERATION_SOCKET_EVENTS). Assuming the dotted convention
///    here is why moderation realtime looks dead.
const List<String> videoRoomSocketEventNames = <String>[
  // Generic join/leave/chat/end fan-out.
  'video_room:member_joined',
  'room:member_joined',
  'video_room:member_left',
  'room:member_left',
  'chat:message',
  'video_room:chat_message',
  'room_ended',
  'room:closed',
  'video_room:closed',
  // Domain fan-out.
  'video_room.user_joined',
  'video_room.user_left',
  'video_room.viewer_connected',
  'video_room.viewer_disconnected',
  'video_room.state_sync',
  'video_room.updated',
  'video_room.closed',
  'video_room.deleted',
  'video_room.seat_updated',
  'video_room.seat_sync',
  'video_room.camera_on',
  'video_room.camera_off',
  'video_room.chat_message_sent',
  'video_room.room_analytics_updated',
  // ---- VR-17 ----
  'video_room.settings_updated',
  'video_room.role_assigned',
  'video_room.role_removed',
  'video_room.role_updated',
  'video_room.chat_mode_changed',
  // Moderation (camelCase — see the doc comment above).
  'userKicked',
  'userBlacklisted',
  'userUnblacklisted',
  'userMuted',
  'userUnmuted',
  'userWarned',
  'roomModerationUpdated',
];
```

Replace the local `eventsToListen` with `videoRoomSocketEventNames`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/video_room_socket_events_test.dart`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room && flutter test test/features/video_room/`
Expected: No issues, all tests pass. **Do not commit.**

---

# PHASE F — Mobile state

### Task 17: `VideoRoomState` carries settings and permissions

**Files:**
- Modify: `lib/features/video_room/presentation/providers/video_room_state.dart`
- Test: `test/features/video_room/video_room_controller_test.dart`

**Interfaces:**
- Produces: `VideoRoomState.settings` (`VideoRoomSettings`), `VideoRoomState.permissions` (`VideoRoomPermissions`), `VideoRoomState.pendingSettings` (`Set<String>` of in-flight wire keys), all threaded through `copyWith`.

- [ ] **Step 1: Write the failing test**

```dart
    test('state exposes settings, permissions and pending fields', () {
      const state = VideoRoomState();
      expect(state.settings.allowChat, true);
      expect(state.permissions.role, VideoRoomRole.viewer);
      expect(state.pendingSettings, isEmpty);

      final next = state.copyWith(
        settings: const VideoRoomSettings(allowGifts: false),
        pendingSettings: <String>{'allowGifts'},
      );
      expect(next.settings.allowGifts, false);
      expect(next.pendingSettings.contains('allowGifts'), true);
      expect(next.settings.allowChat, true);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_controller_test.dart -n "pending fields"`
Expected: FAIL — `settings` is not defined for `VideoRoomState`.

- [ ] **Step 3: Write minimal implementation**

Add the imports, three fields with defaults `const VideoRoomSettings()`, `const VideoRoomPermissions()`, `const <String>{}`, and the matching `copyWith` parameters following the file's existing style.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room`
Expected: No issues found. **Do not commit.**

---

### Task 18: `VideoRoomSettingsController` — hybrid apply with rollback

**Files:**
- Create: `lib/features/video_room/presentation/providers/video_room_settings_controller.dart`
- Test: `test/features/video_room/video_room_settings_controller_test.dart`

**Interfaces:**
- Consumes: `VideoRoomRepository.updateSettings / getMyPermissions / configureSeatLayout` (Task 14); `VideoRoomSettings` (Task 11); `VideoRoomPermissions` (Task 12).
- Produces: `abstract class VideoRoomSettingsApi` with `updateSettings`, `configureSeatLayout`, `getMyPermissions`; and `class VideoRoomSettingsController extends ChangeNotifier` with
  - `VideoRoomSettings get settings` · `VideoRoomPermissions get permissions` · `Set<String> get pending` · `Object? get lastError` · `bool isPending(String field)`
  - `Future<void> setFlag(String field, bool value)` — optimistic + rollback
  - `Future<void> setSlowMode(int seconds)`
  - `Future<void> setSeatLayout(int totalSeats)`
  - `void applyServerSnapshot(Map<String, dynamic> payload)` — **synchronous**, socket reconcile
  - `Future<void> refreshPermissions()`
  - `void handleSocketEvent(String event, Map<String, dynamic> payload)`
  - `void clearError()`

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_settings.dart';
import 'package:soulzaa_mobile/features/video_room/presentation/providers/video_room_settings_controller.dart';

class _FakeRepo implements VideoRoomSettingsApi {
  _FakeRepo({this.shouldFail = false});
  bool shouldFail;
  final List<Map<String, dynamic>> patches = <Map<String, dynamic>>[];

  @override
  Future<VideoRoomSettings> updateSettings(String roomId, Map<String, dynamic> patch) async {
    patches.add(patch);
    if (shouldFail) throw Exception('403');
    return VideoRoomSettings.fromJson(patch);
  }

  @override
  Future<void> configureSeatLayout(String roomId,
      {required int hostSeatCount, int guestSeatCount = 0}) async {}
}

void main() {
  group('VideoRoomSettingsController', () {
    test('applies a toggle optimistically before the request resolves', () async {
      final repo = _FakeRepo();
      final controller = VideoRoomSettingsController(repo, 'room-1',
          initial: const VideoRoomSettings());

      final future = controller.setFlag('allowGifts', false);
      // Optimistic: visible immediately, marked pending.
      expect(controller.settings.allowGifts, false);
      expect(controller.pending.contains('allowGifts'), true);

      await future;
      expect(controller.pending.contains('allowGifts'), false);
      expect(repo.patches.single, <String, dynamic>{'allowGifts': false});
    });

    test('rolls back to the prior value when the request fails', () async {
      final repo = _FakeRepo(shouldFail: true);
      final controller = VideoRoomSettingsController(repo, 'room-1',
          initial: const VideoRoomSettings());

      await controller.setFlag('allowGifts', false);

      expect(controller.settings.allowGifts, true, reason: 'must revert');
      expect(controller.pending, isEmpty);
      expect(controller.lastError, isNotNull);
    });

    test('a server snapshot replaces settings wholesale', () async {
      final controller = VideoRoomSettingsController(_FakeRepo(), 'room-1',
          initial: const VideoRoomSettings(allowGifts: true, allowPk: true));

      controller.applyServerSnapshot(<String, dynamic>{
        'settings': <String, dynamic>{'allowGifts': false, 'allowPk': false},
      });

      expect(controller.settings.allowGifts, false);
      expect(controller.settings.allowPk, false);
    });

    test('a snapshot for a field still in flight does not clobber the optimistic value', () async {
      final repo = _FakeRepo();
      final controller = VideoRoomSettingsController(repo, 'room-1',
          initial: const VideoRoomSettings());

      final future = controller.setFlag('allowGifts', false);
      // A stale broadcast arrives mid-flight carrying the OLD value.
      controller.applyServerSnapshot(<String, dynamic>{
        'settings': <String, dynamic>{'allowGifts': true},
      });
      expect(controller.settings.allowGifts, false, reason: 'in-flight field wins');

      await future;
    });

    test('setSeatLayout converts a total-seat choice to hostSeatCount', () async {
      final repo = _FakeRepo();
      final controller = VideoRoomSettingsController(repo, 'room-1',
          initial: const VideoRoomSettings());
      await controller.setSeatLayout(12);
      expect(controller.settings.hostSeatCount, 11);
    });

    test('a 403 refetches permissions so a demoted user loses the UI', () async {
      final repo = _FakeRepo(shouldFail: true, failStatus: 403);
      final controller = VideoRoomSettingsController(repo, 'room-1',
          initial: const VideoRoomSettings());

      await controller.setFlag('allowGifts', false);

      expect(repo.permissionFetches, 1, reason: '403 must trigger a refetch');
      expect(controller.settings.allowGifts, true, reason: 'still rolls back');
    });

    test('a non-403 failure rolls back WITHOUT refetching permissions', () async {
      final repo = _FakeRepo(shouldFail: true, failStatus: 500);
      final controller = VideoRoomSettingsController(repo, 'room-1',
          initial: const VideoRoomSettings());

      await controller.setFlag('allowGifts', false);

      expect(repo.permissionFetches, 0);
      expect(controller.settings.allowGifts, true);
    });

    test('a role event for me refetches permissions; one for someone else does not', () async {
      final repo = _FakeRepo();
      final controller = VideoRoomSettingsController(repo, 'room-1',
          currentUserId: 'me', initial: const VideoRoomSettings());

      controller.handleSocketEvent(
        'video_room.role_updated', <String, dynamic>{'userId': 'someone-else'},
      );
      expect(repo.permissionFetches, 0);

      controller.handleSocketEvent(
        'video_room.role_updated', <String, dynamic>{'userId': 'me'},
      );
      await Future<void>.delayed(Duration.zero);
      expect(repo.permissionFetches, 1);
    });

    test('a settings_updated event routes to applyServerSnapshot', () async {
      final controller = VideoRoomSettingsController(_FakeRepo(), 'room-1',
          initial: const VideoRoomSettings(allowPk: true));

      controller.handleSocketEvent('video_room.settings_updated', <String, dynamic>{
        'settings': <String, dynamic>{'allowPk': false},
      });

      expect(controller.settings.allowPk, false);
    });
  });
}
```

Extend `_FakeRepo` to support these:

```dart
class _FakeRepo implements VideoRoomSettingsApi {
  _FakeRepo({this.shouldFail = false, this.failStatus = 500});
  bool shouldFail;
  int failStatus;
  int permissionFetches = 0;
  final List<Map<String, dynamic>> patches = <Map<String, dynamic>>[];

  @override
  Future<VideoRoomSettings> updateSettings(String roomId, Map<String, dynamic> patch) async {
    patches.add(patch);
    if (shouldFail) throw DioException(
      requestOptions: RequestOptions(path: '/'),
      response: Response<dynamic>(
        requestOptions: RequestOptions(path: '/'), statusCode: failStatus,
      ),
    );
    return VideoRoomSettings.fromJson(patch);
  }

  @override
  Future<void> configureSeatLayout(String roomId,
      {required int hostSeatCount, int guestSeatCount = 0}) async {}

  @override
  Future<VideoRoomPermissions> getMyPermissions(String roomId) async {
    permissionFetches++;
    return const VideoRoomPermissions();
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/video_room_settings_controller_test.dart`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```dart
import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_permission.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_settings.dart';

/// The repository surface this controller needs. Narrowed to keep the
/// controller testable without a Dio stack.
abstract class VideoRoomSettingsApi {
  Future<VideoRoomSettings> updateSettings(String roomId, Map<String, dynamic> patch);
  Future<void> configureSeatLayout(
    String roomId, {
    required int hostSeatCount,
    int guestSeatCount,
  });
  Future<VideoRoomPermissions> getMyPermissions(String roomId);
}

/// Socket events that mean "my role may have changed".
const Set<String> _kRoleEvents = <String>{
  'video_room.role_assigned',
  'video_room.role_removed',
  'video_room.role_updated',
};

/// Hybrid apply model (VR-17).
///
/// Booleans and slow-mode apply OPTIMISTICALLY and roll back on failure; text
/// and number fields are committed by their editor sheets, not here.
///
/// The server is the source of truth: every successful write is echoed back as
/// `video_room.settings_updated` carrying the FULL snapshot, and
/// [applyServerSnapshot] replaces state wholesale. The one exception is a field
/// still in flight — a broadcast triggered by someone else's earlier write can
/// arrive after we have optimistically moved that field, and honouring it would
/// make the user's switch visibly flip back. [_pending] guards exactly that.
class VideoRoomSettingsController extends ChangeNotifier {
  VideoRoomSettingsController(
    this._api,
    this._roomId, {
    this.currentUserId,
    VideoRoomSettings initial = const VideoRoomSettings(),
    VideoRoomPermissions permissions = const VideoRoomPermissions(),
  })  : _settings = initial,
        _permissions = permissions;

  final VideoRoomSettingsApi _api;
  final String _roomId;
  final String? currentUserId;

  VideoRoomSettings _settings;
  VideoRoomPermissions _permissions;
  final Set<String> _pending = <String>{};
  Object? _lastError;

  VideoRoomSettings get settings => _settings;
  VideoRoomPermissions get permissions => _permissions;
  Set<String> get pending => Set<String>.unmodifiable(_pending);
  Object? get lastError => _lastError;
  bool isPending(String field) => _pending.contains(field);

  /// Toggle one boolean setting. Optimistic, with rollback on failure.
  Future<void> setFlag(String field, bool value) async {
    final previous = _settings.readBool(field);
    if (previous == null || previous == value) return;

    _settings = _settings.setBool(field, value);
    _pending.add(field);
    _lastError = null;
    notifyListeners();

    try {
      await _api.updateSettings(_roomId, <String, dynamic>{field: value});
    } catch (error) {
      _settings = _settings.setBool(field, previous);
      _lastError = error;
      await _reconcileIfForbidden(error);
    } finally {
      _pending.remove(field);
      notifyListeners();
    }
  }

  /// A 403 means our cached permission set is stale — our role changed under us.
  /// Refetch so the UI stops offering controls the server will keep rejecting.
  /// Only 403: a 500 is a server fault, not an authorization change, and
  /// refetching on every error would hammer the endpoint during an outage.
  Future<void> _reconcileIfForbidden(Object error) async {
    if (error is! DioException || error.response?.statusCode != 403) return;
    await refreshPermissions();
  }

  Future<void> refreshPermissions() async {
    try {
      _permissions = await _api.getMyPermissions(_roomId);
      notifyListeners();
    } catch (_) {
      // Keep the last known set; the next action's 403 will retry.
    }
  }

  /// Route an inbound socket event. Called by the room controller's socket
  /// subscription so this controller owns all settings/permission reconciliation.
  void handleSocketEvent(String event, Map<String, dynamic> payload) {
    if (event == 'video_room.settings_updated') {
      applyServerSnapshot(payload);
      return;
    }
    if (_kRoleEvents.contains(event)) {
      // Only when it is OUR role: another user's grant changes nothing for us,
      // and refetching on every role event in a busy room is needless load.
      final target = payload['userId']?.toString();
      if (currentUserId != null && target == currentUserId) {
        unawaited(refreshPermissions());
      }
    }
  }

  Future<void> setSlowMode(int seconds) async {
    final previous = _settings.slowModeSeconds;
    if (previous == seconds) return;

    _settings = _settings.copyWith(slowModeSeconds: seconds);
    _pending.add('slowModeSeconds');
    _lastError = null;
    notifyListeners();

    try {
      await _api.updateSettings(_roomId, <String, dynamic>{'slowModeSeconds': seconds});
    } catch (error) {
      _settings = _settings.copyWith(slowModeSeconds: previous);
      _lastError = error;
    } finally {
      _pending.remove('slowModeSeconds');
      notifyListeners();
    }
  }

  /// Reshape the stage. [totalSeats] is the user-facing choice (4/6/8/9/12);
  /// seat index 0 is the owner, so hostSeatCount is one fewer.
  Future<void> setSeatLayout(int totalSeats) async {
    final hostSeatCount = totalSeats - 1;
    final previous = _settings.hostSeatCount;

    _settings = _settings.copyWith(hostSeatCount: hostSeatCount);
    _pending.add('hostSeatCount');
    _lastError = null;
    notifyListeners();

    try {
      await _api.configureSeatLayout(_roomId, hostSeatCount: hostSeatCount);
    } catch (error) {
      _settings = _settings.copyWith(hostSeatCount: previous);
      _lastError = error;
    } finally {
      _pending.remove('hostSeatCount');
      notifyListeners();
    }
  }

  /// Reconcile from a `video_room.settings_updated` broadcast. Wholesale
  /// replacement, except for fields we currently have in flight.
  void applyServerSnapshot(Map<String, dynamic> payload) {
    final raw = payload['settings'];
    if (raw is! Map) return;

    final incoming = VideoRoomSettings.fromJson(Map<String, dynamic>.from(raw));
    if (_pending.isEmpty) {
      _settings = incoming;
      notifyListeners();
      return;
    }

    // Keep our optimistic value for every in-flight field; take the server's
    // for everything else.
    final merged = incoming.toJson();
    final mine = _settings.toJson();
    for (final field in _pending) {
      merged[field] = mine[field];
    }
    _settings = VideoRoomSettings.fromJson(merged);
    notifyListeners();
  }

  void clearError() {
    _lastError = null;
    notifyListeners();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/video_room_settings_controller_test.dart`
Expected: PASS, 10 tests.

- [ ] **Step 4b: Wire the controller to the socket stream**

In `video_room_controller.dart`, inside the existing `VideoRoomSocketService.events` subscription, forward every event:

```dart
      _settingsController.handleSocketEvent(event.event, event.payload);
```

This is the only place settings/permission reconciliation is triggered, so there is exactly one path for it.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room && flutter test test/features/video_room/`
Expected: No issues, all tests pass. **Do not commit.**

---

# PHASE G — Mobile UI

## Shared test helpers (create once, in Task 19)

Tasks 20–24 all need the same two helpers. Put them in
`test/features/video_room/settings_test_support.dart` and import from each test
file, rather than redefining `_FakeRepo` per file (a private `_FakeRepo` in one
file is invisible to the others, and duplicating it lets the copies drift):

```dart
import 'package:dio/dio.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_permission.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_settings.dart';
import 'package:soulzaa_mobile/features/video_room/presentation/providers/video_room_settings_controller.dart';

VideoRoomPermissions permsFor(String role, List<String> permissions) =>
    VideoRoomPermissions.fromJson(<String, dynamic>{
      'role': role,
      'permissions': permissions,
    });

class FakeSettingsApi implements VideoRoomSettingsApi {
  FakeSettingsApi({this.shouldFail = false, this.failStatus = 500});
  bool shouldFail;
  int failStatus;
  int permissionFetches = 0;
  final List<Map<String, dynamic>> patches = <Map<String, dynamic>>[];
  final List<int> layouts = <int>[];

  @override
  Future<VideoRoomSettings> updateSettings(String roomId, Map<String, dynamic> patch) async {
    patches.add(patch);
    if (shouldFail) {
      throw DioException(
        requestOptions: RequestOptions(path: '/'),
        response: Response<dynamic>(
          requestOptions: RequestOptions(path: '/'), statusCode: failStatus,
        ),
      );
    }
    return VideoRoomSettings.fromJson(patch);
  }

  @override
  Future<void> configureSeatLayout(String roomId,
      {required int hostSeatCount, int guestSeatCount = 0}) async {
    layouts.add(hostSeatCount);
  }

  @override
  Future<VideoRoomPermissions> getMyPermissions(String roomId) async {
    permissionFetches++;
    return const VideoRoomPermissions();
  }
}
```

Task 18's own test file may keep its private `_FakeRepo`, or switch to this one —
either is fine, but Tasks 20–24 must use `FakeSettingsApi` and `permsFor` from here.

### Task 19: Shared settings widgets

**Files:**
- Create: `lib/features/video_room/presentation/widgets/settings/widgets/settings_toggle_tile.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/widgets/settings_nav_tile.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/widgets/settings_editor_sheet.dart`
- Test: `test/features/video_room/settings_widgets_test.dart`

**Interfaces:**
- Produces:
  - `SettingsToggleTile({required String title, String? subtitle, required bool value, required bool enabled, required bool pending, required ValueChanged<bool> onChanged})`
  - `SettingsNavTile({required String title, String? value, IconData? icon, required VoidCallback? onTap})`
  - `Future<String?> showSettingsEditor(BuildContext context, {required String title, required String initialValue, String? hint, int? maxLength, TextInputType? keyboardType, String? Function(String)? validate})`

Design system: use `AppColors` (`neutral800`, `neutral400`, `brandPurple`), `AppSpacing` (`lg`, `md`, `sm`), `AppTypography`. Do **not** hardcode hex colours — the old sheet's `Color(0xFF1E1E2C)` / `Color(0xFF3B82F6)` are exactly what this replaces.

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/presentation/widgets/settings/widgets/settings_toggle_tile.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

  testWidgets('toggle reports changes when enabled', (tester) async {
    bool? received;
    await tester.pumpWidget(wrap(SettingsToggleTile(
      title: 'Allow Gifts',
      value: true,
      enabled: true,
      pending: false,
      onChanged: (v) => received = v,
    )));
    await tester.tap(find.byType(Switch));
    expect(received, false);
  });

  testWidgets('a disabled toggle does not fire', (tester) async {
    bool fired = false;
    await tester.pumpWidget(wrap(SettingsToggleTile(
      title: 'Allow Gifts',
      value: true,
      enabled: false,
      pending: false,
      onChanged: (_) => fired = true,
    )));
    await tester.tap(find.byType(Switch), warnIfMissed: false);
    expect(fired, false);
  });

  testWidgets('a pending toggle shows a progress indicator and does not fire', (tester) async {
    bool fired = false;
    await tester.pumpWidget(wrap(SettingsToggleTile(
      title: 'Allow Gifts',
      value: true,
      enabled: true,
      pending: true,
      onChanged: (_) => fired = true,
    )));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.tap(find.byType(Switch), warnIfMissed: false);
    expect(fired, false);
  });

  testWidgets('long titles do not overflow a narrow screen', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(wrap(SettingsToggleTile(
      title: 'Allow audience members to send gift messages in the room chat',
      subtitle: 'A long explanatory subtitle that also needs to wrap cleanly',
      value: true,
      enabled: true,
      pending: false,
      onChanged: (_) {},
    )));
    expect(tester.takeException(), isNull);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/settings_widgets_test.dart`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`settings_toggle_tile.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:soulzaa_mobile/core/theme/app_colors.dart';
import 'package:soulzaa_mobile/core/theme/app_spacing.dart';

/// One boolean room setting.
///
/// [pending] means a PATCH is in flight: the switch locks and shows a spinner
/// so a user cannot queue conflicting writes on the same field. [enabled] false
/// means the viewer lacks the permission — the control stays visible but inert,
/// which teaches the permission model better than hiding it would.
class SettingsToggleTile extends StatelessWidget {
  const SettingsToggleTile({
    super.key,
    required this.title,
    this.subtitle,
    required this.value,
    required this.enabled,
    required this.pending,
    required this.onChanged,
  });

  final String title;
  final String? subtitle;
  final bool value;
  final bool enabled;
  final bool pending;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final bool interactive = enabled && !pending;
    return Opacity(
      opacity: enabled ? 1.0 : 0.45,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    title,
                    style: Theme.of(context).textTheme.bodyMedium,
                    softWrap: true,
                  ),
                  if (subtitle != null) ...<Widget>[
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      subtitle!,
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: AppColors.neutral400),
                      softWrap: true,
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            SizedBox(
              width: 52,
              height: 32,
              child: Center(
                child: pending
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Switch(
                        value: value,
                        activeColor: AppColors.brandPurple,
                        onChanged: interactive ? onChanged : null,
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
```

`settings_nav_tile.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:soulzaa_mobile/core/theme/app_colors.dart';
import 'package:soulzaa_mobile/core/theme/app_spacing.dart';

/// A drill-down row. A null [onTap] means "visible but not yours to change" —
/// the row dims rather than disappearing, so the permission model stays legible.
class SettingsNavTile extends StatelessWidget {
  const SettingsNavTile({
    super.key,
    required this.title,
    this.value,
    this.icon,
    required this.onTap,
  });

  final String title;
  final String? value;
  final IconData? icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: onTap == null ? 0.45 : 1.0,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.lg,
            vertical: AppSpacing.md,
          ),
          child: Row(
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, size: 20, color: AppColors.neutral400),
                const SizedBox(width: AppSpacing.md),
              ],
              Expanded(
                child: Text(title, style: Theme.of(context).textTheme.bodyMedium),
              ),
              if (value != null)
                Flexible(
                  child: Text(
                    value!,
                    textAlign: TextAlign.end,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context)
                        .textTheme
                        .bodySmall
                        ?.copyWith(color: AppColors.neutral400),
                  ),
                ),
              const SizedBox(width: AppSpacing.sm),
              const Icon(Icons.chevron_right, size: 20, color: AppColors.neutral400),
            ],
          ),
        ),
      ),
    );
  }
}
```

`settings_editor_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:soulzaa_mobile/core/theme/app_spacing.dart';

/// Save/Confirm editor for the text and number half of the hybrid apply model.
///
/// Booleans never come through here — they apply optimistically. Text does NOT,
/// because a debounced half-typed room name would broadcast to every participant.
/// Returns the committed value, or null if cancelled.
Future<String?> showSettingsEditor(
  BuildContext context, {
  required String title,
  required String initialValue,
  String? hint,
  int? maxLength,
  bool obscure = false,
  TextInputType? keyboardType,
  String? Function(String value)? validate,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => _SettingsEditorSheet(
      title: title,
      initialValue: initialValue,
      hint: hint,
      maxLength: maxLength,
      obscure: obscure,
      keyboardType: keyboardType,
      validate: validate,
    ),
  );
}

class _SettingsEditorSheet extends StatefulWidget {
  const _SettingsEditorSheet({
    required this.title,
    required this.initialValue,
    this.hint,
    this.maxLength,
    required this.obscure,
    this.keyboardType,
    this.validate,
  });

  final String title;
  final String initialValue;
  final String? hint;
  final int? maxLength;
  final bool obscure;
  final TextInputType? keyboardType;
  final String? Function(String value)? validate;

  @override
  State<_SettingsEditorSheet> createState() => _SettingsEditorSheetState();
}

class _SettingsEditorSheetState extends State<_SettingsEditorSheet> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialValue);
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    final value = _controller.text.trim();
    final error = widget.validate?.call(value);
    if (error != null) {
      // Keep the sheet open and focused so the user can correct in place.
      setState(() => _error = error);
      return;
    }
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.lg,
        right: AppSpacing.lg,
        top: AppSpacing.lg,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(widget.title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _controller,
            autofocus: true,
            obscureText: widget.obscure,
            keyboardType: widget.keyboardType,
            maxLength: widget.maxLength,
            inputFormatters: widget.keyboardType == TextInputType.number
                ? <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly]
                : null,
            decoration: InputDecoration(hintText: widget.hint, errorText: _error),
            onSubmitted: (_) => _save(),
          ),
          const SizedBox(height: AppSpacing.md),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Cancel'),
              ),
              const SizedBox(width: AppSpacing.sm),
              FilledButton(onPressed: _save, child: const Text('Save')),
            ],
          ),
        ],
      ),
    );
  }
}
```

> The password editor passes `initialValue: ''` and `obscure: true`. It must **never** be seeded from room state — the server does not return passwords, and seeding would reintroduce the plaintext field Task 13 deletes.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/settings_widgets_test.dart`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room`
Expected: No issues found. **Do not commit.**

---

### Task 20: Settings hub with union-rule permission filtering

**Files:**
- Create: `lib/features/video_room/presentation/widgets/settings/video_room_settings_hub.dart`
- Test: `test/features/video_room/settings_hub_test.dart`

**Interfaces:**
- Produces: `VideoRoomSettingsHub({required VideoRoomPermissions permissions, required VideoRoomSettings settings, ...})`; `visibleSectionsFor(VideoRoomPermissions)` returning `List<SettingsSection>`; `enum SettingsSection` with a `requires` list per section.

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_permission.dart';
import 'package:soulzaa_mobile/features/video_room/presentation/widgets/settings/video_room_settings_hub.dart';

VideoRoomPermissions permsFor(String role, List<String> permissions) =>
    VideoRoomPermissions.fromJson(<String, dynamic>{
      'role': role,
      'permissions': permissions,
    });

void main() {
  group('hub section visibility', () {
    test('owner sees every section', () {
      final owner = permsFor('OWNER', VideoRoomPermission.values.map((p) => p.wire).toList());
      final sections = visibleSectionsFor(owner);
      expect(sections, contains(SettingsSection.roomManagement));
      expect(sections, contains(SettingsSection.admins));
      expect(sections, contains(SettingsSection.endRoom));
    });

    test('audience sees only room info and leave', () {
      final audience = permsFor('VIEWER', <String>[]);
      final sections = visibleSectionsFor(audience);
      expect(sections, contains(SettingsSection.roomInfo));
      expect(sections, isNot(contains(SettingsSection.roomManagement)));
      expect(sections, isNot(contains(SettingsSection.moderation)));
      expect(sections, isNot(contains(SettingsSection.admins)));
    });

    test('admin gets seats, moderation, gifts and PK but not room management or admins', () {
      final admin = permsFor('ADMIN', <String>[
        'MANAGE_SEATS', 'MANAGE_PARTICIPANTS', 'INVITE_USERS', 'VIEW_ANALYTICS',
        'START_PK', 'MANAGE_TREASURE', 'KICK_USERS', 'BLOCK_USERS', 'MUTE_USERS',
        'ROOM_MUTE', 'PIN_MESSAGES', 'MANAGE_ANNOUNCEMENTS',
      ]);
      final sections = visibleSectionsFor(admin);
      expect(sections, contains(SettingsSection.seats));
      expect(sections, contains(SettingsSection.moderation));
      expect(sections, contains(SettingsSection.giftsTreasurePk));
      expect(sections, isNot(contains(SettingsSection.roomManagement)));
      expect(sections, isNot(contains(SettingsSection.admins)));
    });

    test('UNION RULE: a moderator sees Audience Permissions via ROOM_MUTE alone', () {
      final moderator = permsFor('MODERATOR', <String>[
        'KICK_USERS', 'BLOCK_USERS', 'MUTE_USERS', 'ROOM_MUTE',
        'PIN_MESSAGES', 'MANAGE_ANNOUNCEMENTS',
      ]);
      final sections = visibleSectionsFor(moderator);
      expect(sections, contains(SettingsSection.audiencePermissions));
      expect(sections, contains(SettingsSection.moderation));
      expect(sections, isNot(contains(SettingsSection.seats)));
      expect(sections, isNot(contains(SettingsSection.giftsTreasurePk)));
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/settings_hub_test.dart`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```dart
import 'package:soulzaa_mobile/features/video_room/domain/models/video_room_permission.dart';

/// The hub's drill-down destinations.
enum SettingsSection {
  roomManagement,
  privacyAccess,
  seats,
  micCamera,
  audiencePermissions,
  giftsTreasurePk,
  moderation,
  admins,
  videoSelf,
  roomInfo,
  endRoom,
}

/// Permissions used by ANY control inside each section.
///
/// Visibility is a UNION rule: hold at least one and the section appears, with
/// individually unpermitted controls disabled inside it. A single required
/// permission per section would be wrong — a Moderator holds ROOM_MUTE but not
/// MANAGE_PARTICIPANTS, and gating Audience Permissions on the latter would
/// hide Allow Chat and Slow Mode from exactly the role meant to manage them.
const Map<SettingsSection, List<VideoRoomPermission>> kSectionPermissions =
    <SettingsSection, List<VideoRoomPermission>>{
  SettingsSection.roomManagement: <VideoRoomPermission>[VideoRoomPermission.manageRoom],
  SettingsSection.privacyAccess: <VideoRoomPermission>[
    VideoRoomPermission.lockRoom,
    VideoRoomPermission.manageRoom,
  ],
  SettingsSection.seats: <VideoRoomPermission>[VideoRoomPermission.manageSeats],
  SettingsSection.micCamera: <VideoRoomPermission>[
    VideoRoomPermission.roomMute,
    VideoRoomPermission.manageParticipants,
  ],
  SettingsSection.audiencePermissions: <VideoRoomPermission>[
    VideoRoomPermission.roomMute,
    VideoRoomPermission.manageAnnouncements,
    VideoRoomPermission.manageParticipants,
  ],
  SettingsSection.giftsTreasurePk: <VideoRoomPermission>[
    VideoRoomPermission.manageTreasure,
    VideoRoomPermission.startPk,
  ],
  SettingsSection.moderation: <VideoRoomPermission>[
    VideoRoomPermission.kickUsers,
    VideoRoomPermission.blockUsers,
    VideoRoomPermission.muteUsers,
  ],
  SettingsSection.admins: <VideoRoomPermission>[
    VideoRoomPermission.grantRoles,
    VideoRoomPermission.transferOwnership,
  ],
};

/// Sections with no permission entry are open to everyone.
List<SettingsSection> visibleSectionsFor(VideoRoomPermissions permissions) {
  return SettingsSection.values.where((section) {
    final required = kSectionPermissions[section];
    if (required == null) return true;
    return permissions.hasAny(required);
  }).toList();
}
```

Then build the `VideoRoomSettingsHub` widget: a `DraggableScrollableSheet` whose body is a `ListView` of `SettingsNavTile`s over `visibleSectionsFor(permissions)`, pushing each section page via a local `Navigator` so the room video stays visible behind.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/settings_hub_test.dart`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room && flutter test test/features/video_room/`
Expected: No issues, all tests pass. **Do not commit.**

---

### Task 21: Room Management + Privacy & Access pages

**Files:**
- Create: `lib/features/video_room/presentation/widgets/settings/sections/room_management_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/privacy_access_page.dart`
- Test: `test/features/video_room/settings_sections_test.dart`

**Interfaces:**
- Consumes: `SettingsNavTile`, `showSettingsEditor` (Task 19); `UpdateVideoRoomInput` (Task 13); repository `updateRoom`, `getCategories`, `getLanguages`.
- Produces: `RoomManagementPage({required VideoRoom room, required bool canEdit, required Future<void> Function(UpdateVideoRoomInput) onSave})`; `PrivacyAccessPage({required VideoRoom room, required bool canEdit, required Future<void> Function({bool lock, String? password}) onLockChanged, required Future<void> Function(int) onMaxParticipants})`.

**Controls — Room Management** (all Save/Confirm, owner-only, `MANAGE_ROOM`):

| Control | Editor | Commits |
|---|---|---|
| Room Name | text, max 60, non-empty | `PATCH :id {name}` |
| Description | text, max 300 | `PATCH :id {description}` |
| Cover | existing image picker + S3 presign | `PATCH :id {imageKey}` |
| Category | picker from `GET /audio-rooms/categories` | `PATCH :id {categoryId}` |
| Language | picker from `GET /audio-rooms/languages` | `PATCH :id {language}` |
| Copy Room ID | `Clipboard.setData` + snackbar | client-only |
| Share Room | existing share util | client-only |

**Controls — Privacy & Access** (owner-only):

| Control | Type | Commits |
|---|---|---|
| Lock Room | toggle | `POST :id/lock` / `POST :id/unlock` |
| Change Password | text editor, obscured, 4–20 chars | `POST :id/lock {password}` |
| Max Participants | number editor, 1–20 | `PATCH :id {maxParticipants}` |
| Visibility | PUBLIC / PRIVATE segmented | `PATCH :id {visibility}` |

> Password is **write-only**. Never read a password from room state, never display one, never send it in a GET.

- [ ] **Step 1: Write the failing test**

```dart
testWidgets('room management hides edit affordances without MANAGE_ROOM', (tester) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: RoomManagementPage(
      room: testRoom, canEdit: false, onSave: (_) async {},
    )),
  ));
  // Read-only: rows render, but none is tappable.
  final tiles = tester.widgetList<SettingsNavTile>(find.byType(SettingsNavTile));
  expect(tiles.where((t) => t.onTap != null), isEmpty);
});

testWidgets('editing the room name commits a name-only patch', (tester) async {
  UpdateVideoRoomInput? saved;
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: RoomManagementPage(
      room: testRoom, canEdit: true, onSave: (input) async { saved = input; },
    )),
  ));
  await tester.tap(find.text('Room Name'));
  await tester.pumpAndSettle();
  await tester.enterText(find.byType(TextField), 'Renamed');
  await tester.tap(find.text('Save'));
  await tester.pumpAndSettle();

  expect(saved!.toJson(), <String, dynamic>{'name': 'Renamed'});
});

testWidgets('password field is never populated from room state', (tester) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: PrivacyAccessPage(
      room: testRoom, canEdit: true,
      onLockChanged: ({bool lock = false, String? password}) async {},
      onMaxParticipants: (_) async {},
    )),
  ));
  await tester.tap(find.text('Change Password'));
  await tester.pumpAndSettle();
  expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/settings_sections_test.dart`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Build both pages as `StatelessWidget`s over a `ListView` of `SettingsNavTile`s, per the control tables above. Each editable row calls `showSettingsEditor`, and on a non-null result constructs a single-field `UpdateVideoRoomInput` and awaits `onSave`. When `canEdit` is false, pass `onTap: null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/settings_sections_test.dart`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room`
Expected: No issues found. **Do not commit.**

---

### Task 22: Seats + Mic & Camera pages

**Files:**
- Create: `lib/features/video_room/presentation/widgets/settings/sections/seats_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/mic_camera_page.dart`
- Test: append to `test/features/video_room/settings_sections_test.dart`

**Interfaces:**
- Consumes: `VideoRoomSettingsController.setSeatLayout / setFlag`; repository `lockSeat`, `configureSeatLayout`.
- Produces: `SeatsPage({required VideoRoomSettingsController controller, required bool canManageSeats, required bool isLive, required int occupiedSeatCount})`; `MicCameraPage({required VideoRoomSettingsController controller, required VideoRoomPermissions permissions, required Future<void> Function(bool) onBroadMute})`.

**Controls — Seats** (`MANAGE_SEATS`):

| Control | Type | Commits |
|---|---|---|
| Seat Layout 4/6/8/9/12 | segmented, **disabled unless room is LIVE** | `POST :id/seats/layout` |
| Auto-Accept Seat Requests | toggle (**inverse** of `seatApprovalRequired`) | `PATCH :id/settings` |
| Lock / Unlock Seat | per-seat row | `POST :id/seats/lock` / `unlock` |
| Invite to Seat | user picker | `POST :id/seats/invite` |
| Remove from Seat | confirm | `POST :id/viewer/demote` |

**Controls — Mic & Camera:**

| Control | Type | Permission | Commits |
|---|---|---|---|
| Broad Mute (mic + chat) | toggle | `ROOM_MUTE` | `POST :id/moderation/mute-all` / `unmute-all` with `channels:['mic','chat']` |
| Allow Camera Switch | toggle | `MANAGE_PARTICIPANTS` | `PATCH :id/settings` |
| Allow Beauty | toggle | `MANAGE_PARTICIPANTS` | `PATCH :id/settings` |
| Allow Screen Share | toggle | `MANAGE_PARTICIPANTS` | `PATCH :id/settings` |
| Allow Recording | toggle | `MANAGE_PARTICIPANTS` | `PATCH :id/settings` |

> **One Broad Mute control only.** "Mute All" and "Broad Mute" are the same server operation.
> **Auto-Accept is inverted:** `seatApprovalRequired == false` means auto-accept is ON.

- [ ] **Step 1: Write the failing test**

```dart
testWidgets('seat layout is disabled when the room is not live', (tester) async {
  final controller = VideoRoomSettingsController(_FakeRepo(), 'r1');
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: SeatsPage(
    controller: controller, canManageSeats: true, isLive: false, occupiedSeatCount: 3,
  ))));
  expect(find.textContaining('while the room is live'), findsOneWidget);
});

testWidgets('shrinking below the occupied count warns before sending', (tester) async {
  final repo = _FakeRepo();
  final controller = VideoRoomSettingsController(repo, 'r1',
      initial: const VideoRoomSettings(hostSeatCount: 11));
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: SeatsPage(
    controller: controller, canManageSeats: true, isLive: true, occupiedSeatCount: 9,
  ))));
  await tester.tap(find.text('4'));
  await tester.pumpAndSettle();
  expect(find.textContaining('will be moved to the audience'), findsOneWidget);
});

testWidgets('auto-accept is the inverse of seatApprovalRequired', (tester) async {
  final controller = VideoRoomSettingsController(_FakeRepo(), 'r1',
      initial: const VideoRoomSettings());
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: SeatsPage(
    controller: controller, canManageSeats: true, isLive: true, occupiedSeatCount: 0,
  ))));
  final tile = tester.widget<SettingsToggleTile>(
    find.widgetWithText(SettingsToggleTile, 'Auto-Accept Seat Requests'),
  );
  // Default seatApprovalRequired == true  =>  auto-accept shows OFF.
  expect(tile.value, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/settings_sections_test.dart -n "seat"`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Build both pages. In `SeatsPage`, the layout selector renders `[4, 6, 8, 9, 12]`; when `!isLive` it is disabled with the caption *"Seat layout can only be changed while the room is live."*; when the chosen total is below `occupiedSeatCount`, show an `AppFeedback.showConfirmDialog` reading *"N users will be moved to the audience."* before calling `controller.setSeatLayout`. Auto-accept renders `value: !settings.seatApprovalRequired` and calls `controller.setFlag('seatApprovalRequired', !newValue)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/settings_sections_test.dart`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room && flutter test test/features/video_room/`
Expected: No issues, all tests pass. **Do not commit.**

---

### Task 23: Audience Permissions + Gifts/Treasure/PK pages

**Files:**
- Create: `lib/features/video_room/presentation/widgets/settings/sections/audience_permissions_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/gifts_treasure_pk_page.dart`
- Test: append to `test/features/video_room/settings_sections_test.dart`

**Interfaces:**
- Produces: `AudiencePermissionsPage({required VideoRoomSettingsController controller, required VideoRoomPermissions permissions})`; `GiftsTreasurePkPage({required VideoRoomSettingsController controller, required VideoRoomPermissions permissions, required VoidCallback onOpenTreasureConfig, required VoidCallback onOpenPkHistory})`.

**Controls — Audience Permissions:**

| Control | Field | Permission |
|---|---|---|
| Allow Chat | `allowChat` | `ROOM_MUTE` |
| Slow Mode (0/3/5/10/30/60s) | `slowModeSeconds` | `ROOM_MUTE` |
| Allow Announcements | `allowAnnouncements` | `MANAGE_ANNOUNCEMENTS` |
| Allow Invites | `allowInvite` | `MANAGE_PARTICIPANTS` |
| Allow Reporting | `allowReporting` | `MANAGE_PARTICIPANTS` |

**Controls — Gifts, Treasure & PK:**

| Control | Field / route | Permission |
|---|---|---|
| Allow Gifts | `allowGifts` | `MANAGE_TREASURE` |
| Enable Treasure Box | `allowTreasure` | `MANAGE_TREASURE` |
| Treasure Configuration | `POST :id/treasure` (existing screen) | `MANAGE_TREASURE` |
| Allow PK | `allowPk` | `START_PK` |
| PK History | `GET :id/pk/history` | `START_PK` |

- [ ] **Step 1: Write the failing test**

```dart
testWidgets('a moderator can change chat policy but not invites', (tester) async {
  final controller = VideoRoomSettingsController(_FakeRepo(), 'r1');
  final moderator = permsFor('MODERATOR', <String>[
    'ROOM_MUTE', 'MANAGE_ANNOUNCEMENTS', 'KICK_USERS',
  ]);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: AudiencePermissionsPage(
    controller: controller, permissions: moderator,
  ))));

  expect(
    tester.widget<SettingsToggleTile>(
      find.widgetWithText(SettingsToggleTile, 'Allow Chat')).enabled,
    true,
  );
  expect(
    tester.widget<SettingsToggleTile>(
      find.widgetWithText(SettingsToggleTile, 'Allow Invites')).enabled,
    false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/settings_sections_test.dart -n "moderator"`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Build both pages as `AnimatedBuilder`s over the controller, one `SettingsToggleTile` per control, each with `enabled: permissions.has(<permission from the table>)`, `pending: controller.isPending(<field>)`, `onChanged: (v) => controller.setFlag(<field>, v)`. On `controller.lastError != null`, surface `AppFeedback.showSnackBar` and call `clearError()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/settings_sections_test.dart`
Expected: PASS.

- [ ] **Step 5: Verification gate (NO COMMIT)**

Run: `flutter analyze lib/features/video_room && flutter test test/features/video_room/`
Expected: No issues, all tests pass. **Do not commit.**

---

### Task 24: Moderation, Admins, Room Info, Video & End Room pages, and live-screen wiring

**Files:**
- Create: `lib/features/video_room/presentation/widgets/settings/sections/moderation_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/admins_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/room_info_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/video_self_page.dart`
- Create: `lib/features/video_room/presentation/widgets/settings/sections/end_room_page.dart`
- Delete: `lib/features/video_room/presentation/widgets/video_room_settings_sheet.dart`
- Modify: `lib/features/video_room/presentation/screens/video_room_live_screen.dart:781-790`
- Test: append to `test/features/video_room/settings_sections_test.dart`

**Interfaces:**
- Produces the five remaining pages plus the live-screen entry point now opening `VideoRoomSettingsHub`.

**Controls:**

| Page | Controls | Routes |
|---|---|---|
| Moderation | Ban list (+unban) · Muted users (+unmute) · Action history · Reports · Warn | `GET :id/blacklisted-users` · `muted-users` · `moderation/history` · `reports` · `POST :id/moderation/warn` · `DELETE :id/moderation/blacklist/:userId` |
| Admins | Admin list · Add · Remove · Change role · Permission summary · Transfer Ownership | `GET/POST :id/roles/*` · `GET video-rooms/permissions` · `POST :id/owner/transfer` |
| Room Info | Room ID · Owner · Members · Viewers · Gifts · Coins · Duration · Treasure progress | `GET :id` · `:id/viewers/count` · `:id/treasure` |
| Video (self) | Beauty · Quality (Auto/Low/Medium/HD) · Mirror (local) · Low data (local) | `POST :id/media/beauty` · `:id/media/quality` |
| End Room | Leave Room (everyone) · End Room (owner, confirm) | `POST :id/leave` · `POST :id/close` |

- [ ] **Step 1: Write the failing test**

```dart
testWidgets('End Room is offered only to the owner; Leave to everyone', (tester) async {
  for (final entry in <String, bool>{'OWNER': true, 'ADMIN': false, 'VIEWER': false}.entries) {
    final perms = permsFor(entry.key, entry.key == 'OWNER' ? <String>['CLOSE_ROOM'] : <String>[]);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: EndRoomPage(
      permissions: perms, onLeave: () async {}, onEnd: () async {},
    ))));
    await tester.pumpAndSettle();
    expect(find.text('Leave Room'), findsOneWidget);
    expect(find.text('End Room'), entry.value ? findsOneWidget : findsNothing);
  }
});

testWidgets('room info renders live statistics without overflow on a narrow screen', (tester) async {
  tester.view.physicalSize = const Size(320, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: RoomInfoPage(
    roomId: 'a-very-long-room-uuid-0000-1111-2222',
    ownerName: 'A very long owner display name that must ellipsize',
    memberCount: 128, viewerCount: 4096,
    totalGifts: 1234, totalGiftCoins: 987654, durationSeconds: 7325,
  ))));
  expect(tester.takeException(), isNull);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/video_room/settings_sections_test.dart -n "End Room"`
Expected: FAIL — target of URI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Build the five pages per the control table. Every list page uses `AppLoader` while loading, `AppErrorView` on failure, and an empty-state message. `EndRoomPage` shows `End Room` only when `permissions.has(VideoRoomPermission.closeRoom)`, behind `AppFeedback.showConfirmDialog`.

**Provider wiring.** `VideoRoomSettingsController` needs one instance per room, owned alongside the existing `VideoRoomController`. Add to `video_room_controller.dart`:

```dart
  late final VideoRoomSettingsController settingsController =
      VideoRoomSettingsController(
    _repository as VideoRoomSettingsApi,
    _roomId,
    currentUserId: _currentUserId,
    initial: state.settings,
    permissions: state.permissions,
  );
```

`VideoRoomRepositoryImpl` already satisfies `VideoRoomSettingsApi` after Task 14 — declare `implements VideoRoomSettingsApi` on it so the cast is checked at compile time rather than at runtime. Dispose it in the controller's `dispose()`. Fetch the initial permission set once on join via `await settingsController.refreshPermissions()`.

Then in `video_room_live_screen.dart`, replace the `showModalBottomSheet` body at line ~785:

```dart
              showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                backgroundColor: Colors.transparent,
                builder: (ctx) => VideoRoomSettingsHub(
                  roomId: room.id,
                  controller: settingsController,
                  permissions: state.permissions,
                ),
              );
```

Delete `video_room_settings_sheet.dart` and remove its import.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/video_room/`
Expected: PASS, every video_room test.

- [ ] **Step 5: Final verification gate (NO COMMIT)**

Run, in `/Users/lt611-18/soulzaa-mobile`:
```
flutter analyze
flutter test
```
Expected: `No issues found.` and the full mobile suite green (baseline: 100 test files).

Run, in `/Users/lt611-18/soulzaa-backend`:
```
npx tsc --noEmit
npx eslint src --max-warnings 0
npx jest
```
Expected: 0 errors, 0 warnings, full suite green with **no regressions** against the pre-phase baseline.

Report both suites' pass/fail counts. **Do not commit — the user commits manually after review.**

---

## Post-implementation report

State explicitly:
1. Backend test counts before and after; any pre-existing failures carried forward.
2. Mobile test counts before and after.
3. Any control that had to be dropped because its backend entry point differed from the spec's assumption (particularly screen-share / recording in Task 10).
4. Confirmation that no file under `prisma/schema/` changed, that `VideoRoomPermission` is unchanged, and that no Audio Room file was modified.
5. Confirmation that no git command was run.
