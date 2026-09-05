# Video Room Gift-Lock — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace video rooms' password-based room lock with a gift-based lock: a host designates one catalog gift as the room's entry requirement, and joining/continuing to watch is gated on having sent it, reusing the existing gift pipeline for wallet deduction and creator earnings.

**Architecture:** Build the new gift-lock feature fully (schema, repository, service, endpoints, events, join-gate, gift-context-handler hook) while the old password-lock feature still exists and works, so every commit compiles and the test suite stays green. Only the final task removes the old password-lock code and schema, once the new feature is fully in place and (per the companion mobile plan) mobile has switched over.

**Tech Stack:** NestJS, Prisma, Jest (manual mocks, no DI container in unit tests — see Task 2 for the exact convention), PostgreSQL.

**Spec:** [docs/superpowers/specs/2026-09-04-video-room-gift-lock-design.md](../specs/2026-09-04-video-room-gift-lock-design.md)

## Global Constraints

- Audio rooms (`src/modules/audio-rooms/**`) are never touched by this plan.
- `VideoRoomSeat.isLocked` / `lockSeat()` (per-seat lock) is a different feature and is never touched.
- The paid-entry-fee feature (`VideoRoomEntryPaymentService`, `VideoRoomEntryAccess`) is never modified.
- No changes to `GiftService`, `WalletService`, or `gift.receiver_earnings_percentage` — wallet deduction and creator earnings are reused exactly as-is by routing the required-gift send through the existing gift pipeline.
- Every task must leave `npm run build` (or the repo's TS project check) and the full Jest suite green — this is additive-first specifically so that's always true.

---

### Task 1: Gift-lock schema (additive migration)

**Files:**
- Modify: `prisma/schema/video_rooms.prisma` (the `VideoRoom` model, ~line 12-60)
- Create: `prisma/schema/video_rooms_gift_lock_access.prisma`
- Modify: `prisma/schema/video_rooms.prisma` (the `VideoRoomLogAction` enum, ~line 253-292)
- Create: a new Prisma migration (via `npx prisma migrate dev`)

**Interfaces:**
- Produces: `VideoRoom.giftLockEnabled: boolean`, `VideoRoom.requiredEntryGiftId: string | null` (plain UUID column, no Prisma-level FK to `Gift` — validated at the service layer in Task 3, matching how `VideoRoomEntryAccess.transactionId` is a loose reference); `VideoRoomGiftLockAccess` model with `findAccess`/`hasGrantedAccess`/`grantAccess` semantics identical in shape to `VideoRoomEntryAccess`.

- [ ] **Step 1: Add the two new columns to `VideoRoom`**

In `prisma/schema/video_rooms.prisma`, add after the existing `defaultEntryFee` field (~line 44):

```prisma
  giftLockEnabled  Boolean @default(false)
  requiredEntryGiftId String? @db.Uuid

  giftLockAccesses VideoRoomGiftLockAccess[]
```

- [ ] **Step 2: Create the access-grant model**

Create `prisma/schema/video_rooms_gift_lock_access.prisma`:

```prisma
/// Session-scoped Gift-Lock entry entitlement for Video Rooms, mirroring
/// VideoRoomEntryAccess's shape for paid entry. A successful send of the
/// room's required entry gift grants access to the CURRENT broadcast session
/// only; when the session ends, the entitlement stays bound to it and does
/// not carry into the next one.
model VideoRoomGiftLockAccess {
  id                String                        @id @default(uuid()) @db.Uuid
  userId            String                        @db.Uuid
  roomId            String                        @db.Uuid
  sessionId         String                        @db.Uuid
  giftId            String                        @db.Uuid
  giftTransactionId String                        @db.Uuid
  status            VideoRoomGiftLockAccessStatus @default(GRANTED)
  grantedAt         DateTime                      @default(now())
  createdAt         DateTime                      @default(now())

  room    VideoRoom             @relation(fields: [roomId], references: [id], onDelete: Cascade)
  session VideoBroadcastSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([userId, sessionId])
  @@index([roomId, sessionId])
  @@map("video_room_gift_lock_accesses")
}

enum VideoRoomGiftLockAccessStatus {
  GRANTED
  REVOKED
}
```

- [ ] **Step 3: Add the reverse relation on `VideoBroadcastSession`**

Find the `VideoBroadcastSession` model (`prisma/schema/video_rooms_broadcast.prisma`) and add a `giftLockAccesses VideoRoomGiftLockAccess[]` line next to its existing `entryAccesses VideoRoomEntryAccess[]` relation field (same file that already declares that field for the paid-entry model).

- [ ] **Step 4: Add new audit-log actions**

In `prisma/schema/video_rooms.prisma`, add two values to the end of the `VideoRoomLogAction` enum (after `PK_REWARD_DISTRIBUTED`, ~line 291):

```prisma
  GIFT_LOCK_ENABLED
  GIFT_LOCK_DISABLED
```

Do NOT remove `LOCKED`/`UNLOCKED` — they stay in the enum as historical values even after Task 8 stops writing them, so existing audit rows keep resolving.

- [ ] **Step 5: Generate and apply the migration**

Run: `npx prisma migrate dev --name video_room_gift_lock`

Expected: a new migration folder under `prisma/schema/migrations/` containing `ALTER TABLE "video_rooms" ADD COLUMN "giftLockEnabled" ...`, `CREATE TABLE "video_room_gift_lock_accesses" ...`, and the enum additions. If the CLI prompts about resetting the dev database over unrelated drift, do **not** confirm it — stop and report instead (see the project's own `prisma_schema_client_drift` note: this has happened before and must never be auto-confirmed).

- [ ] **Step 6: Verify the Prisma client regenerated**

Run: `npx prisma generate`
Expected: no errors; `node_modules/.prisma/client/index.d.ts` now contains `VideoRoomGiftLockAccess` and `VideoRoom.giftLockEnabled`.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema/video_rooms.prisma prisma/schema/video_rooms_gift_lock_access.prisma prisma/schema/video_rooms_broadcast.prisma prisma/schema/migrations
git commit -m "feat(video-rooms): add gift-lock schema (additive)"
```

---

### Task 2: `VideoRoomGiftLockAccessRepository`

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.spec.ts`

**Interfaces:**
- Consumes: Prisma client's `videoRoomGiftLockAccess` model (from Task 1).
- Produces (used by Tasks 5 and 6):
  ```ts
  interface GrantGiftLockAccessData {
    userId: string;
    roomId: string;
    sessionId: string;
    giftId: string;
    giftTransactionId: string;
  }
  class VideoRoomGiftLockAccessRepository {
    findAccess(userId: string, sessionId: string, tx?: Prisma.TransactionClient): Promise<any | null>;
    hasGrantedAccess(userId: string, sessionId: string, tx?: Prisma.TransactionClient): Promise<boolean>;
    grantAccess(data: GrantGiftLockAccessData, tx?: Prisma.TransactionClient): Promise<any>;
  }
  ```

This mirrors `src/modules/video-rooms/repositories/video-room-entry-access.repository.ts` exactly (same shape, same `@Injectable` + `findUnique`/`create` pattern), which is the template — no design decision to make here, just following the established repository shape for a session-scoped access grant.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.spec.ts`:

```ts
import { VideoRoomGiftLockAccessRepository } from './video-room-gift-lock-access.repository';

describe('VideoRoomGiftLockAccessRepository', () => {
  let repo: VideoRoomGiftLockAccessRepository;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      videoRoomGiftLockAccess: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    repo = new VideoRoomGiftLockAccessRepository(prisma);
  });

  it('findAccess looks up by the (userId, sessionId) unique key', async () => {
    prisma.videoRoomGiftLockAccess.findUnique.mockResolvedValue({ id: 'a1', status: 'GRANTED' });
    const result = await repo.findAccess('user-1', 'session-1');
    expect(prisma.videoRoomGiftLockAccess.findUnique).toHaveBeenCalledWith({
      where: { userId_sessionId: { userId: 'user-1', sessionId: 'session-1' } },
    });
    expect(result).toEqual({ id: 'a1', status: 'GRANTED' });
  });

  it('hasGrantedAccess is true only when a GRANTED row exists', async () => {
    prisma.videoRoomGiftLockAccess.findUnique.mockResolvedValueOnce({ status: 'GRANTED' });
    expect(await repo.hasGrantedAccess('user-1', 'session-1')).toBe(true);

    prisma.videoRoomGiftLockAccess.findUnique.mockResolvedValueOnce(null);
    expect(await repo.hasGrantedAccess('user-1', 'session-1')).toBe(false);
  });

  it('grantAccess creates a GRANTED row from the given data', async () => {
    prisma.videoRoomGiftLockAccess.create.mockResolvedValue({ id: 'a2' });
    const result = await repo.grantAccess({
      userId: 'user-1',
      roomId: 'room-1',
      sessionId: 'session-1',
      giftId: 'gift-1',
      giftTransactionId: 'txn-1',
    });
    expect(prisma.videoRoomGiftLockAccess.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        giftId: 'gift-1',
        giftTransactionId: 'txn-1',
        status: 'GRANTED',
        grantedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ id: 'a2' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.spec.ts`
Expected: FAIL — `Cannot find module './video-room-gift-lock-access.repository'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface GrantGiftLockAccessData {
  userId: string;
  roomId: string;
  sessionId: string;
  giftId: string;
  giftTransactionId: string;
}

@Injectable()
export class VideoRoomGiftLockAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Find gift-lock access for a specific user and broadcast session. */
  async findAccess(
    userId: string,
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any | null> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomGiftLockAccess.findUnique({
      where: { userId_sessionId: { userId, sessionId } },
    });
  }

  /** Check if a user has active granted gift-lock access for a broadcast session. */
  async hasGrantedAccess(
    userId: string,
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const access = await this.findAccess(userId, sessionId, tx);
    return access !== null && access.status === 'GRANTED';
  }

  /** Grant new gift-lock access entitlement. */
  async grantAccess(
    data: GrantGiftLockAccessData,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomGiftLockAccess.create({
      data: {
        userId: data.userId,
        roomId: data.roomId,
        sessionId: data.sessionId,
        giftId: data.giftId,
        giftTransactionId: data.giftTransactionId,
        status: 'GRANTED',
        grantedAt: new Date(),
      },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the repository in the module**

In `src/modules/video-rooms/video-rooms.module.ts`, add `VideoRoomGiftLockAccessRepository` (import from its file) to both the `providers` array and, if the module re-exports repositories for other modules to inject, the `exports` array — follow exactly how `VideoRoomEntryAccessRepository` is registered in the same file (find it with `grep -n VideoRoomEntryAccessRepository src/modules/video-rooms/video-rooms.module.ts` and mirror its two entries).

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.ts src/modules/video-rooms/repositories/video-room-gift-lock-access.repository.spec.ts src/modules/video-rooms/video-rooms.module.ts
git commit -m "feat(video-rooms): add VideoRoomGiftLockAccessRepository"
```

---

### Task 3: `VideoRoomGiftLockService` + endpoints

**Files:**
- Create: `src/modules/video-rooms/dto/gift-lock-video-room.dto.ts`
- Create: `src/modules/video-rooms/services/video-room-gift-lock.service.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-lock.service.spec.ts`
- Modify: `src/common/exceptions/error-codes.ts` (add `VIDEO_ROOM_GIFT_REQUIRED`)
- Modify: `src/modules/video-rooms/controllers/video-rooms.controller.ts` (add two endpoints)
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (register the new service)

**Interfaces:**
- Consumes: `VideoRoomsRepository.findById`/`updateRoom`/`appendLog` (existing), `VideoRoomPermissionService.assertPermission` (existing), `IGiftsService.isGiftEnabled` (existing, injected via `GIFTS_SERVICE` token), a new `IEventBus` publish of `GiftLockEnabledEvent`/`GiftLockDisabledEvent` (defined in Task 4 — this task defines the event *classes* it needs; Task 4 wires their socket relay).
- Produces (used by the controller and by Task 4's listener):
  ```ts
  class VideoRoomGiftLockService {
    enable(actor: RoomActor, roomId: string, giftId: string): Promise<VideoRoomDetailView>;
    disable(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView>;
  }
  ```

- [ ] **Step 1: Add the error code**

In `src/common/exceptions/error-codes.ts`, add one line right after `VIDEO_ROOM_PASSWORD_INVALID` (~line 168), under the same "Video Room member lifecycle (VR-3)" section:

```ts
  /** Join blocked: room requires sending its designated entry gift first (402). */
  VIDEO_ROOM_GIFT_REQUIRED: 'VIDEO_ROOM_GIFT_REQUIRED',
```

- [ ] **Step 2: Create the DTO**

Create `src/modules/video-rooms/dto/gift-lock-video-room.dto.ts`:

```ts
import { IsUUID } from 'class-validator';

/** Enable-gift-lock request body: the catalog gift id required to enter. */
export class GiftLockVideoRoomDto {
  @IsUUID()
  giftId!: string;
}
```

- [ ] **Step 3: Write the failing service test**

Create `src/modules/video-rooms/services/video-room-gift-lock.service.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomGiftLockService } from './video-room-gift-lock.service';

describe('VideoRoomGiftLockService', () => {
  let service: VideoRoomGiftLockService;
  let repo: any;
  let permissions: any;
  let gifts: any;
  let bus: any;
  let actor: any;

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue({ id: 'room-1', ownerId: 'owner-1' }),
      updateRoom: jest.fn().mockResolvedValue(undefined),
      appendLog: jest.fn().mockResolvedValue(undefined),
    };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    gifts = { isGiftEnabled: jest.fn().mockResolvedValue(true) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    actor = { id: 'owner-1', roles: [] };

    service = new VideoRoomGiftLockService(repo, permissions, gifts, bus, {
      getDetail: jest.fn().mockResolvedValue({ id: 'room-1' }),
    } as any);
  });

  describe('enable', () => {
    it('throws when the room does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.enable(actor, 'room-404', 'gift-1')).rejects.toThrow(BusinessException);
    });

    it('asserts LOCK_ROOM permission before writing', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        { id: 'room-1', ownerId: 'owner-1' },
        VideoRoomPermission.LOCK_ROOM,
      );
    });

    it('rejects a gift that is not an active catalog gift', async () => {
      gifts.isGiftEnabled.mockResolvedValueOnce(false);
      await expect(service.enable(actor, 'room-1', 'gift-bad')).rejects.toThrow(BusinessException);
      expect(repo.updateRoom).not.toHaveBeenCalled();
    });

    it('persists giftLockEnabled + requiredEntryGiftId and logs GIFT_LOCK_ENABLED', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(repo.updateRoom).toHaveBeenCalledWith(
        'room-1',
        { giftLockEnabled: true, requiredEntryGiftId: 'gift-1' },
        'owner-1',
      );
      expect(repo.appendLog).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: 'room-1', action: 'GIFT_LOCK_ENABLED' }),
      );
    });

    it('publishes GiftLockEnabledEvent', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'video_room.gift_lock_enabled',
          payload: expect.objectContaining({ roomId: 'room-1', giftId: 'gift-1' }),
        }),
      );
    });
  });

  describe('disable', () => {
    it('asserts LOCK_ROOM permission and clears both fields', async () => {
      await service.disable(actor, 'room-1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        { id: 'room-1', ownerId: 'owner-1' },
        VideoRoomPermission.LOCK_ROOM,
      );
      expect(repo.updateRoom).toHaveBeenCalledWith(
        'room-1',
        { giftLockEnabled: false, requiredEntryGiftId: null },
        'owner-1',
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.gift_lock_disabled' }),
      );
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-lock.service.spec.ts`
Expected: FAIL — `Cannot find module './video-room-gift-lock.service'`

- [ ] **Step 5: Add the event classes**

In `src/modules/video-rooms/events/video-room.events.ts`, add two entries to the `VIDEO_ROOM_EVENTS` const (after `LOCKED`, ~line 25 — leave `LOCKED`/`RoomLockedEvent` in place for now, Task 8 removes them):

```ts
  GIFT_LOCK_ENABLED: 'video_room.gift_lock_enabled',
  GIFT_LOCK_DISABLED: 'video_room.gift_lock_disabled',
```

And two new event classes (near `RoomLockedEvent`, ~line 116):

```ts
/** A room's gift-lock was enabled with the given required gift (new lock feature). */
export class GiftLockEnabledEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  giftId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.GIFT_LOCK_ENABLED;
}

/** A room's gift-lock was disabled. */
export class GiftLockDisabledEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.GIFT_LOCK_DISABLED;
}
```

- [ ] **Step 6: Write the service implementation**

Create `src/modules/video-rooms/services/video-room-gift-lock.service.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFTS_SERVICE, type IGiftsService } from 'src/modules/gifts/interfaces/gifts.service.interface';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { GiftLockDisabledEvent, GiftLockEnabledEvent } from '../events/video-room.events';
import type { VideoRoomDetailView } from '../entities/video-room-detail.view';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomQueryService } from './video-room-query.service';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomLogAction } from '@prisma/client';

/**
 * Enable/disable a video room's gift-lock: a designated catalog gift required
 * to enter. Fresh code, independent of the removed password-lock service —
 * the only thing it shares with it is the LOCK_ROOM permission concept ("who
 * may lock this room"), not any lock logic.
 */
@Injectable()
export class VideoRoomGiftLockService {
  constructor(
    private readonly repo: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    @Inject(GIFTS_SERVICE) private readonly gifts: IGiftsService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly query: VideoRoomQueryService,
  ) {}

  async enable(actor: RoomActor, roomId: string, giftId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.LOCK_ROOM);

    const enabled = await this.gifts.isGiftEnabled(giftId);
    if (!enabled) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
        'The selected gift is not available in the catalog.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.repo.updateRoom(
      roomId,
      { giftLockEnabled: true, requiredEntryGiftId: giftId },
      actor.id,
    );
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.GIFT_LOCK_ENABLED,
      metadata: { giftId },
    });
    await this.bus.publish(new GiftLockEnabledEvent({ roomId, actorId: actor.id, giftId }));
    return this.query.getDetail(roomId);
  }

  async disable(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.LOCK_ROOM);

    await this.repo.updateRoom(
      roomId,
      { giftLockEnabled: false, requiredEntryGiftId: null },
      actor.id,
    );
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.GIFT_LOCK_DISABLED,
    });
    await this.bus.publish(new GiftLockDisabledEvent({ roomId, actorId: actor.id }));
    return this.query.getDetail(roomId);
  }

  private async getRoomOrThrow(roomId: string) {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-lock.service.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 8: Wire the controller endpoints**

In `src/modules/video-rooms/controllers/video-rooms.controller.ts`:
- Add `import { GiftLockVideoRoomDto } from '../dto/gift-lock-video-room.dto';` and `import { VideoRoomGiftLockService } from '../services/video-room-gift-lock.service';`
- Add `private readonly giftLock: VideoRoomGiftLockService,` to the constructor parameter list.
- Add two endpoints right after the existing `unlock` endpoint (~line 200):

```ts
  @Post(':id/gift-lock')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable gift-lock: require a specific gift to enter' })
  enableGiftLock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: GiftLockVideoRoomDto,
  ) {
    return this.giftLock.enable(this.actor(user), id, dto.giftId);
  }

  @Post(':id/gift-lock/disable')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable gift-lock' })
  disableGiftLock(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.giftLock.disable(this.actor(user), id);
  }
```

- [ ] **Step 9: Register the service in the module**

In `src/modules/video-rooms/video-rooms.module.ts`, add `VideoRoomGiftLockService` to `providers`, following the same pattern as `VideoRoomLifecycleService`'s registration.

- [ ] **Step 10: Verify the whole module still builds**

Run: `npx tsc --noEmit -p tsconfig.json` (or the repo's standard build check)
Expected: no new errors.

- [ ] **Step 11: Commit**

```bash
git add src/common/exceptions/error-codes.ts src/modules/video-rooms/dto/gift-lock-video-room.dto.ts src/modules/video-rooms/services/video-room-gift-lock.service.ts src/modules/video-rooms/services/video-room-gift-lock.service.spec.ts src/modules/video-rooms/events/video-room.events.ts src/modules/video-rooms/controllers/video-rooms.controller.ts src/modules/video-rooms/video-rooms.module.ts
git commit -m "feat(video-rooms): add gift-lock enable/disable service and endpoints"
```

---

### Task 4: Socket relay for gift-lock events

**Files:**
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts`
- Modify: `src/modules/video-rooms/listeners/video-room-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts` (extend existing file)

**Interfaces:**
- Consumes: `GiftLockEnabledEvent`/`GiftLockDisabledEvent` (Task 3).
- Produces: client-facing socket events `video_room.gift_lock_enabled` / `video_room.gift_lock_disabled`, broadcast room-wide via the existing `emitToNamespaceRoom` relay — consumed by the mobile plan's Task 4.

- [ ] **Step 1: Add the client-facing event names**

In `src/modules/video-rooms/constants/video-room.constants.ts`, add two lines to `VIDEO_ROOM_SOCKET_EVENTS` (after `LOCKED`, ~line 34):

```ts
  GIFT_LOCK_ENABLED: 'video_room.gift_lock_enabled',
  GIFT_LOCK_DISABLED: 'video_room.gift_lock_disabled',
```

- [ ] **Step 2: Write the failing listener test**

Open `src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts` and add (following whatever pattern the existing `RoomLockedEvent` relay test there already uses — mirror its `bus`/`sockets` mock setup exactly):

```ts
  it('relays GiftLockEnabledEvent to video_room.gift_lock_enabled', () => {
    listener.onModuleInit();
    const handler = bus.subscribe.mock.calls.find(
      (call: any[]) => call[0] === 'video_room.gift_lock_enabled',
    )[1];
    handler({ payload: { roomId: 'room-1', actorId: 'owner-1', giftId: 'gift-1' } });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      expect.any(String),
      'room-1',
      'video_room.gift_lock_enabled',
      { roomId: 'room-1', actorId: 'owner-1', giftId: 'gift-1' },
    );
  });

  it('relays GiftLockDisabledEvent to video_room.gift_lock_disabled', () => {
    listener.onModuleInit();
    const handler = bus.subscribe.mock.calls.find(
      (call: any[]) => call[0] === 'video_room.gift_lock_disabled',
    )[1];
    handler({ payload: { roomId: 'room-1', actorId: 'owner-1' } });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      expect.any(String),
      'room-1',
      'video_room.gift_lock_disabled',
      { roomId: 'room-1', actorId: 'owner-1' },
    );
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts`
Expected: FAIL — `bus.subscribe.mock.calls.find(...)` returns `undefined`, throwing on `[1]`.

- [ ] **Step 4: Wire the relay**

In `src/modules/video-rooms/listeners/video-room-socket.listener.ts`:
- Add `GiftLockDisabledEvent` and `GiftLockEnabledEvent` to the `import type { ... }` block from `'../events/video-room.events'`.
- Add two subscriptions right after the existing `RoomLockedEvent` subscription (~line 76):

```ts
    this.bus.subscribe<GiftLockEnabledEvent>(VIDEO_ROOM_EVENTS.GIFT_LOCK_ENABLED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.GIFT_LOCK_ENABLED, e.payload),
    );
    this.bus.subscribe<GiftLockDisabledEvent>(VIDEO_ROOM_EVENTS.GIFT_LOCK_DISABLED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.GIFT_LOCK_DISABLED, e.payload),
    );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/constants/video-room.constants.ts src/modules/video-rooms/listeners/video-room-socket.listener.ts src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts
git commit -m "feat(video-rooms): relay gift-lock events to the video-room socket namespace"
```

---

### Task 5: Grant access when the required gift is sent

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-gift-context.handler.ts`
- Test: `src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts` (extend existing file, or create if none exists — check first with `ls src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`)

**Interfaces:**
- Consumes: `VideoRoomGiftLockAccessRepository.grantAccess` (Task 2), `GiftSendContext` (existing, from `IGiftContextHandler`) — fields used: `ctx.contextId` (roomId), `ctx.senderId`, `ctx.receiverIds`, `ctx.transactionId`.
- Produces: no new public interface — this is a private addition to `onSend()`'s existing behavior.

**Note on scope:** `onSend()` currently only receives a *single* transaction's context per call (it's invoked once per gift-send inside `sendGiftBatch()`'s transaction), and `ctx.receiverIds` is the list of that gift's recipients. The grant only fires when the room's owner (its host) is among the receivers — the same-shaped check `receiverId === room.ownerId` the spec describes. Since `ctx` does not carry the room row itself, this task fetches it via the existing `this.rooms` (`VideoRoomsRepository`) already injected into the handler, and the active broadcast session via the existing `getActiveBroadcastSession` method already used elsewhere in this module (`video-room-entry-payment.service.ts` calls `this.repo.getActiveBroadcastSession(roomId)` — same repository, same method, reused here).

- [ ] **Step 1: Check for an existing spec file**

Run: `ls src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts 2>&1 || echo "NOT FOUND"`

If found, read it fully first to match its existing mock setup exactly before adding to it in Step 2. If not found, Step 2 creates a new minimal spec covering only the new behavior (not a full re-test of `validate()`/existing `onSend()` treasure/PK behavior, which is already covered elsewhere or out of this task's scope).

- [ ] **Step 2: Write the failing test**

Add (or create) in `src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`:

```ts
describe('VideoRoomGiftContextHandler — gift-lock grant', () => {
  let handler: VideoRoomGiftContextHandler;
  let rooms: any;
  let giftLockAccessRepo: any;
  let tx: any;

  beforeEach(() => {
    rooms = {
      findById: jest.fn(),
      getActiveBroadcastSession: jest.fn(),
    };
    giftLockAccessRepo = { grantAccess: jest.fn().mockResolvedValue({ id: 'access-1' }) };
    tx = {};

    // Construct with the handler's other existing collaborators as no-op
    // mocks (moderation/config/registry/treasureProgress/queue/pkScoring/bus)
    // — mirror however the existing describe block in this file already
    // constructs `handler` for its `onSend` tests, adding `giftLockAccessRepo`
    // as one more constructor argument (see Step 3 for the exact new
    // constructor parameter position).
  });

  it('grants gift-lock access when the required gift is sent to the room owner', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });

    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });

    expect(giftLockAccessRepo.grantAccess).toHaveBeenCalledWith(
      {
        userId: 'sender-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        giftId: 'gift-required',
        giftTransactionId: 'txn-1',
      },
      tx,
    );
  });

  it('does nothing when the room does not have gift-lock enabled', async () => {
    rooms.findById.mockResolvedValue({ id: 'room-1', ownerId: 'owner-1', giftLockEnabled: false });
    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });

  it('does nothing when the sent gift is not the required gift', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });
    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-OTHER' },
      transactionId: 'txn-1',
    });
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });

  it('does nothing when the owner is not among the receivers', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });
    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['someone-else'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });
});
```

Note: `grantGiftLockAccessIfApplicable` is called with a minimal object shaped like `GiftSendContext` (per `src/modules/gifts/interfaces/gift-context-handler.interface.ts`, confirmed: the sent gift is `ctx.gift: Gift`, a full catalog row, not a bare `ctx.giftId` string) — only the fields the method under test actually reads are populated (`gift.id` is all `Gift` needs here, so a plain `{ id: ... }` cast stands in for the full `Gift` row).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
Expected: FAIL — `(handler as any).grantGiftLockAccessIfApplicable is not a function`

- [ ] **Step 4: Add the repository dependency and the grant method**

In `src/modules/video-rooms/services/video-room-gift-context.handler.ts`:
- Add `import { VideoRoomGiftLockAccessRepository } from '../repositories/video-room-gift-lock-access.repository';`
- Add `private readonly giftLockAccessRepo: VideoRoomGiftLockAccessRepository,` to the constructor (after `pkScoring`, before the `@Inject(EVENT_BUS)` line — keep all `@Optional()` params last, matching the existing ordering convention in this constructor).
- Add a new private method (using whichever exact field name Step 2 confirmed from `GiftSendContext`):

```ts
  /**
   * Grants VideoRoomGiftLockAccess when this send is the room's designated
   * entry gift, addressed to the room owner, while gift-lock is enabled.
   * Best-effort: a failure here must never fail an already-paid gift send,
   * matching this handler's existing treasure/PK guard convention.
   */
  private async grantGiftLockAccessIfApplicable(
    tx: Prisma.TransactionClient,
    ctx: GiftSendContext,
  ): Promise<void> {
    try {
      const room = await this.rooms.findById(ctx.contextId);
      if (!room?.giftLockEnabled || !room.requiredEntryGiftId) return;
      if (ctx.gift.id !== room.requiredEntryGiftId) return;
      if (!ctx.receiverIds.includes(room.ownerId)) return;

      const activeSession = await this.rooms.getActiveBroadcastSession(ctx.contextId);
      if (!activeSession) return;

      await this.giftLockAccessRepo.grantAccess(
        {
          userId: ctx.senderId,
          roomId: ctx.contextId,
          sessionId: activeSession.id,
          giftId: ctx.gift.id,
          giftTransactionId: ctx.transactionId,
        },
        tx,
      );
    } catch (err) {
      this.logger.warn(
        `Gift-lock access grant failed for room ${ctx.contextId}: ${(err as Error).message}`,
      );
    }
  }
```

- [ ] **Step 5: Call it from `onSend()`**

In the same file's `onSend()` method (~line 195-210), add the call right after `const pk = await this.applyPk(tx, ctx);` and before the `if (!treasure.postCommit && !pk.mirror)` check:

```ts
    await this.grantGiftLockAccessIfApplicable(tx, ctx);
```

This runs unconditionally (not gated by the treasure/PK early-return), since gift-lock access must be granted regardless of whether the room has a treasure ladder or PK battle active.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
Expected: PASS (all new tests, plus every pre-existing test in this file still green — a regression here would mean Step 5's placement broke the treasure/PK inert-return path)

- [ ] **Step 7: Register the new repository as a handler dependency**

Confirm `VideoRoomGiftLockAccessRepository` is already in `video-rooms.module.ts`'s `providers` (it was added in Task 2, Step 5) — no module change needed here since Nest resolves it by type.

- [ ] **Step 8: Commit**

```bash
git add src/modules/video-rooms/services/video-room-gift-context.handler.ts src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts
git commit -m "feat(video-rooms): grant gift-lock access when the required gift is sent"
```

---

### Task 6: Join-gate enforcement

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-member.service.ts`
- Test: `src/modules/video-rooms/services/video-room-member.service.spec.ts` (extend existing file)

**Interfaces:**
- Consumes: `VideoRoomGiftLockAccessRepository.hasGrantedAccess` (Task 2).
- Produces: `join()` now throws `VIDEO_ROOM_GIFT_REQUIRED` (402) for a non-member, non-privileged, non-moderator joiner of a gift-locked room with no granted access — response payload carries enough to render the client dialog without a refetch.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/video-rooms/services/video-room-member.service.spec.ts` (mirror however the existing paid-entry test in this file constructs the service and mocks `entryAccessRepo`/`repo` — add `giftLockAccessRepo` as one more mock alongside it):

```ts
  describe('join — gift-lock gate', () => {
    it('throws VIDEO_ROOM_GIFT_REQUIRED for a new viewer with no granted access', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null); // not already a member
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });
      giftLockAccessRepo.hasGrantedAccess.mockResolvedValue(false);

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).rejects.toMatchObject({ response: { code: 'VIDEO_ROOM_GIFT_REQUIRED' } });
    });

    it('allows join when gift-lock access was already granted', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null);
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });
      giftLockAccessRepo.hasGrantedAccess.mockResolvedValue(true);

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
    });

    it('never gates the room owner', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue(null);
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });

      await expect(
        service.join({ id: 'owner-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
      expect(giftLockAccessRepo.hasGrantedAccess).not.toHaveBeenCalled();
    });

    it('never gates an already-active member (e.g. a seat-holder)', async () => {
      repo.findById.mockResolvedValue({
        id: 'room-1',
        ownerId: 'owner-1',
        status: 'LIVE',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-1',
        maxViewers: 100,
      });
      repo.getMember.mockResolvedValue({ isActive: true });
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 'session-1',
        paidEntryEnabled: false,
      });

      await expect(
        service.join({ id: 'viewer-1', roles: [] }, 'room-1', {}, { socketId: 'sock-1' }),
      ).resolves.toBeDefined();
      expect(giftLockAccessRepo.hasGrantedAccess).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-member.service.spec.ts -t "gift-lock gate"`
Expected: FAIL — either a constructor arity error (missing `giftLockAccessRepo` mock argument) or the 402 never being thrown, depending on how the spec's `beforeEach` is structured. Fix the constructor call to pass a `giftLockAccessRepo` mock (`{ hasGrantedAccess: jest.fn() }`) as part of this step before re-running, so the failure you see is specifically "no error thrown" / "wrong error", not an arity crash.

- [ ] **Step 3: Add the constructor dependency**

In `src/modules/video-rooms/services/video-room-member.service.ts`:
- Add `import { VideoRoomGiftLockAccessRepository } from '../repositories/video-room-gift-lock-access.repository';`
- Add `private readonly giftLockAccessRepo: VideoRoomGiftLockAccessRepository,` to the constructor, right after `private readonly entryAccessRepo: VideoRoomEntryAccessRepository,` (~line 104).

- [ ] **Step 4: Add the gate**

In the same file's `join()` method, insert this block immediately after the existing paid-entry-access check closes (right after the `}` that ends the `if (!privileged && !isModerator) { ... }` paid-entry block, ~line 198, and before `if (isModerator) {`):

```ts
      // Gift-lock access check for non-privileged, non-moderator NEW joiners.
      // An already-active member (including any seat-holder, since taking a
      // seat requires having joined first) is never re-gated here.
      if (!privileged && !isModerator && !alreadyMember && room.giftLockEnabled) {
        const activeSession = await this.repo.getActiveBroadcastSession(roomId);
        if (activeSession) {
          const hasAccess = await this.giftLockAccessRepo.hasGrantedAccess(
            actor.id,
            activeSession.id,
          );
          if (!hasAccess) {
            throw this.err(
              ERROR_CODES.VIDEO_ROOM_GIFT_REQUIRED,
              'This room requires sending its entry gift before you can join.',
              HttpStatus.PAYMENT_REQUIRED,
            );
          }
        }
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-member.service.spec.ts`
Expected: PASS (the 4 new tests, plus every pre-existing test in the file — a regression would mean the insertion point shifted behavior for the password or paid-entry gates above it)

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/services/video-room-member.service.ts src/modules/video-rooms/services/video-room-member.service.spec.ts
git commit -m "feat(video-rooms): enforce the gift-lock gate on join"
```

---

### Task 7: Surface the required gift on the room detail view

**Files:**
- Modify: `src/modules/video-rooms/entities/video-room-detail.view.ts`
- Modify: `src/modules/video-rooms/mappers/video-room-detail.mapper.ts`
- Test: `src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts` (extend if it exists; check with `ls`)

**Interfaces:**
- Produces: `VideoRoomDetailView.giftLockEnabled: boolean` and `VideoRoomDetailView.requiredEntryGift: { id: string; name: string; thumbnailUrl: string | null; coinValue: number } | null` — this is what the mobile client reads to render the settings toggle state and the "required gift" dialog content without a second fetch.

This task exists because Task 3/6 write/read the raw `giftLockEnabled`/`requiredEntryGiftId` columns, but nothing yet exposes them (with the gift's display info resolved) on the view the mobile app actually consumes from `GET /video-rooms/:id`.

- [ ] **Step 1: Check for an existing mapper spec**

Run: `ls src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts 2>&1 || echo "NOT FOUND"`

- [ ] **Step 2: Write the failing test**

If the spec file exists, add this test to it (matching its existing input-building helpers); if not, create it with a minimal fixture matching whatever shape `toVideoRoomDetailView` already expects for its other fields (read the mapper file first to build a valid minimal input row):

```ts
  it('includes the resolved required entry gift when gift-lock is enabled', () => {
    const room = {
      /* ...whatever minimal fields the existing fixture in this file uses..., */
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-1',
    };
    const requiredGift = { id: 'gift-1', name: 'Rose', thumbnailUrl: 'https://x/rose.png', coinValue: 10 };
    const view = toVideoRoomDetailView(room, { requiredEntryGift: requiredGift });
    expect(view.giftLockEnabled).toBe(true);
    expect(view.requiredEntryGift).toEqual({
      id: 'gift-1',
      name: 'Rose',
      thumbnailUrl: 'https://x/rose.png',
      coinValue: 10,
    });
  });

  it('omits the required gift when gift-lock is disabled', () => {
    const room = { /* ...same minimal fixture..., */ giftLockEnabled: false, requiredEntryGiftId: null };
    const view = toVideoRoomDetailView(room, {});
    expect(view.giftLockEnabled).toBe(false);
    expect(view.requiredEntryGift).toBeNull();
  });
```

**Read the actual current signature of `toVideoRoomDetailView` in `video-room-detail.mapper.ts` before writing this test** — it may take a single room argument or `(room, extras)`; Step 4 below adds a new optional second parameter only if one doesn't already exist for extras like this (settings, entry status, etc. — check whether the paid-entry `entryStatus` fields are already threaded through this same mapper via an extras argument, and follow that exact existing pattern rather than inventing a new one).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts`
Expected: FAIL — `view.giftLockEnabled` is `undefined`.

- [ ] **Step 4: Add the fields to the view type and mapper**

In `src/modules/video-rooms/entities/video-room-detail.view.ts`, add to `VideoRoomDetailView`:

```ts
  giftLockEnabled: boolean;
  requiredEntryGift: { id: string; name: string; thumbnailUrl: string | null; coinValue: number } | null;
```

In `src/modules/video-rooms/mappers/video-room-detail.mapper.ts`, populate them from the room row plus a resolved gift (fetched by the caller — the query service — the same way any other cross-module lookup already feeds this mapper; follow the existing pattern for how paid-entry's `entryFee`/`paidEntryEnabled` or similar cross-cutting fields get into this view).

- [ ] **Step 5: Wire the gift lookup in the query service**

In `src/modules/video-rooms/services/video-room-query.service.ts`'s `getDetail()`, when `room.giftLockEnabled && room.requiredEntryGiftId`, call the injected `IGiftsService.getGift(room.requiredEntryGiftId)` (already available via `GIFTS_SERVICE` injection if this service already depends on it — check; if not, add the same `@Inject(GIFTS_SERVICE) private readonly gifts: IGiftsService` dependency the gift-lock service uses) and pass `{ id, name, thumbnailUrl, coinValue }` into the mapper's extras.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/video-rooms/entities/video-room-detail.view.ts src/modules/video-rooms/mappers/video-room-detail.mapper.ts src/modules/video-rooms/mappers/video-room-detail.mapper.spec.ts src/modules/video-rooms/services/video-room-query.service.ts
git commit -m "feat(video-rooms): surface the resolved required entry gift on the room detail view"
```

---

### Task 8: Remove the old password-lock feature (schema + code)

**Do this task only after the companion mobile plan's tasks that switch the settings UI and join-error handling over to gift-lock have shipped** — this task removes the endpoints and columns the old mobile code called.

**Files:**
- Modify: `prisma/schema/video_rooms.prisma` (drop `isLocked`, `passwordHash`; update lifecycle projection)
- Delete: `src/modules/video-rooms/services/video-room-password.service.ts` (+ its spec, if any)
- Delete: `src/modules/video-rooms/dto/lock-video-room.dto.ts`
- Modify: `src/modules/video-rooms/services/video-room-lifecycle.service.ts` (remove `lock`/`unlock`/`computeLockPatch`, the `passwords` dependency, the `LockPatch` interface, `METADATA_ACCESS_POLICIES`'s `PASSWORD` entry if now unreachable — check `deriveAccessPolicy` usage first)
- Modify: `src/modules/video-rooms/controllers/video-rooms.controller.ts` (remove `lock`/`unlock` endpoints and their DTO import)
- Modify: `src/modules/video-rooms/controllers/video-rooms-admin.controller.ts` (remove the admin lock override endpoint)
- Modify: `src/modules/video-rooms/services/video-rooms-admin.service.ts` (remove `setLock()`)
- Modify: `src/modules/video-rooms/events/video-room.events.ts` (remove `RoomLockedEvent`, `VIDEO_ROOM_EVENTS.LOCKED`)
- Modify: `src/modules/video-rooms/listeners/video-room-socket.listener.ts` (remove the `RoomLockedEvent` subscription)
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (remove `VIDEO_ROOM_SOCKET_EVENTS.LOCKED`, the password bounds/salt constants if nothing else uses them — grep first)
- Modify: `src/modules/video-rooms/services/video-room-member.service.ts` (remove the password gate block, the `passwords` dependency, the `password` field from `join()`'s dto type)
- Modify: `src/modules/video-rooms/constants/video-room-lifecycle.ts` (`projectLifecycleState`'s `LOCKED` branch now reads `giftLockEnabled`; `deriveAccessPolicy`'s `PASSWORD` branch is removed since nothing sets it anymore — a gift-locked room's `AccessPolicyProjectionInput` needs a `giftLockEnabled` field added and a policy value for it, e.g. reuse `VideoRoomAccessPolicy.PASSWORD` renamed or add a new enum value — **flag this specific rename/addition to the user for confirmation before implementing**, since the spec did not settle the exact enum value name for gift-gated access policy)
- Modify: every file the Task 1 research already identified referencing `isLocked`/`passwordHash` for type/serialization purposes (mappers, views, DTOs) — enumerate with the command in Step 1
- Modify/Delete: the corresponding `.spec.ts` files for every service above that tested lock/unlock behavior

**Interfaces:** none produced — this is pure removal plus the lifecycle-projection field swap described above.

- [ ] **Step 1: Enumerate every remaining reference before touching code**

Run: `grep -rln "isLocked\|passwordHash" src/modules/video-rooms --include="*.ts" | sort`

Save this list — work through it file by file in the steps below rather than guessing at the full set up front, since some are logic (this task's real work) and many are just type declarations that need the field removed.

- [ ] **Step 2: Remove the service logic**

In `video-room-lifecycle.service.ts`: delete the `// ---- Lock / unlock ----` section (`lock()`, `unlock()`), the `LockPatch` interface, `computeLockPatch()`, the `passwords: VideoRoomPasswordService` constructor param, and the now-unused `LockVideoRoomDto` import. In `video-room-member.service.ts`: delete the `if (room.isLocked && room.passwordHash ...)` block (~lines 161-175) and the `passwords: VideoRoomPasswordService` constructor param. Delete `video-room-password.service.ts` and its spec file entirely.

- [ ] **Step 3: Remove the endpoints**

Delete the `lock`/`unlock` methods from `video-rooms.controller.ts` and the admin lock override from `video-rooms-admin.controller.ts` + `setLock()` from `video-rooms-admin.service.ts`. Delete `lock-video-room.dto.ts` and `video-room-admin.dto.ts`'s `LockRoomAdminDto` (only that export — check the file isn't otherwise still needed for other admin DTOs before deleting the whole file).

- [ ] **Step 4: Remove the event/socket wiring**

Delete `RoomLockedEvent` and the `LOCKED` entry from `VIDEO_ROOM_EVENTS` in `video-room.events.ts`; delete its subscription in `video-room-socket.listener.ts`; delete `VIDEO_ROOM_SOCKET_EVENTS.LOCKED` in `video-room.constants.ts`.

- [ ] **Step 5: Update the lifecycle projection**

In `video-room-lifecycle.ts`: change `LifecycleProjectionInput.isLocked: boolean` to `giftLockEnabled: boolean`, and in `projectLifecycleState`, change `if (room.isLocked) return VideoRoomLifecycleState.LOCKED;` to `if (room.giftLockEnabled) return VideoRoomLifecycleState.LOCKED;`. For `deriveAccessPolicy`/`AccessPolicyProjectionInput`'s `PASSWORD` branch — **stop here and confirm with the user** whether to (a) drop the `PASSWORD` policy value entirely and derive `PUBLIC`/`PRIVATE` only from base visibility for a gift-locked room, or (b) rename/repurpose it to reflect gift-gating. Do not guess past this point in this step; this is the one open design question this plan did not resolve.

- [ ] **Step 6: Run the whole video-rooms test suite and fix every compile/type error the removal surfaced**

Run: `npx jest src/modules/video-rooms --silent 2>&1 | tail -100`

Work through failures file by file using the Step 1 list — most will be tests that directly exercised `lock()`/`unlock()` (delete those `describe` blocks) or fixtures that set `isLocked`/`passwordHash` on a mock room object (just delete those two lines from the fixture; nothing else in an unrelated test should reference them).

- [ ] **Step 7: Migration**

Run: `npx prisma migrate dev --name remove_video_room_password_lock`
Expected: `ALTER TABLE "video_rooms" DROP COLUMN "isLocked", DROP COLUMN "passwordHash";`. As in Task 1 Step 5, never confirm an unrelated dev-DB-reset prompt if one appears — stop and report instead.

- [ ] **Step 8: Full suite green**

Run: `npx jest src/modules/video-rooms`
Expected: PASS, zero failures.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(video-rooms): remove the password-based room lock, superseded by gift-lock"
```
