# Video Room Phase 6 — Viewer Mode & Audience Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a viewer-shaped API surface + host-driven promote/demote to Video Rooms as a thin cohesion layer over the existing member (VR-3) and seat (VR-4) engines — no duplicated lifecycle, no new tables.

**Architecture:** A viewer is a member with the default `VIEWER` role; a participant is a member on a GUEST seat. VR-6 adds a `VideoRoomViewerService` facade (delegates lifecycle to the member/session services, emits viewer events), a `VideoRoomViewerQueryService` reading an `IViewerPresence` seam (durable impl now; Redis-only broadcast-scale impl later), promote/demote orchestration reusing `seatUser`/`vacateUser` plus two gap-fills (participant stats + live media role downgrade), a viewer permission matrix, a viewer REST controller, and 3 new viewer events.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Redis (ioredis), Socket.IO (via EVENT_BUS relay), prom-client, Jest.

## Global Constraints

- **No new tables, no new Prisma models, no new migration.** Reuse `VideoRoomStatistics`, `VideoRoomMember`, `VideoRoomPresence`, `video_room_seats`, the event store.
- **No new Redis lifecycle / no new BullMQ queues / no domain socket gateway.** Inbound = REST; outbound realtime = EVENT_BUS → `VideoRoomSocketListener`.
- **Reuse, do not duplicate:** member lifecycle (`VideoRoomMemberService`), sessions (`VideoRoomSessionService`), presence FSM (`derivePresenceState`), seat engine (`VideoRoomSeatService`), permission RBAC (`VideoRoomPermissionService`), media role plumbing (`VideoRoomMediaService`/`VideoRoomMediaSessionRepository`).
- **No Prisma/Redis primitives inside services** — those stay in repositories and the presence/state managers.
- **RBAC:** promote requires `VideoRoomPermission.MANAGE_SEATS`; demote requires `MANAGE_PARTICIPANTS` + `assertOutranks` (self-demote exempt). Guests blocked at the controller via `@NotGuest()`.
- **TDD:** every unit lands with a colocated `*.spec.ts`; run the test red before implementing.
- **Verification gates (run before declaring done):** `npx tsc --noEmit`, `npx eslint`, the module boundary check, and the `video-rooms` Jest suite must all be green with zero regressions.
- **Commit convention:** `feat(video-rooms): …`. End every commit message with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. (Commit cadence — per-task vs. batched — follows the user's preference; prior phases accumulated uncommitted on `main`. If committing, branch off `main` first.)

---

## File Structure

**Create:**
- `src/modules/video-rooms/interfaces/viewer-presence.interface.ts` — `IViewerPresence` seam + `VIEWER_PRESENCE` token + `AudiencePage`/`ViewerSummaryView`.
- `src/modules/video-rooms/services/durable-viewer-presence.service.ts` — default seam impl (member-is-viewer).
- `src/modules/video-rooms/services/video-room-viewer-presence.projection.ts` — pure `toViewerPresence`.
- `src/modules/video-rooms/services/video-room-viewer.service.ts` — facade + promote/demote.
- `src/modules/video-rooms/services/video-room-viewer-query.service.ts` — audience/count/me read models.
- `src/modules/video-rooms/constants/video-room-viewer-permissions.ts` — viewer capability matrix (learning-contribution point).
- `src/modules/video-rooms/events/video-room-viewer.events.ts` — `ViewerPromotedEvent`/`ViewerDemotedEvent`/`ViewerPresenceChangedEvent`.
- `src/modules/video-rooms/dto/viewer.dto.ts` — viewer DTOs.
- `src/modules/video-rooms/controllers/video-rooms-viewers.controller.ts` — 9 endpoints.
- `*.spec.ts` colocated with each of the above.

**Modify:**
- `src/modules/video-rooms/enums/index.ts` — extend `ViewerStatus`.
- `src/common/exceptions/error-codes.ts` — add 4 codes.
- `src/modules/video-rooms/events/video-room.events.ts` — add 3 event names to `VIDEO_ROOM_EVENTS`.
- `src/modules/video-rooms/services/video-room-event.service.ts` — add 3 emit methods.
- `src/modules/video-rooms/constants/video-room.constants.ts` — add 3 socket event names.
- `src/modules/video-rooms/listeners/video-room-socket.listener.ts` — subscribe the 3 new events.
- `src/modules/video-rooms/repositories/video-rooms.repository.ts` — add `setParticipantStats`.
- `src/modules/video-rooms/services/video-room-media.service.ts` — add `demoteToSubscriber`.
- `src/modules/video-rooms/video-rooms.metrics.ts` — add peak-viewers gauge + promote/demote counters.
- `src/modules/video-rooms/video-rooms.module.ts` — register providers, bind `VIEWER_PRESENCE`, add controller.
- `src/config/env.validation.ts`, `src/config/configuration.ts`, `src/modules/video-rooms/config/video-room.config.ts`, `.env.example` — add `viewerPresenceMode`.

---

### Task 1: Viewer presence projection + `ViewerStatus` extension

Pure mapping from the FSM (`VideoRoomPresenceState`) to the viewer-facing label. No FSM change.

**Files:**
- Modify: `src/modules/video-rooms/enums/index.ts` (extend `ViewerStatus`)
- Create: `src/modules/video-rooms/services/video-room-viewer-presence.projection.ts`
- Test: `src/modules/video-rooms/services/video-room-viewer-presence.projection.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomPresenceState` (`enums/index.ts`).
- Produces: `enum ViewerStatus { WATCHING, BACKGROUND, ONLINE, RECONNECTING, LEFT, OFFLINE }`; `function toViewerPresence(state: VideoRoomPresenceState): ViewerStatus`.

- [ ] **Step 1: Extend the `ViewerStatus` enum.** In `enums/index.ts`, replace the existing `ViewerStatus` (currently `WATCHING`/`BACKGROUND`/`LEFT`) with:

```ts
/**
 * The viewer-facing presence vocabulary (VR-6). A pure projection of the
 * VideoRoomPresenceState FSM — see services/video-room-viewer-presence.projection.ts.
 * WATCHING = live+foreground, BACKGROUND = backgrounded, others pass through.
 */
export enum ViewerStatus {
  WATCHING = 'WATCHING',
  BACKGROUND = 'BACKGROUND',
  ONLINE = 'ONLINE',
  RECONNECTING = 'RECONNECTING',
  LEFT = 'LEFT',
  OFFLINE = 'OFFLINE',
}
```

- [ ] **Step 2: Write the failing test.**

```ts
import { VideoRoomPresenceState, ViewerStatus } from '../enums';
import { toViewerPresence } from './video-room-viewer-presence.projection';

describe('toViewerPresence', () => {
  it.each([
    [VideoRoomPresenceState.ONLINE, ViewerStatus.WATCHING],
    [VideoRoomPresenceState.CONNECTING, ViewerStatus.WATCHING],
    [VideoRoomPresenceState.IDLE, ViewerStatus.BACKGROUND],
    [VideoRoomPresenceState.RECONNECTING, ViewerStatus.RECONNECTING],
    [VideoRoomPresenceState.DISCONNECTED, ViewerStatus.RECONNECTING],
    [VideoRoomPresenceState.LEFT, ViewerStatus.LEFT],
    [VideoRoomPresenceState.OFFLINE, ViewerStatus.OFFLINE],
  ])('%s → %s', (state, expected) => {
    expect(toViewerPresence(state)).toBe(expected);
  });
});
```

- [ ] **Step 3: Run it red.** `npx jest video-room-viewer-presence.projection --silent` → FAIL (module not found).

- [ ] **Step 4: Implement the projection.**

```ts
import { VideoRoomPresenceState, ViewerStatus } from '../enums';

/**
 * Pure projection of the member presence FSM to the viewer-facing vocabulary
 * (VR-6). No new state machine — derivePresenceState remains the single source
 * of truth; this only relabels for the audience surface.
 */
export function toViewerPresence(state: VideoRoomPresenceState): ViewerStatus {
  switch (state) {
    case VideoRoomPresenceState.ONLINE:
    case VideoRoomPresenceState.CONNECTING:
      return ViewerStatus.WATCHING;
    case VideoRoomPresenceState.IDLE:
      return ViewerStatus.BACKGROUND;
    case VideoRoomPresenceState.RECONNECTING:
    case VideoRoomPresenceState.DISCONNECTED:
      return ViewerStatus.RECONNECTING;
    case VideoRoomPresenceState.LEFT:
      return ViewerStatus.LEFT;
    case VideoRoomPresenceState.OFFLINE:
    default:
      return ViewerStatus.OFFLINE;
  }
}
```

- [ ] **Step 5: Run it green.** `npx jest video-room-viewer-presence.projection --silent` → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer presence projection over the FSM" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Viewer permission matrix (LEARNING-CONTRIBUTION POINT)

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-viewer-permissions.ts`
- Test: `src/modules/video-rooms/constants/video-room-viewer-permissions.spec.ts`

**Interfaces:**
- Produces: `type ViewerCapability = keyof typeof VIEWER_CAPABILITIES`; `const VIEWER_CAPABILITIES`; `function videoRoomViewerCan(cap: ViewerCapability): boolean`.

> **Learning-contribution point:** the boolean values below are the product-policy default proposed in the spec (§11). Confirm/adjust to the room's rules before implementing — e.g. a room setting could later gate `canRequestSeat`/`canShareRoom`. Keep the hard-false capabilities false (they are enforced by seat/media derivation).

- [ ] **Step 1: Write the failing test.**

```ts
import { VIEWER_CAPABILITIES, videoRoomViewerCan } from './video-room-viewer-permissions';

describe('viewer capabilities', () => {
  it('grants read + social capabilities', () => {
    expect(videoRoomViewerCan('canReceiveStreams')).toBe(true);
    expect(videoRoomViewerCan('canRequestSeat')).toBe(true);
    expect(videoRoomViewerCan('canReportUser')).toBe(true);
  });
  it('denies publish/seat/manage capabilities', () => {
    expect(videoRoomViewerCan('canPublishCamera')).toBe(false);
    expect(videoRoomViewerCan('canOccupySeat')).toBe(false);
    expect(videoRoomViewerCan('canManageRoom')).toBe(false);
  });
  it('exposes the full matrix as a readonly record', () => {
    expect(Object.keys(VIEWER_CAPABILITIES)).toContain('canFollowHost');
  });
});
```

- [ ] **Step 2: Run it red.** `npx jest video-room-viewer-permissions --silent` → FAIL.

- [ ] **Step 3: Implement the matrix.**

```ts
/**
 * The read-only capability set a video-room VIEWER holds (VR-6). Surfaced by
 * GET /viewer/me for the client. Media capabilities (publish/camera/mic) and
 * seat occupancy remain seat-derived and are listed here as hard-false so the
 * client can render them — they are NOT granted here.
 *
 * LEARNING-CONTRIBUTION POINT: these booleans are the product-policy default;
 * canRequestSeat / canShareRoom / canFollowHost are the intended policy levers.
 */
export const VIEWER_CAPABILITIES = {
  canReceiveStreams: true,
  canViewParticipants: true,
  canViewSeats: true,
  canViewRoomInfo: true,
  canRequestSeat: true,
  canReportUser: true,
  canShareRoom: true,
  canFollowHost: true,
  canPublishCamera: false,
  canPublishAudio: false,
  canOccupySeat: false,
  canMuteOthers: false,
  canManageRoom: false,
} as const;

export type ViewerCapability = keyof typeof VIEWER_CAPABILITIES;

/** True if a viewer holds `cap`. */
export function videoRoomViewerCan(cap: ViewerCapability): boolean {
  return VIEWER_CAPABILITIES[cap];
}
```

- [ ] **Step 4: Run it green.** `npx jest video-room-viewer-permissions --silent` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer permission matrix" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: Error codes + viewer events + socket names + emit methods

Foundational additions consumed by later tasks. The dormant `ViewerJoined`/`ViewerLeft` are **already** subscribed by the socket listener (lines 69-74) and **already** have emit methods on `VideoRoomEventService` (lines 70-75) — this task only adds the 3 NEW events and their wiring.

**Files:**
- Modify: `src/common/exceptions/error-codes.ts`
- Create: `src/modules/video-rooms/events/video-room-viewer.events.ts`
- Modify: `src/modules/video-rooms/events/video-room.events.ts` (add names to `VIDEO_ROOM_EVENTS`)
- Modify: `src/modules/video-rooms/services/video-room-event.service.ts` (3 emit methods)
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (3 socket names)
- Modify: `src/modules/video-rooms/listeners/video-room-socket.listener.ts` (3 subscriptions)
- Test: `src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts` (extend)

**Interfaces:**
- Produces: error codes `VIDEO_ROOM_PROMOTION_FAILED`, `VIDEO_ROOM_DEMOTION_FAILED`, `VIDEO_ROOM_NOT_VIEWER`, `VIDEO_ROOM_NOT_PARTICIPANT`; `ViewerPromotedEvent`/`ViewerDemotedEvent`/`ViewerPresenceChangedEvent`; `VIDEO_ROOM_EVENTS.{VIEWER_PROMOTED,VIEWER_DEMOTED,VIEWER_PRESENCE_CHANGED}`; `VIDEO_ROOM_SOCKET_EVENTS.{VIEWER_PROMOTED,VIEWER_DEMOTED,VIEWER_PRESENCE_CHANGED}`; `VideoRoomEventService.{emitViewerPromoted,emitViewerDemoted,emitViewerPresenceChanged}`.

- [ ] **Step 1: Add error codes.** In `src/common/exceptions/error-codes.ts`, after `VIDEO_ROOM_RECONNECT_FAILED`:

```ts
  VIDEO_ROOM_PROMOTION_FAILED: 'VIDEO_ROOM_PROMOTION_FAILED',
  VIDEO_ROOM_DEMOTION_FAILED: 'VIDEO_ROOM_DEMOTION_FAILED',
  VIDEO_ROOM_NOT_VIEWER: 'VIDEO_ROOM_NOT_VIEWER',
  VIDEO_ROOM_NOT_PARTICIPANT: 'VIDEO_ROOM_NOT_PARTICIPANT',
```

- [ ] **Step 2: Add event names.** In `events/video-room.events.ts`, extend the `VIDEO_ROOM_EVENTS` object:

```ts
  VIEWER_PROMOTED: 'video_room.viewer_promoted',
  VIEWER_DEMOTED: 'video_room.viewer_demoted',
  VIEWER_PRESENCE_CHANGED: 'video_room.viewer_presence_changed',
```

- [ ] **Step 3: Create the event classes.** `events/video-room-viewer.events.ts`:

```ts
import { DomainEvent } from 'src/common/events';
import type { ViewerStatus } from '../enums';
import { VIDEO_ROOM_EVENTS } from './video-room.events';

/** A viewer was seated (host-direct promotion). */
export class ViewerPromotedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  seatIndex: number;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_PROMOTED;
}

/** A participant was returned to the audience (demotion). */
export class ViewerDemotedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_DEMOTED;
}

/** A viewer's presence label changed (coalesced by the caller). */
export class ViewerPresenceChangedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  status: ViewerStatus;
  audienceCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_PRESENCE_CHANGED;
}
```

- [ ] **Step 4: Add emit methods.** In `services/video-room-event.service.ts`, import the 3 classes and add:

```ts
  emitViewerPromoted(payload: ViewerPromotedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerPromotedEvent(payload));
  }

  emitViewerDemoted(payload: ViewerDemotedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerDemotedEvent(payload));
  }

  emitViewerPresenceChanged(payload: ViewerPresenceChangedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerPresenceChangedEvent(payload));
  }
```

- [ ] **Step 5: Add socket event names.** In `constants/video-room.constants.ts`, in `VIDEO_ROOM_SOCKET_EVENTS`:

```ts
  VIEWER_PROMOTED: 'video_room.viewer_promoted',
  VIEWER_DEMOTED: 'video_room.viewer_demoted',
  VIEWER_PRESENCE_CHANGED: 'video_room.viewer_presence_changed',
```

- [ ] **Step 6: Write the failing listener test.** Extend `listeners/video-room-socket.listener.spec.ts` — add a case asserting a published `ViewerPromotedEvent` is broadcast as `video_room.viewer_promoted` to the room. Follow the existing spec's harness (a fake bus that captures subscriptions + a `SocketManager` mock asserting `emitToNamespaceRoom`). Example assertion:

```ts
it('relays ViewerPromoted → viewer_promoted', () => {
  const payload = { roomId: 'r1', userId: 'u1', seatIndex: 3, actorId: 'o1' };
  bus.emit(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, { payload });
  expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
    VIDEO_ROOM_NAMESPACE, 'r1', VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PROMOTED, payload,
  );
});
```

Add equivalent cases for `VIEWER_DEMOTED` and `VIEWER_PRESENCE_CHANGED`.

- [ ] **Step 7: Run it red.** `npx jest video-room-socket.listener --silent` → FAIL (no subscription).

- [ ] **Step 8: Subscribe the 3 events.** In `listeners/video-room-socket.listener.ts` `onModuleInit`, import the event types + add:

```ts
    this.bus.subscribe<ViewerPromotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PROMOTED, e.payload),
    );
    this.bus.subscribe<ViewerDemotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_DEMOTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_DEMOTED, e.payload),
    );
    this.bus.subscribe<ViewerPresenceChangedEvent>(VIDEO_ROOM_EVENTS.VIEWER_PRESENCE_CHANGED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PRESENCE_CHANGED, e.payload),
    );
```

- [ ] **Step 9: Run it green.** `npx jest video-room-socket.listener --silent` → PASS.
- [ ] **Step 10: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer events, error codes, socket relay" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 4: `IViewerPresence` seam + `DurableViewerPresence`

The audience read authority + presence-write contract. Durable impl now; the Redis-only broadcast-scale impl is a future task behind the same interface.

**Files:**
- Create: `src/modules/video-rooms/interfaces/viewer-presence.interface.ts`
- Create: `src/modules/video-rooms/services/durable-viewer-presence.service.ts`
- Test: `src/modules/video-rooms/services/durable-viewer-presence.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomPresenceService.{viewerCount,addViewer,removeViewer,isViewer}`; `VideoRoomSeatStateService.getSnapshot`/`rebuild` (`SeatStageSnapshot`, `SeatEntrySnapshot.status === VideoRoomSeatStatus.OCCUPIED`); `VideoRoomsRepository.listActiveMembers(roomId, take, skip)` + `countActiveMembers(roomId)`.
- Produces: `interface ViewerSummaryView { userId: string }`; `interface AudiencePage { items: ViewerSummaryView[]; total: number }`; `interface IViewerPresence`; `const VIEWER_PRESENCE = Symbol('VIEWER_PRESENCE')`; `class DurableViewerPresence implements IViewerPresence`.

- [ ] **Step 1: Create the interface + token.** `interfaces/viewer-presence.interface.ts`:

```ts
/** One audience row surfaced by the viewer read model (VR-6). */
export interface ViewerSummaryView {
  userId: string;
}

export interface AudiencePage {
  items: ViewerSummaryView[];
  total: number;
}

/**
 * The audience seam (VR-6). Abstracts "who is watching, and how many" so the
 * durable (member-is-viewer) source can be swapped for a Redis-only,
 * broadcast-scale source later without touching the facade/controller. The
 * write methods are the presence contract the future ephemeral impl owns; in
 * durable mode the member lifecycle (VR-3) already performs the equivalent
 * writes on join/leave.
 */
export interface IViewerPresence {
  markPresent(roomId: string, userId: string): Promise<void>;
  markAbsent(roomId: string, userId: string): Promise<void>;
  isPresent(roomId: string, userId: string): Promise<boolean>;
  /** Audience = present members NOT occupying a seat. */
  audienceCount(roomId: string): Promise<number>;
  listAudience(roomId: string, take: number, skip: number): Promise<AudiencePage>;
}

export const VIEWER_PRESENCE = Symbol('VIEWER_PRESENCE');
```

- [ ] **Step 2: Write the failing test.** Mock `VideoRoomPresenceService`, `VideoRoomSeatStateService`, `VideoRoomsRepository`.

```ts
import { VideoRoomSeatStatus } from '@prisma/client';
import { DurableViewerPresence } from './durable-viewer-presence.service';

const seatSnapshot = (occupants: (string | null)[]) => ({
  roomId: 'r1', version: 1, updatedAt: '', hostSeatCount: occupants.length, guestSeatCount: 0,
  seats: occupants.map((occupantUserId, seatIndex) => ({
    seatIndex, occupantUserId,
    status: occupantUserId ? VideoRoomSeatStatus.OCCUPIED : VideoRoomSeatStatus.EMPTY,
  })),
});

describe('DurableViewerPresence', () => {
  let presence: any, seatState: any, repo: any, svc: DurableViewerPresence;
  beforeEach(() => {
    presence = { viewerCount: jest.fn().mockResolvedValue(10), addViewer: jest.fn(), removeViewer: jest.fn(), isViewer: jest.fn().mockResolvedValue(true) };
    seatState = { getSnapshot: jest.fn().mockResolvedValue(seatSnapshot(['a', null, 'b'])), rebuild: jest.fn() };
    repo = { listActiveMembers: jest.fn().mockResolvedValue([{ userId: 'a' }, { userId: 'c' }]), countActiveMembers: jest.fn().mockResolvedValue(10) };
    svc = new DurableViewerPresence(presence, seatState, repo);
  });

  it('audienceCount = viewers − occupied seats', async () => {
    // 10 viewers − 2 occupied = 8
    await expect(svc.audienceCount('r1')).resolves.toBe(8);
  });

  it('listAudience excludes seated users', async () => {
    // active members [a, c]; seated = {a, b} → audience = [c]
    const page = await svc.listAudience('r1', 20, 0);
    expect(page.items).toEqual([{ userId: 'c' }]);
  });

  it('markPresent/markAbsent delegate to the presence set', async () => {
    await svc.markPresent('r1', 'u1');
    expect(presence.addViewer).toHaveBeenCalledWith('r1', 'u1');
    await svc.markAbsent('r1', 'u1');
    expect(presence.removeViewer).toHaveBeenCalledWith('r1', 'u1');
  });
});
```

- [ ] **Step 3: Run it red.** `npx jest durable-viewer-presence --silent` → FAIL.

- [ ] **Step 4: Implement `DurableViewerPresence`.**

```ts
import { Injectable } from '@nestjs/common';
import { VideoRoomSeatStatus } from '@prisma/client';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPresenceService } from './video-room-presence.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import type { AudiencePage, IViewerPresence } from '../interfaces/viewer-presence.interface';

/**
 * Default IViewerPresence impl (VR-6): audience = active members not on a seat.
 * Presence writes reuse the VR-0 role sets; the audience read model subtracts
 * seat occupants (VR-4 snapshot authority) from the viewer set.
 */
@Injectable()
export class DurableViewerPresence implements IViewerPresence {
  constructor(
    private readonly presence: VideoRoomPresenceService,
    private readonly seatState: VideoRoomSeatStateService,
    private readonly repo: VideoRoomsRepository,
  ) {}

  markPresent(roomId: string, userId: string): Promise<void> {
    return this.presence.addViewer(roomId, userId);
  }

  markAbsent(roomId: string, userId: string): Promise<void> {
    return this.presence.removeViewer(roomId, userId);
  }

  isPresent(roomId: string, userId: string): Promise<boolean> {
    return this.presence.isViewer(roomId, userId);
  }

  async audienceCount(roomId: string): Promise<number> {
    const [viewers, occupied] = await Promise.all([
      this.presence.viewerCount(roomId),
      this.occupiedSeatCount(roomId),
    ]);
    return Math.max(0, viewers - occupied);
  }

  async listAudience(roomId: string, take: number, skip: number): Promise<AudiencePage> {
    const seated = await this.seatedUserIds(roomId);
    const rows = await this.repo.listActiveMembers(roomId, take, skip);
    const items = rows.filter((m) => !seated.has(m.userId)).map((m) => ({ userId: m.userId }));
    const total = Math.max(0, (await this.repo.countActiveMembers(roomId)) - seated.size);
    return { items, total };
  }

  private async seatedUserIds(roomId: string): Promise<Set<string>> {
    const snap = (await this.seatState.getSnapshot(roomId)) ?? (await this.seatState.rebuild(roomId));
    const ids = new Set<string>();
    for (const s of snap.seats) {
      if (s.status === VideoRoomSeatStatus.OCCUPIED && s.occupantUserId) ids.add(s.occupantUserId);
    }
    return ids;
  }

  private async occupiedSeatCount(roomId: string): Promise<number> {
    return (await this.seatedUserIds(roomId)).size;
  }
}
```

- [ ] **Step 5: Run it green.** `npx jest durable-viewer-presence --silent` → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(video-rooms): IViewerPresence seam + durable impl" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: `setParticipantStats` repository method

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-rooms.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-rooms.repository.spec.ts` (extend)

**Interfaces:**
- Produces: `VideoRoomsRepository.setParticipantStats(roomId: string, participantCount: number): Promise<void>`.

- [ ] **Step 1: Write the failing test.** Following the existing repo spec's Prisma-mock harness, assert `setParticipantStats` sets `currentParticipants` and conditionally raises `peakParticipants`:

```ts
it('setParticipantStats sets current + conditional peak', async () => {
  await repo.setParticipantStats('r1', 4);
  expect(prisma.videoRoomStatistics.update).toHaveBeenCalledWith({
    where: { roomId: 'r1' },
    data: { currentParticipants: 4, lastActivityAt: expect.any(Date) },
  });
  expect(prisma.videoRoomStatistics.updateMany).toHaveBeenCalledWith({
    where: { roomId: 'r1', peakParticipants: { lt: 4 } },
    data: { peakParticipants: 4 },
  });
});
```

- [ ] **Step 2: Run it red.** `npx jest video-rooms.repository --silent -t setParticipantStats` → FAIL.

- [ ] **Step 3: Implement it** (after `bumpStatsOnLeave`, mirroring the `bumpStatsOnJoin` set-current + conditional-max pattern):

```ts
/**
 * Participant counters (VR-6 promote/demote): set the live participant count to
 * the authoritative occupied-seat count (never +/-1, to avoid concurrent drift)
 * and raise the peak if it is a new high.
 */
async setParticipantStats(roomId: string, participantCount: number): Promise<void> {
  await this.prisma.videoRoomStatistics.update({
    where: { roomId },
    data: { currentParticipants: participantCount, lastActivityAt: new Date() },
  });
  await this.prisma.videoRoomStatistics.updateMany({
    where: { roomId, peakParticipants: { lt: participantCount } },
    data: { peakParticipants: participantCount },
  });
}
```

- [ ] **Step 4: Run it green.** `npx jest video-rooms.repository --silent -t setParticipantStats` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(video-rooms): setParticipantStats repo method" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 6: `demoteToSubscriber` media method (demote gap-fill)

A target-scoped "stop this user publishing" mirror of `stopPublish` (self-scoped, lines 319-350), plus the `setRole(SUBSCRIBER)` flip. Idempotent.

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-media.service.ts`
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `mutateStage`, `mediaState.commit`, `reconcileRoomStreaming`, `upsertParticipant`, `mediaSessions.setRole(roomId, userId, VideoRoomPublishRole.SUBSCRIBER)`, `events.appendEvent`, `bus.publish(new MediaStreamStoppedEvent(...))`, `MediaStreamState.STOPPED`, `ConnectionType.SUBSCRIBER`.
- Produces: `VideoRoomMediaService.demoteToSubscriber(roomId: string, userId: string, actorId: string): Promise<void>`.

- [ ] **Step 1: Write the failing test.** Using the existing media-service spec harness (mocked `mediaState`, `mediaSessions`, `events`, `bus`), assert that when the target is a live publisher, `demoteToSubscriber` flips their snapshot role to SUBSCRIBER, stops the stream, and calls `setRole(SUBSCRIBER)`; and is a no-op when the target is not publishing:

```ts
it('demoteToSubscriber flips a live publisher to subscriber', async () => {
  // arrange: snapshot has participant u1 as PUBLISHER with a streamId (see harness)
  await service.demoteToSubscriber('r1', 'u1', 'owner');
  expect(mediaSessions.setRole).toHaveBeenCalledWith('r1', 'u1', VideoRoomPublishRole.SUBSCRIBER);
  // committed participant role is SUBSCRIBER, streamState STOPPED (assert via mediaState.commit arg)
});

it('demoteToSubscriber is a no-op when the user is not publishing', async () => {
  // arrange: participant u2 absent or already SUBSCRIBER
  await service.demoteToSubscriber('r1', 'u2', 'owner');
  expect(mediaSessions.setRole).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it red.** `npx jest video-room-media.service --silent -t demoteToSubscriber` → FAIL.

- [ ] **Step 3: Implement it** (mirror `stopPublish`, target = `userId`, add role flip; place after `stopPublish`):

```ts
/**
 * Force a specific user off publishing back to audience subscriber (VR-6 demote
 * gap-fill). Mirrors stopPublish for an arbitrary target and flips the media
 * session role, so a demoted participant actually stops publishing and the
 * client re-fetches a subscriber token. Idempotent — no-op if not publishing.
 */
async demoteToSubscriber(roomId: string, userId: string, actorId: string): Promise<void> {
  let changed = false;
  const stage = await this.mutateStage(roomId, async (base) => {
    const me = base.participants.find((p) => p.userId === userId);
    if (!me || (me.role === ConnectionType.SUBSCRIBER && me.streamId === null)) return base; // idempotent
    changed = true;
    const participants = upsertParticipant(base.participants, userId, (p) => ({
      ...p,
      role: ConnectionType.SUBSCRIBER,
      seatIndex: null,
      streamState: MediaStreamState.STOPPED,
      streamId: null,
      camera: { ...p.camera, on: false },
      mic: { ...p.mic, on: false },
    }));
    const next = await this.mediaState.commit(roomId, base, { participants });
    await this.reconcileRoomStreaming(roomId, next.participants, userId);
    return next;
  });
  if (!changed) return;
  await this.mediaSessions.setRole(roomId, userId, VideoRoomPublishRole.SUBSCRIBER);
  await this.events.appendEvent({
    roomId,
    actorId,
    eventType: 'media.demoted',
    payload: { userId },
  });
  await this.bus.publish(
    new MediaStreamStoppedEvent({ roomId, version: stage.version, userId, streamId: null }),
  );
}
```

- [ ] **Step 4: Run it green.** `npx jest video-room-media.service --silent -t demoteToSubscriber` → PASS. Then run the whole media-service spec to confirm no regression: `npx jest video-room-media.service --silent`.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(video-rooms): demoteToSubscriber media gap-fill" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 7: `VideoRoomViewerService` — lifecycle facade

Delegates join/leave/reconnect/heartbeat to the member/session services; emits the viewer events. Adds the peak-viewers metric.

**Files:**
- Create: `src/modules/video-rooms/services/video-room-viewer.service.ts`
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (peak-viewers gauge)
- Test: `src/modules/video-rooms/services/video-room-viewer.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomMemberService.{join,leave,reconnect}` (`(actor: RoomActor, roomId, dto, ctx) → RoomSyncPayload`; leave returns void), `VideoRoomSessionService.heartbeat(socketId, { inBackground }) → boolean`, `VideoRoomEventService.{emitViewerJoined,emitViewerLeft}`, `IViewerPresence.audienceCount` (via `VIEWER_PRESENCE` token), `VideoRoomsMetrics.setPeakViewers`, `RoomSyncPayload`, `JoinContext`, `RoomActor`.
- Produces: `VideoRoomViewerService.{joinAsViewer,leaveAsViewer,reconnectViewer,heartbeat}` — signatures in Step 4.

> The viewer events carry the **audience** count (watchers not on a seat), resolved via the `IViewerPresence` seam after the member write — never a hardcoded value. This makes Task 7 depend on Task 4 (seam), which precedes it.

- [ ] **Step 1: Add the peak-viewers metric.** In `video-rooms.metrics.ts`, declare `private readonly peakViewers: Gauge;`, register it in the constructor:

```ts
this.peakViewers = new Gauge({
  name: 'video_rooms_peak_viewers',
  help: 'Video-room peak concurrent viewers observed (fleet-wide high-water mark)',
  registers,
});
```

and add the helper:

```ts
setPeakViewers(count: number): void {
  this.peakViewers.set(count);
}
```

- [ ] **Step 2: Write the failing test.** Mock the member/session/event/metrics deps; assert delegation + event emission:

```ts
it('joinAsViewer delegates to member.join and emits ViewerJoined with the audience count', async () => {
  member.join.mockResolvedValue({ counts: { viewers: 9 } });
  audience.audienceCount.mockResolvedValue(7);
  const actor = { id: 'u1', roles: [] };
  const out = await svc.joinAsViewer(actor, 'r1', { password: undefined }, { socketId: 's1' });
  expect(member.join).toHaveBeenCalledWith(actor, 'r1', { password: undefined }, { socketId: 's1' });
  expect(events.emitViewerJoined).toHaveBeenCalledWith({ roomId: 'r1', userId: 'u1', viewerCount: 7 });
  expect(metrics.setPeakViewers).toHaveBeenCalledWith(7);
  expect(out).toBe(await member.join.mock.results[0].value);
});

it('leaveAsViewer delegates to member.leave and emits ViewerLeft with the audience count', async () => {
  member.leave.mockResolvedValue(undefined);
  audience.audienceCount.mockResolvedValue(6);
  await svc.leaveAsViewer({ id: 'u1', roles: [] }, 'r1', { socketId: 's1' }, { ip: '1.2.3.4' });
  expect(member.leave).toHaveBeenCalled();
  expect(events.emitViewerLeft).toHaveBeenCalledWith({ roomId: 'r1', userId: 'u1', viewerCount: 6 });
});

it('heartbeat delegates to the session service', async () => {
  session.heartbeat.mockResolvedValue(true);
  await expect(svc.heartbeat({ socketId: 's1', inBackground: true })).resolves.toEqual({ alive: true });
  expect(session.heartbeat).toHaveBeenCalledWith('s1', { inBackground: true });
});
```

- [ ] **Step 3: Run it red.** `npx jest video-room-viewer.service --silent` → FAIL.

- [ ] **Step 4: Implement the facade.**

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VIEWER_PRESENCE, type IViewerPresence } from '../interfaces/viewer-presence.interface';
import { VideoRoomEventService } from './video-room-event.service';
import { VideoRoomSessionService } from './video-room-session.service';
import {
  VideoRoomMemberService,
  type JoinContext,
  type RoomSyncPayload,
} from './video-room-member.service';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Viewer-mode facade (VR-6). A viewer IS a member with the default VIEWER role,
 * so lifecycle delegates verbatim to the VR-3 member/session services; this
 * class adds the viewer-scoped event vocabulary + payload shape on top. Promote
 * / demote orchestration lives in the same service (see the promote/demote
 * task). Holds no Prisma/Redis of its own — the audience count comes through
 * the IViewerPresence seam.
 */
@Injectable()
export class VideoRoomViewerService {
  constructor(
    private readonly members: VideoRoomMemberService,
    private readonly sessions: VideoRoomSessionService,
    private readonly events: VideoRoomEventService,
    @Inject(VIEWER_PRESENCE) private readonly audience: IViewerPresence,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  async joinAsViewer(
    actor: RoomActor,
    roomId: string,
    dto: { password?: string },
    ctx: JoinContext,
  ): Promise<RoomSyncPayload> {
    const payload = await this.members.join(actor, roomId, dto, ctx);
    const audienceCount = await this.audience.audienceCount(roomId);
    await this.events.emitViewerJoined({ roomId, userId: actor.id, viewerCount: audienceCount });
    this.metrics.setPeakViewers(audienceCount);
    return payload;
  }

  async leaveAsViewer(
    actor: RoomActor,
    roomId: string,
    dto: { socketId?: string },
    ctx?: { ip?: string },
  ): Promise<void> {
    await this.members.leave(actor, roomId, dto, ctx);
    const audienceCount = await this.audience.audienceCount(roomId);
    await this.events.emitViewerLeft({ roomId, userId: actor.id, viewerCount: audienceCount });
  }

  reconnectViewer(
    actor: RoomActor,
    roomId: string,
    dto: { previousSocketId?: string },
    ctx: JoinContext,
  ): Promise<RoomSyncPayload> {
    return this.members.reconnect(actor, roomId, dto, ctx);
  }

  async heartbeat(dto: { socketId: string; inBackground?: boolean }): Promise<{ alive: boolean }> {
    const alive = await this.sessions.heartbeat(dto.socketId, { inBackground: dto.inBackground });
    return { alive };
  }
}
```

> The viewer events carry the real audience count (via the `IViewerPresence` seam) resolved after the member write — not a hardcoded value. The facade injects the seam by its `VIEWER_PRESENCE` token; the test mocks `audience.audienceCount`.

- [ ] **Step 5: Run it green.** `npx jest video-room-viewer.service --silent` → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer lifecycle facade" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 8: `VideoRoomViewerService` — promote / demote orchestration

Reuses `seatUser`/`vacateUser`/`findOpenSeat`, permission asserts, `setParticipantStats`, `demoteToSubscriber`; emits promote/demote events + counters.

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-viewer.service.ts`
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (promotion/demotion counters)
- Test: `src/modules/video-rooms/services/video-room-viewer.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `VideoRoomsRepository.{findById,getMember,setParticipantStats}`; `VideoRoomPermissionService.{assertPermission,assertOutranks}` with `PermissionRoomRef` = the room row (`{ id, ownerId }`); `VideoRoomSeatService.{findOpenSeat(actor,roomId),seatUser(roomId,userId,actorId,seatIndex,ip?),vacateUser(roomId,userId,actorId,action,ip?)}`; `VideoRoomSeatStateService.getSnapshot` (occupied count); `VideoRoomMediaService.demoteToSubscriber(roomId,userId,actorId)`; `VideoRoomEventService.{emitViewerPromoted,emitViewerDemoted}`; `VideoRoomPermission.{MANAGE_SEATS,MANAGE_PARTICIPANTS}`; `VideoRoomsMetrics.{incViewerPromotion,incViewerDemotion}`.
- Produces: `VideoRoomViewerService.promote(actor, roomId, dto: { targetUserId; seatIndex? }, ip?)` and `demote(actor, roomId, dto: { targetUserId }, ip?)`.

- [ ] **Step 1: Add the metric counters.** In `video-rooms.metrics.ts`, declare + register `video_rooms_viewer_promotions_total` and `video_rooms_viewer_demotions_total` Counters, and add:

```ts
incViewerPromotion(): void { this.viewerPromotions.inc(); }
incViewerDemotion(): void { this.viewerDemotions.inc(); }
```

- [ ] **Step 2: Write the failing tests.**

```ts
it('promote seats the viewer and bumps participant stats', async () => {
  repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
  repo.getMember.mockResolvedValue({ isActive: true });
  seat.findOpenSeat.mockResolvedValue(3);
  seatState.getSnapshot.mockResolvedValue({ seats: [{ status: 'OCCUPIED', occupantUserId: 'x' }, { status: 'OCCUPIED', occupantUserId: 'u1' }] });
  await svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4');
  expect(perm.assertPermission).toHaveBeenCalledWith({ id: 'owner', roles: [] }, { id: 'r1', ownerId: 'owner', status: 'LIVE' }, VideoRoomPermission.MANAGE_SEATS);
  expect(seat.seatUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 3, '1.2.3.4');
  expect(repo.setParticipantStats).toHaveBeenCalledWith('r1', 2);
  expect(events.emitViewerPromoted).toHaveBeenCalledWith({ roomId: 'r1', userId: 'u1', seatIndex: 3, actorId: 'owner' });
});

it('promote honors an explicit seatIndex', async () => {
  repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
  repo.getMember.mockResolvedValue({ isActive: true });
  seatState.getSnapshot.mockResolvedValue({ seats: [] });
  await svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1', seatIndex: 5 });
  expect(seat.findOpenSeat).not.toHaveBeenCalled();
  expect(seat.seatUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 5, undefined);
});

it('promote rejects a non-member target', async () => {
  repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
  repo.getMember.mockResolvedValue(null);
  await expect(svc.promote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'ghost' }))
    .rejects.toThrow(/not a viewer|VIDEO_ROOM_NOT_VIEWER/i);
});

it('demote vacates the seat, downgrades media, and bumps stats', async () => {
  repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
  seatState.getSnapshot.mockResolvedValue({ seats: [] });
  await svc.demote({ id: 'owner', roles: [] }, 'r1', { targetUserId: 'u1' }, '1.2.3.4');
  expect(perm.assertPermission).toHaveBeenCalledWith(expect.anything(), expect.anything(), VideoRoomPermission.MANAGE_PARTICIPANTS);
  expect(perm.assertOutranks).toHaveBeenCalledWith({ id: 'r1', ownerId: 'owner' }, 'owner', 'u1');
  expect(seat.vacateUser).toHaveBeenCalledWith('r1', 'u1', 'owner', 'seat.demoted', '1.2.3.4');
  expect(media.demoteToSubscriber).toHaveBeenCalledWith('r1', 'u1', 'owner');
  expect(repo.setParticipantStats).toHaveBeenCalledWith('r1', 0);
  expect(events.emitViewerDemoted).toHaveBeenCalledWith({ roomId: 'r1', userId: 'u1', actorId: 'owner' });
});

it('demote skips assertOutranks for self-demote', async () => {
  repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'owner', status: 'LIVE' });
  seatState.getSnapshot.mockResolvedValue({ seats: [] });
  await svc.demote({ id: 'u1', roles: [] }, 'r1', { targetUserId: 'u1' });
  expect(perm.assertOutranks).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run it red.** `npx jest video-room-viewer.service --silent -t promote` → FAIL.

- [ ] **Step 4: Implement promote/demote** (add to `VideoRoomViewerService`; inject `repo`, `permissions`, `seat`, `seatState`, `media`, plus the existing `events`/`metrics`). Helper `occupiedSeatCount` reads the seat snapshot.

```ts
async promote(
  actor: RoomActor,
  roomId: string,
  dto: { targetUserId: string; seatIndex?: number },
  ip?: string,
): Promise<void> {
  const room = await this.requireLiveRoom(roomId);
  await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);

  const member = await this.repo.getMember(roomId, dto.targetUserId);
  if (!member?.isActive) {
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_NOT_VIEWER,
      'That user is not a viewer in this room.',
      HttpStatus.CONFLICT,
    );
  }

  const seatIndex = dto.seatIndex ?? (await this.seat.findOpenSeat(actor, roomId));
  await this.seat.seatUser(roomId, dto.targetUserId, actor.id, seatIndex, ip);

  await this.repo.setParticipantStats(roomId, await this.occupiedSeatCount(roomId));
  await this.events.emitViewerPromoted({ roomId, userId: dto.targetUserId, seatIndex, actorId: actor.id });
  this.metrics.incViewerPromotion();
}

async demote(
  actor: RoomActor,
  roomId: string,
  dto: { targetUserId: string },
  ip?: string,
): Promise<void> {
  const room = await this.requireLiveRoom(roomId);
  await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_PARTICIPANTS);
  if (actor.id !== dto.targetUserId) {
    await this.permissions.assertOutranks({ id: room.id, ownerId: room.ownerId }, actor.id, dto.targetUserId);
  }

  await this.seat.vacateUser(roomId, dto.targetUserId, actor.id, 'seat.demoted', ip);
  await this.media.demoteToSubscriber(roomId, dto.targetUserId, actor.id);

  await this.repo.setParticipantStats(roomId, await this.occupiedSeatCount(roomId));
  await this.events.emitViewerDemoted({ roomId, userId: dto.targetUserId, actorId: actor.id });
  this.metrics.incViewerDemotion();
}

/** Load the room and assert it is live (promotion/demotion need a live room). */
private async requireLiveRoom(roomId: string): Promise<VideoRoom> {
  const room = await this.repo.findById(roomId);
  if (!room) {
    throw new BusinessException(ERROR_CODES.VIDEO_ROOM_NOT_FOUND, `Video room ${roomId} was not found.`, HttpStatus.NOT_FOUND);
  }
  if (room.status !== 'LIVE') {
    throw new BusinessException(ERROR_CODES.VIDEO_ROOM_ENDED, 'This room is not live.', HttpStatus.CONFLICT);
  }
  return room;
}

private async occupiedSeatCount(roomId: string): Promise<number> {
  const snap = await this.seatState.getSnapshot(roomId);
  if (!snap) return 0;
  return snap.seats.filter((s) => s.status === VideoRoomSeatStatus.OCCUPIED && s.occupantUserId).length;
}
```

Add the imports (`BusinessException`, `ERROR_CODES`, `HttpStatus`, `VideoRoom`/`VideoRoomSeatStatus` from `@prisma/client`, `VideoRoomPermission`, `VideoRoomsRepository`, `VideoRoomPermissionService`, `VideoRoomSeatService`, `VideoRoomSeatStateService`, `VideoRoomMediaService`) and the new constructor params.

- [ ] **Step 5: Run it green.** `npx jest video-room-viewer.service --silent` → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer promote/demote orchestration" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 9: `VideoRoomViewerQueryService`

Read models: audience page, count breakdown, `viewer/me`.

**Files:**
- Create: `src/modules/video-rooms/services/video-room-viewer-query.service.ts`
- Test: `src/modules/video-rooms/services/video-room-viewer-query.service.spec.ts`

**Interfaces:**
- Consumes: `IViewerPresence` (via `VIEWER_PRESENCE` token); `VideoRoomMemberService.{listPresence(roomId),getMySession(userId,roomId)}` (`VideoRoomPresenceView[]`, `VideoRoomSessionView | null`); `VideoRoomPermissionService.resolveEffectiveRole(room, userId)`; `VideoRoomsRepository.findById`; `toViewerPresence`; `VIEWER_CAPABILITIES`.
- Produces: `VideoRoomViewerQueryService.{listAudience(roomId,take,skip),countAudience(roomId),getMyViewer(userId,roomId)}` returning the DTO shapes from Task 10.

- [ ] **Step 1: Write the failing test.**

```ts
it('countAudience returns the audience total + a state breakdown', async () => {
  presence.audienceCount.mockResolvedValue(8);
  members.listPresence.mockResolvedValue([
    { userId: 'a', state: VideoRoomPresenceState.ONLINE },
    { userId: 'b', state: VideoRoomPresenceState.IDLE },
    { userId: 'c', state: VideoRoomPresenceState.RECONNECTING },
  ]);
  const out = await svc.countAudience('r1');
  expect(out.audience).toBe(8);
  expect(out.watching).toBe(1);
  expect(out.background).toBe(1);
  expect(out.reconnecting).toBe(1);
});

it('getMyViewer reports effective role, viewer status, and capabilities', async () => {
  repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'o1' });
  perm.resolveEffectiveRole.mockResolvedValue(null); // audience viewer
  members.getMySession.mockResolvedValue({ presenceState: VideoRoomPresenceState.ONLINE, socketId: 's1' });
  const me = await svc.getMyViewer('u1', 'r1');
  expect(me.status).toBe(ViewerStatus.WATCHING);
  expect(me.capabilities.canRequestSeat).toBe(true);
});
```

- [ ] **Step 2: Run it red.** `npx jest video-room-viewer-query.service --silent` → FAIL.

- [ ] **Step 3: Implement it.**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { VIEWER_CAPABILITIES } from '../constants/video-room-viewer-permissions';
import { ViewerStatus } from '../enums';
import { VIEWER_PRESENCE, type IViewerPresence } from '../interfaces/viewer-presence.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { toViewerPresence } from './video-room-viewer-presence.projection';
import { VideoRoomMemberService } from './video-room-member.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface ViewerCountBreakdown {
  audience: number;
  watching: number;
  background: number;
  reconnecting: number;
}

@Injectable()
export class VideoRoomViewerQueryService {
  constructor(
    @Inject(VIEWER_PRESENCE) private readonly presence: IViewerPresence,
    private readonly members: VideoRoomMemberService,
    private readonly permissions: VideoRoomPermissionService,
    private readonly repo: VideoRoomsRepository,
  ) {}

  listAudience(roomId: string, take: number, skip: number) {
    return this.presence.listAudience(roomId, take, skip);
  }

  async countAudience(roomId: string): Promise<ViewerCountBreakdown> {
    const [audience, presenceRows] = await Promise.all([
      this.presence.audienceCount(roomId),
      this.members.listPresence(roomId),
    ]);
    let watching = 0, background = 0, reconnecting = 0;
    for (const row of presenceRows) {
      const s = toViewerPresence(row.state);
      if (s === ViewerStatus.WATCHING) watching++;
      else if (s === ViewerStatus.BACKGROUND) background++;
      else if (s === ViewerStatus.RECONNECTING) reconnecting++;
    }
    return { audience, watching, background, reconnecting };
  }

  async getMyViewer(userId: string, roomId: string) {
    const room = await this.repo.findById(roomId);
    const role = room ? await this.permissions.resolveEffectiveRole(room, userId) : null;
    const session = await this.members.getMySession(userId, roomId);
    const status = session ? toViewerPresence(session.presenceState) : ViewerStatus.OFFLINE;
    return {
      userId,
      roomId,
      effectiveRole: role,          // null = audience viewer
      status,
      session,
      capabilities: VIEWER_CAPABILITIES,
    };
  }
}
```

- [ ] **Step 4: Run it green.** `npx jest video-room-viewer-query.service --silent` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer query service" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 10: Viewer DTOs + `video-rooms-viewers.controller.ts`

9 endpoints, thin delegation, mirroring `video-rooms-members.controller.ts`.

**Files:**
- Create: `src/modules/video-rooms/dto/viewer.dto.ts`
- Create: `src/modules/video-rooms/controllers/video-rooms-viewers.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-viewers.controller.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomViewerService`, `VideoRoomViewerQueryService`, `CurrentUser`, `NotGuest`, `ParseUuidPipe`, `AuthenticatedUser`, `RoomActor`, `JoinContext`.
- Produces: the REST surface (§8 of the spec).

- [ ] **Step 1: Create the DTOs.** `dto/viewer.dto.ts` — reuse the existing validators. `JoinViewerDto` mirrors `JoinVideoRoomDto` (`socketId` required, `deviceId?`, `platform?`, `password?`), `ReconnectViewerDto` adds `previousSocketId?`, `ViewerHeartbeatDto` = `{ socketId; inBackground? }`, `LeaveViewerDto` = `{ socketId? }`, `PromoteViewerDto = { targetUserId: uuid; seatIndex?: int >= 0 }`, `DemoteViewerDto = { targetUserId: uuid }`. Use `class-validator` decorators + `@ApiProperty` matching the existing DTOs. (If the existing join/leave/reconnect/heartbeat DTOs are a clean fit, re-export them under the viewer names rather than re-declaring — DRY.)

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class PromoteViewerDto {
  @ApiProperty({ format: 'uuid', description: 'The viewer to seat.' })
  @IsUUID()
  targetUserId!: string;

  @ApiProperty({ required: false, minimum: 0, description: 'Target seat; omit to auto-pick an open seat.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  seatIndex?: number;
}

export class DemoteViewerDto {
  @ApiProperty({ format: 'uuid', description: 'The participant to return to the audience.' })
  @IsUUID()
  targetUserId!: string;
}
// JoinViewerDto / LeaveViewerDto / ReconnectViewerDto / ViewerHeartbeatDto:
// re-export the existing Join/Leave/Reconnect/Heartbeat DTOs (identical fields).
export { JoinVideoRoomDto as JoinViewerDto } from './join-video-room.dto';
export { LeaveVideoRoomDto as LeaveViewerDto } from './leave-video-room.dto';
export { ReconnectVideoRoomDto as ReconnectViewerDto } from './reconnect-video-room.dto';
export { VideoRoomHeartbeatDto as ViewerHeartbeatDto } from './video-room-heartbeat.dto';
```

- [ ] **Step 2: Write the failing controller test.** Assert each route delegates to the right service method with mapped args (mirror `video-rooms-members.controller.spec.ts`). Cover: join → `viewer.joinAsViewer`; promote → `viewer.promote`; demote → `viewer.demote`; `viewers` → `query.listAudience`; `viewers/count` → `query.countAudience`; `viewer/me` → `query.getMyViewer`.

```ts
it('POST viewer/promote delegates with the actor, room, dto, ip', async () => {
  const user = { id: 'o1', roles: [], sid: 'sid1' };
  await controller.promote(user as any, 'r1', { targetUserId: 'u1', seatIndex: 3 }, '1.2.3.4');
  expect(viewer.promote).toHaveBeenCalledWith({ id: 'o1', roles: [] }, 'r1', { targetUserId: 'u1', seatIndex: 3 }, '1.2.3.4');
});
```

- [ ] **Step 3: Run it red.** `npx jest video-rooms-viewers.controller --silent` → FAIL.

- [ ] **Step 4: Implement the controller** (mirror the members controller: `@ApiTags('video-rooms')`, `@ApiBearerAuth()`, `@Controller('video-rooms')`, `@NotGuest()` + `@HttpCode(200)` on writes, `ParseUuidPipe` on `:id`, `@Ip()` on writes, full `@ApiOperation`/`@ApiResponse`). Endpoints:

```ts
@Post(':id/viewer/join')  @NotGuest() @HttpCode(HttpStatus.OK)  // → viewer.joinAsViewer
@Post(':id/viewer/leave') @NotGuest() @HttpCode(HttpStatus.OK)  // → viewer.leaveAsViewer
@Post(':id/viewer/reconnect') @NotGuest() @HttpCode(HttpStatus.OK) // → viewer.reconnectViewer
@Post(':id/viewer/heartbeat') @NotGuest() @HttpCode(HttpStatus.OK) // → viewer.heartbeat
@Post(':id/viewer/promote') @NotGuest() @HttpCode(HttpStatus.OK)   // → viewer.promote (body PromoteViewerDto)
@Post(':id/viewer/demote')  @NotGuest() @HttpCode(HttpStatus.OK)   // → viewer.demote (body DemoteViewerDto)
@Get(':id/viewers')        // → query.listAudience (limit/offset like the members controller)
@Get(':id/viewers/count')  // → query.countAudience
@Get(':id/viewer/me')      // → query.getMyViewer (CurrentUser)
```

Use the members controller's private `actor(user)` and `joinContext(dto, user, ip)` helpers verbatim.

- [ ] **Step 5: Run it green.** `npx jest video-rooms-viewers.controller --silent` → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(video-rooms): viewer REST controller + DTOs" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 11: Config `viewerPresenceMode` + module wiring + full verification

Register everything, bind the seam, add config, run every gate.

**Files:**
- Modify: `src/config/env.validation.ts`, `src/config/configuration.ts`, `.env.example`, `src/modules/video-rooms/config/video-room.config.ts`
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Test: run the whole `video-rooms` suite + `tsc` + `eslint` + boundaries

**Interfaces:**
- Produces: `videoRoom.viewerPresenceMode: 'durable' | 'ephemeral'` (default `'durable'`); DI binding `{ provide: VIEWER_PRESENCE, useClass: DurableViewerPresence }`.

- [ ] **Step 1: Add config.** In `configuration.ts` `videoRoom` namespace add `viewerPresenceMode: process.env.VIDEO_ROOM_VIEWER_PRESENCE_MODE ?? 'durable'`; add the key + coercion (`String(raw.viewerPresenceMode)`) to `video-room.config.ts` (`VideoRoomConfig` + `RawVideoRoomConfig` + `loadVideoRoomConfig`); add `VIDEO_ROOM_VIEWER_PRESENCE_MODE` to `env.validation.ts` (optional, default `durable`, `@IsIn(['durable','ephemeral'])`) and to `.env.example` with a comment.

- [ ] **Step 2: Wire the module.** In `video-rooms.module.ts`:
  - `import` `DurableViewerPresence`, `VideoRoomViewerService`, `VideoRoomViewerQueryService`, `VIEWER_PRESENCE`, `IViewerPresence`, `VideoRoomsViewersController`.
  - Add the three services + `DurableViewerPresence` to `providers`.
  - Add the seam binding (mode-aware, defaulting to durable):

```ts
{
  provide: VIEWER_PRESENCE,
  useExisting: DurableViewerPresence,
},
```

  (The `ephemeral` impl is a future task; when it lands, swap to a `useFactory` that reads `viewerPresenceMode`. For VR-6 the durable impl is the only implementation, so `useExisting` is correct and avoids an unused factory branch — YAGNI.)
  - Add `VideoRoomsViewersController` to `controllers`.

- [ ] **Step 3: Typecheck.** Run `npx tsc --noEmit`. Expected: no errors. Fix any signature drift.

- [ ] **Step 4: Lint + boundaries.** Run `npx eslint src/modules/video-rooms --max-warnings 0` and the repo's module-boundary check (the command used by prior phases). Expected: clean.

- [ ] **Step 5: Full module suite.** Run `npx jest src/modules/video-rooms --silent`. Expected: all green, zero regressions against the pre-VR-6 baseline.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(video-rooms): wire viewer mode module + config (VR-6)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §2 scale seam → Task 4 (+ Task 11 binding). §2 presence-labels → Task 1. §2 host-direct promote → Task 8. §2 participants-from-seat-snapshot → Tasks 4/8 (`occupiedSeatCount`). §2 stats reuse → Task 5.
- §3 reuse map → Tasks 7/8/9 delegate to the listed symbols; no duplication.
- §4 components → Tasks 1–10 create exactly the listed files; §4 wiring → Tasks 3/11.
- §5 seam → Task 4. §6.1 projection → Task 1; §6.2 counters → Tasks 4 (audience) + 9 (breakdown) + 5 (peak/participant stats).
- §7.1 facade → Task 7; §7.2 promote → Task 8; §7.3 demote (incl. live media gap-fill) → Tasks 6 + 8; §7.4 query → Task 9.
- §8 REST → Task 10. §9 DTOs/exceptions → Tasks 10 + 3. §10 events/socket/audit/metrics → Tasks 3 (events/socket) + 7/8 (metrics) + audit inside seat/media reuse. §11 permissions → Task 2. §12 validations → Tasks 7/8 (reuse VR-3/VR-4 gates). §13 config → Task 11. §14 testing → each task's spec. §15 order → task order. §16 non-goals → nothing built beyond scope (ephemeral impl explicitly deferred in Tasks 4/11).

**Placeholder scan:** no TBD/TODO; every code step shows complete code or an exact mirror reference with the precise reused signature.

**Type consistency:** `IViewerPresence` methods (`markPresent`/`markAbsent`/`isPresent`/`audienceCount`/`listAudience`) are identical in Tasks 4, 9, 11. `seatUser(roomId,userId,actorId,seatIndex,ip?)` / `vacateUser(roomId,userId,actorId,action,ip?)` / `findOpenSeat(actor,roomId)` match the verified VR-4 signatures. `emitViewerJoined/Left` (existing) + `emitViewerPromoted/Demoted/PresenceChanged` (Task 3) payloads match the event classes. `setParticipantStats(roomId, count)` matches between Tasks 5 and 8. `demoteToSubscriber(roomId, userId, actorId)` matches between Tasks 6 and 8.
