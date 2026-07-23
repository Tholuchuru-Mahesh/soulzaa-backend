# Video Room — Phase 15: Enterprise Notification & Real-Time Event Delivery (Design)

- **Date:** 2026-07-23
- **Phase:** VR-15
- **Status:** Approved (design) — ready for implementation plan
- **Author:** Backend
- **Scope decision:** *Integration + fan-out layer only.* Reuse the entire existing notification/device/push/socket/queue spine. Build only: a config-driven notification **matrix**, **bridge listeners** for video-room events, a chunked **fan-out worker**, additive **enum/preference** extensions, **per-room mute**, and metrics/audit wiring. No parallel notification system, no duplicate controllers/queues/device APIs/push providers/transport.

---

## 1. Context & premise correction

The Phase 15 brief reads as "build an enterprise notification system: 6 BullMQ queues, delivery/retry ledgers, device management, push providers, REST + preferences, socket transport." **Three independent reconnaissance passes (notification/device/push core; socket/Redis/BullMQ/event-bus spine; Prisma schema) established that this system already exists, is production-shaped, and is already wired for other domains (chat, social, gifts, calls).** The brief itself mandates: *"Do NOT duplicate notification infrastructure. Integrate with the existing notification service."* Phase 15 is therefore an **integration + fan-out layer**, mirroring the Phase-14 (Wallet) shape.

### What already exists (must be reused, not rebuilt)

| Capability | Where | Status |
|---|---|---|
| Durable in-app store: create/list/markRead/markAllRead/unreadCount | `NotificationService` (`@Global`) — `src/modules/notification/services/notification.service.ts` | ✅ done |
| Preference-gated push seam | `NotificationService.notify(userId, PushIntent)` — persist-then-publish, fire-and-forget | ✅ done |
| Preferences (per-category toggles, sound, vibration, showPreview, DND/`mutedUntil` snooze) | `NotificationPreference` + `PushPolicy` (compile-exhaustive category switch) — `notification/services/push.policy.ts` | ✅ done |
| Push transport: FCM Android **data-only** (channel-id contract) + iOS via `apns` block; multi-device fan-out; dead-token retirement | `device` module → `pushToUser` → `push` BullMQ queue → `PushDispatcher` / `FcmPushProvider` — `src/modules/device/…` | ✅ done |
| Device registry (multi-device, platform, token refresh) | `UserDevice` + `IDeviceService` (`registerDevice`, `updatePushToken`, `pushTokensForUser`) | ✅ done |
| Socket delivery: user-everywhere (all devices/instances) + room broadcast; Redis adapter for horizontal scale | `SocketManager.emitToUserEverywhere` / `emitToNamespaceRoom` — `src/infra/socket/socket.manager.ts`; `socket.adapter.ts` | ✅ done |
| Notification realtime fan-out on `/notifications` (`user:<id>` room) | `NotificationSocketListener` — `notification/listeners/notification-socket.listener.ts` | ✅ done |
| BullMQ retry / exponential backoff / DLQ / job registry | `BaseQueueWorker` + default job options + `dead-letter` queue + `QueueJobRegistry.register` | ✅ done |
| Event bus (persist-then-publish, `bus.subscribe` in `onModuleInit`) | `EVENT_BUS` + `DomainEvent` — `src/common/events/…` | ✅ done |
| REST `/notifications` (list/unread-count/read/read-all) + `/notifications/preferences` (GET/PUT) | `NotificationController` | ✅ done |
| Device REST (`/devices/register`, `/devices/push-token`) | `DeviceController` | ✅ done |
| **Gift Received** durable + push | `GiftNotificationListener` (subscribes `GIFT_EVENTS.SENT`) | ✅ done → **REUSE_EXISTING** |
| **Follow Notification** durable + push | `SocialNotificationListener` (`NEW_FOLLOWER`) | ✅ done → **REUSE_EXISTING** |
| Video-room domain events for seat/role/viewer/treasure/pk/room/chat | `src/modules/video-rooms/events/*` (24-slot `VIDEO_ROOM_*_EVENTS` maps) | ✅ emitted |
| Per-domain in-room socket fan-out (gift/treasure/pk/seat/role/chat) | `video-rooms/listeners/*-socket.listener.ts` | ✅ done |
| Metrics stack (`prom-client` via `MetricsService`) + queue metrics/DLQ dashboard | `src/infra/observability/*`, `src/infra/queue/*` | ✅ done |

### Genuine gaps this phase fills

1. **`NotificationType` enum has no video-room values** — no `ROOM_STARTED`, `SEAT_APPROVED`, `TREASURE_UNLOCKED`, `PK_WINNER`, `MENTION`, etc.
2. **No broadcast/fan-out primitive** — `create()`/`notify()` are strictly single-user. "Room went live → notify N followers" or "announcement → all members" is N individual calls today. This is the one net-new *capability*.
3. **The infra `notifications` BullMQ queue + `NotificationsProcessor` is a dead stub** (`src/infra/queue/processors/notifications.processor.ts` — logs and returns `{ ok:true }`, nothing enqueues to it). Natural home for the fan-out worker.
4. **Preferences are per-user global** — no per-video-room-category toggles, no per-room mute.
5. **No single source of truth for routing** — which type → which channels / priority / audience / preference toggle / TTL / collapse behavior. Phase 15 introduces the **matrix** to make this explicit and configurable.

---

## 2. Locked design decisions

1. **Scope:** Integration + fan-out layer only. Strictly additive, fully backward compatible.
2. **Single source of truth:** the **notification matrix** governs all routing behavior (channels, priority, audience, preference toggle, TTL, collapse key, reuse marker). "Future notification types must be configurable" = add a matrix row.
3. **REUSE_EXISTING rule:** before adding any bridge listener, verify no existing listener already covers the event. `Gift Received` and `Follow` are already produced — Phase 15 adds **no** listener for them (prevents duplicate notifications). Every matrix row carries a `wiring` marker (`NEW` | `REUSE_EXISTING` | `SOCKET_ONLY`).
4. **Dispatcher is Prisma-free:** all persistence/lookups go through existing repositories/services (`NotificationService`, `VideoRoomMemberRepository`, social follower lookups, `RedisService`). The dispatcher composes primitives; it never touches Prisma.
5. **Fan-out:** chunked, idempotent, horizontally scalable, on the reclaimed `notifications` queue. **Redis `SADD` is the sole delivery-idempotency mechanism** (no persistent per-recipient delivery ledger unless a future requirement justifies it).
6. **Preference granularity:** add five additive boolean columns to `notification_preferences`. Fine-grained gating happens **in the dispatcher** (reads `NotificationService.preferences`), so push **categories stay coarse** (`INVITE`/`GIFT`/`SYSTEM`) — no new Android channel-ids, no mobile release coupling. `PushPolicy` still applies DND/snooze as a second layer.
7. **Schema:** every change additive (enum `ADD VALUE`, defaulted columns, one new table). Authored-only migration in `prisma/migrations/` (VR-11/VR-12 style) if shadow-replay is blocked.
8. **Process:** subagent-driven TDD, working-tree-only, **no git operations** (project rule + user instruction).

### Ownership split

- **`video-rooms` module** owns everything video-room-specific: the matrix, bridge listeners, dispatcher, fan-out worker, per-room mute, in-room notification socket, metrics/audit for notifications.
- **`notification` module** is extended minimally and additively: new `NotificationType` values, new preference columns + DTO field + repo upsert + `DEFAULT_PREFERENCES`. Its services/controllers/transport are otherwise untouched and reused.
- **`NotificationService` remains the ONLY component that writes notification rows or triggers push.** Every Phase-15 component is a producer of intent that flows through it.

---

## 3. Architecture & file layout (all additive)

**`src/modules/video-rooms/` (extend):**
```
constants/video-room-notification.constants.ts        # NEW  the MATRIX (single source of truth) + fan-out chunk-size constant + collapse-key policy
services/video-room-notification.service.ts           # NEW  dispatch(kind, ctx): matrix lookup → gate → create()+notify() / enqueue fan-out.  NO Prisma.
services/video-room-notification-mute.service.ts       # NEW  per-room mute (durable table + Redis read-cache)
services/video-room-notification-fanout.service.ts     # NEW  registers 'video-room.notification.fanout' on notifications queue; chunked cursor worker; SADD dedup
listeners/video-room-notification.listener.ts          # NEW  thin OnModuleInit bridges: subscribe existing video_room.* events → dispatch()  (split by domain if it grows)
listeners/video-room-notification-socket.listener.ts   # NEW  in-room live banners (roomNotification/announcement) on /video-room — only where no existing socket event covers it
controllers/video-rooms-notification.controller.ts     # NEW  per-room mute endpoints only (GET/POST/DELETE :id/notifications/mute)
repositories/video-room-notification-mute.repository.ts# NEW  mute table access (keeps dispatcher/service Prisma-free)
metrics/video-room-notification.metrics.ts             # NEW  prom-client counters/histograms into existing MetricsService
events/video-room.events.ts                            # EDIT (thin) add STARTED emission at OFFLINE→LIVE transition IF no existing event marks go-live
video-rooms.module.ts                                  # EDIT wire new providers/listeners
```

**`src/modules/notification/` + `prisma/schema/notification.prisma` (extend, additive):**
```
prisma/schema/notification.prisma      # EDIT +video-room NotificationType values; +5 preference columns
dto/*preference*.dto.ts                # EDIT +roomEvents/seatEvents/treasureEvents/pkEvents/announcementEvents (optional booleans)
repositories/notification-preference.repository.ts  # EDIT upsert maps new columns
services/notification.service.ts (DEFAULT_PREFERENCES)  # EDIT defaults for new toggles (all true)
```

**`prisma/migrations/` (authored-only, additive):**
```
vr15_notification_integration/migration.sql   # NEW  ALTER TYPE ADD VALUE (ordered first); ALTER TABLE ADD 5 bool cols DEFAULT true; CREATE TABLE video_room_notification_mutes
```

**Guiding principle:** every new unit is a *listener*, a *config table*, a *read-cache*, or a *worker that calls `NotificationService`*. There is no second notification store, no second push path, no second queue infrastructure.

---

## 4. Section — The notification matrix (single source of truth)

`video-room-notification.constants.ts` exports `VIDEO_ROOM_NOTIFICATION_MATRIX: Record<VideoRoomNotificationKind, MatrixRow>`. One row per kind:

```ts
interface MatrixRow {
  notificationType: NotificationType | null;   // durable-row enum value; null = no durable row (socket-only)
  pushCategory: PushCategory;                   // coarse: INVITE | GIFT | SYSTEM (reused; no new channels)
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  channels: { inApp: boolean; socket: boolean; push: boolean; silent: boolean };
  preferenceToggle: keyof NotificationPreference; // fine-grained gate applied in dispatcher
  audience: 'TARGET' | 'ROOM_MEMBERS' | 'PARTICIPANTS' | 'FOLLOWERS';
  ttlSeconds?: number;                          // push TTL
  collapseKey?: (ctx) => string | undefined;    // see §7 collapse policy; undefined = never collapse
  wiring: 'NEW' | 'REUSE_EXISTING' | 'SOCKET_ONLY';
}
```

### The 25 supported notifications → routing (finalized in Task 1; matrix is SoT)

| # | Kind | Trigger (existing event unless noted) | NotificationType | Audience | inApp / socket / push | Priority | Toggle | Collapse | Wiring |
|---|---|---|---|---|:---:|---|---|---|---|
| 1 | Room Invitation | seat `INVITATION_SENT` (type=ROOM) | `ROOM_INVITE` | TARGET | ✓/✓/✓ | HIGH | inviteEvents | never | NEW |
| 2 | Seat Invitation | seat `INVITATION_SENT` (type=SEAT) | `SEAT_INVITE` | TARGET | ✓/✓/✓ | HIGH | seatEvents | never | NEW |
| 3 | Seat Approval | seat `REQUEST_RESOLVED` (approved) | `SEAT_APPROVED` | TARGET | ✓/✓/✓ | HIGH | seatEvents | never | NEW |
| 4 | Seat Rejection | seat `REQUEST_RESOLVED` (rejected) | `SEAT_REJECTED` | TARGET | ✓/✓/✗ | NORMAL | seatEvents | never | NEW |
| 5 | Viewer Promotion | `VIEWER_PROMOTED` | `VIEWER_PROMOTED` | TARGET | ✓/✓/✓ | HIGH | roomEvents | never | NEW |
| 6 | Viewer Demotion | `VIEWER_DEMOTED` | `VIEWER_DEMOTED` | TARGET | ✓/✓/✗ | NORMAL | roomEvents | never | NEW |
| 7 | Gift Received | `GIFT_EVENTS.SENT` | `GIFT_RECEIVED` | TARGET | ✓/✓/✓ | HIGH | giftEvents | never | **REUSE_EXISTING** |
| 8 | Gift Sent | `GIFT_EVENTS.SENT` (sender echo) | — | TARGET(sender) | ✗/✓/✗ | LOW | giftEvents | — | **SOCKET_ONLY** (existing gift socket listener) |
| 9 | Treasure Progress | `treasure.PROGRESS_UPDATED` | — | ROOM_MEMBERS | ✗/✓/✗ | LOW | treasureEvents | collapse | **SOCKET_ONLY** (existing) |
| 10 | Treasure Unlocked | `treasure.UNLOCKED` | `TREASURE_UNLOCKED` | ROOM_MEMBERS | ✓/✓/✓ | NORMAL | treasureEvents | never | NEW |
| 11 | Treasure Reward | `treasure.REWARD_DISTRIBUTED` (per recipient) | `TREASURE_REWARD` | TARGET(winner) | ✓/✓/✓ | HIGH | treasureEvents | never | NEW |
| 12 | PK Invitation | `pk.INVITATION_SENT` | `PK_INVITE` | TARGET | ✓/✓/✓ | HIGH | pkEvents | never | NEW |
| 13 | PK Accepted | `pk.INVITATION_ACCEPTED` | `PK_ACCEPTED` | TARGET(inviter) | ✓/✓/✗ | NORMAL | pkEvents | never | NEW |
| 14 | PK Rejected | `pk.INVITATION_REJECTED` | `PK_REJECTED` | TARGET(inviter) | ✓/✓/✗ | NORMAL | pkEvents | never | NEW |
| 15 | PK Started | `pk.STARTED` | `PK_STARTED` | ROOM_MEMBERS | ✗/✓/✗ | NORMAL | pkEvents | collapse | **SOCKET_ONLY** (existing pk socket listener) |
| 16 | PK Ended | `pk.ENDED` | `PK_ENDED` | ROOM_MEMBERS | ✗/✓/✗ | NORMAL | pkEvents | collapse | **SOCKET_ONLY** (existing) |
| 17 | PK Winner | `pk.WINNER_DECLARED` | `PK_WINNER` | PARTICIPANTS | ✓/✓/✓ | HIGH | pkEvents | never | NEW |
| 18 | Room Started | OFFLINE→LIVE transition (thin `STARTED` event if missing) | `ROOM_STARTED` | FOLLOWERS | ✓/✓/✓ | NORMAL | roomEvents | collapse (`vr:{roomId}:live`) | NEW + **fan-out** |
| 19 | Room Closed | `VIDEO_ROOM_EVENTS.CLOSED` | `ROOM_CLOSED` | ROOM_MEMBERS | ✓/✓/✗ | LOW | roomEvents | collapse | NEW |
| 20 | Room Locked | `VIDEO_ROOM_EVENTS.LOCKED` (isLocked=true) | `ROOM_LOCKED` | ROOM_MEMBERS | ✗/✓/✗ | LOW | roomEvents | collapse (`vr:{roomId}:state`) | **SOCKET_ONLY** |
| 21 | Room Unlocked | `VIDEO_ROOM_EVENTS.LOCKED` (isLocked=false) | `ROOM_UNLOCKED` | ROOM_MEMBERS | ✗/✓/✗ | LOW | roomEvents | collapse (`vr:{roomId}:state`) | **SOCKET_ONLY** |
| 22 | Announcement | chat `ANNOUNCEMENT_CREATED` | `ANNOUNCEMENT` | ROOM_MEMBERS | ✓/✓/✓ | NORMAL | announcementEvents | collapse (`vr:{roomId}:announcement`) | NEW |
| 23 | Mention | chat `MENTIONED` | `MENTION` | TARGET | ✓/✓/✓ | HIGH | roomEvents | never | NEW |
| 24 | Follow Notification | `SOCIAL_EVENTS.FOLLOWED` | `NEW_FOLLOWER` | TARGET | ✓/✓/✓ | NORMAL | followEvents | never | **REUSE_EXISTING** |
| 25 | System Notification | internal `dispatchSystem()` (admin/ops entrypoint) | `SYSTEM` | TARGET or ROOM_MEMBERS | ✓/✓/✓ | configurable | systemEvents | configurable | NEW (internal) |

**Interpretation of `wiring`:**
- `NEW` → Phase 15 adds a bridge listener that turns the event into durable in-app row + push (and, where there is no existing in-room socket event, an in-room banner).
- `REUSE_EXISTING` → an existing listener already produces the notification; Phase 15 adds **nothing** (documented in the matrix only, to prove no duplication). During Task-1 verification we confirm the existing listener actually covers video-room context; if it does not, we *extend that listener* rather than add a parallel one.
- `SOCKET_ONLY` → already fanned out in-room by an existing `*-socket.listener.ts`; Phase 15 does not re-emit and does not create a durable row (the matrix records it for completeness). Push is off by default for these transient/high-frequency events.

`NotificationType` enum values to add (finalized with the matrix): `ROOM_STARTED, ROOM_CLOSED, ROOM_LOCKED, ROOM_UNLOCKED, SEAT_INVITE, SEAT_APPROVED, SEAT_REJECTED, VIEWER_PROMOTED, VIEWER_DEMOTED, TREASURE_UNLOCKED, TREASURE_REWARD, PK_ACCEPTED, PK_REJECTED, PK_STARTED, PK_ENDED, PK_WINNER, ANNOUNCEMENT, MENTION, SYSTEM`. (`ROOM_INVITE`, `PK_INVITE`, `GIFT_RECEIVED`, `NEW_FOLLOWER` already exist and are reused.)

---

## 5. Section — The dispatcher (Prisma-free core)

`VideoRoomNotificationService.dispatch(kind: VideoRoomNotificationKind, ctx: DispatchContext)`:

1. **Look up** the matrix row for `kind`. If `wiring !== 'NEW'`, no-op (defensive — bridges only call for NEW kinds).
2. **Resolve audience** → recipient user ids:
   - `TARGET` → `ctx.targetUserId` (1 recipient).
   - `ROOM_MEMBERS` / `PARTICIPANTS` → via `VideoRoomMemberRepository` (bounded by room capacity) — through the repository, never Prisma directly.
   - `FOLLOWERS` → **do not resolve inline**; enqueue a fan-out job (§6).
3. **Gate** each recipient (bounded audiences) through, in order:
   - `preferences[row.preferenceToggle]` via `NotificationService.preferences(userId)` (fail-open per existing convention).
   - per-room mute via `VideoRoomNotificationMuteService.isMuted(userId, roomId)` (Redis read-cache).
   - (DND/snooze is applied downstream by the existing `PushPolicy` for push.)
4. **Deliver** for survivors:
   - `channels.inApp` → `NotificationService.create({ userId, type: row.notificationType, actorId, entityType:'VIDEO_ROOM', entityId: roomId, data })` (emits `notification.created` → existing `/notifications` socket fan-out for free).
   - `channels.push` → `NotificationService.notify(userId, { category: row.pushCategory, title, body, priority: row.priority, ttlSeconds: row.ttlSeconds, collapseKey: row.collapseKey?.(ctx), data })`.
   - `channels.socket` in-room banner → only for kinds with no existing in-room socket event (announcement/system/room-started banner) via the new socket listener (§8). SOCKET_ONLY kinds are already emitted elsewhere.
5. **Observe** → increment metrics (§9) and write audit (§9).

The dispatcher holds no Prisma client, opens no transaction, and never calls the device/push transport directly — it only calls `NotificationService`. This is what keeps preferences un-bypassable and the write path singular.

---

## 6. Section — Fan-out (chunked, idempotent, horizontally scalable)

Only `FOLLOWERS` (Room Started) and large `ROOM_MEMBERS` audiences use fan-out. `VideoRoomNotificationFanoutService`:

- **Registration:** `queueJobRegistry.register(QUEUE_NAMES.NOTIFICATIONS, 'video-room.notification.fanout', handler)` in `onModuleInit` — reclaims the dead `notifications` queue via the same pattern PK/treasure/gift use. (The stub `NotificationsProcessor` is repurposed to `registry.dispatch`, or left as-is if it already delegates — verified in Task 6.)
- **Enqueue:** dispatcher enqueues `{ kind, roomId, ownerId, occurrenceId, cursor: null }` with `{ jobId: 'vrnotif:'+occurrenceId+':0', attempts, backoff:{type:'exponential',delay} }`. `occurrenceId` is a stable id for this fan-out occasion (e.g. the room-session id or event `eventId`).
- **Worker loop (one bounded chunk per job):**
  1. Resolve the next chunk of recipients by `cursor` — followers via the social follower repository/service, or members via the member repository. Chunk size = **configurable constant** (§7.1).
  2. For each recipient: `SADD video-room:notif:fanout:{occurrenceId}:sent <userId>` → **skip if it returns 0** (already delivered on a prior attempt → at-most-once). Then apply the same preference + mute gate as the dispatcher, then `create()` + `notify()`.
  3. If more recipients remain, enqueue the next job with the advanced `cursor` (and `jobId` suffixed by chunk index). Set an expiry (e.g. 24h) on the `:sent` set so it self-cleans.
- **Fault tolerance:** retries/backoff/DLQ inherited from `BaseQueueWorker` + default job options. A crashed chunk replays only itself; the `SADD` set guarantees no follower is double-notified across retries. **Redis `SADD` is the sole delivery-idempotency mechanism** — no per-recipient `NotificationDelivery` table (documented trade-off; revisit only if durable per-recipient delivery audit becomes a hard requirement).
- **Scalability:** because each job is one bounded chunk and re-enqueues the next cursor, fan-out to N followers is O(N/chunk) small jobs spread across all worker instances — no single unbounded job, no head-of-line blocking.

---

## 7. Section — Two explicitly documented implementation choices

### 7.1 Fan-out chunk size — configurable constant (not hard-coded)

`VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE` is a named constant in `video-room-notification.constants.ts` with a **config override** (read via `ConfigService`, constant as default), so operators can tune throughput vs. per-job latency **without any architectural change**.

- **Default:** `500` recipients per chunk.
- **Bounds (validated):** `[100, 2000]`. Too small ⇒ excessive job churn on the queue; too large ⇒ long single-job runtime and coarse retry granularity.
- Sourced as `config.get('videoRoom.notificationFanoutChunkSize') ?? VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE`. No code path hard-codes the number; the worker and tests both read the constant/config.

### 7.2 Collapse-key policy — which types collapse, which must never

A push `collapseKey` (Android `collapseKey` / iOS `apns-collapse-id`) makes a **new** push replace a still-pending one on the device. It is correct only for **state-latest / high-frequency** signals where only the newest value matters, and **dangerous** for **discrete, must-see** events (collapsing would silently drop one).

**COLLAPSE (latest-wins; key scoped so only same-room-same-topic collapses):**

| Kind | Collapse key | Rationale |
|---|---|---|
| Room Started (live ping) | `vr:{roomId}:live` | avoid duplicate "X is live" pings for one session |
| Room Locked / Unlocked | `vr:{roomId}:state` | only the latest lock state matters |
| Room Closed | `vr:{roomId}:state` | supersedes a stale lock/live banner |
| Announcement | `vr:{roomId}:announcement` | latest announcement banner replaces the previous (per the brief's "repeated announcements … collapse") |
| Treasure Progress (socket-only) | `vr:{roomId}:treasure` | progress is a moving number; only latest is meaningful |
| PK Started / Ended / Score (socket-only) | `vr:{roomId}:pk` | live PK state; only latest frame matters |

**NEVER COLLAPSE (each is a discrete, must-deliver signal — `collapseKey = undefined`):**

- Seat Invitation, Seat Approval, Seat Rejection
- Room Invitation
- PK Invitation, PK Accepted, PK Rejected, **PK Winner**
- **Treasure Unlocked, Treasure Reward** (money/prizes — must never be dropped)
- **Gift Received** (money — REUSE_EXISTING; already never-collapse)
- Viewer Promotion / Demotion
- Mention
- Follow Notification

The matrix `collapseKey` function encodes exactly this: it returns a scoped key for the collapse set above and `undefined` for everything else. Tests assert that every never-collapse kind yields `undefined` and every collapse kind yields a room-scoped key.

---

## 8. Section — Events, bridge listeners & in-room socket

### 8.1 Events (reuse; at most one thin addition)

All triggers already emit domain events (§ verified in recon), **except** "Room Started" (the OFFLINE→LIVE transition). Task handling:
- **Room Started:** hook `VideoRoomLifecycleService` at the `status → LIVE` transition. If it already publishes a lifecycle event there, reuse it; otherwise add a thin **additive** `VIDEO_ROOM_EVENTS.STARTED` emission at that single point (no new infrastructure, no behavior change to existing events).
- **Room Locked & Unlocked** are one event (`VIDEO_ROOM_EVENTS.LOCKED` carrying `isLocked`) — one bridge distinguishes by the flag.
- **Room Invitation vs Seat Invitation** are one event (`seat INVITATION_SENT` carrying `VideoRoomInvitationType`) — the bridge picks `ROOM_INVITE` vs `SEAT_INVITE` by `type`.
- **Announcement / Mention** reuse `VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED` / `MENTIONED` — the chat module already owns the creation REST endpoint, so **no new announcement endpoint is added**.

### 8.2 Bridge listeners

Thin `@Injectable implements OnModuleInit` classes; inject `EVENT_BUS` + `VideoRoomNotificationService`; `bus.subscribe` in `onModuleInit`; map event payload → `dispatch(kind, ctx)`. Split by domain to keep each file single-purpose (e.g. lifecycle / seat / engagement) if one file grows large. **Before adding each subscription, verify no existing listener already covers it** (REUSE_EXISTING rule) — `Gift Received` and `Follow` get no bridge.

### 8.3 In-room notification socket

`video-room-notification-socket.listener.ts` emits live in-room banners on `/video-room` (`SOCKET_NAMESPACES.VIDEO_ROOM`) for kinds that need a room banner but have no existing in-room socket event — announcement, system, room-started banner — via `SocketManager.emitToNamespaceRoom(namespace, roomId, event, payload)`. Socket event names (`roomNotification`, `announcement`, …) are declared as constants. Durable `notification.created/read/count` continue to fan out on `/notifications` via the existing `NotificationSocketListener` (unchanged). SOCKET_ONLY / gift / pk / treasure in-room events remain owned by their existing listeners.

---

## 9. Section — Preferences, REST, metrics, audit, RBAC

- **Preferences (additive):** 5 new boolean columns on `notification_preferences` — `roomEvents`, `seatEvents`, `treasureEvents`, `pkEvents`, `announcementEvents` (all `DEFAULT true`). Wire into `DEFAULT_PREFERENCES`, the preference repo `upsert`, and the existing `UpdateNotificationPreferenceDto` (optional booleans). The **existing** `GET`/`PUT /notifications/preferences` now covers them for free.
- **REST (minimal, video-room-only):** `VideoRoomsNotificationController` adds **only** per-room mute — `GET`/`POST`/`DELETE /video-rooms/:id/notifications/mute` (JWT self-scoped; room membership implicit). All Swagger-documented (`@ApiOperation`/`@ApiResponse`, typed DTOs). **No** new generic notification controller, **no** new device endpoints, **no** new announcement endpoint (chat owns it).
- **Per-room mute:** durable `video_room_notification_mutes` (`userId`,`roomId`, `@@unique([userId, roomId])`, all-UUID, `@@index`) via `VideoRoomNotificationMuteRepository`; `VideoRoomNotificationMuteService` fronts it with a Redis read-cache (`SISMEMBER video-room:notif:mute:{userId}`) refreshed on mutate. Durable table (survives Redis flush) + cache for hot-path reads.
- **Metrics** (`video-room-notification.metrics.ts` into existing `MetricsService`): `video_room_notifications_dispatched_total{kind,channel}`, `video_room_notifications_suppressed_total{reason}` (preference/mute/dnd), `video_room_notification_fanout_batch_duration_ms` (histogram), `video_room_notification_fanout_recipients_total`. Queue depth / DLQ come from the existing queue metrics. Derives notifications-per-minute, delivery attempts, retry counts, failure rate.
- **Audit:** created/delivered/failed written to the existing `VideoRoomLog` / `VideoRoomEvent` append-only stores with `{ notificationId, userId, roomId, deviceId?, requestId, timestamp }` (the brief's audit-field set). Reuses existing log repositories — no new audit infrastructure.
- **RBAC:** targeted notifications respect existing room RBAC (Phase 7) at the trigger points; the dispatcher additionally respects user preferences + per-room mute. Mute endpoints are JWT self-scoped. Announcement/system triggers remain owner/admin-guarded at their existing source (chat/admin). No new permission engine.

---

## 10. Section — Testing (TDD, mirrors prior phases)

- **Matrix (`constants` spec):** every one of the 25 kinds has a row; enum values valid; never-collapse kinds ⇒ `collapseKey` undefined, collapse kinds ⇒ room-scoped key; REUSE_EXISTING/SOCKET_ONLY kinds are not dispatched.
- **Dispatcher spec:** audience resolution; preference gate suppresses; mute gate suppresses; correct `create()`/`notify()` calls per channel matrix; **asserts no Prisma client is injected / used** (composition-only); FOLLOWERS enqueues rather than resolves inline.
- **Fan-out spec:** chunking honors the configurable constant; cursor advances and re-enqueues; `SADD` dedup ⇒ a replayed chunk sends each recipient at most once; DLQ on repeated failure; `:sent` set expiry set.
- **Mute service/repo spec:** mute/unmute/isMuted; Redis cache hit/miss + refresh on mutate.
- **Preference spec:** new columns default true; DTO round-trips; upsert persists new toggles.
- **Bridge listener specs:** each event maps to the right `dispatch(kind, ctx)`; REUSE_EXISTING events are **not** re-bridged (guard against duplicate-notify).
- **Socket spec:** in-room banner emitted on `/video-room` for announcement/system/room-started; durable rows still fan out on `/notifications`.
- **Integration spec (video-rooms integration area):** seat approval → target gets in-app+push; treasure reward → winner gets durable+push; room-started → followers fan out (chunked, deduped); muted user receives nothing.
- **Concurrency:** two workers processing the same `occurrenceId` chunk concurrently ⇒ `SADD` guarantees no double-send.

---

## 11. Explicit non-goals (do NOT build)

- ❌ A second notification store / in-app model / read-status model.
- ❌ 6 dedicated queues (`notification-delivery`, `push-notification`, `socket-notification`, `notification-retry`, `notification-cleanup`, `notification-analytics`) — the one reclaimed `notifications` queue + existing `push` queue + `QueueJobRegistry` + DLQ cover it.
- ❌ A duplicate `NotificationController` or device-management API — reuse `NotificationController` / `DeviceController`.
- ❌ New push providers or transport — FCM/APNs via the device module is reused as-is.
- ❌ A persistent per-recipient `NotificationDelivery` / `RetryHistory` ledger — Redis `SADD` + queue DLQ cover idempotency/recovery (revisit only on a hard durable-audit requirement).
- ❌ New `PushCategory` values / new Android channel-ids (avoids mobile coupling; fine-gating lives in the dispatcher).
- ❌ Moderation, analytics dashboard, recommendation engine, marketing, email, SMS (per the brief's DO-NOT list).

---

## 12. Backward compatibility & additive guarantee

- **Additive only:** new files; new `NotificationType` enum values (append-only); new defaulted preference columns; one new table; one thin optional event emission; new metrics. No existing endpoint, event name, DTO field, table, queue, service signature, or push channel is removed or changed in a breaking way.
- Existing `/notifications`, `/notifications/preferences`, `/devices/*` remain behavior-compatible; they now additionally serve video-room notifications with no change to callers.
- `REUSE_EXISTING` guarantees zero duplicate notifications for `Gift Received` and `Follow`.
- Migration is fully additive (enum `ADD VALUE` first / separate txn; `ADD COLUMN … DEFAULT true`; `CREATE TABLE`) — no backfill, no downtime; authored-only in `prisma/migrations/` if shadow-replay is blocked (VR-11/VR-12 convention).

---

## 13. File manifest

**New source files (8) + tests:**
- `src/modules/video-rooms/constants/video-room-notification.constants.ts`
- `src/modules/video-rooms/services/video-room-notification.service.ts`
- `src/modules/video-rooms/services/video-room-notification-mute.service.ts`
- `src/modules/video-rooms/services/video-room-notification-fanout.service.ts`
- `src/modules/video-rooms/listeners/video-room-notification.listener.ts` (may split by domain)
- `src/modules/video-rooms/listeners/video-room-notification-socket.listener.ts`
- `src/modules/video-rooms/controllers/video-rooms-notification.controller.ts`
- `src/modules/video-rooms/repositories/video-room-notification-mute.repository.ts`
- `src/modules/video-rooms/metrics/video-room-notification.metrics.ts`
- tests: a `*.spec.ts` alongside each new service/listener/controller + one integration spec in the video-rooms integration area

**Modified (additive):**
- `prisma/schema/notification.prisma` (enum values + preference columns)
- `src/modules/notification/**` preference DTO + preference repository upsert + `DEFAULT_PREFERENCES`
- `src/modules/video-rooms/events/video-room.events.ts` (thin `STARTED` emission only if go-live has no existing event)
- `src/modules/video-rooms/video-rooms.module.ts` (wire new providers/listeners)
- possibly `src/infra/queue/processors/notifications.processor.ts` (delegate to `registry.dispatch` if not already)

**New migration (1, additive/authored-only):** `prisma/migrations/vr15_notification_integration/migration.sql`

**Zero** new queues. **Zero** new push providers. **Zero** new notification stores. **Zero** duplicate controllers/device APIs.

---

## 14. Process constraints

- **No git operations** (project rule + user instruction). Spec and all implementation stay in the working tree, uncommitted.
- Subagent-driven **TDD**, task-by-task, mirroring prior phases.
- Strictly additive; full backward compatibility; reuse over reinvention at every seam.

---

## 15. Execution notes (as-built, 2026-07-23)

Implemented via subagent-driven TDD (13 task cycles + final whole-branch review). Final gate: `tsc` 0, `eslint` 0, `jest src/modules/video-rooms src/modules/notification` **2378/2378** (205 suites). One intentional deviation from the design above, plus one clarification:

- **§9 audit hook dropped (deviation).** The design implied a per-notification write to `VideoRoomLog`/`VideoRoomEvent`. This was **not** implemented: at followers/member fan-out scale it would reintroduce the per-recipient DB ledger that §2 decision 5 explicitly forbids, and it is redundant with the durable `Notification` row that `create()` already persists per recipient. Auditability is satisfied by **durable notification rows + Prometheus metrics + structured logs**. (Coarser once-per-dispatch audit remains a possible future addition.)
- **ROOM_MEMBERS fan-out (clarification).** Per §6, large `ROOM_MEMBERS` audiences (announcement / treasure-unlocked / room-closed) route through the same chunked/SADD worker via a `source: 'FOLLOWERS' | 'MEMBERS'` discriminator (threshold `VIDEO_ROOM_NOTIFICATION_MEMBER_FANOUT_THRESHOLD = 50`); at/below the threshold they deliver inline. The three ROOM_MEMBERS bridges pass a stable `occurrenceId = ${roomId}:${eventId}` so retries dedup.
- **Migration folder** ships as `prisma/migrations/20260723000000_vr15_notification_integration/` (timestamped to sort correctly), and the mute table id has no DB `DEFAULT` (client-side `@default(uuid())`, matching repo convention).
- **Post-completion closers (2026-07-23, +3 tests → 2381/2381):** fan-out batch-duration + `video_room_notification_fanout_recipients_total` metrics are now wired into the worker; `dispatchSystem` now has a live producer — an owner/admin/mod endpoint `POST /video-rooms/:id/notifications/system` (guarded by `MANAGE_ANNOUNCEMENTS`) that broadcasts a SYSTEM notification to room members via `VideoRoomSystemNotificationService`.
- **Remaining non-blocking:** `matrix.channels.socket` is not read by the dispatcher (in-room banners are driven directly by `VideoRoomNotificationSocketListener`). The `ROOM_INVITATION` matrix branch stays forward-compat: a real room invitation (inviting a **non-member** into a private room) is a separate feature with its own validation + join-on-accept semantics — **not** a `type` flag on the seat-invite endpoint, which requires the invitee to already be an active member. Out of Phase-15 scope.
