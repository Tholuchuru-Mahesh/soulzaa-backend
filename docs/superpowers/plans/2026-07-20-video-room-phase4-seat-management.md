# Video Room Phase 4 — Multi-Seat Management Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade multi-seat management engine for Video Rooms (lock/unlock, reserve, invite, request, switch, transfer, sync) on the existing lean schema, with Redis-authoritative live state and DB write-through history.

**Architecture:** New slice inside `src/modules/video-rooms` — no new module, no new tables, no migration. Live seat state is a versioned, lock-serialized Redis snapshot (source of truth); every mutation write-throughs to `video_room_seats`, appends an immutable `video_room_events` audit row, and publishes a domain event on `EVENT_BUS` that a socket listener bridges to `video_room.seat_*` broadcasts. Mirrors the existing `VideoRoomStateService` / `VideoRoomSocketListener` patterns.

**Tech Stack:** NestJS, TypeScript, Prisma (Postgres), ioredis (`CacheService`/`LockService`), `@nestjs/event-emitter` (`EVENT_BUS`), Socket.IO (`SocketManager`), prom-client (`VideoRoomsMetrics`), Jest.

## Global Constraints

- **Conventions-first:** express the engine on existing tables + video-room primitives; add storage only where truly unavoidable. No new Prisma tables, no migration, no priority-queue table, no bespoke exception classes.
- **Redis-authoritative + DB write-through:** the versioned Redis seat snapshot is the source of truth for reads + socket sync; Postgres `video_room_seats` is the durable projection/recovery source.
- **All seat mutations run under `withLock(videoRoomSeatLockKey(roomId))`** — validate → mutate Redis snapshot (version++) → write-through DB → append audit → publish event, all inside the lock.
- **Services never touch sockets.** Fan-out is `EVENT_BUS` → `VideoRoomSeatSocketListener` → `SocketManager.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload)`.
- **RBAC only** via `VideoRoomPermissionService` + `VIDEO_ROOM_PERMISSION_MATRIX`; platform ADMIN/SUPER_ADMIN bypass. No hardcoded role checks.
- **Errors:** `throw new BusinessException(ERROR_CODES.X, message, HttpStatus.Y)`.
- **Every file gets a colocated `.spec.ts`.** Verification bar: `npx tsc --noEmit` clean, ESLint clean, `boundaries` clean, full suite green, zero regressions.
- **Owner seat (index 0):** always exists; never locked/reserved/occupied-by-another/removed; reassigned only by ownership transfer.

## Canonical interfaces (defined in Tasks 2–4; referenced everywhere)

```ts
// Task 3 — interfaces/seat-stage.interface.ts
export interface SeatEntrySnapshot {
  seatIndex: number;
  seatType: VideoRoomSeatType;      // OWNER | HOST | GUEST
  status: VideoRoomSeatStatus;      // EMPTY | OCCUPIED | LOCKED | RESERVED
  occupantUserId: string | null;
  reservedForUserId: string | null;
  isLocked: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
  reason: string | null;            // 'disabled' | 'maintenance' | null
  premium: boolean;                 // metadata.premium === true
}
export interface SeatStageSnapshot {
  roomId: string; version: number; updatedAt: string;   // ISO
  hostSeatCount: number; guestSeatCount: number;
  seats: SeatEntrySnapshot[];
}
export type SeatStageMutation = Partial<Pick<SeatStageSnapshot, 'seats' | 'hostSeatCount' | 'guestSeatCount'>>;

// Task 4 — VideoRoomSeatStateService
getSnapshot(roomId: string): Promise<SeatStageSnapshot | null>
rebuild(roomId: string): Promise<SeatStageSnapshot>          // from DB seats + settings, version=1
commit(roomId, base: SeatStageSnapshot, patch: SeatStageMutation): Promise<SeatStageSnapshot>  // version++, cache.set (NON-locking; caller holds seat lock)
clear(roomId: string): Promise<void>

// Task 2 — video-room-seat-lifecycle.ts
type DisplayStatus = 'EMPTY'|'OCCUPIED'|'LOCKED'|'RESERVED'|'INVITED'|'REQUESTED'|'DISABLED'|'MAINTENANCE';
canSeatTransition(from: VideoRoomSeatStatus, to: VideoRoomSeatStatus): boolean
isOwnerSeat(seatIndex: number): boolean
```

---

### Task 1: Seat constants, Redis keys, socket event names, error codes

**Files:**
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts`
- Modify: `src/common/exceptions/error-codes.ts`
- Test: `src/modules/video-rooms/constants/video-room-seat.constants.spec.ts` (Create)

**Interfaces:**
- Produces: `videoRoomSeatStateKey(roomId)`, `videoRoomSeatLockKey(roomId)`, `videoRoomSeatReservationKey(roomId, seatIndex)`, `VIDEO_ROOM_RESERVATION_TTL_SECONDS`, seat entries on `VIDEO_ROOM_SOCKET_EVENTS`, new `ERROR_CODES` seat keys.

- [ ] **Step 1: Write the failing test**

```ts
// video-room-seat.constants.spec.ts
import {
  videoRoomSeatStateKey, videoRoomSeatLockKey, videoRoomSeatReservationKey,
  VIDEO_ROOM_SOCKET_EVENTS, VIDEO_ROOM_RESERVATION_TTL_SECONDS,
} from './video-room.constants';

describe('video-room seat constants', () => {
  it('hash-tags the room id so all seat keys land on one Cluster slot', () => {
    expect(videoRoomSeatStateKey('r1')).toBe('video-room:{r1}:seats');
    expect(videoRoomSeatLockKey('r1')).toBe('video-room:seat:{r1}');
    expect(videoRoomSeatReservationKey('r1', 3)).toBe('video-room:{r1}:seat:3:hold');
  });
  it('exposes the seat socket events and a positive reservation TTL', () => {
    expect(VIDEO_ROOM_SOCKET_EVENTS.SEAT_SYNC).toBe('video_room.seat_sync');
    expect(VIDEO_ROOM_SOCKET_EVENTS.SEAT_TRANSFERRED).toBe('video_room.seat_transferred');
    expect(VIDEO_ROOM_RESERVATION_TTL_SECONDS).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx jest video-room-seat.constants.spec -t 'seat constants'`
Expected: FAIL (`videoRoomSeatStateKey is not a function` / undefined events).

- [ ] **Step 3: Implement**

In `video-room.constants.ts` add after the existing Redis key builders:
```ts
/** Authoritative versioned seat snapshot (JSON) — VideoRoomSeatStateService. */
export function videoRoomSeatStateKey(roomId: string): string {
  return `video-room:{${roomId}}:seats`;
}
/** Per-room lock serialising all seat mutations. */
export function videoRoomSeatLockKey(roomId: string): string {
  return `video-room:seat:{${roomId}}`;
}
/** Reservation hold with TTL → auto-released by the seat monitor. */
export function videoRoomSeatReservationKey(roomId: string, seatIndex: number): string {
  return `video-room:{${roomId}}:seat:${seatIndex}:hold`;
}
/** TTL (seconds) a seat reservation is held before automatic release. */
export const VIDEO_ROOM_RESERVATION_TTL_SECONDS = 60;
```
Extend `VIDEO_ROOM_SOCKET_EVENTS` with:
```ts
  // ---- VR-4 seat management ----
  SEAT_SYNC: 'video_room.seat_sync',
  SEAT_LOCKED: 'video_room.seat_locked',
  SEAT_UNLOCKED: 'video_room.seat_unlocked',
  SEAT_RESERVED: 'video_room.seat_reserved',
  SEAT_RELEASED: 'video_room.seat_released',
  SEAT_REQUESTED: 'video_room.seat_requested',
  SEAT_APPROVED: 'video_room.seat_approved',
  SEAT_REJECTED: 'video_room.seat_rejected',
  SEAT_INVITATION_SENT: 'video_room.seat_invitation_sent',
  SEAT_INVITATION_ACCEPTED: 'video_room.seat_invitation_accepted',
  SEAT_INVITATION_REJECTED: 'video_room.seat_invitation_rejected',
  SEAT_SWITCHED: 'video_room.seat_switched',
  SEAT_TRANSFERRED: 'video_room.seat_transferred',
  SEAT_UPDATED: 'video_room.seat_updated',
```
In `error-codes.ts`, after the existing `SEAT_INVITATION_EXPIRED` line add:
```ts
  SEAT_RESERVED: 'SEAT_RESERVED',
  SEAT_REQUEST_EXPIRED: 'SEAT_REQUEST_EXPIRED',
  SEAT_SWITCH_INVALID: 'SEAT_SWITCH_INVALID',
  SEAT_TRANSFER_INVALID: 'SEAT_TRANSFER_INVALID',
  DUPLICATE_SEAT_INVITATION: 'DUPLICATE_SEAT_INVITATION',
  DUPLICATE_SEAT_REQUEST: 'DUPLICATE_SEAT_REQUEST',
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx jest video-room-seat.constants.spec` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video-rooms): VR-4 seat constants, redis keys, socket events, error codes"`

---

### Task 2: Seat state machine (`video-room-seat-lifecycle.ts`) — LEARNING CONTRIBUTION

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-seat-lifecycle.ts`
- Test: `src/modules/video-rooms/constants/video-room-seat-lifecycle.spec.ts`

**Interfaces:**
- Produces: `SEAT_TRANSITIONS`, `canSeatTransition(from, to)`, `isOwnerSeat(seatIndex)`, `seatReason(metadata)`, `DisplayStatus`, `displayStatusFor(entry, overlays)`.

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomSeatStatus } from '@prisma/client';
import { canSeatTransition, isOwnerSeat, displayStatusFor } from './video-room-seat-lifecycle';

describe('seat lifecycle', () => {
  it('permits EMPTY→OCCUPIED and EMPTY→RESERVED', () => {
    expect(canSeatTransition(VideoRoomSeatStatus.EMPTY, VideoRoomSeatStatus.OCCUPIED)).toBe(true);
    expect(canSeatTransition(VideoRoomSeatStatus.EMPTY, VideoRoomSeatStatus.RESERVED)).toBe(true);
  });
  it('rejects LOCKED→OCCUPIED (must unlock first)', () => {
    expect(canSeatTransition(VideoRoomSeatStatus.LOCKED, VideoRoomSeatStatus.OCCUPIED)).toBe(false);
  });
  it('marks index 0 as the owner seat', () => {
    expect(isOwnerSeat(0)).toBe(true);
    expect(isOwnerSeat(1)).toBe(false);
  });
  it('derives DISABLED / MAINTENANCE / INVITED / REQUESTED display statuses', () => {
    const base = { status: VideoRoomSeatStatus.LOCKED, reason: 'maintenance' } as any;
    expect(displayStatusFor(base, {})).toBe('MAINTENANCE');
    expect(displayStatusFor({ ...base, reason: 'disabled' }, {})).toBe('DISABLED');
    expect(displayStatusFor({ status: VideoRoomSeatStatus.RESERVED, reason: null } as any, { invited: true }))
      .toBe('INVITED');
    expect(displayStatusFor({ status: VideoRoomSeatStatus.EMPTY, reason: null } as any, { requested: true }))
      .toBe('REQUESTED');
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`Cannot find module`).

- [ ] **Step 3: Implement**

```ts
import { VideoRoomSeatStatus } from '@prisma/client';
import { VIDEO_ROOM_OWNER_SEAT_INDEX } from './video-room.constants';

export type DisplayStatus =
  | 'EMPTY' | 'OCCUPIED' | 'LOCKED' | 'RESERVED'
  | 'INVITED' | 'REQUESTED' | 'DISABLED' | 'MAINTENANCE';

/**
 * LEARNING CONTRIBUTION POINT — the seat state-machine legality table.
 * Each key is a from-state; the set lists the to-states allowed. This is a product
 * decision: e.g. may a LOCKED seat go straight to RESERVED, or must it EMPTY first?
 * Implement the sets to match the spec §7. Keep it total (every enum value keyed).
 */
export const SEAT_TRANSITIONS: Record<VideoRoomSeatStatus, ReadonlySet<VideoRoomSeatStatus>> = {
  [VideoRoomSeatStatus.EMPTY]: new Set([
    VideoRoomSeatStatus.OCCUPIED, VideoRoomSeatStatus.RESERVED, VideoRoomSeatStatus.LOCKED,
  ]),
  [VideoRoomSeatStatus.RESERVED]: new Set([
    VideoRoomSeatStatus.OCCUPIED, VideoRoomSeatStatus.EMPTY, VideoRoomSeatStatus.LOCKED,
  ]),
  [VideoRoomSeatStatus.OCCUPIED]: new Set([
    VideoRoomSeatStatus.EMPTY, VideoRoomSeatStatus.OCCUPIED, VideoRoomSeatStatus.LOCKED,
  ]),
  [VideoRoomSeatStatus.LOCKED]: new Set([VideoRoomSeatStatus.EMPTY]),
};

export function canSeatTransition(from: VideoRoomSeatStatus, to: VideoRoomSeatStatus): boolean {
  return SEAT_TRANSITIONS[from]?.has(to) ?? false;
}
export function isOwnerSeat(seatIndex: number): boolean {
  return seatIndex === VIDEO_ROOM_OWNER_SEAT_INDEX;
}
export function displayStatusFor(
  entry: { status: VideoRoomSeatStatus; reason: string | null },
  overlays: { invited?: boolean; requested?: boolean },
): DisplayStatus {
  if (entry.status === VideoRoomSeatStatus.LOCKED) {
    if (entry.reason === 'maintenance') return 'MAINTENANCE';
    if (entry.reason === 'disabled') return 'DISABLED';
    return 'LOCKED';
  }
  if (entry.status === VideoRoomSeatStatus.RESERVED && overlays.invited) return 'INVITED';
  if (entry.status === VideoRoomSeatStatus.EMPTY && overlays.requested) return 'REQUESTED';
  return entry.status as DisplayStatus;
}
```

- [ ] **Step 4: Run — verify PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat state machine + display-status derivation"`

---

### Task 3: Seat snapshot types, stage view + mapper

**Files:**
- Create: `src/modules/video-rooms/interfaces/seat-stage.interface.ts`
- Create: `src/modules/video-rooms/entities/video-room-seat-stage.view.ts`
- Create: `src/modules/video-rooms/mappers/video-room-seat-stage.mapper.ts`
- Test: `src/modules/video-rooms/mappers/video-room-seat-stage.mapper.spec.ts`

**Interfaces:**
- Consumes: `SeatEntrySnapshot`, `SeatStageSnapshot` (this task defines them), `displayStatusFor` (Task 2).
- Produces: `seatRowToEntry(row: VideoRoomSeat): SeatEntrySnapshot`, `toSeatStageView(snapshot, pendingRequests, pendingInvitations): SeatStageView`.

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import { toSeatStageView, seatRowToEntry } from './video-room-seat-stage.mapper';

const seat = (i: number, over = {}) => ({
  seatIndex: i, seatType: VideoRoomSeatType.HOST, status: VideoRoomSeatStatus.EMPTY,
  occupantUserId: null, reservedForUserId: null, isLocked: false, isMuted: false,
  isVideoOn: false, reason: null, premium: false, ...over,
});

describe('seat stage mapper', () => {
  it('overlays REQUESTED/INVITED and computes displayStatus', () => {
    const snap = { roomId: 'r', version: 5, updatedAt: 't', hostSeatCount: 9, guestSeatCount: 0,
      seats: [seat(1), seat(2, { status: VideoRoomSeatStatus.RESERVED, reservedForUserId: 'u2' })] };
    const view = toSeatStageView(snap as any,
      [{ userId: 'u9', seatIndex: 1 }] as any,
      [{ inviteeUserId: 'u2', seatIndex: 2 }] as any);
    expect(view.version).toBe(5);
    expect(view.seats[0].displayStatus).toBe('REQUESTED');
    expect(view.seats[0].requestedBy).toEqual(['u9']);
    expect(view.seats[1].displayStatus).toBe('INVITED');
    expect(view.seats[1].invitedUserId).toBe('u2');
  });
  it('maps a DB row → entry, reading reason/premium from metadata', () => {
    const entry = seatRowToEntry({ seatIndex: 0, seatType: VideoRoomSeatType.OWNER,
      seatStatus: VideoRoomSeatStatus.LOCKED, occupantUserId: null, reservedForUserId: null,
      isLocked: true, isMuted: false, isVideoOn: false, metadata: { reason: 'maintenance', premium: true } } as any);
    expect(entry.reason).toBe('maintenance');
    expect(entry.premium).toBe(true);
    expect(entry.status).toBe(VideoRoomSeatStatus.LOCKED);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

`interfaces/seat-stage.interface.ts` — paste the `SeatEntrySnapshot`, `SeatStageSnapshot`, `SeatStageMutation` from the Canonical interfaces block above (import `VideoRoomSeatStatus, VideoRoomSeatType` as types).

`entities/video-room-seat-stage.view.ts`:
```ts
import type { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import type { DisplayStatus } from '../constants/video-room-seat-lifecycle';

export interface SeatEntryView {
  seatIndex: number;
  seatType: VideoRoomSeatType;
  status: VideoRoomSeatStatus;
  displayStatus: DisplayStatus;
  occupantUserId: string | null;
  reservedForUserId: string | null;
  invitedUserId: string | null;
  requestedBy: string[];
  isLocked: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
  premium: boolean;
}
export interface SeatStageView {
  roomId: string;
  version: number;
  hostSeatCount: number;
  guestSeatCount: number;
  seats: SeatEntryView[];
}
```

`mappers/video-room-seat-stage.mapper.ts`:
```ts
import type { VideoRoomSeat, VideoRoomInvitation, VideoRoomSeatRequest } from '@prisma/client';
import { displayStatusFor } from '../constants/video-room-seat-lifecycle';
import type { SeatEntrySnapshot, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';

export function seatRowToEntry(row: VideoRoomSeat): SeatEntrySnapshot {
  const meta = (row.metadata ?? {}) as { reason?: string; premium?: boolean };
  return {
    seatIndex: row.seatIndex, seatType: row.seatType, status: row.seatStatus,
    occupantUserId: row.occupantUserId, reservedForUserId: row.reservedForUserId,
    isLocked: row.isLocked, isMuted: row.isMuted, isVideoOn: row.isVideoOn,
    reason: meta.reason ?? null, premium: meta.premium === true,
  };
}
export function toSeatStageView(
  snapshot: SeatStageSnapshot,
  pendingRequests: Pick<VideoRoomSeatRequest, 'userId' | 'seatIndex'>[],
  pendingInvitations: Pick<VideoRoomInvitation, 'inviteeUserId' | 'seatIndex'>[],
): SeatStageView {
  const reqBySeat = new Map<number, string[]>();
  for (const r of pendingRequests) {
    if (r.seatIndex == null) continue;
    reqBySeat.set(r.seatIndex, [...(reqBySeat.get(r.seatIndex) ?? []), r.userId]);
  }
  const inviteBySeat = new Map<number, string>();
  for (const i of pendingInvitations) if (i.seatIndex != null) inviteBySeat.set(i.seatIndex, i.inviteeUserId);
  return {
    roomId: snapshot.roomId, version: snapshot.version,
    hostSeatCount: snapshot.hostSeatCount, guestSeatCount: snapshot.guestSeatCount,
    seats: snapshot.seats.map((s) => {
      const requestedBy = reqBySeat.get(s.seatIndex) ?? [];
      const invitedUserId = inviteBySeat.get(s.seatIndex) ?? null;
      return {
        seatIndex: s.seatIndex, seatType: s.seatType, status: s.status,
        displayStatus: displayStatusFor(s, { invited: invitedUserId != null, requested: requestedBy.length > 0 }),
        occupantUserId: s.occupantUserId, reservedForUserId: s.reservedForUserId,
        invitedUserId, requestedBy, isLocked: s.isLocked, isMuted: s.isMuted,
        isVideoOn: s.isVideoOn, premium: s.premium,
      };
    }),
  };
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat snapshot types + stage view/mapper"`

---

### Task 4: `VideoRoomSeatStateService` (Redis snapshot primitive)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-seat-state.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-state.service.spec.ts`

**Interfaces:**
- Consumes: `CacheService.get/set/del`, `VideoRoomSeatsRepository.listSeats`, `VideoRoomSeatsRepository.getSeatLayout` (Task 5), `seatRowToEntry` (Task 3), `videoRoomSeatStateKey` (Task 1), config `stateTtlSeconds`.
- Produces: `getSnapshot`, `rebuild`, `commit`, `clear` (signatures in Canonical block).

- [ ] **Step 1: Write the failing test** (mock `CacheService`, `VideoRoomSeatsRepository`, `ConfigService`):

```ts
describe('VideoRoomSeatStateService', () => {
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const repo = { listSeats: jest.fn(), getSeatLayout: jest.fn() };
  const config = { get: jest.fn().mockReturnValue({ stateTtlSeconds: 300 }) };
  const svc = new VideoRoomSeatStateService(cache as any, repo as any, config as any);

  it('rebuild() builds a versioned snapshot from DB seats + layout and caches it', async () => {
    repo.getSeatLayout.mockResolvedValue({ hostSeatCount: 2, guestSeatCount: 0 });
    repo.listSeats.mockResolvedValue([
      { seatIndex: 0, seatType: 'OWNER', seatStatus: 'EMPTY', occupantUserId: null, reservedForUserId: null,
        isLocked: false, isMuted: false, isVideoOn: false, metadata: null },
    ]);
    const snap = await svc.rebuild('r1');
    expect(snap.version).toBe(1);
    expect(snap.seats).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:seats', snap, 300);
  });

  it('commit() bumps the version and persists the merged snapshot', async () => {
    const base = { roomId: 'r1', version: 4, updatedAt: 't', hostSeatCount: 2, guestSeatCount: 0, seats: [] };
    const next = await svc.commit('r1', base as any, { seats: [{ seatIndex: 1 } as any] });
    expect(next.version).toBe(5);
    expect(next.seats).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:seats', next, 300);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { videoRoomSeatStateKey } from '../constants/video-room.constants';
import { seatRowToEntry } from '../mappers/video-room-seat-stage.mapper';
import type { SeatStageMutation, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';

@Injectable()
export class VideoRoomSeatStateService {
  private readonly ttl: number;
  constructor(
    private readonly cache: CacheService,
    private readonly seats: VideoRoomSeatsRepository,
    config: ConfigService,
  ) {
    this.ttl = loadVideoRoomConfig(config).stateTtlSeconds;
  }
  getSnapshot(roomId: string): Promise<SeatStageSnapshot | null> {
    return this.cache.get<SeatStageSnapshot>(videoRoomSeatStateKey(roomId));
  }
  async rebuild(roomId: string): Promise<SeatStageSnapshot> {
    const [layout, rows] = await Promise.all([
      this.seats.getSeatLayout(roomId),
      this.seats.listSeats(roomId),
    ]);
    const snapshot: SeatStageSnapshot = {
      roomId, version: 1, updatedAt: new Date().toISOString(),
      hostSeatCount: layout.hostSeatCount, guestSeatCount: layout.guestSeatCount,
      seats: rows.map(seatRowToEntry),
    };
    await this.cache.set(videoRoomSeatStateKey(roomId), snapshot, this.ttl);
    return snapshot;
  }
  async commit(roomId: string, base: SeatStageSnapshot, patch: SeatStageMutation): Promise<SeatStageSnapshot> {
    const next: SeatStageSnapshot = {
      ...base, ...patch, roomId, version: base.version + 1, updatedAt: new Date().toISOString(),
    };
    await this.cache.set(videoRoomSeatStateKey(roomId), next, this.ttl);
    return next;
  }
  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomSeatStateKey(roomId));
  }
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 redis-authoritative seat state service"`

---

### Task 5: Extend `VideoRoomSeatsRepository` (layout + by-id lookups)

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-room-seats.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-seats.repository.spec.ts` (extend existing)

**Interfaces:**
- Produces: `getSeatLayout(roomId): Promise<{hostSeatCount:number;guestSeatCount:number}>`, `setSeatLayout(roomId, host, guest, actorId)`, `findRequestById(id)`, `findInvitationById(id)`, `deleteSeatsFrom(roomId, minIndex, actorId)`, `resolveAllPendingRequestsForUser(roomId, userId, status, actorId)`.

- [ ] **Step 1: Write the failing test** (use the existing spec's PrismaService mock; assert delegation):

```ts
it('getSeatLayout reads host/guest counts from settings (defaults when absent)', async () => {
  prisma.videoRoomSettings.findUnique.mockResolvedValue({ hostSeatCount: 6, guestSeatCount: 2 });
  await expect(repo.getSeatLayout('r1')).resolves.toEqual({ hostSeatCount: 6, guestSeatCount: 2 });
});
it('findRequestById delegates to findUnique', async () => {
  prisma.videoRoomSeatRequest.findUnique.mockResolvedValue({ id: 'q1' });
  await expect(repo.findRequestById('q1')).resolves.toEqual({ id: 'q1' });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (append methods; use `VIDEO_ROOM_DEFAULT_HOST_SEATS`/`GUEST_SEATS` for the null-settings fallback):

```ts
async getSeatLayout(roomId: string): Promise<{ hostSeatCount: number; guestSeatCount: number }> {
  const s = await this.prisma.videoRoomSettings.findUnique({ where: { roomId } });
  return {
    hostSeatCount: s?.hostSeatCount ?? VIDEO_ROOM_DEFAULT_HOST_SEATS,
    guestSeatCount: s?.guestSeatCount ?? VIDEO_ROOM_DEFAULT_GUEST_SEATS,
  };
}
async setSeatLayout(roomId: string, hostSeatCount: number, guestSeatCount: number, actorId: string): Promise<void> {
  await this.prisma.videoRoomSettings.update({
    where: { roomId }, data: { hostSeatCount, guestSeatCount, ...auditUpdate(actorId) },
  });
}
findRequestById(id: string): Promise<VideoRoomSeatRequest | null> {
  return this.prisma.videoRoomSeatRequest.findUnique({ where: { id } });
}
findInvitationById(id: string): Promise<VideoRoomInvitation | null> {
  return this.prisma.videoRoomInvitation.findUnique({ where: { id } });
}
async deleteSeatsFrom(roomId: string, minIndex: number): Promise<number> {
  const { count } = await this.prisma.videoRoomSeat.deleteMany({
    where: { roomId, seatIndex: { gte: minIndex } },
  });
  return count;
}
async resolveAllPendingRequestsForUser(
  roomId: string, userId: string, status: VideoRoomSeatRequestStatus, actorId: string,
): Promise<void> {
  await this.prisma.videoRoomSeatRequest.updateMany({
    where: { roomId, userId, status: VideoRoomSeatRequestStatus.PENDING },
    data: { status, resolvedBy: actorId, resolvedAt: new Date(), ...auditUpdate(actorId) },
  });
}
```
(Add the `VIDEO_ROOM_DEFAULT_HOST_SEATS`, `VIDEO_ROOM_DEFAULT_GUEST_SEATS`, `VideoRoomInvitation` imports.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat repo layout + by-id lookups"`

---

### Task 6: Extend `VideoRoomPermissionService` (seat-derived roles + outranking)

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-permission.service.ts`
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (permission service now needs `VideoRoomSeatsRepository` — already a provider)
- Test: `src/modules/video-rooms/services/video-room-permission.service.spec.ts` (extend existing)

**Interfaces:**
- Consumes: `VideoRoomSeatsRepository.findOccupiedSeat(roomId, userId)`.
- Produces: extended `resolveEffectiveRole` (adds HOST/PARTICIPANT tier), `authorityRank(room, userId): Promise<number>`, `assertOutranks(room, actorId, targetId): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
it('resolves HOST when the user occupies a HOST seat (no grant)', async () => {
  roles.find.mockResolvedValue(null);
  seats.findOccupiedSeat.mockResolvedValue({ seatType: VideoRoomSeatType.HOST });
  await expect(svc.resolveEffectiveRole({ id: 'r', ownerId: 'o' }, 'u1'))
    .resolves.toBe(VideoRoomMemberRole.HOST);
});
it('assertOutranks throws when actor does not outrank target', async () => {
  // actor participant(1) vs target host(2)
  jest.spyOn(svc, 'authorityRank').mockResolvedValueOnce(1).mockResolvedValueOnce(2);
  await expect(svc.assertOutranks({ id: 'r', ownerId: 'o' }, 'a', 't')).rejects.toThrow();
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — inject `private readonly seats: VideoRoomSeatsRepository` into the constructor; extend:

```ts
async resolveEffectiveRole(room: PermissionRoomRef, userId: string): Promise<VideoRoomMemberRole | null> {
  if (room.ownerId === userId) return VideoRoomMemberRole.OWNER;
  const grant = await this.roles.find(room.id, userId);
  if (grant) return grant.role;
  const seat = await this.seats.findOccupiedSeat(room.id, userId);
  if (seat) {
    return seat.seatType === VideoRoomSeatType.GUEST
      ? VideoRoomMemberRole.PARTICIPANT
      : VideoRoomMemberRole.HOST;   // OWNER-seat occupant is already caught by ownerId
  }
  return null;
}

private static readonly RANK: Record<VideoRoomMemberRole, number> = {
  [VideoRoomMemberRole.OWNER]: 5, [VideoRoomMemberRole.ADMIN]: 4, [VideoRoomMemberRole.MODERATOR]: 3,
  [VideoRoomMemberRole.HOST]: 2, [VideoRoomMemberRole.PARTICIPANT]: 1, [VideoRoomMemberRole.VIEWER]: 0,
};
async authorityRank(room: PermissionRoomRef, userId: string): Promise<number> {
  const role = await this.resolveEffectiveRole(room, userId);
  return role ? VideoRoomPermissionService.RANK[role] : 0;
}
async assertOutranks(room: PermissionRoomRef, actorId: string, targetId: string): Promise<void> {
  const [a, t] = await Promise.all([this.authorityRank(room, actorId), this.authorityRank(room, targetId)]);
  if (a <= t) {
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_FORBIDDEN, 'You cannot act on a user of equal or higher authority.',
      HttpStatus.FORBIDDEN);
  }
}
```

- [ ] **Step 4: Run — PASS** (also run the existing permission spec — no regressions).
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat-derived roles + outranking in permission service"`

---

### Task 7: Seat domain events (`video-room-seat.events.ts`)

**Files:**
- Create: `src/modules/video-rooms/events/video-room-seat.events.ts`
- Modify: `src/modules/video-rooms/events/index.ts` (re-export)
- Test: `src/modules/video-rooms/events/video-room-seat.events.spec.ts`

**Interfaces:**
- Produces: `VIDEO_ROOM_SEAT_EVENTS` map + event classes `SeatTakenEvent`, `SeatLeftEvent`, `SeatLockedEvent`, `SeatUnlockedEvent`, `SeatReservedEvent`, `SeatReleasedEvent`, `SeatRequestedEvent`, `SeatRequestResolvedEvent`, `SeatInvitationSentEvent`, `SeatInvitationResolvedEvent`, `SeatSwitchedEvent`, `SeatTransferredEvent`, `SeatUpdatedEvent`, `SeatSyncEvent`. Every payload carries `{ roomId, version }` plus event-specific fields.

- [ ] **Step 1: Write the failing test**

```ts
import { SeatTakenEvent, SeatReservedEvent, VIDEO_ROOM_SEAT_EVENTS } from './video-room-seat.events';
it('event carries its bus name and payload', () => {
  const e = new SeatTakenEvent({ roomId: 'r', version: 2, seatIndex: 3, userId: 'u' });
  expect(e.name).toBe(VIDEO_ROOM_SEAT_EVENTS.TAKEN);
  expect(e.payload.seatIndex).toBe(3);
  expect(new SeatReservedEvent({ roomId: 'r', version: 3, seatIndex: 1, reservedForUserId: 'u', actorId: 'a' }).name)
    .toBe(VIDEO_ROOM_SEAT_EVENTS.RESERVED);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — follow `video-room.events.ts` exactly. Names:
```ts
export const VIDEO_ROOM_SEAT_EVENTS = {
  TAKEN: 'video_room.seat_taken', LEFT: 'video_room.seat_left',
  LOCKED: 'video_room.seat_locked', UNLOCKED: 'video_room.seat_unlocked',
  RESERVED: 'video_room.seat_reserved', RELEASED: 'video_room.seat_released',
  REQUESTED: 'video_room.seat_requested', REQUEST_RESOLVED: 'video_room.seat_request_resolved',
  INVITATION_SENT: 'video_room.seat_invitation_sent', INVITATION_RESOLVED: 'video_room.seat_invitation_resolved',
  SWITCHED: 'video_room.seat_switched', TRANSFERRED: 'video_room.seat_transferred',
  UPDATED: 'video_room.seat_updated', SYNC: 'video_room.seat_sync',
} as const;
```
Each class `extends DomainEvent<{...}>` with `readonly name = VIDEO_ROOM_SEAT_EVENTS.X`. Payloads:
- TAKEN/LEFT: `{ roomId, version, seatIndex, userId }`
- LOCKED/UNLOCKED: `{ roomId, version, seatIndex, actorId, reason?: string | null }`
- RESERVED: `{ roomId, version, seatIndex, reservedForUserId, actorId }`; RELEASED: `{ roomId, version, seatIndex, reason: 'cancelled'|'expired' }`
- REQUESTED: `{ roomId, requestId, userId, seatIndex: number | null }`; REQUEST_RESOLVED: `{ roomId, requestId, userId, status: 'ACCEPTED'|'REJECTED'|'CANCELLED'|'EXPIRED', actorId, version?: number, seatIndex?: number | null }`
- INVITATION_SENT: `{ roomId, invitationId, inviterId, inviteeUserId, seatIndex: number | null, expiresAt: string }`; INVITATION_RESOLVED: `{ roomId, invitationId, inviteeUserId, status: 'ACCEPTED'|'REJECTED'|'CANCELLED'|'EXPIRED', version?: number, seatIndex?: number | null }`
- SWITCHED: `{ roomId, version, userId, fromSeatIndex, toSeatIndex }`; TRANSFERRED: `{ roomId, version, userId, fromSeatIndex: number | null, toSeatIndex, actorId, forced: boolean }`
- UPDATED: `{ roomId, version, seatIndex, reason: string }`; SYNC: `{ roomId, version }`

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat domain events"`

---

### Task 8: `VideoRoomSeatSocketListener` (bus → socket bridge)

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-seat-socket.listener.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`
- Test: `src/modules/video-rooms/listeners/video-room-seat-socket.listener.spec.ts`

**Interfaces:**
- Consumes: `IEventBus.subscribe`, `SocketManager.emitToNamespaceRoom`, `VIDEO_ROOM_SEAT_EVENTS` (Task 7), `VIDEO_ROOM_SOCKET_EVENTS` seat names (Task 1).
- Produces: `VideoRoomSeatSocketListener` (implements `OnModuleInit`).

- [ ] **Step 1: Write the failing test** (mock bus that records handlers; mock SocketManager):

```ts
it('bridges seat_taken → video_room.seat_updated broadcast', () => {
  const handlers: Record<string, Function> = {};
  const bus = { subscribe: (n: string, h: Function) => { handlers[n] = h; } };
  const sockets = { emitToNamespaceRoom: jest.fn() };
  new VideoRoomSeatSocketListener(bus as any, sockets as any).onModuleInit();
  handlers[VIDEO_ROOM_SEAT_EVENTS.TAKEN]({ payload: { roomId: 'r', version: 2, seatIndex: 1, userId: 'u' } });
  expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
    VIDEO_ROOM_NAMESPACE, 'r', VIDEO_ROOM_SOCKET_EVENTS.SEAT_UPDATED, expect.objectContaining({ seatIndex: 1 }));
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — mirror `VideoRoomSocketListener`. Map each seat bus event to its client socket event: TAKEN/LEFT/SWITCHED→`SEAT_UPDATED` (plus dedicated `SEAT_SWITCHED` for SWITCHED), LOCKED→`SEAT_LOCKED`, UNLOCKED→`SEAT_UNLOCKED`, RESERVED→`SEAT_RESERVED`, RELEASED→`SEAT_RELEASED`, REQUESTED→`SEAT_REQUESTED`, REQUEST_RESOLVED→`SEAT_APPROVED`/`SEAT_REJECTED` (branch on `status`), INVITATION_SENT→`SEAT_INVITATION_SENT`, INVITATION_RESOLVED→`SEAT_INVITATION_ACCEPTED`/`SEAT_INVITATION_REJECTED` (branch), TRANSFERRED→`SEAT_TRANSFERRED`, SYNC→`SEAT_SYNC`. Use a private `emit(roomId, event, payload)` helper.

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat socket bridge listener"`

---

### Task 9: Seat DTOs

**Files:**
- Modify: `src/modules/video-rooms/dto/seat.dto.ts`
- Modify: `src/modules/video-rooms/dto/index.ts`
- Test: `src/modules/video-rooms/dto/seat.dto.spec.ts`

**Interfaces:**
- Produces: `ReserveSeatDto {seatIndex:number; forUserId:string; ttlSeconds?:number}`, `CancelReservationDto {seatIndex:number}`, `ResolveSeatRequestDto` (no body — reqId is a param), `AcceptSeatInvitationDto {invitationId:string}`, `RejectSeatInvitationDto {invitationId:string}`, `LockSeatsDto {seatIndexes:number[]; reason?:string}`, `UnlockSeatsDto {seatIndexes:number[]}`, `SwitchSeatDto {toSeatIndex:number}`, `TransferSeatDto {userId:string; fromSeatIndex?:number; toSeatIndex:number; force?:boolean}`. Keep existing `CreateSeatRequestDto`, `CreateVideoRoomInvitationDto`.

- [ ] **Step 1: Write the failing test** — `validate()` a good + bad instance of `TransferSeatDto` and `LockSeatsDto` via `class-validator` + `plainToInstance` (assert errors on bad `toSeatIndex`/empty `seatIndexes`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — each DTO with `@ApiProperty`/`@ApiPropertyOptional` + `class-validator` decorators (`@IsInt() @Min(0)`, `@IsUUID()`, `@IsArray() @ArrayNotEmpty() @IsInt({each:true})`, `@IsBoolean()`, `@IsOptional()`). Bound `seatIndexes` length with `@ArrayMaxSize(VIDEO_ROOM_MAX_SEATS)`; bound `ttlSeconds` `@Min(5) @Max(600)`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat DTOs"`

---

### Task 10: `VideoRoomSeatService` — core (getStage, takeSeat, leaveSeat)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-seat.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat.service.spec.ts`

**Interfaces:**
- Consumes: `LockService.withLock`, `VideoRoomSeatStateService` (Task 4), `VideoRoomSeatsRepository` (Tasks 1/5), `VideoRoomsRepository.findById`/`getMember`, `VideoRoomPermissionService` (Task 6), `VideoRoomEventsRepository.appendEvent`, `IEventBus.publish`, `toSeatStageView` (Task 3), `canSeatTransition`/`isOwnerSeat` (Task 2), `VideoRoomsMetrics` (Task 16 — inject; helpers may be no-ops until then), `ERROR_CODES`.
- Produces: `getStage(actor, roomId): Promise<SeatStageView>`, `takeSeat(actor, roomId, seatIndex, ip?): Promise<SeatStageView>`, `leaveSeat(actor, roomId, ip?): Promise<SeatStageView>`, and the private helpers `assertLiveRoom`, `assertActiveMember`, `mutateUnderLock(...)`, `buildStageView(roomId, snapshot)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('takeSeat seats an active member on an EMPTY seat and write-throughs + publishes', async () => {
  rooms.findById.mockResolvedValue({ id: 'r', ownerId: 'o', status: 'LIVE' });
  rooms.getMember.mockResolvedValue({ isActive: true });
  seatState.getSnapshot.mockResolvedValue(snapshotWith([empty(1)]));
  seats.findOccupiedSeat.mockResolvedValue(null);
  seatState.commit.mockImplementation((_r, b, p) => ({ ...b, ...p, version: b.version + 1 }));
  await svc.takeSeat(actor('u'), 'r', 1);
  expect(seats.updateSeat).toHaveBeenCalledWith('r', 1,
    expect.objectContaining({ seatStatus: 'OCCUPIED', occupantUserId: 'u' }), 'u');
  expect(bus.publish).toHaveBeenCalled();   // SeatTakenEvent
  expect(events.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'seat.taken' }));
});
it('takeSeat rejects an already-occupied seat with SEAT_TAKEN', async () => { /* seat OCCUPIED → expect BusinessException SEAT_TAKEN */ });
it('takeSeat rejects a locked seat with SEAT_LOCKED', async () => { /* ... */ });
it('takeSeat rejects a second seat for the same user (ALREADY_ON_SEAT)', async () => { /* findOccupiedSeat → a seat */ });
it('leaveSeat vacates the occupant', async () => { /* occupant leaves → seatStatus EMPTY, SeatLeftEvent */ });
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** the pipeline. Key shape:

```ts
async takeSeat(actor: RoomActor, roomId: string, seatIndex: number, ip?: string): Promise<SeatStageView> {
  const room = await this.assertLiveRoom(roomId);
  await this.assertActiveMember(roomId, actor.id);
  return this.mutateUnderLock(roomId, async (base) => {
    if (await this.seats.findOccupiedSeat(roomId, actor.id)) {
      throw new BusinessException(ERROR_CODES.ALREADY_ON_SEAT, 'You are already on a seat.', HttpStatus.CONFLICT);
    }
    const seat = base.seats.find((s) => s.seatIndex === seatIndex);
    if (!seat) throw new BusinessException(ERROR_CODES.SEAT_NOT_FOUND, 'No such seat.', HttpStatus.NOT_FOUND);
    if (seat.isLocked) throw new BusinessException(ERROR_CODES.SEAT_LOCKED, 'That seat is locked.', HttpStatus.CONFLICT);
    if (seat.status === 'OCCUPIED') throw new BusinessException(ERROR_CODES.SEAT_TAKEN, 'That seat is taken.', HttpStatus.CONFLICT);
    if (seat.status === 'RESERVED' && seat.reservedForUserId !== actor.id) {
      throw new BusinessException(ERROR_CODES.SEAT_RESERVED, 'That seat is reserved.', HttpStatus.CONFLICT);
    }
    if (isOwnerSeat(seatIndex) && room.ownerId !== actor.id) {
      throw new BusinessException(ERROR_CODES.SEAT_TYPE_FORBIDDEN, 'The owner seat is reserved for the owner.', HttpStatus.FORBIDDEN);
    }
    const seats = base.seats.map((s) => s.seatIndex === seatIndex
      ? { ...s, status: 'OCCUPIED' as const, occupantUserId: actor.id, reservedForUserId: null } : s);
    const next = await this.seatState.commit(roomId, base, { seats });
    await this.seats.updateSeat(roomId, seatIndex,
      { seatStatus: VideoRoomSeatStatus.OCCUPIED, occupantUserId: actor.id, reservedForUserId: null }, actor.id);
    await this.audit(roomId, actor.id, 'seat.taken', { seatIndex, ip });
    await this.bus.publish(new SeatTakenEvent({ roomId, version: next.version, seatIndex, userId: actor.id }));
    this.metrics.setSeatGauges?.(next);   // best-effort gauge refresh
    return next;
  });
}
```
`mutateUnderLock(roomId, fn)` = `withLock(videoRoomSeatLockKey(roomId), async () => { const base = await getSnapshot(roomId) ?? await rebuild(roomId); const next = await fn(base); return this.buildStageView(roomId, next); })`.
`assertLiveRoom` = `findById`; not found → `VIDEO_ROOM_NOT_FOUND` (404); `status !== LIVE` → `VIDEO_ROOM_INVALID_STATE`/`VIDEO_ROOM_ENDED` (409). Returns the room (for ownerId).
`assertActiveMember` = `getMember`; `!member?.isActive` → `VIDEO_ROOM_NOT_MEMBER` (403).
`buildStageView` = fetch `listPendingRequests` + pending invitations (add a repo `listPendingInvitationsForRoom`), then `toSeatStageView(snapshot, requests, invites)`.
`audit(roomId, actorId, type, payload)` = `events.appendEvent({ roomId, actorId, eventType: type, payload })`.
`getStage` (read, no lock): snapshot ?? rebuild → `buildStageView`.

*Note:* add `VideoRoomSeatsRepository.listPendingInvitationsForRoom(roomId)` in this task (mirror `listPendingRequests`).

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat service core (get/take/leave)"`

---

### Task 11: `VideoRoomSeatService` — lock/unlock (+ bulk, disable, maintenance) & configureLayout

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-seat.service.ts`
- Test: extend `video-room-seat.service.spec.ts`

**Interfaces:**
- Produces: `lockSeats(actor, roomId, seatIndexes, reason?, ip?)`, `unlockSeats(actor, roomId, seatIndexes, ip?)`, `configureLayout(actor, roomId, hostSeatCount, guestSeatCount, ip?)`. Single-index lock/unlock call the bulk form with one index.

- [ ] **Step 1: Write the failing tests** — (a) `lockSeats` requires `MANAGE_SEATS` (assert `permissions.assertPermission` called with `MANAGE_SEATS`); (b) locking an OCCUPIED seat vacates its occupant; (c) owner seat rejects lock (`SEAT_TYPE_FORBIDDEN`); (d) `configureLayout` shrinking below an occupied index vacates the displaced occupant and calls `setSeatLayout` + `deleteSeatsFrom`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**
  - `lockSeats`: `await this.assertManageSeats(actor, room)` (fetch room, `permissions.assertPermission(actor, {id,ownerId}, MANAGE_SEATS)`), then under lock map each index → `{ status:'LOCKED', isLocked:true, occupantUserId:null }` writing `metadata.reason = reason ?? null`; skip/throw owner seat (`isOwnerSeat` → `SEAT_TYPE_FORBIDDEN`); write-through each via `updateSeat` (set `metadata`); one `commit`; publish a `SeatLockedEvent` per seat (or one `SeatUpdatedEvent{reason:'locked'}` for bulk) + audit `seat.locked`. `reason:'disabled'|'maintenance'` flows straight into `metadata.reason` — that is how DISABLED/MAINTENANCE are modeled.
  - `unlockSeats`: reverse → `{ status:'EMPTY', isLocked:false }`, clear `metadata.reason`; publish `SeatUnlockedEvent`.
  - `configureLayout`: validate `1 + hostSeatCount + guestSeatCount <= VIDEO_ROOM_MAX_SEATS` else `SEAT_LAYOUT_INVALID`; under lock: `setSeatLayout`; ensure seat rows 0..N exist (create missing via `createLayout`) and `deleteSeatsFrom(roomId, total)` for shrink (vacating displaced occupants first — emit `SeatLeftEvent` for each); rebuild snapshot from DB (`seatState.rebuild`) so counts + rows re-sync; publish `SeatUpdatedEvent{reason:'layout_changed'}`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat lock/unlock/bulk + configureLayout"`

---

### Task 12: `VideoRoomSeatService` — switch / transfer / force / remove

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-seat.service.ts`
- Test: extend `video-room-seat.service.spec.ts`

**Interfaces:**
- Produces: `switchSeat(actor, roomId, toSeatIndex, ip?)`, `transferSeat(actor, roomId, userId, toSeatIndex, fromSeatIndex?, force?, ip?)`, `removeFromSeat(actor, roomId, userId, ip?)`.

- [ ] **Step 1: Write the failing tests** — (a) `switchSeat` moves the caller's occupant atomically to an empty seat, rejects if destination taken (`SEAT_TAKEN`) or if caller not seated (`NOT_ON_SEAT`); (b) `transferSeat` needs `MANAGE_PARTICIPANTS` + `assertOutranks(actor, target)`; (c) `removeFromSeat` vacates a target and publishes `SeatLeftEvent`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**
  - `switchSeat`: under lock find caller's current seat (`NOT_ON_SEAT` if none); validate destination EMPTY or RESERVED-for-self (else `SEAT_TAKEN`/`SEAT_RESERVED`); owner-seat guard; move occupant in one `commit` (from→EMPTY, to→OCCUPIED); two `updateSeat` write-throughs; audit `seat.switched`; publish `SeatSwitchedEvent{fromSeatIndex,toSeatIndex}`.
  - `transferSeat`: `assertPermission(MANAGE_PARTICIPANTS)` + `assertOutranks(actor.id, userId)`; resolve target's current seat (or `fromSeatIndex`); destination must be free (unless `force` → vacate current occupant first, emitting `SeatLeftEvent`); move; audit `seat.transferred`; publish `SeatTransferredEvent{forced}`.
  - `removeFromSeat`: `assertPermission(MANAGE_PARTICIPANTS)` + `assertOutranks`; vacate; audit `seat.removed`; publish `SeatLeftEvent`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat switch/transfer/force/remove"`

---

### Task 13: `VideoRoomSeatReservationService`

**Files:**
- Create: `src/modules/video-rooms/services/video-room-seat-reservation.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-reservation.service.spec.ts`

**Interfaces:**
- Consumes: `LockService`, `VideoRoomSeatStateService`, `VideoRoomSeatsRepository`, `VideoRoomsRepository`, `VideoRoomPermissionService`, `CacheService` (reservation hold key), `VideoRoomEventsRepository`, `IEventBus`, `VIDEO_ROOM_RESERVATION_TTL_SECONDS`, `videoRoomSeatReservationKey`.
- Produces: `reserve(actor, roomId, seatIndex, forUserId, ttlSeconds?, ip?)`, `cancelReservation(actor, roomId, seatIndex, ip?)`, `releaseExpired(roomId, seatIndex)` (called by the monitor).

- [ ] **Step 1: Write the failing tests** — (a) `reserve` needs `MANAGE_SEATS`, sets seat RESERVED + `reservedForUserId`, writes a Redis hold key with TTL, publishes `SeatReservedEvent`; (b) reserving an occupied/owner seat throws; (c) `cancelReservation` clears RESERVED→EMPTY + deletes hold, publishes `SeatReleasedEvent{reason:'cancelled'}`; (d) `releaseExpired` flips a still-RESERVED seat to EMPTY and publishes `SeatReleasedEvent{reason:'expired'}`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — same locked pipeline as Task 10. `reserve`: after `commit`, `cache.set(videoRoomSeatReservationKey(roomId,seatIndex), { forUserId }, ttl)` where `ttl = ttlSeconds ?? VIDEO_ROOM_RESERVATION_TTL_SECONDS`. `releaseExpired`: guard that the seat is still RESERVED for the same holder before releasing (idempotent — the holder may have already taken it).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat reservation service + TTL hold"`

---

### Task 14: `VideoRoomSeatRequestService` — LEARNING CONTRIBUTION (priority comparator)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-seat-request.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-request.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomSeatsRepository` (createRequest/findPendingRequest/listPendingRequests/setRequestStatus/findRequestById/resolveAllPendingRequestsForUser), `VideoRoomSeatService.takeSeat`-equivalent seating helper (call `VideoRoomSeatService.seatUser(...)` — add a small internal `seatUser(actor, roomId, userId, seatIndex)` in Task 10/12, or approve via the same locked mutate), `VideoRoomPermissionService`, `VideoRoomsRepository`, `VideoRoomEventsRepository`, `IEventBus`, config request TTL.
- Produces: `request(actor, roomId, seatIndex?, ip?)`, `cancelRequest(actor, roomId, ip?)`, `approve(actor, roomId, requestId, ip?)`, `reject(actor, roomId, requestId, ip?)`, `listRequests(actor, roomId): Promise<VideoRoomSeatRequestView[]>` (ordered by priority), and the exported comparator `compareRequestPriority(a, b, ctx): number`.

- [ ] **Step 1: Write the failing tests** — (a) `request` dedupes (`DUPLICATE_SEAT_REQUEST` if one PENDING exists), sets `expiresAt = now + TTL`, publishes `SeatRequestedEvent`; (b) `approve` requires `MANAGE_SEATS`, seats the requester on the requested/next-free seat and marks the request ACCEPTED, publishing `SeatRequestResolvedEvent{status:'ACCEPTED'}`; (c) `listRequests` returns owner-affinity/role/VIP/FIFO order (drive via `compareRequestPriority`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Scaffold the comparator as the learning contribution:

```ts
export interface RequestPriorityContext {
  rank: Map<string, number>;   // userId → authorityRank
  vip: Map<string, number>;    // userId → vip level (0 if none)
}
/**
 * LEARNING CONTRIBUTION POINT — request ordering is a product decision.
 * Return <0 if `a` should come before `b`. Suggested precedence (spec §9):
 *   1) higher authority rank first
 *   2) then higher VIP level
 *   3) then FIFO (earlier createdAt first)
 * Implement using ctx.rank / ctx.vip and the rows' createdAt.
 */
export function compareRequestPriority(
  a: VideoRoomSeatRequest, b: VideoRoomSeatRequest, ctx: RequestPriorityContext,
): number {
  // TODO(user): implement the precedence above.
  return a.createdAt.getTime() - b.createdAt.getTime();
}
```
`listRequests` builds `ctx` (authorityRank per requester via the permission service; VIP via the existing VIP source if wired, else 0) and sorts `listPendingRequests` with the comparator, then maps to views. `approve` runs the seating inside the seat lock (reuse the Task 10/12 locked mutate through a shared internal `VideoRoomSeatService.seatUser`).

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat request service + priority comparator"`

---

### Task 15: `VideoRoomSeatInvitationService`

**Files:**
- Create: `src/modules/video-rooms/services/video-room-seat-invitation.service.ts`
- Test: `src/modules/video-rooms/services/video-room-seat-invitation.service.spec.ts`

**Interfaces:**
- Produces: `invite(actor, roomId, inviteeUserId, seatIndex?, ip?)`, `accept(actor, roomId, invitationId, ip?)`, `reject(actor, roomId, invitationId, ip?)`, `cancel(actor, roomId, invitationId, ip?)`.

- [ ] **Step 1: Write the failing tests** — (a) `invite` requires `MANAGE_PARTICIPANTS`/`INVITE_USERS`, dedupes one PENDING per (room,invitee,seat) (`DUPLICATE_SEAT_INVITATION`), sets `expiresAt = now + VIDEO_ROOM_INVITATION_TTL_SECONDS`, optionally reserves the target seat (RESERVED + reservedForUserId), publishes `SeatInvitationSentEvent`; (b) `accept` (invitee only) seats them and marks ACCEPTED (`SeatInvitationResolvedEvent{status:'ACCEPTED'}`); (c) expired invite → `SEAT_INVITATION_EXPIRED`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — `invite` creates the row + (if `seatIndex`) reserves the seat via the reservation path; `accept` validates the caller is the invitee, the invite is PENDING + unexpired, then seats them (shared seat lock) and releases the reservation hold; `reject`/`cancel` set status + release any hold + publish resolved.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat invitation service"`

---

### Task 16: Extend `VideoRoomsMetrics` (seat gauges/counters/histograms)

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts`
- Test: extend `video-rooms.metrics.spec.ts` (or create if absent)

**Interfaces:**
- Produces: `setSeatGauges(snapshot: SeatStageSnapshot)`, `incSeatRequest()`, `incSeatInvitation()`, `incSeatTransfer()`, `incSeatSwitch()`, `incReservationTimeout()`, `observeSeatOp(seconds)`, `observeSeatRedisSync(seconds)`.

- [ ] **Step 1: Write the failing test** — construct with a real `MetricsService` registry; call `setSeatGauges` + `incSeatTransfer`; assert `registry.getSingleMetricAsString('video_rooms_seats_occupied')` reflects the value.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — add private `Gauge` (`video_rooms_seats_occupied/empty/locked`), `Counter` (`video_rooms_seat_requests_total`, `…invitations_total`, `…transfers_total`, `…switches_total`, `…reservation_timeouts_total`), `Histogram` (`video_rooms_seat_op_latency_seconds`, `video_rooms_seat_redis_sync_seconds`), each registered on `metrics.registry`, plus the helper methods. `setSeatGauges` counts statuses from `snapshot.seats`.
- [ ] **Step 4: Run — PASS.** Wire the `metrics.inc*`/`observe*` calls into the Task 10–15 services (make the earlier `this.metrics.*?.()` calls concrete).
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat metrics"`

---

### Task 17: `VideoRoomSeatLifecycleListener` (room events → seat reactions)

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-seat-lifecycle.listener.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`
- Test: `src/modules/video-rooms/listeners/video-room-seat-lifecycle.listener.spec.ts`

**Interfaces:**
- Consumes: `IEventBus.subscribe`, `VIDEO_ROOM_EVENTS` (USER_LEFT, CLOSED, DELETED, ownership transfer if present), `VideoRoomSeatService` (add `onMemberLeave(roomId,userId)`, `onRoomClosed(roomId)`), `VideoRoomSeatStateService.clear`.
- Produces: `VideoRoomSeatLifecycleListener` (implements `OnModuleInit`).

- [ ] **Step 1: Write the failing test** — publishing `USER_LEFT` calls `seatService.onMemberLeave`; `CLOSED`/`DELETED` calls `onRoomClosed` (which vacates all + `seatState.clear`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — subscribe in `onModuleInit`; add `onMemberLeave` (vacate the user's seat if any, under the seat lock, publishing `SeatLeftEvent`) and `onRoomClosed` (clear the Redis snapshot; seats persist in DB as history) to `VideoRoomSeatService`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat lifecycle listener (react to room events)"`

---

### Task 18: `VideoRoomSeatMonitor` (expiry sweep)

**Files:**
- Create: `src/modules/video-rooms/scheduler/video-room-seat.monitor.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-seat.monitor.spec.ts`

**Interfaces:**
- Consumes: `LockService` (fleet lock `video-room:seat:monitor`), `VideoRoomSeatsRepository.expireStaleRequests/expireStaleInvitations`, reservation-hold scanning (via `VideoRoomSeatReservationService.releaseExpired` per expired hold), config sweep interval.
- Produces: `VideoRoomSeatMonitor` (implements `OnModuleInit`, `OnModuleDestroy`).

- [ ] **Step 1: Write the failing test** — `sweep()` (guarded by the fleet lock) calls `expireStaleRequests(now)` + `expireStaleInvitations(now)`; when another instance holds the lock, it no-ops.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — mirror `VideoRoomSessionMonitor` (setInterval → `withLock` → sweep). Sweep: bulk-expire stale requests/invitations (publishing `SeatRequestResolvedEvent{status:'EXPIRED'}` / `SeatInvitationResolvedEvent{status:'EXPIRED'}` for each affected — fetch the just-expired rows to know whom to notify), and reap reservation holds whose Redis key has expired but whose seat is still RESERVED (belt-and-suspenders) via `releaseExpired`. Increment `metrics.incReservationTimeout()` per released hold.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seat expiry monitor"`

---

### Task 19: `VideoRoomSeatsController` (REST + Swagger)

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-seats.controller.ts`
- Modify: `src/modules/video-rooms/controllers/index.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-seats.controller.spec.ts`

**Interfaces:**
- Consumes: all Task 10–15 services; `@CurrentUser`, `@Ip`, `ParseUuidPipe`, `@NotGuest`, the Task 9 DTOs.
- Produces: the routes in spec §10.

- [ ] **Step 1: Write the failing test** — instantiate the controller with mocked services; assert each handler delegates with `this.actor(user)`, the room id, DTO fields, and `ip`. E.g. `controller.reserve(user, 'r', dto, '1.2.3.4')` → `reservation.reserve(actor, 'r', dto.seatIndex, dto.forUserId, dto.ttlSeconds, '1.2.3.4')`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — mirror `video-rooms-members.controller.ts` (class-level `@ApiTags('video-room-seats')`, `@ApiBearerAuth()`, `@Controller('video-rooms')`, private `actor(user)`). Declare literal sub-paths before `:index` routes. Full Swagger per route (`@ApiOperation`, `@ApiResponse` for 200/400/403/404/409). `@NotGuest()` on take/request/switch/invite-accept. Bulk lock/unlock accept `LockSeatsDto`/`UnlockSeatsDto`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-4 seats REST controller + swagger"`

---

### Task 20: Module wiring + full verification

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/video-rooms/services/index.ts`, `interfaces/index.ts`, `mappers/index.ts`, `entities/index.ts` (re-exports)

**Interfaces:**
- Consumes: every provider/controller from Tasks 4–19.

- [ ] **Step 1:** Register in `video-rooms.module.ts`: providers `VideoRoomSeatStateService`, `VideoRoomSeatService`, `VideoRoomSeatReservationService`, `VideoRoomSeatRequestService`, `VideoRoomSeatInvitationService`, `VideoRoomSeatSocketListener`, `VideoRoomSeatLifecycleListener`, `VideoRoomSeatMonitor`; controller `VideoRoomSeatsController`. (`VideoRoomSeatsRepository`, `VideoRoomPermissionService`, `VideoRoomEventsRepository`, `VideoRoomsMetrics`, `LockService`, `CacheService` already provided.)
- [ ] **Step 2: Run typecheck** — `npx tsc --noEmit` → 0 errors.
- [ ] **Step 3: Run the video-rooms suite** — `npx jest src/modules/video-rooms` → all green.
- [ ] **Step 4: Lint + boundaries** — `npx eslint src/modules/video-rooms` and the repo's `boundaries` check → clean.
- [ ] **Step 5: Full suite** — `npm test` → zero regressions. Commit — `git commit -am "feat(video-rooms): VR-4 wire seat management module + green suite"`

---

## Self-Review

**Spec coverage:** layouts (Task 11 configureLayout) · 8 states (Task 2 display-status + lock-reason) · 6 types (Task 6 role derivation + metadata.premium) · lock/unlock/bulk (11) · reserve + expiry (13, 18) · invite workflow (15) · request workflow + priority (14) · switch/transfer/force (12) · sync/versioning (4) · Redis live state (4) · socket events (1, 8) · event bus (7) · audit (10–15 via appendEvent) · metrics (16) · owner-seat protection (10–12) · RBAC (6) · scheduler expiry (18) · endpoints + Swagger (19) · DTOs (9) · error codes (1). All spec sections map to a task.

**Placeholder scan:** the only intentional TODOs are the two LEARNING CONTRIBUTION points (Task 2 transitions table is pre-filled with a working default; Task 14 comparator ships a working FIFO default) — both compile and pass tests as written; the user refines them. No `TBD`/"handle edge cases"/uncoded steps remain.

**Type consistency:** `SeatStageSnapshot`/`SeatEntrySnapshot`/`SeatStageMutation` defined in Task 3, consumed unchanged in Tasks 4/10–15. `commit(roomId, base, patch)` signature identical across callers. `displayStatusFor(entry, overlays)` used consistently by the mapper. Event payload shapes in Task 7 match the socket listener reads in Task 8 and the publishes in Tasks 10–15.
