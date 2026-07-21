# Video Room — Phase 9: Enterprise Real-Time Room Chat System (VR-9)

**Date:** 2026-07-21
**Status:** Approved (all three design sections approved by user, 2026-07-21)
**Depends on:** VR-0 … VR-8 (all complete, uncommitted working tree)

---

## 1. Objective

Implement the production-grade real-time chat engine for Video Rooms: message
send/edit/delete/recall/reply, mentions, pinned messages, announcements, typing
indicators, read receipts, history, search, Redis synchronisation, socket
delivery, event publishing, audit logging and monitoring.

VR-9 is a *net-new subsystem* for the video-room domain, but it is deliberately
**not** a greenfield build. VR-1 pre-landed the announcement table, the
announcement DTOs and the `PIN_MESSAGES` / `MANAGE_ANNOUNCEMENTS` permissions
with no consumers — exactly as VR-0 pre-landed the media seam that VR-5 later
filled. AR-4 (audio-room chat) supplies a proven anti-abuse layer and a
blocked-word engine over a **global** dictionary table. VR-9 consumes all of it.

Out of scope, per the phase brief: gifts, treasure boxes, wallet, PK battles,
rankings, notifications, moderation actions, analytics processing, recording,
live-stream business logic.

---

## 2. Locked design decisions (brainstorming, 2026-07-21)

1. **New `video_room_messages` table.** The audio room's `room_messages` lacks
   edit tracking, status, attachments, recall, metadata and read cursors. Sharing
   it would put two domains on one hot index, change AR-4's system of record, and
   break the file-ownership convention the schema comments enforce. This mirrors
   the deliberate `VideoRoom`-does-not-reuse-`AudioRoom` split already in the
   schema.
2. **REST for durable commands, socket for ephemeral signals.** Send / edit /
   delete / recall / pin / announce stay REST — auditable, idempotent, and
   consistent with the house pattern across AR-4 and VR-0…VR-8. Only
   `typing_start` / `typing_stop` / `message_delivered` / `message_read` get
   inbound `@SubscribeMessage` handlers, where an HTTP round trip per keystroke
   is genuinely wasteful.
3. **Read receipts are a high-water-mark cursor**, one row per `(roomId, userId)`
   — never one row per `(message, user)`. A 10k-viewer room at 500 msg/min would
   otherwise generate 5M receipt rows/minute. The reader list is *derived*.
4. **Announcements: existing table + projected stream message.**
   `video_room_announcements` (already built, zero call sites) stays the editable
   record of record; posting one also writes a linked `ANNOUNCEMENT`-type message
   carrying `metadata.announcementId` so it appears inline in chat.
5. **The blocked-word engine moves to `src/infra/content-moderation/`.** It is
   161 lines over the **global** `chat_blocked_words` table whose only
   module-local dependency is one repository method — it was never
   audio-room-owned. Audio Rooms keeps working unchanged. This avoids a
   semantically backwards `video-rooms → audio-rooms` dependency edge.
6. **Persist-then-broadcast, plus a Redis ring buffer on the read path.**
   Synchronous Postgres insert (real id, real ordering, zero loss), then
   EVENT_BUS → socket. A per-room ring buffer of recent messages serves
   late-joiner backfill and history's hot window so reads rarely touch Postgres.
7. **`allowViewerChat` is deprecated, not dropped.** `chatMode` is the runtime
   source of truth; the legacy column is backfilled, mirrored on write, marked
   `@deprecated` in the schema, and removed in a later cleanup migration once a
   consumer audit proves no readers remain. VR-9 stays purely additive. (§4.6)

---

## 3. Reuse map (what already exists — do NOT recreate)

| Asset | Location | Current state |
| --- | --- | --- |
| `VideoRoomAnnouncement` table | `prisma/schema/video_rooms_events.prisma:62` | built, **zero call sites** |
| Announcement CRUD (create/list/update/softDelete) | `video-room-events.repository.ts:107-146` | built, unused |
| `Create/UpdateVideoRoomAnnouncementDto` | `dto/announcement.dto.ts` | built, unused |
| `allowChat`, `slowModeSeconds`, `allowAnnouncements`, `isRoomMuted` | `video_rooms.prisma:176-199` | columns exist, unread |
| `PIN_MESSAGES`, `MANAGE_ANNOUNCEMENTS` | `constants/video-room-permissions.ts:38-49` | in matrix, unconsumed |
| `VideoRoomStatistics.totalChatMessages` | `video_rooms.prisma` | exists, unwritten |
| `VideoRoomLogAction.ANNOUNCEMENT_POSTED` | `video_rooms.prisma` | exists, unused |
| `VIDEO_ROOM_ANNOUNCEMENT_MAX`, `VIDEO_ROOM_SLOW_MODE_MAX_SECONDS` | `constants/video-room.constants.ts` | exist |
| 10 chat error codes | `common/exceptions/error-codes.ts:121-131` | shared, reusable as-is |
| `chat_blocked_words` dictionary + engine | `audio-rooms/services/blocked-word.service.ts` | to be extracted (decision 5) |
| RBAC decision point | `VideoRoomPermissionService` (VR-7) | reuse |
| Mute / block lookups | `VideoRoomModerationRepository` | reuse |
| Presence, sessions, members | VR-3 services | reuse |
| EVENT_BUS → `/video-room` relay pattern | `listeners/video-room-*-socket.listener.ts` | mirror |
| `LockService`, `CacheService`, `QueueService`, `SocketManager`, `VideoRoomsMetrics` | infra / module | reuse |
| Per-request `ip` / `requestId` / `userAgent` | `common/decorators/request-meta.decorator.ts` | reuse for audit |
| `USERS_SERVICE` token (for `@username` lookup) | `users/interfaces/` | reuse (AR-4 precedent) |

**Zero new infrastructure.** No new Socket.IO namespace, no new Redis client, no
new queue, no new auth, no new validation layer.

---

## 4. Data model

New file: `prisma/schema/video_rooms_chat.prisma`. **3 new tables, 4 columns
added to `VideoRoomSettings`, 1 column deprecated-in-place, 0 tables duplicated,
0 columns dropped — the phase is purely additive.**

### 4.1 Enums

```prisma
enum VideoRoomMessageType {
  TEXT
  EMOJI
  GIF
  IMAGE          // future-ready: enum + attachments slot, no upload pipeline
  VIDEO          // future-ready
  VOICE          // future-ready
  SYSTEM
  ANNOUNCEMENT
}

enum VideoRoomChatMode {
  NORMAL              // any active member may send
  PARTICIPANTS_ONLY   // seat holders (HOST/PARTICIPANT) + elevated roles; viewers muted
  READ_ONLY           // elevated roles only, any message type
  ANNOUNCEMENT_ONLY   // MANAGE_ANNOUNCEMENTS holders, ANNOUNCEMENT type only
}
```

"Elevated roles" means exactly `ELEVATED_VIDEO_ROOM_ROLES` — `OWNER`, `ADMIN`,
`MODERATOR` — as already defined in `constants/video-room-permissions.ts:129`.
Platform `ADMIN` / `SUPER_ADMIN` bypass every mode, consistent with the rest of
the video-room RBAC.

### 4.2 `video_room_messages`

```prisma
model VideoRoomMessage {
  id              String               @id @default(uuid()) @db.Uuid
  roomId          String               @db.Uuid
  senderId        String               @db.Uuid   // system msgs → VIDEO_ROOM_SYSTEM_ACTOR_ID
  type            VideoRoomMessageType @default(TEXT)
  content         String
  mentions        String[]             @db.Uuid
  mentionScope    String?                         // 'OWNER' | 'ADMINS' group mentions
  replyToId       String?              @db.Uuid
  forwardedFromId String?              @db.Uuid   // forward-ready
  attachments     Json?
  metadata        Json?                           // announcementId, systemEvent kind, gif dims, audit ctx
  editedAt        DateTime?
  editCount       Int                  @default(0)
  deletedAt       DateTime?
  deletedBy       String?              @db.Uuid
  recalledAt      DateTime?
  createdAt       DateTime             @default(now())

  @@index([roomId, createdAt(sort: Desc)])
  @@index([roomId, type, createdAt(sort: Desc)])
  @@index([roomId, senderId, createdAt(sort: Desc)])
  @@index([replyToId])
  @@index([mentions], type: Gin)
  @@map("video_room_messages")
}
```

Migration SQL additionally creates the `pg_trgm` extension and a GIN trigram
index on `content`, so keyword search stays indexed instead of sequential-scanning
millions of rows. Prisma full-text preview features are **not** used.

### 4.3 Message status is derived, never stored

The brief lists seven statuses. They live in three different places, and
collapsing them into one column would guarantee drift with the timestamps:

| Status | Source of truth |
| --- | --- |
| `SENDING`, `FAILED` | client-only — the row does not exist yet |
| `SENT`, `EDITED`, `DELETED`, `RECALLED` | derived from `editedAt` / `deletedAt` / `recalledAt` |
| `DELIVERED`, `READ` | per-**recipient**, from the cursor table — never a property of the message |

The response DTO exposes the full seven-value enum as the client contract; the
column set above is the single source of truth behind it. `deletedAt IS NULL`
indexes fine, so no status column is needed for filtering either.

### 4.4 `video_room_message_pins`

```prisma
model VideoRoomMessagePin {
  id         String    @id @default(uuid()) @db.Uuid
  roomId     String    @db.Uuid
  messageId  String    @db.Uuid
  pinnedBy   String    @db.Uuid
  isActive   Boolean   @default(true)
  pinnedAt   DateTime  @default(now())
  unpinnedBy String?   @db.Uuid
  unpinnedAt DateTime?

  @@index([roomId, isActive])
  @@index([messageId])
  @@map("video_room_message_pins")
}
```

Mirrors AR-4's `pinned_messages` (pin/unpin audit trail). **Deliberately no
denormalised `isPinned` flag on the message**: pins are capped at a handful per
room and cached in Redis, so a second copy would only create drift.

### 4.5 `video_room_chat_cursors`

```prisma
model VideoRoomChatCursor {
  roomId                 String    @db.Uuid
  userId                 String    @db.Uuid
  lastReadMessageId      String?   @db.Uuid
  lastReadAt             DateTime?
  lastDeliveredMessageId String?   @db.Uuid
  lastDeliveredAt        DateTime?
  updatedAt              DateTime  @updatedAt

  @@id([roomId, userId])
  @@index([roomId, lastReadAt])
  @@map("video_room_chat_cursors")
}
```

One row per member. `readerList(M) = cursors where lastReadAt >= M.createdAt`.
Cursor advance is strictly monotonic — a lower high-water mark is ignored, never
written.

### 4.6 `VideoRoomSettings` changes

```prisma
chatMode               VideoRoomChatMode @default(NORMAL)
chatMaxMessageLength   Int               @default(500)
chatMaxAttachments     Int               @default(1)
chatRateLimitPerMinute Int               @default(20)
```

**Why an enum and not more booleans.** The brief's six chat toggles are mutually
exclusive states, not independent flags: as booleans they admit eight
combinations, five of which are nonsense, and every reader has to invent its own
precedence rule. One enum makes the illegal states unrepresentable. `allowChat`
is kept as the master on/off switch — it is already there and already named
correctly.

Effective-send precedence: `!allowChat` ⇒ `CHAT_DISABLED` for everyone (including
the owner); otherwise `chatMode` decides.

#### `allowViewerChat` — deprecated this release, dropped in a later one

`PARTICIPANTS_ONLY` states precisely what `allowViewerChat = false` meant, so the
column is redundant. **VR-9 does not drop it.** Removing a column and discovering
a consumer afterwards is an outage; keeping a redundant column costs one boolean
per room. The deprecation is therefore staged:

1. **Backfill (VR-9 migration).** `allowViewerChat = false → chatMode =
   PARTICIPANTS_ONLY`. Existing rooms keep their current behaviour exactly.
2. **`chatMode` is the runtime source of truth.** `ChatPolicyService` reads
   `chatMode` and **never** reads `allowViewerChat`. There is exactly one
   decision input, so the two cannot disagree in a way that affects behaviour.
3. **One-way mirror on write.** The settings-update path writes
   `allowViewerChat = (chatMode !== PARTICIPANTS_ONLY)` alongside every
   `chatMode` change. Nothing in VR-9 reads it back; the mirror exists purely so
   that any consumer not yet found — a mobile client, an admin surface, a
   serialized settings payload — keeps seeing a truthful value instead of a
   frozen stale one.
4. **Schema marked deprecated.** A `/// @deprecated — superseded by chatMode
   (VR-9); drop after consumer audit` doc comment on the column, so the next
   person to read the schema knows before they use it.
5. **Future cleanup migration.** Drop the column once a consumer audit —
   backend grep, mobile client, any external API consumer — confirms zero
   readers. That audit is explicitly **not** VR-9 work.

This makes VR-9 purely additive: no dropped column, no destructive change, and
the removal happens later against evidence rather than assumption.

### 4.7 Mentions

Persisted as the `mentions String[]` array with a GIN index (AR-4 precedent). A
separate mentions table would buy nothing — "messages mentioning me" is an
indexed array-contains query.

---

## 5. Module architecture

### 5.1 The send path

```
POST /video-rooms/:id/chat/messages  ──▶ VideoRoomsChatController
                                              │  (+ @RequestMeta → ip, requestId)
                                              ▼
                                     VideoRoomChatService.send()
   ┌──────────────────────────────────────────┼───────────────────────────────┐
   │ 1  ChatPolicyService.assertCanSend()                                     │
   │      room LIVE? · allowChat? · chatMode vs effective role                │
   │      · blocked/muted? · length · type · attachment count · reply target  │
   │      └─▶ delegates to VideoRoomPermissionService (VR-7) + Moderation repo│
   │ 2  ChatRateLimiter.check()      rate → flood → dedup → cooldown  (Redis) │
   │ 3  BlockedWordScanner.scan()                        (shared, infra)      │
   │ 4  MentionResolver.resolve()    @user / @owner / @admins                 │
   │ 5  ChatRepository.create()                       ← DURABLE, Postgres     │
   │ 6  ChatCacheService.push()      LPUSH + LTRIM    ← Redis ring buffer     │
   │ 7  bus.publish(ChatMessageSentEvent)                                     │
   └──────────────────────────────────────────┼───────────────────────────────┘
                                              ▼
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
           ChatSocketListener        ChatMetricsListener       ChatAuditListener
           → /video-room room        → Prometheus              → VideoRoomEvent
                                                                 (+ ip, requestId)
```

Steps 1–4 are pure decisions, 5–6 are writes, 7 is fan-out. **Nothing after
step 5 can reject the message**, so there is no partial-write window.

### 5.2 File layout

```
src/modules/video-rooms/
  services/
    video-room-chat.service.ts              commands: send/edit/delete/recall/reply
    video-room-chat-query.service.ts        history · search · pinned · unread
    video-room-chat-policy.service.ts       THE gate — one decision point
    video-room-chat-pin.service.ts          pin/unpin, lock-guarded + capped
    video-room-announcement.service.ts      CRUD + projection into the stream
    video-room-typing.service.ts            typing + chat presence (Redis TTL)
    video-room-chat-receipt.service.ts      delivered/read cursors, reader list
    video-room-system-message.service.ts    domain event → SYSTEM message
    video-room-mention-resolver.service.ts
    video-room-chat-cache.service.ts        ring buffer · pin/announcement cache
    video-room-chat-rate-limiter.service.ts
  repositories/
    video-room-chat.repository.ts           messages · pins · cursors (Postgres only)
  listeners/
    video-room-chat-socket.listener.ts      bus → namespace (outbound)
    video-room-chat-metrics.listener.ts     bus → Prometheus
    video-room-chat-system.listener.ts      VR-2/3/4/6/7 events → system messages
    video-room-chat-audit.listener.ts       bus → VideoRoomEvent / VideoRoomLog
  gateway/
    video-room-chat.gateway.ts              inbound EPHEMERAL only
  controllers/  video-rooms-chat.controller.ts
  dto/chat/*.dto.ts
  events/video-room-chat.events.ts
  constants/video-room-chat.constants.ts
  config/video-room-chat.config.ts

src/infra/content-moderation/               ← extracted from audio-rooms
  blocked-word.service.ts
  blocked-word.seeder.service.ts
  content-moderation.module.ts  (@Global)
```

### 5.3 Why these boundaries

- **`ChatPolicyService` is one service, not scattered checks.** VR-7's design
  note records what happened when authorization was spread out: a coarse
  `assertCanManage` gate sat beside the fine permission matrix, won wherever they
  overlapped, and the PRD's admin restrictions went unenforced for six phases.
  Chat has more gates than RBAC did — mode, mute, block, length, type,
  attachments, reply target — so they get one service, one call, one test suite.
- **Metrics and audit are decoupled listeners.** Counting inside `send()` would
  put Prometheus and an extra insert on the hot path and couple the write path to
  observability. Subscribing to the same bus event the socket listener uses costs
  nothing and means metrics can never break a send (VR-4 precedent).
- **The extraction lands in `infra`, not `common`.** dependency-cruiser forbids
  both `common → modules` and `infra → modules`, so the scanner must drop its
  `ChatRepository` dependency and read `chat_blocked_words` through
  `PrismaService`. `infra` is the right home regardless: it is a stateful
  `@Injectable` with `OnModuleInit` and a compiled in-memory cache. The
  blocked-word admin CRUD and seeder move with it; AR-4's `chat-admin.controller`
  injects the shared service.

### 5.4 Boundary compliance

`video-rooms → infra` ✓ · `video-rooms → common` ✓ · `@username` lookup via the
`USERS_SERVICE` token from `users/interfaces/` ✓ (AR-4 precedent) · **no**
`video-rooms → audio-rooms` edge. `pnpm boundaries` must stay green.

---

## 6. Contracts

### 6.1 REST

Base path `video-rooms` (plural), matching all six shipped controllers. The brief
wrote `/video-room/…` singular; the existing convention wins so the module stays
uniform. **This is a deliberate contract deviation from the brief.**

| Method | Route | Permission |
| --- | --- | --- |
| POST | `/video-rooms/:id/chat/messages` | member + `chatMode` |
| PATCH | `/video-rooms/:id/chat/messages/:msgId` | own message only |
| DELETE | `/video-rooms/:id/chat/messages/:msgId` | own, or moderator |
| POST | `/video-rooms/:id/chat/messages/:msgId/recall` | own, inside recall window |
| GET | `/video-rooms/:id/chat/messages` | member |
| GET | `/video-rooms/:id/chat/search` | member |
| GET | `/video-rooms/:id/chat/pinned` | member |
| POST | `/video-rooms/:id/chat/pin` | `PIN_MESSAGES` |
| DELETE | `/video-rooms/:id/chat/pin/:msgId` | `PIN_MESSAGES` |
| GET | `/video-rooms/:id/chat/announcements` | member |
| POST | `/video-rooms/:id/chat/announcements` | `MANAGE_ANNOUNCEMENTS` |
| PATCH | `/video-rooms/:id/chat/announcements/:aId` | `MANAGE_ANNOUNCEMENTS` |
| DELETE | `/video-rooms/:id/chat/announcements/:aId` | `MANAGE_ANNOUNCEMENTS` |
| POST \| DELETE | `/video-rooms/:id/chat/announcements/:aId/pin` | `MANAGE_ANNOUNCEMENTS` |

`DELETE …/chat/pin/:msgId` takes the message id in the path rather than the
brief's bodyless `DELETE /chat/pin` — a bodyless DELETE cannot say *which* pin.

History supports both cursor pagination (`before` / `after` message id, the
scalable path) and offset pagination (`page` / `limit`, for parity with the
platform's `buildPaginated` envelope), newest-first by default with an explicit
`order` parameter. Search filters: `q` (keyword), `senderId`, `type`, `from`,
`to`, `pinnedOnly`, `announcementsOnly`.

### 6.2 Socket — inbound (`VideoRoomChatGateway`)

`video_room.typing_start` · `video_room.typing_stop` ·
`video_room.message_delivered` · `video_room.message_read`

Ephemeral only, per decision 2. Each handler resolves the actor from the
authenticated socket, applies its own light rate limit, and delegates to the same
service the REST path would use.

### 6.3 Socket — outbound

15 new entries in `VIDEO_ROOM_SOCKET_EVENTS`, `video_room.chat_*` prefixed:

`chat_message_sent` · `chat_message_edited` · `chat_message_deleted` ·
`chat_message_recalled` · `chat_message_pinned` · `chat_message_unpinned` ·
`chat_announcement_created` · `chat_announcement_updated` ·
`chat_announcement_deleted` · `chat_typing_started` · `chat_typing_stopped` ·
`chat_message_delivered` · `chat_message_read` · `chat_mentioned`
(point-to-point) · `chat_mode_changed`

`chat_mode_changed` is emitted from the **existing VR-2 settings-update path**
when `chatMode`, `allowChat` or `slowModeSeconds` changes — VR-9 adds the
broadcast, not a new settings endpoint. It carries the effective chat policy so
clients can grey out the composer without refetching settings.

### 6.4 EVENT_BUS domain events

`events/video-room-chat.events.ts` publishes 14 events matching the brief:
`MessageSent`, `MessageEdited`, `MessageDeleted`, `MessageRecalled`,
`MessagePinned`, `MessageUnpinned`, `AnnouncementCreated`, `AnnouncementUpdated`,
`AnnouncementDeleted`, `TypingStarted`, `TypingStopped`, `MessageDelivered`,
`MessageRead`, `MentionCreated`.

---

## 7. System messages

All 13 triggers already exist as published domain events. The listener
subscribes; **zero new event plumbing**.

| Brief's trigger | Existing event | Phase |
| --- | --- | --- |
| User Joined / Left | `MemberJoined` / `MemberLeft` | VR-3 |
| Viewer Joined / Left | `ViewerJoined` / `ViewerLeft` | VR-6 |
| Seat Approved / Rejected | `SeatRequestResolved` (ACCEPTED / REJECTED) | VR-8 |
| Seat Invitation | `SeatInvitationSent` | VR-8 |
| Promotion / Demotion | `ViewerPromoted` / `ViewerDemoted` | VR-6 |
| Room Locked / Unlocked | `RoomLocked` | VR-2 |
| Owner Changed | `OwnershipTransferred` | VR-7 |
| Room Closed | `RoomClosed` | VR-2 |

### 7.1 System-message policy map

Persisting a system message per join would make chat unusable in exactly the
rooms this phase was built for: a 10k-viewer room churning viewers writes more
system rows than human messages, buries real conversation, and leaves
`totalChatMessages` dominated by "X joined".

So system messages are governed by a **code policy map**,
`event → { persist, broadcast, suppressAboveViewers }`:

- Lifecycle and moderation events (owner changed, room locked/unlocked, room
  closed, seat approved/rejected, promotion/demotion) — **always persist**.
- Viewer join/leave — **broadcast-only** (not persisted) above a configurable
  room size; **suppressed entirely** above a second threshold.

Thresholds live in the `videoRoomChat` config namespace.

---

## 8. Anti-abuse

Four Redis gates, evaluated in order, all `{roomId}`-hash-tagged so every
operation is single-key and Redis-Cluster-safe.

| Gate | Mechanism | Bound | Error code |
| --- | --- | --- | --- |
| Rate limit | `INCR … EX 60` | `settings.chatRateLimitPerMinute` (default 20) | `CHAT_RATE_LIMITED` |
| Slow mode | `SET … EX slowModeSeconds` | `settings.slowModeSeconds` | `CHAT_SLOW_MODE` |
| Flood | burst window — N msgs in M sec | 5 in 2s → cooldown | `CHAT_RATE_LIMITED` |
| Duplicate | `SET NX sha1(content) EX w` | 30s window | `DUPLICATE_MESSAGE` |
| Cooldown | `SET … EX` blocks sends | escalating 10 / 30 / 120s | `CHAT_RATE_LIMITED` |

**Escalating cooldown, not auto-mute.** AR-4's violation counter escalates to
`autoMute` / `autoKick`. VR-9 stops at the Redis cooldown because *Moderation
Actions* is on the brief's DO-NOT-IMPLEMENT list — same detection, no enforcement
this phase is not scoped for.

Blocked-word handling: `MASK` masks and continues; `REJECT` and `ESCALATE` both
reject with `BLOCKED_WORD`. No auto-report, no auto-discipline.

### 8.1 Configuration

New `videoRoomChat` config namespace in `src/config/configuration.ts` with
`VIDEO_ROOM_CHAT_*` env vars, read through a `loadVideoRoomChatConfig()`
coercion accessor — namespaced config values surface as raw `process.env` strings
at runtime, so every numeric field is coerced once behind a single accessor
(the VR-0 pattern, adopted after the string-coercion defect).

Tunables: `messageMaxLength`, `maxMentions`, `maxPins`, `rateMax`,
`rateWindowSeconds`, `dedupWindowSeconds`, `floodBurstMax`,
`floodBurstWindowSeconds`, `cooldownSteps`, `recentBufferSize`,
`recentBufferTtlSeconds`, `typingTtlSeconds`, `recallWindowSeconds`,
`editWindowSeconds`, `receiptThrottleMs`, `systemMessageBroadcastOnlyAboveViewers`,
`systemMessageSuppressAboveViewers`.

---

## 9. Redis keys

All single-key, `{roomId}`-hash-tagged (Cluster-safe), following the
`constants/video-room.constants.ts` convention:

```
video-room:{roomId}:chat:recent            LIST  ring buffer (LPUSH + LTRIM)
video-room:{roomId}:chat:pins              SET   active pinned message ids
video-room:{roomId}:chat:announcements     STR   cached announcement payload
video-room:{roomId}:chat:typing            ZSET  userId → expiry (TTL sweep on read)
video-room:{roomId}:chat:rate:<userId>     STR   INCR + EX
video-room:{roomId}:chat:slow:<userId>     STR   EX slowModeSeconds
video-room:{roomId}:chat:flood:<userId>    STR   INCR + EX burst window
video-room:{roomId}:chat:dedup:<userId>:<hash>  STR  SET NX EX
video-room:{roomId}:chat:cd:<userId>       STR   cooldown
video-room:{roomId}:chat:cursor:<userId>   STR   read-cursor write-through
video-room:chat:pin:{roomId}               LOCK  serialises pin/unpin (cap check)
```

Losing Redis costs a rebuild (ring buffer refills from Postgres, pins/cursors
re-read), never data.

---

## 10. Audit logging

Every mutating action writes to the existing append-only `VideoRoomEvent` stream
via `ChatAuditListener` — `eventType` is an open string, exactly what that table
was built for. The payload carries the brief's required fields:

```json
{ "roomId", "messageId", "userId", "timestamp", "ip", "requestId", "userAgent" }
```

`ip` / `requestId` / `userAgent` come from the existing
`@RequestMeta` decorator, threaded from the controller into the service call and
onto the published event. Socket-originated ephemeral actions carry the socket's
handshake address in the same field.

Human-readable moderator-visible actions additionally append to `VideoRoomLog`.
`VideoRoomLogAction` gains `MESSAGE_DELETED`, `MESSAGE_PINNED`,
`MESSAGE_UNPINNED`, `ANNOUNCEMENT_UPDATED`, `ANNOUNCEMENT_DELETED` (additive enum
migration; `ANNOUNCEMENT_POSTED` already exists).

---

## 11. Monitoring

Nine metric families added to the existing `VideoRoomsMetrics` (registered on the
shared `MetricsService` registry, exposed at `GET /metrics`):

| Metric | Type |
| --- | --- |
| `chatMessages{type}` | Counter |
| `chatMessageLatency` (send → broadcast) | Histogram |
| `chatDeliveryLatency` | Histogram |
| `chatReadLatency` | Histogram |
| `typingEvents` | Counter |
| `announcements{action}` | Counter |
| `pinnedMessages` | Gauge |
| `spamDetected{kind}` (flood / duplicate / blocked_word) | Counter |
| `rateLimitViolations` | Counter |

---

## 12. Validations

Room exists and is LIVE · user is an active member · `allowChat` · `chatMode`
permits this actor and this message type · not blocked · not muted · content
length within `chatMaxMessageLength` (emoji messages use the tighter emoji bound)
· message type valid · attachment count within `chatMaxAttachments` · reply
target exists, belongs to this room, and is not deleted · pin target exists and
is not already pinned · pin cap not exceeded · duplicate window · flood window ·
mention count capped.

Deleted-parent handling: a reply whose parent was deleted still renders; the
parent snapshot resolves to a tombstone rather than failing the read.

### 12.1 Edit / delete / recall are three distinct operations

The brief lists all three; they are not synonyms, and each has its own window and
visible outcome:

| Operation | Who | Window | Result |
| --- | --- | --- | --- |
| **Edit** | author only | `editWindowSeconds` (default 900) | content replaced, `editedAt` + `editCount` set; message stays visible, clients render an "edited" marker |
| **Delete** | author, or a moderator | none (always allowed) | soft delete — `deletedAt` + `deletedBy` set; content withheld from non-moderators, row retained for audit |
| **Recall** | author only | `recallWindowSeconds` (default 120) | `recalledAt` set; the message is withdrawn from every client as though unsent, content withheld from **everyone** including moderators, row retained for audit |

Delete is the moderation-visible removal; recall is the sender's own "unsend".
Both are soft — VR-9 never hard-deletes a message row. An already-deleted or
already-recalled message is idempotent on repeat (no error, no second event).
Editing a deleted, recalled or `SYSTEM`-type message is refused. Recalling or
deleting a pinned message unpins it in the same operation.

---

## 13. Testing

TDD throughout, matching the phase's house standard.

- Unit specs for all 11 services + the repository.
- **`ChatPolicyService` mode × role matrix enumerated exhaustively** — 4 modes ×
  6 roles = 24 cases. The gate VR-7's post-mortem says is worth over-testing.
- Listener specs asserting exhaustive bus-event → socket-event mapping. VR-8's
  `REQUEST_RESOLUTION_EVENTS` lesson applies: an unmapped case must emit
  **nothing**, never the wrong thing.
- Gateway specs for the four inbound handlers.
- Rate-limit / flood / dedup / cooldown specs against a fake Redis.
- Edit / delete / recall specs: window boundaries (inside vs expired), author vs
  moderator authority, idempotent repeats, refusal on `SYSTEM` messages, and
  auto-unpin of a deleted or recalled pinned message.
- Cursor specs proving reader-list derivation and monotonic high-water advance
  (a stale lower cursor must be ignored).
- Announcement projection specs: create/update/delete keeps the linked stream
  message in sync.
- Deprecation specs: `ChatPolicyService` decides identically regardless of
  `allowViewerChat` (proving it is never read), and the settings-update path
  mirrors `allowViewerChat = (chatMode !== PARTICIPANTS_ONLY)` on every
  `chatMode` write. A backfill spec asserts `allowViewerChat = false` rooms land
  on `PARTICIPANTS_ONLY` with unchanged behaviour.
- System-message policy specs: persist vs broadcast-only vs suppressed at each
  room-size threshold.
- `video-rooms-chat.integration.spec.ts`: send → persist → cache → broadcast,
  mode enforcement, pin cap, announcement ↔ message projection.
- **Regression gate:** full suite green (1192 baseline + VR-9), and AR-4's
  `chat.service.spec` (408 lines) + `blocked-word.service.spec` (137 lines) pass
  with **zero assertion edits** after the scanner extraction. If the move changes
  behaviour, the move is wrong.

---

## 14. Swagger

Every route documented with: bearer auth, the required permission, validation
bounds, a request example, a response example, and the specific error codes that
route can return.

---

## 15. Risks

1. **The scanner extraction touches shipped AR-4 code.** Mitigation: it is a move
   plus a re-export, not a rewrite; the acceptance gate is AR-4's existing specs
   passing unedited.
2. **`chatMode` and the deprecated `allowViewerChat` could drift.** Mitigation:
   only `chatMode` is ever read, so drift cannot change behaviour; the one-way
   mirror on write keeps the legacy column truthful for any undiscovered
   consumer. VR-9 drops no columns, so the phase carries **no destructive
   change**.
3. **Announcement ↔ stream-message sync is a two-write path.** Mitigation:
   announcements are owner/admin-only and low-volume; the projection is covered
   by dedicated specs, and the announcement table remains the record of record so
   a lost projection is cosmetic, never data loss.
4. **Phase size.** ~20–22 TDD tasks, in line with VR-5 (19) and VR-8 (16).

---

## 16. Out of scope

Virtual gifts · treasure boxes · wallet · PK battles · rankings · notifications ·
moderation actions (mute/kick/ban enforcement) · analytics processing ·
recording · live-stream business logic · message reactions (AR-4 has them; the
VR-9 brief does not list them) · image/video/voice upload pipelines (enum values
and the `attachments` slot are landed future-ready; no storage path).

---

## 17. Definition of done

- `video_rooms_chat.prisma` + migration SQL applied — **purely additive**: 3 new
  tables, 4 new settings columns, `allowViewerChat` backfilled into `chatMode`
  and marked `@deprecated` (**not** dropped), `pg_trgm` index, additive
  log-action enum values. No column or table is removed.
- 11 services, 1 repository, 4 listeners, 1 gateway, 1 controller, DTOs, events,
  constants and config landed and wired in `video-rooms.module.ts`.
- Blocked-word engine + seeder + dictionary CRUD extracted to
  `src/infra/content-moderation/`; audio-rooms rewired; AR-4 specs unedited and
  green.
- 15 REST routes live and Swagger-documented; 4 inbound socket handlers; 15
  outbound socket events; 14 bus events.
- All 13 system-message triggers wired to existing domain events, governed by the
  policy map.
- 9 metric families reporting.
- `pnpm tsc`, `pnpm lint`, `pnpm boundaries` green.
- Full test suite green with zero regressions against the 1192-test baseline.
