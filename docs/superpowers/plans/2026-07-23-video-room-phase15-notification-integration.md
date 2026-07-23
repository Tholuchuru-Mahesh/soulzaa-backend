# Video Room — Phase 15: Enterprise Notification & Real-Time Event Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge existing video-room domain events into the already-built notification spine — durable in-app rows, preference-gated push, and a chunked/idempotent followers fan-out — governed by a single config-driven notification matrix, without building any parallel notification, queue, device, or push infrastructure.

**Architecture:** A config **matrix** (single source of truth for channels/priority/audience/preference-toggle/TTL/collapse) drives a Prisma-free **dispatcher** that composes `NotificationService.create()` + `notify()`. Thin `OnModuleInit` **bridge listeners** subscribe to existing `video_room.*` events and call `dispatch()`. Only "creator went live" fans out to followers, via a chunked cursor **worker** on the reclaimed `notifications` BullMQ queue with Redis `SADD` delivery-idempotency. Every schema change is additive.

**Tech Stack:** NestJS 10, TypeScript, Prisma (PostgreSQL), Socket.IO (Redis adapter), BullMQ, `prom-client`, `EVENT_BUS` (in-process `EventEmitter2`), Jest.

## Global Constraints

- **No git operations.** Project rule + user instruction: work stays in the working tree, uncommitted. Every "Checkpoint" step runs verification only — never `git add`/`git commit`/`git`-anything.
- **Strictly additive & backward compatible.** No existing endpoint, event name, DTO field, table, queue, service signature, or push channel is removed or changed in a breaking way. New event/DTO/enum fields are optional or appended.
- **Reuse, don't duplicate.** `NotificationService` is the ONLY writer of notification rows / trigger of push. No new notification store, no new queue names, no new device API, no new push provider, no new socket transport.
- **REUSE_EXISTING rule.** Before adding a bridge for an event, confirm no existing listener already produces that notification. `Gift Received` (`GiftNotificationListener`) and `Follow` (`SocialNotificationListener`) are already wired — Phase 15 adds NO bridge for them.
- **Matrix is the single source of truth** for routing (channels, priority, audience, preference toggle, TTL, collapse key, wiring marker). New notification type = new matrix row.
- **Dispatcher is Prisma-free.** All persistence/lookups go through repositories/services (`NotificationService`, `VideoRoomsRepository`, `SOCIAL_SERVICE`, `RedisService`).
- **Fan-out = chunked + idempotent + horizontally scalable.** Redis `SADD` is the SOLE delivery-idempotency mechanism (no per-recipient delivery ledger).
- **Fine-grained preference gating lives in the dispatcher**, so push categories stay coarse (`INVITE`/`GIFT`/`SYSTEM`) — no new Android channel-ids.
- **Test runner:** `npx jest <path>` (unit specs next to source, `*.spec.ts`). **Typecheck:** `npx tsc --noEmit`. **Lint:** `npx eslint <path>`. **Prisma:** `npx prisma validate` / `npx prisma generate`.

## Confirmed contracts (consume verbatim — do not redefine)

- `INotificationService` / token `NOTIFICATION_SERVICE = Symbol('NOTIFICATION_SERVICE')` — `src/modules/notification/interfaces/notification.interface.ts`:
  - `create(input: CreateNotificationInput): Promise<NotificationView>`; `CreateNotificationInput = { userId: string; type: NotificationType; actorId?: string | null; entityType?: string | null; entityId?: string | null; data?: Record<string, unknown> | null }`.
  - `notify(userId: string, intent: PushIntent): Promise<boolean>`; `PushIntent = { category: PushCategory; title: string; body: string; redactedBody?: string; data?: Record<string, string>; priority?: PushPriority; ttlSeconds?: number; collapseKey?: string; threadId?: string; badge?: 'unread' | number }`.
  - `preferences(userId: string): Promise<NotificationPreferenceView>`.
- `PushPriority = 'high' | 'normal'` — `src/modules/device/interfaces/push-provider.interface.ts` (string union, NOT an enum).
- `PushCategory` + `PUSH_CATEGORIES = { MESSAGE, CALL, FRIEND, FOLLOW, INVITE, GIFT, SYSTEM, SECURITY }` (values equal keys) — `src/modules/device/interfaces/push.constants.ts`.
- `NotificationPreferenceView` — `src/modules/notification/interfaces/notification.interface.ts` (fields: `pushEnabled, messageEvents, callEvents, friendEvents, followEvents, inviteEvents, giftEvents, systemEvents, sound, vibration, showPreview, mutedUntil: Date|null`).
- `SocketManager.emitToNamespaceRoom(namespace: string, roomId: string, event: string, payload: unknown): void`; `SocketManager.emitToUserEverywhere(userId: string, event: string, payload: unknown): void` — `src/infra/socket/socket.manager.ts`. `SOCKET_NAMESPACES.VIDEO_ROOM = '/video-room'` — `src/common/constants/socket.constants.ts`.
- `IEventBus` — token `EVENT_BUS`, `src/common/events`: `subscribe<E extends DomainEvent>(name: string, handler: (e: E) => void | Promise<void>): () => void`; `publish<E>(event: E): Promise<void>`. `DomainEvent<TPayload>` — abstract `readonly name: string`, `constructor(readonly payload: TPayload)`.
- `QueueJobRegistry` — `src/infra/queue/workers/queue-job.registry.ts`: `register(queue: string, jobName: string, handler: (data: unknown, job: Job) => Promise<unknown>): void`; `dispatch(queue: string, job: Job): Promise<unknown>`.
- `QueueService` — `src/infra/queue/queue.service.ts`: `enqueue<T>(queue: QueueName, name: string, data: T, opts?: JobsOptions): Promise<Job>`. `QUEUE_NAMES.NOTIFICATIONS = 'notifications'`.
- `RedisService` — `src/infra/redis/redis.service.ts`: `readonly client: RedisClient` (`RedisClient = Redis | Cluster` from `ioredis`). Use `redis.client.sadd/srem/sismember/smembers/expire` directly (there is no `sismember` helper on `CacheService`; precedent: `presence.service.ts`).
- `SOCIAL_SERVICE = Symbol('SOCIAL_SERVICE')` + `ISocialService.followerIds(userId: string): Promise<string[]>` — `src/modules/social/interfaces/social.interface.ts`. Repo `FollowRepository.pageFollowerIds(userId, skip, take): Promise<{ ids: string[]; total: number }>` — `src/modules/social/repositories/follow.repository.ts`.
- Video-room events (`src/modules/video-rooms/events/`):
  - `SeatInvitationSentEvent` (`VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT`) payload `{ roomId; invitationId; inviterId; inviteeUserId; seatIndex: number|null; expiresAt: string }`.
  - `SeatRequestResolvedEvent` (`VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED`) payload `{ roomId; requestId; userId; status: SeatRequestResolution; actorId?: string|null; seatIndex?: number|null; requestedAt?: string }`; `SeatRequestResolution = 'ACCEPTED'|'REJECTED'|'CANCELLED'|'EXPIRED'|'PROMOTED'|'FAILED'`.
  - `ViewerPromotedEvent` (`VIDEO_ROOM_EVENTS.VIEWER_PROMOTED`) `{ roomId; userId; seatIndex: number; actorId: string }`; `ViewerDemotedEvent` (`VIDEO_ROOM_EVENTS.VIEWER_DEMOTED`) `{ roomId; userId; actorId: string }`.
  - `TreasureRewardDistributedEvent` (`VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED`) `TreasureEventBase & { userId; amount: number; walletTxnId: string|null }`; `TreasureUnlockedEvent` (`...UNLOCKED`) `TreasureEventBase & { poolAmount; winners: {userId; amount; shareBps}[]; algorithm; nextLevel }`. `TreasureEventBase = { correlationId; roomId; sessionId; boxId?; level?; batchId?; requestId? }`.
  - `PkInvitationSentEvent` `PkEventBase & { invitationId; inviteeUserId; inviterUserId; side; attempt; expiresAt }`; `PkInvitationAcceptedEvent`/`PkInvitationRejectedEvent` `PkEventBase & { invitationId; inviteeUserId }`; `PkWinnerDeclaredEvent` `PkEventBase & { winningTeamId: string|null; isDraw: boolean; winners: string[] }`. `PkEventBase = { roomId; battleId; requestId? }`.
  - `ChatAnnouncementCreatedEvent` (`VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED`) `{ roomId; announcementId; messageId; authorId; content; isPinned; audit? }`; `ChatMentionedEvent` (`...MENTIONED`) `{ roomId; messageId; senderId; recipientIds: string[]; scope: string|null }`.
  - `RoomClosedEvent` (`VIDEO_ROOM_EVENTS.CLOSED`) `{ roomId; actorId; ownerId; durationSeconds }`.
- `VideoRoomEventService` (`this.events`, `src/modules/video-rooms/services/video-room-event.service.ts`): `constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus)`; methods `emitRoomX(payload: RoomXEvent['payload']): Promise<void> { return this.bus.publish(new RoomXEvent(payload)); }`.
- `VideoRoomLifecycleService.activate(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView>` — `src/modules/video-rooms/services/video-room-lifecycle.service.ts:277`; goes OFFLINE→LIVE; today publishes only `this.events.emitRoomUpdated({ roomId, actorId, changed: ['status'] })`. `room.ownerId` is available (from `getRoomOrThrow`).
- `VideoRoomsRepository` (`src/modules/video-rooms/repositories/video-rooms.repository.ts`): `constructor(private readonly prisma: PrismaService, ...)`; `listActiveMembers(roomId, take, skip): Promise<VideoRoomMember[]>`; `countActiveMembers(roomId): Promise<number>`; `appendLog(input: AppendLogInput): Promise<void>` where `AppendLogInput = { roomId; actorId: string|null; action: VideoRoomLogAction; metadata?: Prisma.InputJsonValue }`. `VideoRoomMember.userId` is the id field.
- `VideoRoomsMetrics` (`src/modules/video-rooms/video-rooms.metrics.ts`): `constructor(metrics: MetricsService)`; pattern `new Counter({ name, help, labelNames, registers: [metrics.registry] })`. `MetricsService` is `@Global`, `readonly registry: Registry`.
- Controllers: `@ApiTags('video-rooms') @ApiBearerAuth() @Controller('video-rooms')`; JWT guard is GLOBAL (no per-controller `@UseGuards`); writes add `@NotGuest()` (`src/common/decorators/not-guest.decorator`); `@CurrentUser() user: AuthenticatedUser` (`src/common/decorators/current-user.decorator`, supports `@CurrentUser('id')`); `@Param('id', ParseUuidPipe)` (`src/common/pipes/parse-uuid.pipe`). `PrismaService` import: `src/infra/prisma/prisma.service`.
- `video-rooms.module.ts` is `@Global`; flat `controllers:` array + flat `providers:` array grouped by `// ---- VR-N ----` banners; custom tokens use `{ provide, useExisting }`.

---

### Task 1: Notification constants — kinds, matrix, collapse policy, fan-out chunk size, socket events

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-notification.constants.ts`
- Test: `src/modules/video-rooms/constants/video-room-notification.constants.spec.ts` (create)

**Interfaces:**
- Produces: `VIDEO_ROOM_NOTIFICATION_KINDS` (17 dispatchable kinds); `VideoRoomNotificationKind` type; `MatrixRow` interface; `VIDEO_ROOM_NOTIFICATION_MATRIX: Record<VideoRoomNotificationKind, MatrixRow>`; `toPushPriority(p: NotificationSeverity): PushPriority`; `VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE = 500`; `VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS = { min: 100, max: 2000 }`; `VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY`; `VIDEO_ROOM_NOTIFICATION_FANOUT_JOB`; `VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS`; `videoRoomFanoutSentKey(occurrenceId)`; `videoRoomNotificationMuteKey(userId)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/constants/video-room-notification.constants.spec.ts
import {
  VIDEO_ROOM_NOTIFICATION_KINDS as K,
  VIDEO_ROOM_NOTIFICATION_MATRIX as M,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS,
  toPushPriority,
  videoRoomFanoutSentKey,
} from './video-room-notification.constants';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';

describe('video-room notification matrix', () => {
  it('has a row for every dispatchable kind', () => {
    for (const kind of Object.values(K)) {
      expect(M[kind]).toBeDefined();
      expect(M[kind].preferenceToggle).toBeTruthy();
    }
  });

  it('never-collapse kinds (money/discrete) return undefined collapse key', () => {
    const ctx = { roomId: 'r1' };
    for (const kind of [K.SEAT_INVITATION, K.PK_WINNER, K.TREASURE_REWARD, K.SEAT_APPROVAL, K.MENTION]) {
      expect(M[kind].collapseKey?.(ctx)).toBeUndefined();
    }
  });

  it('collapse kinds return a room-scoped collapse key', () => {
    expect(M[K.ROOM_STARTED].collapseKey?.({ roomId: 'r1' })).toBe('vr:r1:live');
    expect(M[K.ANNOUNCEMENT].collapseKey?.({ roomId: 'r1' })).toBe('vr:r1:announcement');
  });

  it('keeps push categories coarse (INVITE/GIFT/SYSTEM only)', () => {
    const allowed = new Set([PUSH_CATEGORIES.INVITE, PUSH_CATEGORIES.GIFT, PUSH_CATEGORIES.SYSTEM]);
    for (const kind of Object.values(K)) expect(allowed.has(M[kind].pushCategory)).toBe(true);
  });

  it('maps HIGH/CRITICAL → high push priority, else normal', () => {
    expect(toPushPriority('CRITICAL')).toBe('high');
    expect(toPushPriority('HIGH')).toBe('high');
    expect(toPushPriority('NORMAL')).toBe('normal');
    expect(toPushPriority('LOW')).toBe('normal');
  });

  it('exposes a tunable fan-out chunk size within bounds', () => {
    expect(VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE).toBeGreaterThanOrEqual(VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS.min);
    expect(VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE).toBeLessThanOrEqual(VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS.max);
    expect(videoRoomFanoutSentKey('occ1')).toBe('video-room:notif:fanout:occ1:sent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/constants/video-room-notification.constants.spec.ts`
Expected: FAIL — cannot find `./video-room-notification.constants`.

- [ ] **Step 3: Create the constants + matrix**

```typescript
// src/modules/video-rooms/constants/video-room-notification.constants.ts
import type { NotificationType } from '@prisma/client';
import {
  PUSH_CATEGORIES,
  type PushCategory,
} from 'src/modules/device/interfaces/push.constants';
import type { PushPriority } from 'src/modules/device/interfaces/push-provider.interface';

/**
 * VR-15 notification matrix — the single source of truth for how a video-room
 * event is routed. Adding a notification type = adding a kind + a row here. Only
 * NEW-wired kinds live here; Gift Received / Follow are produced by existing
 * listeners (REUSE_EXISTING) and are deliberately absent, and purely in-room
 * socket events (treasure progress, pk started/ended, room lock/unlock, gift
 * sent) are owned by existing *-socket.listener.ts and are not dispatched here.
 */
export const VIDEO_ROOM_NOTIFICATION_KINDS = {
  ROOM_INVITATION: 'ROOM_INVITATION',
  SEAT_INVITATION: 'SEAT_INVITATION',
  SEAT_APPROVAL: 'SEAT_APPROVAL',
  SEAT_REJECTION: 'SEAT_REJECTION',
  VIEWER_PROMOTION: 'VIEWER_PROMOTION',
  VIEWER_DEMOTION: 'VIEWER_DEMOTION',
  TREASURE_UNLOCKED: 'TREASURE_UNLOCKED',
  TREASURE_REWARD: 'TREASURE_REWARD',
  PK_INVITATION: 'PK_INVITATION',
  PK_ACCEPTED: 'PK_ACCEPTED',
  PK_REJECTION: 'PK_REJECTION',
  PK_WINNER: 'PK_WINNER',
  ROOM_STARTED: 'ROOM_STARTED',
  ROOM_CLOSED: 'ROOM_CLOSED',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  MENTION: 'MENTION',
  SYSTEM: 'SYSTEM',
} as const;

export type VideoRoomNotificationKind =
  (typeof VIDEO_ROOM_NOTIFICATION_KINDS)[keyof typeof VIDEO_ROOM_NOTIFICATION_KINDS];

/** 4-level product severity; distinct from the device's 2-level PushPriority. */
export type NotificationSeverity = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

/** Which preference boolean gates this kind (checked in the dispatcher). */
export type PreferenceToggle =
  | 'inviteEvents'
  | 'giftEvents'
  | 'systemEvents'
  | 'roomEvents'
  | 'seatEvents'
  | 'treasureEvents'
  | 'pkEvents'
  | 'announcementEvents';

export type NotificationAudience = 'TARGET' | 'ROOM_MEMBERS' | 'FOLLOWERS';

export interface MatrixCollapseCtx {
  roomId: string;
}

export interface MatrixRow {
  /** Durable-row enum value. All NEW kinds persist an in-app row. */
  notificationType: NotificationType;
  /** Coarse push category — reused, never a new Android channel. */
  pushCategory: PushCategory;
  severity: NotificationSeverity;
  channels: { inApp: boolean; socket: boolean; push: boolean };
  preferenceToggle: PreferenceToggle;
  audience: NotificationAudience;
  ttlSeconds?: number;
  /** undefined = never collapse (discrete/must-see). */
  collapseKey?: (ctx: MatrixCollapseCtx) => string | undefined;
}

/** HIGH/CRITICAL are wake-the-screen; everything else is normal. */
export function toPushPriority(severity: NotificationSeverity): PushPriority {
  return severity === 'HIGH' || severity === 'CRITICAL' ? 'high' : 'normal';
}

const roomState = (ctx: MatrixCollapseCtx) => `vr:${ctx.roomId}:state`;
const roomLive = (ctx: MatrixCollapseCtx) => `vr:${ctx.roomId}:live`;
const roomAnnouncement = (ctx: MatrixCollapseCtx) => `vr:${ctx.roomId}:announcement`;

const K = VIDEO_ROOM_NOTIFICATION_KINDS;

export const VIDEO_ROOM_NOTIFICATION_MATRIX: Record<VideoRoomNotificationKind, MatrixRow> = {
  [K.ROOM_INVITATION]: { notificationType: 'ROOM_INVITE', pushCategory: PUSH_CATEGORIES.INVITE, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'inviteEvents', audience: 'TARGET', ttlSeconds: 120 },
  [K.SEAT_INVITATION]: { notificationType: 'SEAT_INVITE', pushCategory: PUSH_CATEGORIES.INVITE, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'seatEvents', audience: 'TARGET', ttlSeconds: 120 },
  [K.SEAT_APPROVAL]: { notificationType: 'SEAT_APPROVED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'seatEvents', audience: 'TARGET' },
  [K.SEAT_REJECTION]: { notificationType: 'SEAT_REJECTED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: false }, preferenceToggle: 'seatEvents', audience: 'TARGET' },
  [K.VIEWER_PROMOTION]: { notificationType: 'VIEWER_PROMOTED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'roomEvents', audience: 'TARGET' },
  [K.VIEWER_DEMOTION]: { notificationType: 'VIEWER_DEMOTED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: false }, preferenceToggle: 'roomEvents', audience: 'TARGET' },
  [K.TREASURE_UNLOCKED]: { notificationType: 'TREASURE_UNLOCKED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'treasureEvents', audience: 'ROOM_MEMBERS' },
  [K.TREASURE_REWARD]: { notificationType: 'TREASURE_REWARD', pushCategory: PUSH_CATEGORIES.GIFT, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'treasureEvents', audience: 'TARGET' },
  [K.PK_INVITATION]: { notificationType: 'PK_INVITE', pushCategory: PUSH_CATEGORIES.INVITE, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'pkEvents', audience: 'TARGET', ttlSeconds: 120 },
  [K.PK_ACCEPTED]: { notificationType: 'PK_ACCEPTED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: false }, preferenceToggle: 'pkEvents', audience: 'TARGET' },
  [K.PK_REJECTION]: { notificationType: 'PK_REJECTED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: false }, preferenceToggle: 'pkEvents', audience: 'TARGET' },
  [K.PK_WINNER]: { notificationType: 'PK_WINNER', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'pkEvents', audience: 'TARGET' },
  [K.ROOM_STARTED]: { notificationType: 'ROOM_STARTED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: false, push: true }, preferenceToggle: 'roomEvents', audience: 'FOLLOWERS', collapseKey: roomLive },
  [K.ROOM_CLOSED]: { notificationType: 'ROOM_CLOSED', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'LOW', channels: { inApp: true, socket: true, push: false }, preferenceToggle: 'roomEvents', audience: 'ROOM_MEMBERS', collapseKey: roomState },
  [K.ANNOUNCEMENT]: { notificationType: 'ANNOUNCEMENT', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'announcementEvents', audience: 'ROOM_MEMBERS', collapseKey: roomAnnouncement },
  [K.MENTION]: { notificationType: 'MENTION', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'HIGH', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'roomEvents', audience: 'TARGET' },
  [K.SYSTEM]: { notificationType: 'SYSTEM', pushCategory: PUSH_CATEGORIES.SYSTEM, severity: 'NORMAL', channels: { inApp: true, socket: true, push: true }, preferenceToggle: 'systemEvents', audience: 'TARGET' },
};

/** Tunable fan-out chunk size — see §7.1. Config override key resolves first. */
export const VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE = 500;
export const VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS = { min: 100, max: 2000 } as const;
export const VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY = 'videoRoom.notificationFanoutChunkSize';

/** BullMQ job name registered on the existing `notifications` queue. */
export const VIDEO_ROOM_NOTIFICATION_FANOUT_JOB = 'video-room.notification.fanout';

/** In-room live banner socket events on the /video-room namespace. */
export const VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS = {
  ROOM_NOTIFICATION: 'roomNotification',
  ANNOUNCEMENT: 'announcement',
} as const;

/** Redis set tracking already-delivered recipients for one fan-out occurrence. */
export const videoRoomFanoutSentKey = (occurrenceId: string): string =>
  `video-room:notif:fanout:${occurrenceId}:sent`;

/** Redis set of roomIds a user has muted notifications for. */
export const videoRoomNotificationMuteKey = (userId: string): string =>
  `video-room:notif:mute:${userId}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/constants/video-room-notification.constants.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/constants/video-room-notification.constants.ts`
Expected: clean. Do NOT commit (working-tree-only per project rule).

> Note: `notificationType` string literals (`'SEAT_INVITE'`, `'ROOM_STARTED'`, …) will only satisfy the `NotificationType` type after Task 2 regenerates the Prisma client. `npx tsc --noEmit` in this checkpoint may report those literals as not assignable — that is expected and resolves at Task 2 Step 6. Run the isolated jest spec (which does not import `@prisma/client` types at runtime) to confirm the logic; defer the full typecheck to Task 2.

---

### Task 2: Prisma — video-room NotificationType values, preference columns, mute table, migration

**Files:**
- Modify: `prisma/schema/notification.prisma` (enum + preference columns)
- Create: `prisma/schema/video_rooms_notification.prisma` (mute model)
- Create: `prisma/migrations/20260723000000_vr15_notification_integration/migration.sql`

**Interfaces:**
- Produces: `NotificationType` gains 19 video-room values; `NotificationPreference` gains `roomEvents/seatEvents/treasureEvents/pkEvents/announcementEvents`; new model `VideoRoomNotificationMute` (table `video_room_notification_mutes`).

- [ ] **Step 1: Append video-room values to the `NotificationType` enum**

In `prisma/schema/notification.prisma`, inside `enum NotificationType { ... }`, append after `GIFT_RECEIVED` (append-only — do not reorder existing values):

```prisma
  // ---- VR-15: video-room notification types (append-only) ----
  ROOM_STARTED
  ROOM_CLOSED
  ROOM_LOCKED
  ROOM_UNLOCKED
  SEAT_INVITE
  SEAT_APPROVED
  SEAT_REJECTED
  VIEWER_PROMOTED
  VIEWER_DEMOTED
  TREASURE_UNLOCKED
  TREASURE_REWARD
  PK_ACCEPTED
  PK_REJECTED
  PK_STARTED
  PK_ENDED
  PK_WINNER
  ANNOUNCEMENT
  MENTION
  SYSTEM
```

- [ ] **Step 2: Add the five preference columns**

In `prisma/schema/notification.prisma`, inside `model NotificationPreference`, after `systemEvents Boolean @default(true)`:

```prisma
  // ---- VR-15: video-room per-category switches (additive, default on) ----
  roomEvents         Boolean @default(true)
  seatEvents         Boolean @default(true)
  treasureEvents     Boolean @default(true)
  pkEvents           Boolean @default(true)
  announcementEvents Boolean @default(true)
```

- [ ] **Step 3: Create the mute model**

```prisma
// prisma/schema/video_rooms_notification.prisma
// VR-15 — per-room notification mute. Durable (survives Redis flush); the mute
// service keeps a Redis read-cache in front of it. No cross-module FK (platform
// convention) — userId/roomId are UUID values.

model VideoRoomNotificationMute {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  roomId    String   @db.Uuid
  createdAt DateTime @default(now())

  @@unique([userId, roomId])
  @@index([userId])
  @@map("video_room_notification_mutes")
}
```

- [ ] **Step 4: Write the authored-only migration**

```sql
-- prisma/migrations/20260723000000_vr15_notification_integration/migration.sql
-- VR-15 notification integration. Fully additive: enum ADD VALUE (ordered first,
-- outside the column txn), defaulted preference columns, one new table. No
-- backfill, no downtime. Authored-only (mirrors vr11/vr12) if shadow-replay is
-- blocked in this environment.

-- 1) NotificationType enum additions. ADD VALUE cannot run in the same tx as
--    statements that use the value, so these come first, each idempotent.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_CLOSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_LOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_UNLOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEAT_INVITE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEAT_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEAT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIEWER_PROMOTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIEWER_DEMOTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TREASURE_UNLOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TREASURE_REWARD';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_ENDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_WINNER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MENTION';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SYSTEM';

-- 2) Preference columns (additive, defaulted true).
ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "roomEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "seatEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "treasureEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "pkEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "announcementEvents" BOOLEAN NOT NULL DEFAULT true;

-- 3) Per-room mute table.
CREATE TABLE IF NOT EXISTS "video_room_notification_mutes" (
  "id"        UUID NOT NULL,
  "userId"    UUID NOT NULL,
  "roomId"    UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_notification_mutes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "video_room_notification_mutes_userId_roomId_key"
  ON "video_room_notification_mutes" ("userId", "roomId");
CREATE INDEX IF NOT EXISTS "video_room_notification_mutes_userId_idx"
  ON "video_room_notification_mutes" ("userId");
```

- [ ] **Step 5: Regenerate the Prisma client**

Run: `npx prisma validate && npx prisma generate`
Expected: schema valid; client regenerated so `@prisma/client` exports the new `NotificationType` members, the `VideoRoomNotificationMute` model delegate, and the new preference fields.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit`
Expected: clean — Task 1's `notificationType` literals now typecheck against the regenerated enum. Do NOT commit. Do NOT run `prisma migrate dev` (authored-only; project applies migrations out of band).

---

### Task 3: Preference plumbing — view, defaults, mapper, DTO for the five new toggles

**Files:**
- Modify: `src/modules/notification/interfaces/notification.interface.ts` (`NotificationPreferenceView`)
- Modify: `src/modules/notification/services/notification.service.ts` (`DEFAULT_PREFERENCES`, `toPreferenceView`)
- Modify: `src/modules/notification/dto/notification.dto.ts` (`UpdateNotificationPreferencesDto`)
- Test: `src/modules/notification/services/notification-preferences-vr15.spec.ts` (create)

**Interfaces:**
- Produces: `NotificationPreferenceView` and the update DTO both carry `roomEvents/seatEvents/treasureEvents/pkEvents/announcementEvents`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/notification/services/notification-preferences-vr15.spec.ts
import { NotificationService } from './notification.service';

describe('NotificationService VR-15 preferences', () => {
  it('defaults the five video-room toggles to true when no row exists', async () => {
    const prefRepo = { find: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
    const svc = new NotificationService(
      { create: jest.fn(), page: jest.fn(), markRead: jest.fn(), markAllRead: jest.fn(), unreadCount: jest.fn() } as never,
      prefRepo as never,
      { publish: jest.fn() } as never,
    );
    const prefs = await svc.preferences('u1');
    expect(prefs.roomEvents).toBe(true);
    expect(prefs.seatEvents).toBe(true);
    expect(prefs.treasureEvents).toBe(true);
    expect(prefs.pkEvents).toBe(true);
    expect(prefs.announcementEvents).toBe(true);
  });
});
```

> The constructor argument order must match `NotificationService`'s actual constructor — open the file and pass mocks positionally (repository, preference repository, event bus). Adjust the mock object shapes only if the constructor differs; the assertion on the five toggles is the point.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/notification/services/notification-preferences-vr15.spec.ts`
Expected: FAIL — `roomEvents` is `undefined` (not in `DEFAULT_PREFERENCES` / view).

- [ ] **Step 3: Extend `NotificationPreferenceView`**

In `notification.interface.ts`, inside `NotificationPreferenceView`, after `systemEvents: boolean;`:

```typescript
  // ---- VR-15 video-room categories ----
  roomEvents: boolean;
  seatEvents: boolean;
  treasureEvents: boolean;
  pkEvents: boolean;
  announcementEvents: boolean;
```

- [ ] **Step 4: Extend `DEFAULT_PREFERENCES` and `toPreferenceView`**

In `notification.service.ts`, add to the `DEFAULT_PREFERENCES` object (after `systemEvents: true,`):

```typescript
  roomEvents: true,
  seatEvents: true,
  treasureEvents: true,
  pkEvents: true,
  announcementEvents: true,
```

And in `toPreferenceView(p)` return (after `systemEvents: p.systemEvents,`):

```typescript
      roomEvents: p.roomEvents,
      seatEvents: p.seatEvents,
      treasureEvents: p.treasureEvents,
      pkEvents: p.pkEvents,
      announcementEvents: p.announcementEvents,
```

- [ ] **Step 5: Extend `UpdateNotificationPreferencesDto`**

In `notification.dto.ts`, after the existing `systemEvents` field (mirror the existing `@ApiPropertyOptional() @IsOptional() @IsBoolean()` pattern):

```typescript
  @ApiPropertyOptional() @IsOptional() @IsBoolean() roomEvents?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() seatEvents?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() treasureEvents?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pkEvents?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() announcementEvents?: boolean;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/notification/services/notification-preferences-vr15.spec.ts`
Expected: PASS.

- [ ] **Step 7: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/notification/interfaces/notification.interface.ts src/modules/notification/services/notification.service.ts src/modules/notification/dto/notification.dto.ts`
Expected: clean. Do NOT commit.

---

### Task 4: Per-room mute — repository + Redis-cached service

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-notification-mute.repository.ts`
- Create: `src/modules/video-rooms/services/video-room-notification-mute.service.ts`
- Test: `src/modules/video-rooms/services/video-room-notification-mute.service.spec.ts` (create)

**Interfaces:**
- Produces (repo): `VideoRoomNotificationMuteRepository` with `create(userId, roomId)`, `remove(userId, roomId)`, `list(userId): Promise<string[]>`, `exists(userId, roomId): Promise<boolean>`.
- Produces (service): `VideoRoomNotificationMuteService` with `mute(userId, roomId)`, `unmute(userId, roomId)`, `isMuted(userId, roomId): Promise<boolean>`, `listMuted(userId): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/services/video-room-notification-mute.service.spec.ts
import { VideoRoomNotificationMuteService } from './video-room-notification-mute.service';

function makeDeps() {
  const store = new Set<string>();
  const repo = {
    create: jest.fn(async (u: string, r: string) => { store.add(`${u}:${r}`); }),
    remove: jest.fn(async (u: string, r: string) => { store.delete(`${u}:${r}`); }),
    list: jest.fn(async (u: string) => [...store].filter((k) => k.startsWith(`${u}:`)).map((k) => k.split(':')[1])),
    exists: jest.fn(async (u: string, r: string) => store.has(`${u}:${r}`)),
  };
  const client = { sismember: jest.fn(), sadd: jest.fn(), srem: jest.fn() };
  const redis = { client };
  return { repo, redis, client };
}

describe('VideoRoomNotificationMuteService', () => {
  it('isMuted reads the Redis cache first, falling back to the repo on a miss', async () => {
    const d = makeDeps();
    d.client.sismember.mockResolvedValue(1);
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    expect(await svc.isMuted('u1', 'r1')).toBe(true);
    expect(d.client.sismember).toHaveBeenCalled();
    expect(d.repo.exists).not.toHaveBeenCalled();
  });

  it('mute persists to the repo and adds to the Redis set', async () => {
    const d = makeDeps();
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    await svc.mute('u1', 'r1');
    expect(d.repo.create).toHaveBeenCalledWith('u1', 'r1');
    expect(d.client.sadd).toHaveBeenCalledWith('video-room:notif:mute:u1', 'r1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-notification-mute.service.spec.ts`
Expected: FAIL — cannot find `./video-room-notification-mute.service`.

- [ ] **Step 3: Create the repository**

```typescript
// src/modules/video-rooms/repositories/video-room-notification-mute.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Durable per-room notification mutes (VR-15). Idempotent create via upsert. */
@Injectable()
export class VideoRoomNotificationMuteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, roomId: string): Promise<void> {
    await this.prisma.videoRoomNotificationMute.upsert({
      where: { userId_roomId: { userId, roomId } },
      create: { userId, roomId },
      update: {},
    });
  }

  async remove(userId: string, roomId: string): Promise<void> {
    await this.prisma.videoRoomNotificationMute.deleteMany({ where: { userId, roomId } });
  }

  async list(userId: string): Promise<string[]> {
    const rows = await this.prisma.videoRoomNotificationMute.findMany({
      where: { userId },
      select: { roomId: true },
    });
    return rows.map((r) => r.roomId);
  }

  async exists(userId: string, roomId: string): Promise<boolean> {
    const row = await this.prisma.videoRoomNotificationMute.findUnique({
      where: { userId_roomId: { userId, roomId } },
      select: { id: true },
    });
    return row !== null;
  }
}
```

- [ ] **Step 4: Create the service**

```typescript
// src/modules/video-rooms/services/video-room-notification-mute.service.ts
import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/infra/redis/redis.service';
import { videoRoomNotificationMuteKey } from '../constants/video-room-notification.constants';
import { VideoRoomNotificationMuteRepository } from '../repositories/video-room-notification-mute.repository';

/**
 * Per-room mute (VR-15). Durable table is the source of truth; a Redis set is a
 * hot-path read-cache for the dispatcher's per-recipient gate. isMuted trusts a
 * positive cache hit and falls back to the table on a miss (then warms the set).
 */
@Injectable()
export class VideoRoomNotificationMuteService {
  constructor(
    private readonly repo: VideoRoomNotificationMuteRepository,
    private readonly redis: RedisService,
  ) {}

  async mute(userId: string, roomId: string): Promise<void> {
    await this.repo.create(userId, roomId);
    await this.redis.client.sadd(videoRoomNotificationMuteKey(userId), roomId);
  }

  async unmute(userId: string, roomId: string): Promise<void> {
    await this.repo.remove(userId, roomId);
    await this.redis.client.srem(videoRoomNotificationMuteKey(userId), roomId);
  }

  async isMuted(userId: string, roomId: string): Promise<boolean> {
    const cached = await this.redis.client.sismember(videoRoomNotificationMuteKey(userId), roomId);
    if (cached === 1) return true;
    const persisted = await this.repo.exists(userId, roomId);
    if (persisted) await this.redis.client.sadd(videoRoomNotificationMuteKey(userId), roomId);
    return persisted;
  }

  listMuted(userId: string): Promise<string[]> {
    return this.repo.list(userId);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-notification-mute.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/repositories/video-room-notification-mute.repository.ts src/modules/video-rooms/services/video-room-notification-mute.service.ts`
Expected: clean. Do NOT commit.

---

### Task 5: Dispatcher — `VideoRoomNotificationService` (Prisma-free core) + member id lookup

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-rooms.repository.ts` (add `listActiveMemberIds`)
- Create: `src/modules/video-rooms/services/video-room-notification.service.ts`
- Test: `src/modules/video-rooms/services/video-room-notification.service.spec.ts` (create)

**Interfaces:**
- Consumes: `NOTIFICATION_SERVICE` (`create`, `notify`, `preferences`), `VideoRoomNotificationMuteService`, `VideoRoomsRepository.listActiveMemberIds`, `QueueService.enqueue`, the matrix, `toPushPriority`.
- Produces (repo): `listActiveMemberIds(roomId: string): Promise<string[]>`.
- Produces (service): `VideoRoomNotificationService` with `dispatch(kind: VideoRoomNotificationKind, ctx: DispatchContext): Promise<void>` and `dispatchSystem(ctx: DispatchContext & { audience?: NotificationAudience }): Promise<void>`. `DispatchContext = { roomId: string; targetUserIds?: string[]; ownerId?: string; occurrenceId?: string; actorId?: string | null; title: string; body: string; data?: Record<string, string> }`.

- [ ] **Step 1: Add `listActiveMemberIds` to the repository**

In `video-rooms.repository.ts`, next to `listActiveMembers`:

```typescript
  /** Active member user-ids for a room (bounded by room capacity). */
  async listActiveMemberIds(roomId: string): Promise<string[]> {
    const rows = await this.prisma.videoRoomMember.findMany({
      where: { roomId, isActive: true },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/modules/video-rooms/services/video-room-notification.service.spec.ts
import { VideoRoomNotificationService } from './video-room-notification.service';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function allOn() {
  return { pushEnabled: true, roomEvents: true, seatEvents: true, treasureEvents: true, pkEvents: true, announcementEvents: true, inviteEvents: true, giftEvents: true, systemEvents: true } as never;
}

function makeDeps() {
  const notifications = { create: jest.fn().mockResolvedValue({ id: 'n1' }), notify: jest.fn().mockResolvedValue(true), preferences: jest.fn().mockResolvedValue(allOn()) };
  const mute = { isMuted: jest.fn().mockResolvedValue(false) };
  const rooms = { listActiveMemberIds: jest.fn().mockResolvedValue(['a', 'b']) };
  const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'j1' }) };
  const metrics = { incNotificationDispatched: jest.fn(), incNotificationSuppressed: jest.fn() };
  return { notifications, mute, rooms, queue, metrics };
}

const svcOf = (d: ReturnType<typeof makeDeps>) =>
  new VideoRoomNotificationService(d.notifications as never, d.mute as never, d.rooms as never, d.queue as never, d.metrics as never);

describe('VideoRoomNotificationService', () => {
  it('TARGET seat approval: creates in-app + push for the target', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.SEAT_APPROVAL, { roomId: 'r1', targetUserIds: ['t1'], title: 'Approved', body: 'You may take a seat' });
    expect(d.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 't1', type: 'SEAT_APPROVED', entityType: 'VIDEO_ROOM', entityId: 'r1' }));
    expect(d.notifications.notify).toHaveBeenCalledWith('t1', expect.objectContaining({ badge: 'unread' }));
  });

  it('suppresses when the recipient muted the room', async () => {
    const d = makeDeps();
    d.mute.isMuted.mockResolvedValue(true);
    await svcOf(d).dispatch(K.SEAT_APPROVAL, { roomId: 'r1', targetUserIds: ['t1'], title: 'x', body: 'y' });
    expect(d.notifications.create).not.toHaveBeenCalled();
    expect(d.metrics.incNotificationSuppressed).toHaveBeenCalledWith('mute');
  });

  it('suppresses when the preference toggle is off', async () => {
    const d = makeDeps();
    d.notifications.preferences.mockResolvedValue({ ...allOn(), seatEvents: false });
    await svcOf(d).dispatch(K.SEAT_APPROVAL, { roomId: 'r1', targetUserIds: ['t1'], title: 'x', body: 'y' });
    expect(d.notifications.create).not.toHaveBeenCalled();
    expect(d.metrics.incNotificationSuppressed).toHaveBeenCalledWith('preference');
  });

  it('ROOM_MEMBERS announcement resolves members via the repo', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'Notice', body: 'Hello room' });
    expect(d.rooms.listActiveMemberIds).toHaveBeenCalledWith('r1');
    expect(d.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('FOLLOWERS room-started enqueues a fan-out job instead of resolving inline', async () => {
    const d = makeDeps();
    await svcOf(d).dispatch(K.ROOM_STARTED, { roomId: 'r1', ownerId: 'o1', occurrenceId: 'occ1', title: 'Live', body: 'o1 is live' });
    expect(d.queue.enqueue).toHaveBeenCalled();
    expect(d.notifications.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-notification.service.spec.ts`
Expected: FAIL — cannot find `./video-room-notification.service`.

- [ ] **Step 4: Create the dispatcher**

```typescript
// src/modules/video-rooms/services/video-room-notification.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueueService } from 'src/infra/queue/queue.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
  type NotificationPreferenceView,
} from 'src/modules/notification/interfaces/notification.interface';
import {
  MatrixRow,
  NotificationAudience,
  PreferenceToggle,
  toPushPriority,
  VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
  VIDEO_ROOM_NOTIFICATION_MATRIX,
  VideoRoomNotificationKind,
} from '../constants/video-room-notification.constants';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomNotificationMuteService } from './video-room-notification-mute.service';
import { VideoRoomNotificationMetrics } from '../metrics/video-room-notification.metrics';

export interface DispatchContext {
  roomId: string;
  targetUserIds?: string[];
  ownerId?: string;
  occurrenceId?: string;
  actorId?: string | null;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** Fan-out job payload — consumed by VideoRoomNotificationFanoutService (Task 6). */
export interface VideoRoomFanoutJob {
  kind: VideoRoomNotificationKind;
  roomId: string;
  ownerId: string;
  occurrenceId: string;
  cursor: number;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * VR-15 dispatcher — the single seam turning a video-room notification KIND into
 * durable in-app rows + preference-gated push, driven entirely by the matrix.
 * Prisma-free: it composes NotificationService + repositories/services only.
 * FOLLOWERS audiences are handed to a chunked fan-out worker; bounded audiences
 * (TARGET / ROOM_MEMBERS) are resolved and delivered inline.
 */
@Injectable()
export class VideoRoomNotificationService {
  private readonly logger = new Logger(VideoRoomNotificationService.name);

  constructor(
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    private readonly mute: VideoRoomNotificationMuteService,
    private readonly rooms: VideoRoomsRepository,
    private readonly queue: QueueService,
    private readonly metrics: VideoRoomNotificationMetrics,
  ) {}

  async dispatch(kind: VideoRoomNotificationKind, ctx: DispatchContext): Promise<void> {
    const row = VIDEO_ROOM_NOTIFICATION_MATRIX[kind];

    if (row.audience === 'FOLLOWERS') {
      if (!ctx.ownerId || !ctx.occurrenceId) {
        this.logger.warn(`FOLLOWERS dispatch for ${kind} missing ownerId/occurrenceId — skipped`);
        return;
      }
      await this.queue.enqueue<VideoRoomFanoutJob>(
        QUEUE_NAMES.NOTIFICATIONS,
        VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
        { kind, roomId: ctx.roomId, ownerId: ctx.ownerId, occurrenceId: ctx.occurrenceId, cursor: 0, title: ctx.title, body: ctx.body, data: ctx.data },
        { jobId: `vrnotif:${ctx.occurrenceId}:0`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
      );
      return;
    }

    const recipients = await this.resolveBounded(row.audience, ctx);
    for (const userId of recipients) await this.deliverOne(kind, row, userId, ctx);
  }

  /** SYSTEM entrypoint (admin/ops). Audience overridable; defaults to the matrix row. */
  async dispatchSystem(ctx: DispatchContext & { audience?: NotificationAudience }): Promise<void> {
    const kind = 'SYSTEM' as VideoRoomNotificationKind;
    const base = VIDEO_ROOM_NOTIFICATION_MATRIX[kind];
    const row: MatrixRow = { ...base, audience: ctx.audience ?? base.audience };
    const recipients = await this.resolveBounded(row.audience, ctx);
    for (const userId of recipients) await this.deliverOne(kind, row, userId, ctx);
  }

  private resolveBounded(audience: NotificationAudience, ctx: DispatchContext): Promise<string[]> {
    if (audience === 'ROOM_MEMBERS') return this.rooms.listActiveMemberIds(ctx.roomId);
    return Promise.resolve(ctx.targetUserIds ?? []);
  }

  /** Shared per-recipient gate + delivery. Reused by the fan-out worker (Task 6). */
  async deliverOne(
    kind: VideoRoomNotificationKind,
    row: MatrixRow,
    userId: string,
    ctx: DispatchContext,
  ): Promise<void> {
    if (await this.mute.isMuted(userId, ctx.roomId)) {
      this.metrics.incNotificationSuppressed('mute');
      return;
    }
    const prefs = await this.notifications.preferences(userId);
    if (!this.allowed(prefs, row.preferenceToggle)) {
      this.metrics.incNotificationSuppressed('preference');
      return;
    }

    if (row.channels.inApp) {
      await this.notifications.create({
        userId,
        type: row.notificationType,
        actorId: ctx.actorId ?? null,
        entityType: 'VIDEO_ROOM',
        entityId: ctx.roomId,
        data: { title: ctx.title, body: ctx.body, ...(ctx.data ?? {}) },
      });
      this.metrics.incNotificationDispatched(kind, 'inApp');
    }
    if (row.channels.push) {
      await this.notifications.notify(userId, {
        category: row.pushCategory,
        title: ctx.title,
        body: ctx.body,
        priority: toPushPriority(row.severity),
        ttlSeconds: row.ttlSeconds,
        collapseKey: row.collapseKey?.({ roomId: ctx.roomId }),
        data: { roomId: ctx.roomId, kind, ...(ctx.data ?? {}) },
        badge: 'unread',
      });
      this.metrics.incNotificationDispatched(kind, 'push');
    }
  }

  private allowed(prefs: NotificationPreferenceView, toggle: PreferenceToggle): boolean {
    return (prefs as unknown as Record<PreferenceToggle, boolean>)[toggle] === true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-notification.service.spec.ts`
Expected: PASS. (The test injects a metrics stub, so the spec passes standalone.)

> **Ordering note:** the dispatcher imports `VideoRoomNotificationMetrics` from `../metrics/video-room-notification.metrics`, which Task 12 Step 3 creates. That file has NO dependency on this task — so create it now (copy Task 12 Step 3 verbatim) before writing the dispatcher, then return here. This keeps the Step 6 typecheck clean without reordering the whole plan. Its method names (`incNotificationDispatched`, `incNotificationSuppressed`, `observeFanoutBatch`) are fixed and match Task 12.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/repositories/video-rooms.repository.ts src/modules/video-rooms/services/video-room-notification.service.ts`
Expected: clean (once the metrics class from Task 12 exists). Do NOT commit.

---

### Task 6: Fan-out worker — chunked, `SADD`-idempotent, on the reclaimed `notifications` queue

**Files:**
- Modify: `src/modules/social/interfaces/social.interface.ts` + `src/modules/social/services/social.service.ts` (expose `pageFollowerIds`)
- Modify: `src/infra/queue/processors/notifications.processor.ts` (delegate to `QueueJobRegistry`)
- Create: `src/modules/video-rooms/services/video-room-notification-fanout.service.ts`
- Test: `src/modules/video-rooms/services/video-room-notification-fanout.service.spec.ts` (create)

**Interfaces:**
- Consumes: `QueueJobRegistry.register`, `QueueService.enqueue`, `SOCIAL_SERVICE.pageFollowerIds`, `RedisService.client` (`sadd`/`expire`), `VideoRoomNotificationService.deliverOne`, the matrix, chunk-size constant + config.
- Produces (social): `ISocialService.pageFollowerIds(userId, skip, take): Promise<{ ids: string[]; total: number }>`.
- Produces: `VideoRoomNotificationFanoutService` (`@Injectable implements OnModuleInit`) with `handle(job: VideoRoomFanoutJob): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/services/video-room-notification-fanout.service.spec.ts
import { VideoRoomNotificationFanoutService } from './video-room-notification-fanout.service';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps(chunk = 2) {
  const registry = { register: jest.fn() };
  const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'j' }) };
  const social = { pageFollowerIds: jest.fn(), followerIds: jest.fn() };
  const added = new Set<string>();
  const client = {
    sadd: jest.fn(async (_k: string, m: string) => (added.has(m) ? 0 : (added.add(m), 1))),
    expire: jest.fn(),
  };
  const redis = { client };
  const dispatcher = { deliverOne: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(chunk) };
  return { registry, queue, social, redis, dispatcher, config, client };
}

const job = (cursor: number) => ({ kind: K.ROOM_STARTED, roomId: 'r1', ownerId: 'o1', occurrenceId: 'occ1', cursor, title: 'Live', body: 'o1 is live' });

describe('VideoRoomNotificationFanoutService', () => {
  it('delivers one chunk, dedupes via SADD, and enqueues the next cursor when more remain', async () => {
    const d = makeDeps(2);
    d.social.pageFollowerIds.mockResolvedValue({ ids: ['a', 'b'], total: 5 });
    const svc = new VideoRoomNotificationFanoutService(d.registry as never, d.queue as never, d.social as never, d.redis as never, d.dispatcher as never, d.config as never);

    await svc.handle(job(0) as never);

    expect(d.dispatcher.deliverOne).toHaveBeenCalledTimes(2);
    expect(d.queue.enqueue).toHaveBeenCalledWith('notifications', expect.any(String), expect.objectContaining({ cursor: 2 }), expect.objectContaining({ jobId: 'vrnotif:occ1:2' }));
  });

  it('a replayed chunk sends each recipient at most once (SADD returns 0)', async () => {
    const d = makeDeps(2);
    d.social.pageFollowerIds.mockResolvedValue({ ids: ['a', 'b'], total: 2 });
    const svc = new VideoRoomNotificationFanoutService(d.registry as never, d.queue as never, d.social as never, d.redis as never, d.dispatcher as never, d.config as never);

    await svc.handle(job(0) as never);
    await svc.handle(job(0) as never); // replay

    expect(d.dispatcher.deliverOne).toHaveBeenCalledTimes(2); // not 4
    expect(d.queue.enqueue).not.toHaveBeenCalled(); // total exhausted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-notification-fanout.service.spec.ts`
Expected: FAIL — cannot find the fan-out service.

- [ ] **Step 3: Expose `pageFollowerIds` on the social service (additive)**

In `src/modules/social/interfaces/social.interface.ts`, add to `ISocialService`:

```typescript
  pageFollowerIds(userId: string, skip: number, take: number): Promise<{ ids: string[]; total: number }>;
```

In `src/modules/social/services/social.service.ts`, add the delegating method (the repository already implements it):

```typescript
  pageFollowerIds(userId: string, skip: number, take: number): Promise<{ ids: string[]; total: number }> {
    return this.follows.pageFollowerIds(userId, skip, take);
  }
```

> Open the service to confirm the follow-repository property name (it is injected as a `FollowRepository`); use that property in place of `this.follows` if it differs.

- [ ] **Step 4: Make the notifications processor dispatch to the registry**

Replace the stub body of `src/infra/queue/processors/notifications.processor.ts` so registered handlers actually run (mirrors `wallet-processing.processor.ts`):

```typescript
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';
import { QueueJobRegistry } from '../workers/queue-job.registry';

/** Fan-out of in-app / push notifications — dispatches to registered handlers. */
@Processor(QUEUE_NAMES.NOTIFICATIONS, { concurrency: QUEUE_CONCURRENCY })
export class NotificationsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.NOTIFICATIONS, support);
  }

  async handle(job: Job): Promise<unknown> {
    return this.registry.dispatch(QUEUE_NAMES.NOTIFICATIONS, job);
  }
}
```

> `QueueJobRegistry` is exported from the `@Global` `QueueModule`, so no import wiring beyond this constructor change. Unregistered job names no-op safely (`dispatch` returns `{ ok: true, unhandled: true }`), so existing behavior is unchanged.

- [ ] **Step 5: Create the fan-out worker**

```typescript
// src/modules/video-rooms/services/video-room-notification-fanout.service.ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { RedisService } from 'src/infra/redis/redis.service';
import { SOCIAL_SERVICE, type ISocialService } from 'src/modules/social/interfaces/social.interface';
import {
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY,
  VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
  VIDEO_ROOM_NOTIFICATION_MATRIX,
  videoRoomFanoutSentKey,
} from '../constants/video-room-notification.constants';
import {
  VideoRoomNotificationService,
  type VideoRoomFanoutJob,
} from './video-room-notification.service';

const SENT_SET_TTL_SECONDS = 24 * 60 * 60;

/**
 * Chunked followers fan-out (VR-15). One BullMQ job = one bounded chunk; it
 * resolves the next page of the owner's followers, delivers each (with the
 * dispatcher's own preference/mute gate), and re-enqueues the next cursor if
 * more remain. Redis SADD per (occurrence, user) makes it at-most-once across
 * retries — the sole delivery-idempotency mechanism. Retry/backoff/DLQ come from
 * BaseQueueWorker via the notifications processor.
 */
@Injectable()
export class VideoRoomNotificationFanoutService implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomNotificationFanoutService.name);

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly queue: QueueService,
    @Inject(SOCIAL_SERVICE) private readonly social: ISocialService,
    private readonly redis: RedisService,
    private readonly dispatcher: VideoRoomNotificationService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      QUEUE_NAMES.NOTIFICATIONS,
      VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
      (data: unknown) => this.handle(data as VideoRoomFanoutJob),
    );
  }

  private chunkSize(): number {
    const raw = Number(this.config.get(VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE;
    const { min, max } = VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
  }

  async handle(job: VideoRoomFanoutJob): Promise<void> {
    const take = this.chunkSize();
    const { ids, total } = await this.social.pageFollowerIds(job.ownerId, job.cursor, take);
    const row = VIDEO_ROOM_NOTIFICATION_MATRIX[job.kind];
    const sentKey = videoRoomFanoutSentKey(job.occurrenceId);

    for (const userId of ids) {
      const fresh = await this.redis.client.sadd(sentKey, userId);
      if (fresh === 0) continue; // already delivered on a prior attempt
      await this.dispatcher.deliverOne(job.kind, row, userId, {
        roomId: job.roomId,
        actorId: job.ownerId,
        title: job.title,
        body: job.body,
        data: job.data,
      });
    }
    await this.redis.client.expire(sentKey, SENT_SET_TTL_SECONDS);

    const next = job.cursor + take;
    if (next < total) {
      await this.queue.enqueue<VideoRoomFanoutJob>(
        QUEUE_NAMES.NOTIFICATIONS,
        VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
        { ...job, cursor: next },
        { jobId: `vrnotif:${job.occurrenceId}:${next}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
      );
    }
  }
}
```

> The BullMQ handler signature is `(data, job) => Promise<unknown>`; the `Job` param is unused here (imported type only for clarity). `deliverOne` is the same gate the inline path uses, so preference + mute are honored per follower.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-notification-fanout.service.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/social/services/social.service.ts src/infra/queue/processors/notifications.processor.ts src/modules/video-rooms/services/video-room-notification-fanout.service.ts`
Expected: clean. Do NOT commit.

---

### Task 7: Room lifecycle — thin `STARTED` event + lifecycle/room bridge listener

**Files:**
- Modify: `src/modules/video-rooms/events/video-room.events.ts` (add `STARTED` + `RoomStartedEvent`)
- Modify: `src/modules/video-rooms/services/video-room-event.service.ts` (add `emitRoomStarted`)
- Modify: `src/modules/video-rooms/services/video-room-lifecycle.service.ts` (emit on go-live)
- Create: `src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.spec.ts` (create)

**Interfaces:**
- Produces (event): `VIDEO_ROOM_EVENTS.STARTED = 'video_room.started'`; `RoomStartedEvent` payload `{ roomId: string; ownerId: string; actorId: string }`.
- Produces (facade): `emitRoomStarted(payload: RoomStartedEvent['payload']): Promise<void>`.
- Produces (listener): `VideoRoomLifecycleNotificationListener` (`@Injectable implements OnModuleInit`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.spec.ts
import { VideoRoomLifecycleNotificationListener } from './video-room-lifecycle-notification.listener';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => undefined; }, publish: jest.fn() };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  return { handlers, bus, dispatcher };
}

describe('VideoRoomLifecycleNotificationListener', () => {
  it('room started → dispatch ROOM_STARTED to followers with ownerId + occurrenceId', async () => {
    const d = makeDeps();
    new VideoRoomLifecycleNotificationListener(d.bus as never, d.dispatcher as never).onModuleInit();
    await d.handlers[VIDEO_ROOM_EVENTS.STARTED]({ payload: { roomId: 'r1', ownerId: 'o1', actorId: 'o1' } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.ROOM_STARTED, expect.objectContaining({ roomId: 'r1', ownerId: 'o1', occurrenceId: expect.any(String) }));
  });

  it('room closed → dispatch ROOM_CLOSED to room members', async () => {
    const d = makeDeps();
    new VideoRoomLifecycleNotificationListener(d.bus as never, d.dispatcher as never).onModuleInit();
    await d.handlers[VIDEO_ROOM_EVENTS.CLOSED]({ payload: { roomId: 'r1', ownerId: 'o1', actorId: 'o1', durationSeconds: 10 } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.ROOM_CLOSED, expect.objectContaining({ roomId: 'r1' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.spec.ts`
Expected: FAIL — `VIDEO_ROOM_EVENTS.STARTED` undefined / listener missing.

- [ ] **Step 3: Add the `STARTED` event**

In `video-room.events.ts`, add to the `VIDEO_ROOM_EVENTS` const map (append):

```typescript
  STARTED: 'video_room.started',
```

And add the event class (mirroring `RoomClosedEvent`):

```typescript
/** A room went LIVE (OFFLINE→LIVE). Drives the followers "X is live" fan-out. */
export class RoomStartedEvent extends DomainEvent<{
  roomId: string;
  ownerId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.STARTED;
}
```

- [ ] **Step 4: Add the facade method + emit on go-live**

In `video-room-event.service.ts`, add (import `RoomStartedEvent` at top with the other event imports):

```typescript
  emitRoomStarted(payload: RoomStartedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomStartedEvent(payload));
  }
```

In `video-room-lifecycle.service.ts` `activate(...)`, after the existing `await this.events.emitRoomUpdated({ roomId, actorId: actor.id, changed: ['status'] });`:

```typescript
    await this.events.emitRoomStarted({ roomId, ownerId: room.ownerId, actorId: actor.id });
```

- [ ] **Step 5: Create the listener**

```typescript
// src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_EVENTS,
  type RoomClosedEvent,
  type RoomStartedEvent,
} from '../events/video-room.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges room lifecycle events to notifications (VR-15). */
@Injectable()
export class VideoRoomLifecycleNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomStartedEvent>(VIDEO_ROOM_EVENTS.STARTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.ROOM_STARTED, {
        roomId: p.roomId,
        ownerId: p.ownerId,
        actorId: p.ownerId,
        occurrenceId: `${p.roomId}:${e.eventId}`,
        title: 'Live now',
        body: 'A creator you follow just went live',
      });
    });

    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.ROOM_CLOSED, {
        roomId: p.roomId,
        actorId: p.actorId,
        title: 'Room closed',
        body: 'A room you were in has ended',
      });
    });
  }
}
```

> `DomainEvent` provides `eventId`; `${roomId}:${eventId}` is the stable fan-out `occurrenceId`. If `RoomClosedEvent`/`RoomStartedEvent` are not exported as types, add `export` to their class declarations (Step 3 already exports `RoomStartedEvent`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.spec.ts`
Expected: PASS.

- [ ] **Step 7: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/events/video-room.events.ts src/modules/video-rooms/services/video-room-event.service.ts src/modules/video-rooms/services/video-room-lifecycle.service.ts src/modules/video-rooms/listeners/video-room-lifecycle-notification.listener.ts`
Expected: clean. Do NOT commit.

---

### Task 8: Seat & viewer bridge — invitations, request resolution, promote/demote

**Files:**
- Modify: `src/modules/video-rooms/events/video-room-seat.events.ts` (add optional `type` to `SeatInvitationSentEvent`)
- Modify: `src/modules/video-rooms/services/video-room-seat-invitation.service.ts` (populate `type`)
- Create: `src/modules/video-rooms/listeners/video-room-seat-notification.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-seat-notification.listener.spec.ts` (create)

**Interfaces:**
- Produces (event): `SeatInvitationSentEvent` payload gains `type?: 'SEAT' | 'ROOM'`.
- Produces (listener): `VideoRoomSeatNotificationListener` (`@Injectable implements OnModuleInit`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/listeners/video-room-seat-notification.listener.spec.ts
import { VideoRoomSeatNotificationListener } from './video-room-seat-notification.listener';
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => undefined; }, publish: jest.fn() };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomSeatNotificationListener(bus as never, dispatcher as never).onModuleInit();
  return { handlers, dispatcher };
}

describe('VideoRoomSeatNotificationListener', () => {
  it('seat invitation (type SEAT) → SEAT_INVITATION to invitee', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT]({ payload: { roomId: 'r1', invitationId: 'i1', inviterId: 'h1', inviteeUserId: 'u1', seatIndex: 0, expiresAt: 'x', type: 'SEAT' } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.SEAT_INVITATION, expect.objectContaining({ roomId: 'r1', targetUserIds: ['u1'], actorId: 'h1' }));
  });

  it('room invitation (type ROOM) → ROOM_INVITATION', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT]({ payload: { roomId: 'r1', invitationId: 'i1', inviterId: 'h1', inviteeUserId: 'u1', seatIndex: null, expiresAt: 'x', type: 'ROOM' } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.ROOM_INVITATION, expect.objectContaining({ targetUserIds: ['u1'] }));
  });

  it('request resolved ACCEPTED → SEAT_APPROVAL; REJECTED → SEAT_REJECTION; others ignored', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({ payload: { roomId: 'r1', requestId: 'q1', userId: 'u1', status: 'ACCEPTED' } });
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({ payload: { roomId: 'r1', requestId: 'q2', userId: 'u2', status: 'REJECTED' } });
    await d.handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({ payload: { roomId: 'r1', requestId: 'q3', userId: 'u3', status: 'EXPIRED' } });
    const kinds = d.dispatcher.dispatch.mock.calls.map((c: unknown[]) => c[0]);
    expect(kinds).toEqual([K.SEAT_APPROVAL, K.SEAT_REJECTION]);
  });

  it('viewer promoted → VIEWER_PROMOTION; demoted → VIEWER_DEMOTION', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_EVENTS.VIEWER_PROMOTED]({ payload: { roomId: 'r1', userId: 'u1', seatIndex: 1, actorId: 'h1' } });
    await d.handlers[VIDEO_ROOM_EVENTS.VIEWER_DEMOTED]({ payload: { roomId: 'r1', userId: 'u2', actorId: 'h1' } });
    const kinds = d.dispatcher.dispatch.mock.calls.map((c: unknown[]) => c[0]);
    expect(kinds).toEqual([K.VIEWER_PROMOTION, K.VIEWER_DEMOTION]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-notification.listener.spec.ts`
Expected: FAIL — listener missing.

- [ ] **Step 3: Add optional `type` to `SeatInvitationSentEvent`**

In `video-room-seat.events.ts`, add `type?: 'SEAT' | 'ROOM';` to the `SeatInvitationSentEvent` payload generic (additive/optional — existing publishers still compile):

```typescript
export class SeatInvitationSentEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviterId: string;
  inviteeUserId: string;
  seatIndex: number | null;
  expiresAt: string;
  type?: 'SEAT' | 'ROOM';
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT;
}
```

- [ ] **Step 4: Populate `type` at the emit site**

In `video-room-seat-invitation.service.ts`, in the `new SeatInvitationSentEvent({ ... })` payload, add (the created invitation row `inv` carries `.type: VideoRoomInvitationType`):

```typescript
        type: inv.type,
```

- [ ] **Step 5: Create the listener**

```typescript
// src/modules/video-rooms/listeners/video-room-seat-notification.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationSentEvent,
  type SeatRequestResolvedEvent,
} from '../events/video-room-seat.events';
import {
  VIDEO_ROOM_EVENTS,
  type ViewerDemotedEvent,
  type ViewerPromotedEvent,
} from '../events/video-room.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges seat-workflow + viewer events to notifications (VR-15). */
@Injectable()
export class VideoRoomSeatNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, (e) => {
      const p = e.payload;
      const kind = p.type === 'ROOM' ? K.ROOM_INVITATION : K.SEAT_INVITATION;
      return this.notifications.dispatch(kind, {
        roomId: p.roomId,
        targetUserIds: [p.inviteeUserId],
        actorId: p.inviterId,
        title: p.type === 'ROOM' ? 'Room invitation' : 'Seat invitation',
        body: 'You have been invited',
      });
    });

    this.bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) => {
      const p = e.payload;
      if (p.status === 'ACCEPTED') {
        return this.notifications.dispatch(K.SEAT_APPROVAL, { roomId: p.roomId, targetUserIds: [p.userId], actorId: p.actorId ?? null, title: 'Seat approved', body: 'Your seat request was approved' });
      }
      if (p.status === 'REJECTED') {
        return this.notifications.dispatch(K.SEAT_REJECTION, { roomId: p.roomId, targetUserIds: [p.userId], actorId: p.actorId ?? null, title: 'Seat request declined', body: 'Your seat request was declined' });
      }
      return undefined; // CANCELLED/EXPIRED/PROMOTED/FAILED are not user-facing notifications
    });

    this.bus.subscribe<ViewerPromotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.VIEWER_PROMOTION, { roomId: p.roomId, targetUserIds: [p.userId], actorId: p.actorId, title: 'You are on a seat', body: 'You were promoted to a seat' });
    });

    this.bus.subscribe<ViewerDemotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_DEMOTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.VIEWER_DEMOTION, { roomId: p.roomId, targetUserIds: [p.userId], actorId: p.actorId, title: 'Returned to audience', body: 'You were moved back to the audience' });
    });
  }
}
```

> `ViewerPromotedEvent` / `ViewerDemotedEvent` live in `video-room-viewer.events.ts` but are re-exported through the events barrel; if the direct import path errors, import them from `'../events/video-room-viewer.events'`. Confirm the export site during implementation.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-seat-notification.listener.spec.ts`
Expected: PASS.

- [ ] **Step 7: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/events/video-room-seat.events.ts src/modules/video-rooms/services/video-room-seat-invitation.service.ts src/modules/video-rooms/listeners/video-room-seat-notification.listener.ts`
Expected: clean. Do NOT commit.

---

### Task 9: Engagement bridge — treasure & PK

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-engagement-notification.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-engagement-notification.listener.spec.ts` (create)

**Interfaces:**
- Produces: `VideoRoomEngagementNotificationListener` (`@Injectable implements OnModuleInit`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/listeners/video-room-engagement-notification.listener.spec.ts
import { VideoRoomEngagementNotificationListener } from './video-room-engagement-notification.listener';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => undefined; }, publish: jest.fn() };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomEngagementNotificationListener(bus as never, dispatcher as never).onModuleInit();
  return { handlers, dispatcher };
}

describe('VideoRoomEngagementNotificationListener', () => {
  it('treasure reward → TREASURE_REWARD to the recipient', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]({ payload: { roomId: 'r1', correlationId: 'c', sessionId: 's', userId: 'u1', amount: 50, walletTxnId: 'w1' } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.TREASURE_REWARD, expect.objectContaining({ roomId: 'r1', targetUserIds: ['u1'] }));
  });

  it('treasure unlocked → TREASURE_UNLOCKED to room members', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED]({ payload: { roomId: 'r1', correlationId: 'c', sessionId: 's', poolAmount: 100, winners: [], algorithm: 'x', nextLevel: null } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.TREASURE_UNLOCKED, expect.objectContaining({ roomId: 'r1' }));
  });

  it('pk invitation/accepted/rejected/winner map to their kinds', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_PK_EVENTS.INVITATION_SENT]({ payload: { roomId: 'r1', battleId: 'b1', invitationId: 'i', inviteeUserId: 'u1', inviterUserId: 'h1', side: 'A', attempt: 1, expiresAt: 'x' } });
    await d.handlers[VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED]({ payload: { roomId: 'r1', battleId: 'b1', invitationId: 'i', inviteeUserId: 'u1' } });
    await d.handlers[VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED]({ payload: { roomId: 'r1', battleId: 'b1', invitationId: 'i', inviteeUserId: 'u1' } });
    await d.handlers[VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED]({ payload: { roomId: 'r1', battleId: 'b1', winningTeamId: 't1', isDraw: false, winners: ['u1', 'u2'] } });
    const kinds = d.dispatcher.dispatch.mock.calls.map((c: unknown[]) => c[0]);
    expect(kinds).toEqual([K.PK_INVITATION, K.PK_ACCEPTED, K.PK_REJECTION, K.PK_WINNER]);
    const winnerCall = d.dispatcher.dispatch.mock.calls.find((c: unknown[]) => c[0] === K.PK_WINNER)!;
    expect((winnerCall[1] as { targetUserIds: string[] }).targetUserIds).toEqual(['u1', 'u2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-engagement-notification.listener.spec.ts`
Expected: FAIL — listener missing.

- [ ] **Step 3: Create the listener**

```typescript
// src/modules/video-rooms/listeners/video-room-engagement-notification.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureRewardDistributedEvent,
  type TreasureUnlockedEvent,
} from '../events/video-room-treasure.events';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkInvitationAcceptedEvent,
  type PkInvitationRejectedEvent,
  type PkInvitationSentEvent,
  type PkWinnerDeclaredEvent,
} from '../events/video-room-pk.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges treasure + PK engagement events to notifications (VR-15). */
@Injectable()
export class VideoRoomEngagementNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureRewardDistributedEvent>(VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.TREASURE_REWARD, { roomId: p.roomId, targetUserIds: [p.userId], title: 'Treasure reward', body: `You received ${p.amount}`, data: { amount: String(p.amount) } });
    });

    this.bus.subscribe<TreasureUnlockedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.TREASURE_UNLOCKED, { roomId: p.roomId, title: 'Treasure unlocked', body: 'A treasure box was unlocked in the room' });
    });

    this.bus.subscribe<PkInvitationSentEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.PK_INVITATION, { roomId: p.roomId, targetUserIds: [p.inviteeUserId], actorId: p.inviterUserId, title: 'PK invitation', body: 'You were challenged to a PK battle' });
    });

    this.bus.subscribe<PkInvitationAcceptedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.PK_ACCEPTED, { roomId: p.roomId, targetUserIds: [p.inviteeUserId], title: 'PK accepted', body: 'Your PK invitation was accepted' });
    });

    this.bus.subscribe<PkInvitationRejectedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.PK_REJECTION, { roomId: p.roomId, targetUserIds: [p.inviteeUserId], title: 'PK declined', body: 'Your PK invitation was declined' });
    });

    this.bus.subscribe<PkWinnerDeclaredEvent>(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED, (e) => {
      const p = e.payload;
      if (p.winners.length === 0) return undefined;
      return this.notifications.dispatch(K.PK_WINNER, { roomId: p.roomId, targetUserIds: p.winners, title: 'PK winner', body: 'You won the PK battle' });
    });
  }
}
```

> `PK_ACCEPTED` / `PK_REJECTED` notifications target the invitee here (they get the follow-up). If product wants the *inviter* notified instead, the accepted/rejected event payloads do not carry the inviter id — that would require adding it at the emit site (additive follow-up), out of scope for this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-engagement-notification.listener.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/listeners/video-room-engagement-notification.listener.ts`
Expected: clean. Do NOT commit.

---

### Task 10: Chat bridge + in-room notification socket listener

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-chat-notification.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-notification-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-chat-notification.listener.spec.ts` (create)
- Test: `src/modules/video-rooms/listeners/video-room-notification-socket.listener.spec.ts` (create)

**Interfaces:**
- Produces: `VideoRoomChatNotificationListener` and `VideoRoomNotificationSocketListener` (both `@Injectable implements OnModuleInit`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/modules/video-rooms/listeners/video-room-chat-notification.listener.spec.ts
import { VideoRoomChatNotificationListener } from './video-room-chat-notification.listener';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => undefined; }, publish: jest.fn() };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomChatNotificationListener(bus as never, dispatcher as never).onModuleInit();
  return { handlers, dispatcher };
}

describe('VideoRoomChatNotificationListener', () => {
  it('announcement → ANNOUNCEMENT to room members', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({ payload: { roomId: 'r1', announcementId: 'a1', messageId: 'm1', authorId: 'h1', content: 'Hello', isPinned: true } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.ANNOUNCEMENT, expect.objectContaining({ roomId: 'r1', actorId: 'h1', body: 'Hello' }));
  });

  it('mention → MENTION to each recipient', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.MENTIONED]({ payload: { roomId: 'r1', messageId: 'm1', senderId: 'h1', recipientIds: ['u1', 'u2'], scope: null } });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(K.MENTION, expect.objectContaining({ targetUserIds: ['u1', 'u2'], actorId: 'h1' }));
  });
});
```

```typescript
// src/modules/video-rooms/listeners/video-room-notification-socket.listener.spec.ts
import { VideoRoomNotificationSocketListener } from './video-room-notification-socket.listener';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS } from '../constants/video-room-notification.constants';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

describe('VideoRoomNotificationSocketListener', () => {
  it('emits an in-room announcement banner on the /video-room namespace', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => undefined; }, publish: jest.fn() };
    const sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    new VideoRoomNotificationSocketListener(bus as never, sockets as never).onModuleInit();

    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({ payload: { roomId: 'r1', announcementId: 'a1', messageId: 'm1', authorId: 'h1', content: 'Hi', isPinned: false } });

    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(SOCKET_NAMESPACES.VIDEO_ROOM, 'r1', VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS.ANNOUNCEMENT, expect.objectContaining({ content: 'Hi' }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-notification.listener.spec.ts src/modules/video-rooms/listeners/video-room-notification-socket.listener.spec.ts`
Expected: FAIL — listeners missing.

- [ ] **Step 3: Create the chat notification bridge**

```typescript
// src/modules/video-rooms/listeners/video-room-chat-notification.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_CHAT_EVENTS,
  type ChatAnnouncementCreatedEvent,
  type ChatMentionedEvent,
} from '../events/video-room-chat.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges chat announcement + mention events to durable notifications (VR-15). */
@Injectable()
export class VideoRoomChatNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ChatAnnouncementCreatedEvent>(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.ANNOUNCEMENT, { roomId: p.roomId, actorId: p.authorId, title: 'Announcement', body: p.content, data: { announcementId: p.announcementId } });
    });

    this.bus.subscribe<ChatMentionedEvent>(VIDEO_ROOM_CHAT_EVENTS.MENTIONED, (e) => {
      const p = e.payload;
      if (p.recipientIds.length === 0) return undefined;
      return this.notifications.dispatch(K.MENTION, { roomId: p.roomId, targetUserIds: p.recipientIds, actorId: p.senderId, title: 'You were mentioned', body: 'You were mentioned in a room', data: { messageId: p.messageId } });
    });
  }
}
```

- [ ] **Step 4: Create the in-room socket listener**

```typescript
// src/modules/video-rooms/listeners/video-room-notification-socket.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_CHAT_EVENTS,
  type ChatAnnouncementCreatedEvent,
} from '../events/video-room-chat.events';

/**
 * In-room live banners on /video-room (VR-15) for events with no existing in-room
 * socket emission (announcements). Durable notification.created / read / count
 * continue to fan out on /notifications via the existing NotificationSocketListener;
 * gift/pk/treasure/seat/role in-room events stay owned by their existing listeners.
 */
@Injectable()
export class VideoRoomNotificationSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ChatAnnouncementCreatedEvent>(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED, (e) => {
      const p = e.payload;
      this.sockets.emitToNamespaceRoom(
        SOCKET_NAMESPACES.VIDEO_ROOM,
        p.roomId,
        VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS.ANNOUNCEMENT,
        { announcementId: p.announcementId, messageId: p.messageId, authorId: p.authorId, content: p.content, isPinned: p.isPinned },
      );
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-notification.listener.spec.ts src/modules/video-rooms/listeners/video-room-notification-socket.listener.spec.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/listeners/video-room-chat-notification.listener.ts src/modules/video-rooms/listeners/video-room-notification-socket.listener.ts`
Expected: clean. Do NOT commit.

---

### Task 11: Per-room mute REST endpoints

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-notification.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-notification.controller.spec.ts` (create)

**Interfaces:**
- Consumes: `VideoRoomNotificationMuteService`, `@CurrentUser`, `ParseUuidPipe`, `@NotGuest`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/video-rooms/controllers/video-rooms-notification.controller.spec.ts
import { VideoRoomsNotificationController } from './video-rooms-notification.controller';

describe('VideoRoomsNotificationController', () => {
  const mute = { mute: jest.fn().mockResolvedValue(undefined), unmute: jest.fn().mockResolvedValue(undefined), listMuted: jest.fn().mockResolvedValue(['r1']) };
  const ctrl = new VideoRoomsNotificationController(mute as never);
  const user = { id: 'u1' } as never;

  it('POST mute delegates to the service', async () => {
    await ctrl.mute(user, 'r1');
    expect(mute.mute).toHaveBeenCalledWith('u1', 'r1');
  });

  it('DELETE mute delegates to unmute', async () => {
    await ctrl.unmute(user, 'r1');
    expect(mute.unmute).toHaveBeenCalledWith('u1', 'r1');
  });

  it('GET mute lists muted rooms and reports membership', async () => {
    const res = await ctrl.status(user, 'r1');
    expect(res).toEqual({ roomId: 'r1', muted: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-notification.controller.spec.ts`
Expected: FAIL — controller missing.

- [ ] **Step 3: Create the controller**

```typescript
// src/modules/video-rooms/controllers/video-rooms-notification.controller.ts
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { VideoRoomNotificationMuteService } from '../services/video-room-notification-mute.service';

/**
 * Per-room notification mute (VR-15). Global JwtAuthGuard secures every route;
 * all generic notification/preference/device endpoints are served by the existing
 * NotificationController / DeviceController — this controller adds ONLY per-room mute.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsNotificationController {
  constructor(private readonly muteService: VideoRoomNotificationMuteService) {}

  @Post(':id/notifications/mute')
  @NotGuest()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Mute notifications for this video room' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Room muted for the current user.' })
  async mute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string): Promise<void> {
    await this.muteService.mute(user.id, roomId);
  }

  @Delete(':id/notifications/mute')
  @NotGuest()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Unmute notifications for this video room' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Room unmuted for the current user.' })
  async unmute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string): Promise<void> {
    await this.muteService.unmute(user.id, roomId);
  }

  @Get(':id/notifications/mute')
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Whether the current user muted this video room' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Mute status.' })
  async status(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string): Promise<{ roomId: string; muted: boolean }> {
    const muted = await this.muteService.listMuted(user.id);
    return { roomId, muted: muted.includes(roomId) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-notification.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint (NO git)**

Run: `npx tsc --noEmit && npx eslint src/modules/video-rooms/controllers/video-rooms-notification.controller.ts`
Expected: clean. Do NOT commit.

---

### Task 12: Metrics, audit, module wiring, integration test & BC verification

**Files:**
- Create: `src/modules/video-rooms/metrics/video-room-notification.metrics.ts`
- Modify: `src/modules/video-rooms/services/video-room-notification.service.ts` (audit hook — optional log)
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (register all new providers + controller)
- Test: `src/modules/video-rooms/metrics/video-room-notification.metrics.spec.ts` (create)
- Test: `src/modules/video-rooms/video-rooms-notification-integration.spec.ts` (create)

**Interfaces:**
- Produces: `VideoRoomNotificationMetrics` (`@Injectable`) with `incNotificationDispatched(kind: string, channel: string): void`, `incNotificationSuppressed(reason: string): void`, `observeFanoutBatch(seconds: number): void`.

- [ ] **Step 1: Write the failing metrics test**

```typescript
// src/modules/video-rooms/metrics/video-room-notification.metrics.spec.ts
import { MetricsService } from 'src/infra/observability/metrics.service';
import { VideoRoomNotificationMetrics } from './video-room-notification.metrics';

describe('VideoRoomNotificationMetrics', () => {
  it('registers notification metric families on the shared registry', async () => {
    const metrics = new MetricsService();
    const vr = new VideoRoomNotificationMetrics(metrics);
    vr.incNotificationDispatched('SEAT_APPROVAL', 'push');
    vr.incNotificationSuppressed('mute');
    vr.observeFanoutBatch(0.02);
    const out = await metrics.registry.metrics();
    expect(out).toContain('video_room_notifications_dispatched_total');
    expect(out).toContain('video_room_notifications_suppressed_total');
    expect(out).toContain('video_room_notification_fanout_batch_duration_seconds');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/metrics/video-room-notification.metrics.spec.ts`
Expected: FAIL — cannot find the metrics class.

- [ ] **Step 3: Create the metrics class**

```typescript
// src/modules/video-rooms/metrics/video-room-notification.metrics.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

/** VR-15 notification metrics on the shared /metrics registry. */
@Injectable()
export class VideoRoomNotificationMetrics {
  private readonly dispatched: Counter<'kind' | 'channel'>;
  private readonly suppressed: Counter<'reason'>;
  private readonly fanoutBatch: Histogram<string>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.dispatched = new Counter({ name: 'video_room_notifications_dispatched_total', help: 'Video-room notifications dispatched', labelNames: ['kind', 'channel'] as const, registers });
    this.suppressed = new Counter({ name: 'video_room_notifications_suppressed_total', help: 'Video-room notifications suppressed', labelNames: ['reason'] as const, registers });
    this.fanoutBatch = new Histogram({ name: 'video_room_notification_fanout_batch_duration_seconds', help: 'Fan-out chunk handling duration', buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3], registers });
  }

  incNotificationDispatched(kind: string, channel: string): void {
    this.dispatched.inc({ kind, channel });
  }

  incNotificationSuppressed(reason: string): void {
    this.suppressed.inc({ reason });
  }

  observeFanoutBatch(seconds: number): void {
    this.fanoutBatch.observe(seconds);
  }
}
```

> If Task 5 was implemented before this class existed, replace its temporary metrics stub import with this class now; the method names (`incNotificationDispatched`, `incNotificationSuppressed`) match exactly.

- [ ] **Step 4: Add a lightweight audit hook in the dispatcher (optional log)**

In `video-room-notification.service.ts` `deliverOne`, after a successful `create(...)`, append an audit line via the injected `VideoRoomsRepository.appendLog` (add `roomsRepo.appendLog` usage — `VideoRoomsRepository` is already injected as `this.rooms`):

```typescript
      await this.rooms.appendLog({
        roomId: ctx.roomId,
        actorId: ctx.actorId ?? null,
        action: VideoRoomLogAction.ANNOUNCEMENT_POSTED, // generic notification audit marker
        metadata: { kind, userId, notificationType: row.notificationType },
      });
```

Add the import: `import { VideoRoomLogAction } from '@prisma/client';`. (This reuses the existing append-only `video_room_logs` audit store; no new audit infrastructure. If a more specific `VideoRoomLogAction` value is preferred, pick the closest existing enum member — do not add new enum values in this task.)

> Keep this audit write inside the `row.channels.inApp` branch so it fires once per durable notification, carrying kind/userId/notificationType (+ roomId/actorId from the log row) — the brief's audit-field set. Guard it so an audit failure never blocks delivery (wrap in try/catch logging a warning).

- [ ] **Step 5: Wire everything into `video-rooms.module.ts`**

Add imports at the top and register in the arrays (new `// ---- VR-15 notifications ----` banner in `providers`):

```typescript
// providers: add
VideoRoomNotificationMuteRepository,
VideoRoomNotificationMuteService,
VideoRoomNotificationMetrics,
VideoRoomNotificationService,
VideoRoomNotificationFanoutService,
VideoRoomLifecycleNotificationListener,
VideoRoomSeatNotificationListener,
VideoRoomEngagementNotificationListener,
VideoRoomChatNotificationListener,
VideoRoomNotificationSocketListener,

// controllers: add
VideoRoomsNotificationController,
```

- [ ] **Step 6: Write the integration test**

```typescript
// src/modules/video-rooms/video-rooms-notification-integration.spec.ts
import { VideoRoomNotificationService } from './services/video-room-notification.service';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from './constants/video-room-notification.constants';

// Verifies the dispatcher end-to-end with real matrix + fakes for the seams.
describe('VR-15 notification integration', () => {
  function build(prefsOverride: Record<string, boolean> = {}) {
    const created: unknown[] = [];
    const pushed: unknown[] = [];
    const notifications = {
      create: jest.fn(async (i: unknown) => { created.push(i); return { id: 'n' }; }),
      notify: jest.fn(async (u: string, i: unknown) => { pushed.push({ u, i }); return true; }),
      preferences: jest.fn().mockResolvedValue({ pushEnabled: true, roomEvents: true, seatEvents: true, treasureEvents: true, pkEvents: true, announcementEvents: true, inviteEvents: true, giftEvents: true, systemEvents: true, ...prefsOverride }),
    };
    const mute = { isMuted: jest.fn().mockResolvedValue(false) };
    const rooms = { listActiveMemberIds: jest.fn().mockResolvedValue(['m1', 'm2']), appendLog: jest.fn() };
    const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'j' }) };
    const metrics = { incNotificationDispatched: jest.fn(), incNotificationSuppressed: jest.fn(), observeFanoutBatch: jest.fn() };
    const svc = new VideoRoomNotificationService(notifications as never, mute as never, rooms as never, queue as never, metrics as never);
    return { svc, created, pushed, notifications, mute, rooms, queue };
  }

  it('seat approval reaches in-app + push for the target', async () => {
    const t = build();
    await t.svc.dispatch(K.SEAT_APPROVAL, { roomId: 'r1', targetUserIds: ['t1'], title: 'a', body: 'b' });
    expect(t.created).toHaveLength(1);
    expect(t.pushed).toHaveLength(1);
  });

  it('announcement reaches every room member', async () => {
    const t = build();
    await t.svc.dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'a', body: 'b' });
    expect(t.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('a muted member receives nothing', async () => {
    const t = build();
    t.mute.isMuted.mockResolvedValue(true);
    await t.svc.dispatch(K.ANNOUNCEMENT, { roomId: 'r1', title: 'a', body: 'b' });
    expect(t.notifications.create).not.toHaveBeenCalled();
  });

  it('room started enqueues the followers fan-out', async () => {
    const t = build();
    await t.svc.dispatch(K.ROOM_STARTED, { roomId: 'r1', ownerId: 'o1', occurrenceId: 'occ1', title: 'a', body: 'b' });
    expect(t.queue.enqueue).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run the full new suite**

Run: `npx jest src/modules/video-rooms/metrics/video-room-notification.metrics.spec.ts src/modules/video-rooms/video-rooms-notification-integration.spec.ts`
Expected: PASS.

- [ ] **Step 8: Final BC verification (NO git)**

Run: `npx tsc --noEmit && npx eslint "src/modules/video-rooms/**/*notification*.ts" "src/modules/notification/**/*.ts" && npx jest src/modules/video-rooms src/modules/notification`
Expected: no type/lint errors; all video-rooms + notification specs pass (existing suites confirm nothing regressed). Do NOT commit — working-tree-only per project rule.

---

## Self-review — spec coverage

- **In-app / read status / unread / pagination / preferences / device / push transport / retry / DLQ:** reused (`NotificationService`, `device` module, existing queue infra) — no task, by design (§11 non-goals).
- **25 notification types:** matrix (Task 1) + bridges (Tasks 7–10); Gift Received / Follow are REUSE_EXISTING (no task, verified in Task 1 note); socket-only in-room events owned by existing listeners.
- **Channels configurable / priority / audience / TTL / collapse:** matrix `MatrixRow` (Task 1); collapse policy §7.2 encoded as `collapseKey` fns; 4→2 priority mapping via `toPushPriority`.
- **Fan-out (chunked/idempotent/scalable) + configurable chunk size:** Task 6 + Task 1 constant/config (§7.1).
- **Preferences per video-room category + per-room mute:** Tasks 2–4, 11.
- **Socket events (roomNotification/announcement + notification.*):** Task 10 (in-room) + existing `NotificationSocketListener` (durable).
- **Metrics / audit:** Task 12.
- **Schema additive:** Task 2 (enum ADD VALUE, defaulted columns, one table).
- **Type consistency:** dispatcher `deliverOne(kind, row, userId, ctx)` is consumed identically by the fan-out worker; `incNotificationDispatched`/`incNotificationSuppressed` names match between Task 5 usage and Task 12 definition; `VideoRoomFanoutJob` shape defined in Task 5, consumed in Task 6; `VIDEO_ROOM_NOTIFICATION_KINDS` keys match matrix rows (Task 1 test enforces).

## Process constraints

- **No git operations** (project rule + user instruction). Spec, plan, and all implementation stay in the working tree, uncommitted. Every "Checkpoint" runs verification only.
- Subagent-driven **TDD**, task-by-task; strictly additive; reuse over reinvention at every seam.
