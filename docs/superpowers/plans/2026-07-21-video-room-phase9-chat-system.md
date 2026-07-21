# Video Room Phase 9 (VR-9) — Real-Time Room Chat System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-grade real-time chat engine for Video Rooms — send/edit/delete/recall/reply, mentions, pins, announcements, typing, read receipts, history, search — over the existing VR-0…VR-8 infrastructure.

**Architecture:** REST for durable commands, Socket.IO for ephemeral signals. Persist-then-broadcast: a synchronous Postgres insert, then EVENT_BUS → `/video-room` namespace fan-out, with a Redis ring buffer serving the read hot path. One `ChatPolicyService` is the single authorization decision point. Read receipts are high-water-mark cursors (one row per member), never per-message rows.

**Tech Stack:** NestJS · Prisma (PostgreSQL, multi-file schema) · ioredis · Socket.IO (Redis adapter) · BullMQ · Jest · prom-client · class-validator/Swagger

**Spec:** `docs/superpowers/specs/2026-07-21-video-room-phase9-chat-system-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Purely additive schema.** No column or table is dropped. `allowViewerChat` is deprecated in place, never removed.
- **`chatMode` is the only runtime source of truth** for who may send. `ChatPolicyService` must **never** read `allowViewerChat`.
- **No Prisma inside services.** All Postgres access goes through `VideoRoomChatRepository`.
- **Module boundaries** (`pnpm boundaries` must stay green): a module may import another module only via its `interfaces/` or `events/`. **No `video-rooms → audio-rooms` import may be introduced.** `src/infra/**` and `src/common/**` must not import from `src/modules/**`.
- **Redis keys are single-key and `{roomId}`-hash-tagged** so every operation is Redis-Cluster-safe.
- **AR-4 regression gate:** `src/modules/audio-rooms/services/chat.service.spec.ts` and `blocked-word.service.spec.ts` must pass with **zero edits to their assertions** after Task 5.
- **Baseline (corrected 2026-07-21, measured — the original "1192" was stale VR-5-era):**
  `140 suites / 1635 tests — 1632 pass, 3 fail`.
  The 3 failures are **all** `TreasureService › startSession` in
  `src/modules/treasure-boxes/services/treasure.service.spec.ts` — pre-existing
  spec/implementation drift, unrelated to Video Rooms, **QUARANTINED and OUT OF
  SCOPE**. Do not touch the treasure-boxes module for any reason.
- **Per-task gate is ZERO NEW FAILURES, not an absolute count.** Ignore every
  "Expected: NNNN passing" figure in the task steps — they were derived from the
  stale 1192 baseline and are all understated by 443. What must hold after each
  task: the task's own new tests pass, no previously-passing test starts failing,
  and the treasure-boxes failure count stays at exactly 3.
- **NO GIT OPERATIONS.** User-directed. No commit, push, stash, rebase, branch
  change, or `git add`. **Ignore the "Commit" step at the end of every task** —
  work stays in the working tree, as VR-5 through VR-8 did. Read-only inspection
  (`git status`, `git diff`) is fine.
- **Lint gate is SCOPED, not project-wide (measured 2026-07-21).** `pnpm lint`
  reports **180 pre-existing errors** across 23 files in 10 modules
  (audio-rooms 5, treasure-boxes 3, gifts 3, games 3, wallet 2, casino 2,
  backpack 2, otp 1, auth 1, infra/socket 1). **`src/modules/video-rooms` is
  clean and must stay clean.** So the gate is
  `npx eslint <files this task touched> --max-warnings 0` → zero errors, NOT
  `pnpm lint` project-wide, which cannot pass and never could. Do not fix
  unrelated modules' lint debt.
- **Run `npx eslint --fix` on every file you create or modify** before reporting.
  The plan's code blocks use a compact style that Prettier reformats; this bit
  earlier phases repeatedly (recorded in `.superpowers/sdd/progress.md`).
- **System actor id:** `VIDEO_ROOM_SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'` (already in `constants/video-room.constants.ts`). Every audit column is `@db.Uuid`; a non-UUID sentinel throws at the query layer.
- **Commands:** `pnpm test` · `pnpm lint` · `npx tsc --noEmit` · `pnpm boundaries`
- **Test style:** plain constructor injection with `as never` mocks — **no** Nest `TestingModule`. Match `src/modules/video-rooms/services/video-room-permission.service.spec.ts`.
- **Soft delete only.** VR-9 never hard-deletes a message row.
- **Out of scope:** gifts, treasure boxes, wallet, PK, rankings, notifications, moderation *actions* (mute/kick/ban enforcement), analytics processing, recording, reactions, upload pipelines.

---

## File Structure

**New — Prisma**
| File | Responsibility |
| --- | --- |
| `prisma/schema/video_rooms_chat.prisma` | `VideoRoomMessage`, `VideoRoomMessagePin`, `VideoRoomChatCursor`, `VideoRoomMessageType`, `VideoRoomChatMode` |
| `prisma/schema/migrations/20260721120000_video_rooms_phase9_chat/migration.sql` | tables, settings columns, backfill, `pg_trgm`, enum additions |

**New — `src/infra/content-moderation/`** (extracted from audio-rooms)
| File | Responsibility |
| --- | --- |
| `blocked-word.service.ts` | compiled dictionary cache + `scan()` |
| `blocked-word.repository.ts` | `chat_blocked_words` persistence (Prisma) |
| `blocked-word.seeder.service.ts` | idempotent default seed |
| `content-moderation.module.ts` | `@Global` module exporting the above |

**New — `src/modules/video-rooms/`**
| File | Responsibility |
| --- | --- |
| `constants/video-room-chat.constants.ts` | socket event names, Redis key builders, fixed bounds |
| `config/video-room-chat.config.ts` | typed + coerced `videoRoomChat` namespace accessor |
| `events/video-room-chat.events.ts` | 14 `DomainEvent` classes + `VIDEO_ROOM_CHAT_EVENTS` |
| `repositories/video-room-chat.repository.ts` | messages · pins · cursors (Postgres only) |
| `services/video-room-chat-cache.service.ts` | ring buffer · pin cache · typing zset (Redis) |
| `services/video-room-chat-rate-limiter.service.ts` | rate · slow · flood · dedup · cooldown |
| `services/video-room-mention-resolver.service.ts` | `@user` / `@owner` / `@admins` → user ids |
| `services/video-room-chat-policy.service.ts` | **the** send/edit/delete authorization gate |
| `services/video-room-chat.service.ts` | send · edit · delete · recall |
| `services/video-room-chat-pin.service.ts` | pin · unpin (lock-guarded, capped) |
| `services/video-room-announcement.service.ts` | announcement CRUD + stream projection |
| `services/video-room-chat-query.service.ts` | history · search · pinned · unread |
| `services/video-room-typing.service.ts` | typing start/stop + typing roster |
| `services/video-room-chat-receipt.service.ts` | delivered/read cursors + reader list |
| `services/video-room-system-message.service.ts` | policy map + system message emission |
| `dto/chat/*.dto.ts` | 9 request DTOs + response view |
| `controllers/video-rooms-chat.controller.ts` | 15 REST routes + Swagger |
| `gateway/video-room-chat.gateway.ts` | 4 inbound ephemeral handlers |
| `listeners/video-room-chat-socket.listener.ts` | bus → namespace (outbound) |
| `listeners/video-room-chat-system.listener.ts` | VR-2/3/6/7/8 events → system messages |
| `listeners/video-room-chat-metrics.listener.ts` | bus → Prometheus |
| `listeners/video-room-chat-audit.listener.ts` | bus → `VideoRoomEvent` (+ip, requestId) |

**Modified**
| File | Change |
| --- | --- |
| `prisma/schema/video_rooms.prisma` | 4 settings columns; `allowViewerChat` deprecation comment; 5 `VideoRoomLogAction` values |
| `src/common/exceptions/error-codes.ts` | 6 VR-9 codes |
| `src/config/configuration.ts` + `env.validation.ts` | `videoRoomChat` namespace |
| `src/modules/video-rooms/video-rooms.metrics.ts` | 9 metric families |
| `src/modules/video-rooms/video-rooms.module.ts` | wire everything |
| `src/modules/audio-rooms/**` | consume the extracted engine (Task 5) |
| `src/app.module.ts` | register `ContentModerationModule` |

**23 tasks.** Tasks 1–5 are foundation and must run in order. Tasks 6–8 are independent of each other. Task 9 gates 10–14.

---

### Task 1: Schema, migration, and error codes

**Files:**
- Create: `prisma/schema/video_rooms_chat.prisma`
- Create: `prisma/schema/migrations/20260721120000_video_rooms_phase9_chat/migration.sql`
- Modify: `prisma/schema/video_rooms.prisma` (settings columns + log actions)
- Modify: `src/common/exceptions/error-codes.ts:132` (after `INVALID_REGEX`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: Prisma client models `videoRoomMessage`, `videoRoomMessagePin`, `videoRoomChatCursor`; enums `VideoRoomMessageType`, `VideoRoomChatMode`; error codes listed below.

- [ ] **Step 1: Create the chat schema file**

Create `prisma/schema/video_rooms_chat.prisma`:

```prisma
// ============================================================
// Video Rooms — VR-9: room chat messages, pins, and read cursors.
// Owned by the "video_rooms" module. No cross-module relations —
// reference users/rooms/messages by id.
//
// Deliberately separate from audio_rooms_chat.prisma's RoomMessage:
// that table has no edit trail, status, attachments, recall or read
// cursor, and sharing it would put two domains on one hot index.
// This mirrors the VideoRoom-does-not-reuse-AudioRoom split.
//
// Message STATUS is derived, never stored: SENDING/FAILED are
// client-only, SENT/EDITED/DELETED/RECALLED come from the timestamp
// columns, and DELIVERED/READ are per-recipient facts living in
// video_room_chat_cursors. A status column could only drift.
// ============================================================

enum VideoRoomMessageType {
  TEXT
  EMOJI
  GIF
  IMAGE
  VIDEO
  VOICE
  SYSTEM
  ANNOUNCEMENT
}

/// Who may send in a room. Mutually exclusive states, so an enum rather
/// than overlapping booleans (six booleans admit combinations that are
/// nonsense). NORMAL = any active member; PARTICIPANTS_ONLY = seat
/// holders + elevated roles; READ_ONLY = elevated roles only;
/// ANNOUNCEMENT_ONLY = MANAGE_ANNOUNCEMENTS holders, ANNOUNCEMENT type only.
enum VideoRoomChatMode {
  NORMAL
  PARTICIPANTS_ONLY
  READ_ONLY
  ANNOUNCEMENT_ONLY
}

/// A chat message. `senderId` is VIDEO_ROOM_SYSTEM_ACTOR_ID for SYSTEM rows.
/// `metadata` carries announcementId (for ANNOUNCEMENT projections), the
/// system-event kind (for SYSTEM rows), and the request audit context.
/// Deletes and recalls are soft — the row is always retained.
model VideoRoomMessage {
  id              String               @id @default(uuid()) @db.Uuid
  roomId          String               @db.Uuid
  senderId        String               @db.Uuid
  type            VideoRoomMessageType @default(TEXT)
  content         String
  mentions        String[]             @db.Uuid
  /// 'OWNER' | 'ADMINS' for group mentions; null for direct @username mentions.
  mentionScope    String?
  replyToId       String?              @db.Uuid
  forwardedFromId String?              @db.Uuid
  attachments     Json?
  metadata        Json?
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

/// Pin/unpin audit trail. `isActive` false ⇒ unpinned (kept for audit).
/// No denormalised isPinned flag on the message — pins are few and cached
/// in Redis, so a second copy would only create drift.
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

/// Read-receipt high-water mark — ONE row per (room, user), never one per
/// (message, user). A 10k-viewer room at 500 msg/min would otherwise write
/// 5M receipt rows a minute. The reader list is derived:
/// readers(M) = cursors where lastReadAt >= M.createdAt.
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

- [ ] **Step 2: Add settings columns and log actions**

In `prisma/schema/video_rooms.prisma`, inside `model VideoRoomSettings`, replace the line `allowViewerChat      Boolean  @default(true)` with:

```prisma
  /// @deprecated VR-9 — superseded by `chatMode` (PARTICIPANTS_ONLY).
  /// Still WRITTEN (mirrored from chatMode on every settings update) so any
  /// consumer not yet found — mobile client, admin surface, cached settings
  /// payload — keeps seeing a truthful value. NEVER READ by backend code.
  /// Drop in a later cleanup migration after a consumer audit.
  allowViewerChat      Boolean  @default(true)
  // ---- VR-9 chat policy ----
  chatMode               VideoRoomChatMode @default(NORMAL)
  chatMaxMessageLength   Int               @default(500)
  chatMaxAttachments     Int               @default(1)
  chatRateLimitPerMinute Int               @default(20)
```

In the same file, append these five values to `enum VideoRoomLogAction` (after `KICKED`):

```prisma
  MESSAGE_DELETED
  MESSAGE_PINNED
  MESSAGE_UNPINNED
  ANNOUNCEMENT_UPDATED
  ANNOUNCEMENT_DELETED
```

- [ ] **Step 3: Write the migration SQL**

Create `prisma/schema/migrations/20260721120000_video_rooms_phase9_chat/migration.sql`:

```sql
-- VR-9: Video Room chat. PURELY ADDITIVE — no column or table is dropped.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "VideoRoomMessageType" AS ENUM
  ('TEXT','EMOJI','GIF','IMAGE','VIDEO','VOICE','SYSTEM','ANNOUNCEMENT');
CREATE TYPE "VideoRoomChatMode" AS ENUM
  ('NORMAL','PARTICIPANTS_ONLY','READ_ONLY','ANNOUNCEMENT_ONLY');

ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_DELETED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_PINNED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_UNPINNED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_UPDATED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_DELETED';

CREATE TABLE "video_room_messages" (
    "id"              UUID NOT NULL,
    "roomId"          UUID NOT NULL,
    "senderId"        UUID NOT NULL,
    "type"            "VideoRoomMessageType" NOT NULL DEFAULT 'TEXT',
    "content"         TEXT NOT NULL,
    "mentions"        UUID[],
    "mentionScope"    TEXT,
    "replyToId"       UUID,
    "forwardedFromId" UUID,
    "attachments"     JSONB,
    "metadata"        JSONB,
    "editedAt"        TIMESTAMP(3),
    "editCount"       INTEGER NOT NULL DEFAULT 0,
    "deletedAt"       TIMESTAMP(3),
    "deletedBy"       UUID,
    "recalledAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_room_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "video_room_messages_roomId_createdAt_idx"
  ON "video_room_messages" ("roomId", "createdAt" DESC);
CREATE INDEX "video_room_messages_roomId_type_createdAt_idx"
  ON "video_room_messages" ("roomId", "type", "createdAt" DESC);
CREATE INDEX "video_room_messages_roomId_senderId_createdAt_idx"
  ON "video_room_messages" ("roomId", "senderId", "createdAt" DESC);
CREATE INDEX "video_room_messages_replyToId_idx"
  ON "video_room_messages" ("replyToId");
CREATE INDEX "video_room_messages_mentions_idx"
  ON "video_room_messages" USING GIN ("mentions");
-- Keyword search stays indexed instead of sequential-scanning millions of rows.
CREATE INDEX "video_room_messages_content_trgm_idx"
  ON "video_room_messages" USING GIN ("content" gin_trgm_ops);

CREATE TABLE "video_room_message_pins" (
    "id"         UUID NOT NULL,
    "roomId"     UUID NOT NULL,
    "messageId"  UUID NOT NULL,
    "pinnedBy"   UUID NOT NULL,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "pinnedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpinnedBy" UUID,
    "unpinnedAt" TIMESTAMP(3),
    CONSTRAINT "video_room_message_pins_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "video_room_message_pins_roomId_isActive_idx"
  ON "video_room_message_pins" ("roomId", "isActive");
CREATE INDEX "video_room_message_pins_messageId_idx"
  ON "video_room_message_pins" ("messageId");

CREATE TABLE "video_room_chat_cursors" (
    "roomId"                 UUID NOT NULL,
    "userId"                 UUID NOT NULL,
    "lastReadMessageId"      UUID,
    "lastReadAt"             TIMESTAMP(3),
    "lastDeliveredMessageId" UUID,
    "lastDeliveredAt"        TIMESTAMP(3),
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "video_room_chat_cursors_pkey" PRIMARY KEY ("roomId", "userId")
);
CREATE INDEX "video_room_chat_cursors_roomId_lastReadAt_idx"
  ON "video_room_chat_cursors" ("roomId", "lastReadAt");

-- Settings: new chat policy columns.
ALTER TABLE "video_room_settings"
  ADD COLUMN "chatMode" "VideoRoomChatMode" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "chatMaxMessageLength"   INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "chatMaxAttachments"     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "chatRateLimitPerMinute" INTEGER NOT NULL DEFAULT 20;

-- Deprecation backfill: existing rooms keep their exact current behaviour.
-- allowViewerChat is NOT dropped (see the schema doc comment).
UPDATE "video_room_settings"
   SET "chatMode" = 'PARTICIPANTS_ONLY'
 WHERE "allowViewerChat" = false;
```

- [ ] **Step 4: Add the six VR-9 error codes**

In `src/common/exceptions/error-codes.ts`, after line 132 (`INVALID_REGEX`), add:

```typescript
  // ---- Video Room chat (VR-9) ----
  VIDEO_ROOM_CHAT_MODE_RESTRICTED: 'VIDEO_ROOM_CHAT_MODE_RESTRICTED',
  VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED: 'VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED',
  VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED: 'VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED',
  VIDEO_ROOM_MESSAGE_NOT_EDITABLE: 'VIDEO_ROOM_MESSAGE_NOT_EDITABLE',
  VIDEO_ROOM_REPLY_TARGET_INVALID: 'VIDEO_ROOM_REPLY_TARGET_INVALID',
  VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND: 'VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND',
  VIDEO_ROOM_ATTACHMENT_LIMIT: 'VIDEO_ROOM_ATTACHMENT_LIMIT',
```

- [ ] **Step 5: Generate the client and verify it compiles**

Run: `pnpm prisma:generate && npx tsc --noEmit`
Expected: generation succeeds; tsc reports no errors.

- [ ] **Step 6: Verify the models exist on the client**

Run:
```bash
node -e "const{PrismaClient}=require('@prisma/client');const c=new PrismaClient();console.log(['videoRoomMessage','videoRoomMessagePin','videoRoomChatCursor'].map(m=>m+':'+(typeof c[m])).join(' '))"
```
Expected: `videoRoomMessage:object videoRoomMessagePin:object videoRoomChatCursor:object`

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `pnpm test`
Expected: 1192 passing, 0 failing.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema/video_rooms_chat.prisma \
        prisma/schema/video_rooms.prisma \
        prisma/schema/migrations/20260721120000_video_rooms_phase9_chat \
        src/common/exceptions/error-codes.ts
git commit -m "feat(video-rooms): VR-9 chat schema, migration and error codes"
```

---

### Task 2: Constants and configuration

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-chat.constants.ts`
- Create: `src/modules/video-rooms/config/video-room-chat.config.ts`
- Create: `src/modules/video-rooms/config/video-room-chat.config.spec.ts`
- Modify: `src/config/configuration.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (append chat socket events)

**Interfaces:**
- Consumes: Task 1's enums.
- Produces: `VIDEO_ROOM_CHAT_SOCKET_EVENTS`, the Redis key builders listed below, `VideoRoomChatConfig`, `loadVideoRoomChatConfig(config: ConfigService): VideoRoomChatConfig`.

- [ ] **Step 1: Write the failing config test**

Create `src/modules/video-rooms/config/video-room-chat.config.spec.ts`:

```typescript
import { loadVideoRoomChatConfig } from './video-room-chat.config';

describe('loadVideoRoomChatConfig', () => {
  // Namespaced config values surface as raw process.env STRINGS at runtime.
  // Coercing once behind this accessor is what stops '20' > 5 comparisons
  // from silently doing string comparison across every call site.
  it('coerces string env values to numbers', () => {
    const config = {
      get: () => ({
        messageMaxLength: '500',
        maxMentions: '10',
        maxPins: '3',
        rateMax: '20',
        rateWindowSeconds: '60',
        dedupWindowSeconds: '30',
        floodBurstMax: '5',
        floodBurstWindowSeconds: '2',
        cooldownSteps: '10,30,120',
        recentBufferSize: '100',
        recentBufferTtlSeconds: '3600',
        typingTtlSeconds: '5',
        recallWindowSeconds: '120',
        editWindowSeconds: '900',
        receiptThrottleMs: '2000',
        systemMessageBroadcastOnlyAboveViewers: '200',
        systemMessageSuppressAboveViewers: '2000',
      }),
    };

    const cfg = loadVideoRoomChatConfig(config as never);

    expect(cfg.messageMaxLength).toBe(500);
    expect(cfg.rateMax).toBe(20);
    expect(cfg.editWindowSeconds).toBe(900);
    expect(cfg.cooldownSteps).toEqual([10, 30, 120]);
  });

  it('throws when the namespace is not registered', () => {
    const config = { get: () => undefined };
    expect(() => loadVideoRoomChatConfig(config as never)).toThrow(
      'videoRoomChat config namespace is not registered',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/config/video-room-chat.config.spec.ts`
Expected: FAIL — `Cannot find module './video-room-chat.config'`

- [ ] **Step 3: Implement the config accessor**

Create `src/modules/video-rooms/config/video-room-chat.config.ts`:

```typescript
import type { ConfigService } from '@nestjs/config';

/**
 * Typed, fully-coerced view of the `videoRoomChat` config namespace. Namespaced
 * config values surface as raw process.env strings at runtime, so every numeric
 * field is re-coerced here once, behind a single accessor, instead of scattering
 * `Number(...)` across the chat services (the VR-0 pattern).
 */
export interface VideoRoomChatConfig {
  messageMaxLength: number;
  maxMentions: number;
  maxPins: number;
  rateMax: number;
  rateWindowSeconds: number;
  dedupWindowSeconds: number;
  floodBurstMax: number;
  floodBurstWindowSeconds: number;
  /** Escalating cooldown ladder in seconds, indexed by violation count. */
  cooldownSteps: number[];
  recentBufferSize: number;
  recentBufferTtlSeconds: number;
  typingTtlSeconds: number;
  recallWindowSeconds: number;
  editWindowSeconds: number;
  receiptThrottleMs: number;
  systemMessageBroadcastOnlyAboveViewers: number;
  systemMessageSuppressAboveViewers: number;
}

type Raw = Record<keyof VideoRoomChatConfig, number | string>;

/** Parse "10,30,120" (or an already-parsed array) into a number ladder. */
function toLadder(value: number | string | number[]): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

/** Read + coerce the `videoRoomChat` namespace into a typed config. */
export function loadVideoRoomChatConfig(config: ConfigService): VideoRoomChatConfig {
  const raw = config.get<Raw>('videoRoomChat');
  if (!raw) {
    throw new Error('videoRoomChat config namespace is not registered');
  }
  return {
    messageMaxLength: Number(raw.messageMaxLength),
    maxMentions: Number(raw.maxMentions),
    maxPins: Number(raw.maxPins),
    rateMax: Number(raw.rateMax),
    rateWindowSeconds: Number(raw.rateWindowSeconds),
    dedupWindowSeconds: Number(raw.dedupWindowSeconds),
    floodBurstMax: Number(raw.floodBurstMax),
    floodBurstWindowSeconds: Number(raw.floodBurstWindowSeconds),
    cooldownSteps: toLadder(raw.cooldownSteps as never),
    recentBufferSize: Number(raw.recentBufferSize),
    recentBufferTtlSeconds: Number(raw.recentBufferTtlSeconds),
    typingTtlSeconds: Number(raw.typingTtlSeconds),
    recallWindowSeconds: Number(raw.recallWindowSeconds),
    editWindowSeconds: Number(raw.editWindowSeconds),
    receiptThrottleMs: Number(raw.receiptThrottleMs),
    systemMessageBroadcastOnlyAboveViewers: Number(raw.systemMessageBroadcastOnlyAboveViewers),
    systemMessageSuppressAboveViewers: Number(raw.systemMessageSuppressAboveViewers),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/config/video-room-chat.config.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Register the namespace**

In `src/config/configuration.ts`, add this `registerAs` block next to the existing namespaces and include it in the exported array (mirroring how `chatConfig` is registered at line 301 and listed at line 380):

```typescript
export const videoRoomChatConfig = registerAs('videoRoomChat', () => ({
  messageMaxLength: process.env.VIDEO_ROOM_CHAT_MESSAGE_MAX_LENGTH ?? 500,
  maxMentions: process.env.VIDEO_ROOM_CHAT_MAX_MENTIONS ?? 10,
  maxPins: process.env.VIDEO_ROOM_CHAT_MAX_PINS ?? 3,
  rateMax: process.env.VIDEO_ROOM_CHAT_RATE_MAX ?? 20,
  rateWindowSeconds: process.env.VIDEO_ROOM_CHAT_RATE_WINDOW_SECONDS ?? 60,
  dedupWindowSeconds: process.env.VIDEO_ROOM_CHAT_DEDUP_WINDOW_SECONDS ?? 30,
  floodBurstMax: process.env.VIDEO_ROOM_CHAT_FLOOD_BURST_MAX ?? 5,
  floodBurstWindowSeconds: process.env.VIDEO_ROOM_CHAT_FLOOD_BURST_WINDOW_SECONDS ?? 2,
  cooldownSteps: process.env.VIDEO_ROOM_CHAT_COOLDOWN_STEPS ?? '10,30,120',
  recentBufferSize: process.env.VIDEO_ROOM_CHAT_RECENT_BUFFER_SIZE ?? 100,
  recentBufferTtlSeconds: process.env.VIDEO_ROOM_CHAT_RECENT_BUFFER_TTL_SECONDS ?? 3600,
  typingTtlSeconds: process.env.VIDEO_ROOM_CHAT_TYPING_TTL_SECONDS ?? 5,
  recallWindowSeconds: process.env.VIDEO_ROOM_CHAT_RECALL_WINDOW_SECONDS ?? 120,
  editWindowSeconds: process.env.VIDEO_ROOM_CHAT_EDIT_WINDOW_SECONDS ?? 900,
  receiptThrottleMs: process.env.VIDEO_ROOM_CHAT_RECEIPT_THROTTLE_MS ?? 2000,
  systemMessageBroadcastOnlyAboveViewers:
    process.env.VIDEO_ROOM_CHAT_SYSMSG_BROADCAST_ONLY_ABOVE_VIEWERS ?? 200,
  systemMessageSuppressAboveViewers:
    process.env.VIDEO_ROOM_CHAT_SYSMSG_SUPPRESS_ABOVE_VIEWERS ?? 2000,
}));
```

- [ ] **Step 6: Create the chat constants**

Create `src/modules/video-rooms/constants/video-room-chat.constants.ts`:

```typescript
/**
 * VR-9 chat constants: Redis key builders and fixed bounds. Tunables live in the
 * `videoRoomChat` config namespace; these are the fixed conventions shared across
 * the repository/service/listener tree. Every key is single-key and hash-tagged
 * on the room id, so every op is Redis-Cluster-safe.
 */

/** Ring buffer of recent messages (LPUSH + LTRIM) — read hot path. */
export function videoRoomChatRecentKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:recent`;
}

/** Active pinned message ids. */
export function videoRoomChatPinsKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:pins`;
}

/** Cached announcement payload. */
export function videoRoomChatAnnouncementsKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:announcements`;
}

/** Typing roster: ZSET of userId → expiry epoch ms. */
export function videoRoomChatTypingKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:typing`;
}

export function videoRoomChatRateKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:rate:${userId}`;
}

export function videoRoomChatSlowKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:slow:${userId}`;
}

export function videoRoomChatFloodKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:flood:${userId}`;
}

export function videoRoomChatDedupKey(roomId: string, userId: string, hash: string): string {
  return `video-room:{${roomId}}:chat:dedup:${userId}:${hash}`;
}

/** Active cooldown; presence blocks sending. */
export function videoRoomChatCooldownKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:cd:${userId}`;
}

/** Rolling violation counter driving the escalating cooldown ladder. */
export function videoRoomChatViolationKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:viol:${userId}`;
}

/** Write-through read cursor (throttles the Postgres upsert). */
export function videoRoomChatCursorKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:cursor:${userId}`;
}

/** Per-room lock serialising pin/unpin so the pin cap cannot be raced. */
export function videoRoomChatPinLockKey(roomId: string): string {
  return `video-room:chat:pin:{${roomId}}`;
}

// ---- Fixed bounds (mirrored by the DTOs) ----

/** Emoji-only messages get a tighter bound than the configurable text max. */
export const VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH = 64;
/** Hard ceiling on a search term. */
export const VIDEO_ROOM_CHAT_SEARCH_TERM_MAX = 100;
/** Matches `@username` (3–30 ASCII word chars). */
export const VIDEO_ROOM_CHAT_MENTION_RE = /@([a-zA-Z0-9_]{3,30})/g;
/** Group-mention tokens resolved to role sets rather than a single user. */
export const VIDEO_ROOM_CHAT_GROUP_MENTIONS = ['owner', 'admins'] as const;
```

- [ ] **Step 7: Append the 15 outbound socket event names**

In `src/modules/video-rooms/constants/video-room.constants.ts`, inside `VIDEO_ROOM_SOCKET_EVENTS`, append before the closing `} as const;`:

```typescript
  // ---- VR-9 chat (client-facing) ----
  CHAT_MESSAGE_SENT: 'video_room.chat_message_sent',
  CHAT_MESSAGE_EDITED: 'video_room.chat_message_edited',
  CHAT_MESSAGE_DELETED: 'video_room.chat_message_deleted',
  CHAT_MESSAGE_RECALLED: 'video_room.chat_message_recalled',
  CHAT_MESSAGE_PINNED: 'video_room.chat_message_pinned',
  CHAT_MESSAGE_UNPINNED: 'video_room.chat_message_unpinned',
  CHAT_ANNOUNCEMENT_CREATED: 'video_room.chat_announcement_created',
  CHAT_ANNOUNCEMENT_UPDATED: 'video_room.chat_announcement_updated',
  CHAT_ANNOUNCEMENT_DELETED: 'video_room.chat_announcement_deleted',
  CHAT_TYPING_STARTED: 'video_room.chat_typing_started',
  CHAT_TYPING_STOPPED: 'video_room.chat_typing_stopped',
  CHAT_MESSAGE_DELIVERED: 'video_room.chat_message_delivered',
  CHAT_MESSAGE_READ: 'video_room.chat_message_read',
  /** Point-to-point: the mentioned user's own notice. */
  CHAT_MENTIONED: 'video_room.chat_mentioned',
  /** Emitted from the VR-2 settings path when chat policy moves. */
  CHAT_MODE_CHANGED: 'video_room.chat_mode_changed',
```

Also add the four inbound event names used by the gateway (Task 20):

```typescript
/** Inbound (client → server) chat events served by VideoRoomChatGateway. */
export const VIDEO_ROOM_CHAT_INBOUND_EVENTS = {
  TYPING_START: 'video_room.typing_start',
  TYPING_STOP: 'video_room.typing_stop',
  MESSAGE_DELIVERED: 'video_room.message_delivered',
  MESSAGE_READ: 'video_room.message_read',
} as const;
```

- [ ] **Step 8: Verify compile, lint and full suite**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: no errors; 1194 passing (1192 + 2 new).

- [ ] **Step 9: Commit**

```bash
git add src/modules/video-rooms/constants/video-room-chat.constants.ts \
        src/modules/video-rooms/constants/video-room.constants.ts \
        src/modules/video-rooms/config/video-room-chat.config.ts \
        src/modules/video-rooms/config/video-room-chat.config.spec.ts \
        src/config/configuration.ts
git commit -m "feat(video-rooms): VR-9 chat constants, Redis keys and config namespace"
```

---

### Task 3: Chat domain events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-chat.events.ts`
- Create: `src/modules/video-rooms/events/video-room-chat.events.spec.ts`
- Modify: `src/modules/video-rooms/events/index.ts`

**Interfaces:**
- Consumes: `DomainEvent` from `src/common/events`.
- Produces: `VIDEO_ROOM_CHAT_EVENTS` (14 names) and 14 event classes. `ChatMessagePayload` is the shared message shape every message event carries.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/events/video-room-chat.events.spec.ts`:

```typescript
import {
  ChatMessageSentEvent,
  ChatTypingStartedEvent,
  VIDEO_ROOM_CHAT_EVENTS,
} from './video-room-chat.events';

describe('video-room chat events', () => {
  it('carries a stable dot-namespaced name and the payload', () => {
    const event = new ChatMessageSentEvent({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'u1',
      type: 'TEXT',
      content: 'hi',
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: '2026-07-21T00:00:00.000Z',
    });

    expect(event.name).toBe(VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT);
    expect(event.name).toBe('video_room.chat_message_sent');
    expect(event.payload.messageId).toBe('m1');
    expect(event.eventId).toEqual(expect.any(String));
  });

  it('exposes all 14 event names', () => {
    expect(Object.keys(VIDEO_ROOM_CHAT_EVENTS)).toHaveLength(14);
  });

  it('typing events carry the room and user', () => {
    const event = new ChatTypingStartedEvent({ roomId: 'r1', userId: 'u1' });
    expect(event.name).toBe('video_room.chat_typing_started');
    expect(event.payload.userId).toBe('u1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room-chat.events.spec.ts`
Expected: FAIL — `Cannot find module './video-room-chat.events'`

- [ ] **Step 3: Implement the events**

Create `src/modules/video-rooms/events/video-room-chat.events.ts`:

```typescript
import { DomainEvent } from 'src/common/events';

/**
 * VR-9 chat domain events on the EVENT_BUS. `VideoRoomChatSocketListener` bridges
 * these to `video_room.chat_*` broadcasts; the metrics and audit listeners
 * subscribe to the same names. Downstream domains may subscribe without importing
 * this module. Chat services never touch sockets, Prometheus or the audit store
 * directly — they publish here.
 */
export const VIDEO_ROOM_CHAT_EVENTS = {
  MESSAGE_SENT: 'video_room.chat_message_sent',
  MESSAGE_EDITED: 'video_room.chat_message_edited',
  MESSAGE_DELETED: 'video_room.chat_message_deleted',
  MESSAGE_RECALLED: 'video_room.chat_message_recalled',
  MESSAGE_PINNED: 'video_room.chat_message_pinned',
  MESSAGE_UNPINNED: 'video_room.chat_message_unpinned',
  ANNOUNCEMENT_CREATED: 'video_room.chat_announcement_created',
  ANNOUNCEMENT_UPDATED: 'video_room.chat_announcement_updated',
  ANNOUNCEMENT_DELETED: 'video_room.chat_announcement_deleted',
  TYPING_STARTED: 'video_room.chat_typing_started',
  TYPING_STOPPED: 'video_room.chat_typing_stopped',
  MESSAGE_DELIVERED: 'video_room.chat_message_delivered',
  MESSAGE_READ: 'video_room.chat_message_read',
  MENTIONED: 'video_room.chat_mentioned',
} as const;

/** The wire shape of a message, shared by every message-carrying event. */
export interface ChatMessagePayload {
  roomId: string;
  messageId: string;
  senderId: string;
  type: string;
  content: string;
  mentions: string[];
  mentionScope: string | null;
  replyToId: string | null;
  createdAt: string;
  /** Present only on ANNOUNCEMENT projections. */
  announcementId?: string;
  /** Present only on SYSTEM rows — the domain event that produced it. */
  systemEvent?: string;
}

/** Per-request audit context threaded from the controller onto every event. */
export interface ChatAuditContext {
  ip?: string;
  requestId?: string;
  userAgent?: string;
}

export class ChatMessageSentEvent extends DomainEvent<
  ChatMessagePayload & { audit?: ChatAuditContext }
> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT;
}

export class ChatMessageEditedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  editorId: string;
  content: string;
  editedAt: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_EDITED;
}

export class ChatMessageDeletedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  deletedBy: string;
  /** True when a moderator deleted someone else's message. */
  byModerator: boolean;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED;
}

export class ChatMessageRecalledEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  senderId: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_RECALLED;
}

export class ChatMessagePinnedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  pinnedBy: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED;
}

export class ChatMessageUnpinnedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  unpinnedBy: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED;
}

export class ChatAnnouncementCreatedEvent extends DomainEvent<{
  roomId: string;
  announcementId: string;
  messageId: string;
  authorId: string;
  content: string;
  isPinned: boolean;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED;
}

export class ChatAnnouncementUpdatedEvent extends DomainEvent<{
  roomId: string;
  announcementId: string;
  messageId: string | null;
  actorId: string;
  content: string;
  isPinned: boolean;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED;
}

export class ChatAnnouncementDeletedEvent extends DomainEvent<{
  roomId: string;
  announcementId: string;
  messageId: string | null;
  actorId: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED;
}

export class ChatTypingStartedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED;
}

export class ChatTypingStoppedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED;
}

export class ChatMessageDeliveredEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  messageId: string;
  at: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELIVERED;
}

export class ChatMessageReadEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  messageId: string;
  at: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ;
}

export class ChatMentionedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  senderId: string;
  recipientIds: string[];
  scope: string | null;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MENTIONED;
}
```

- [ ] **Step 4: Export from the events barrel**

In `src/modules/video-rooms/events/index.ts`, add:

```typescript
export * from './video-room-chat.events';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room-chat.events.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: no errors; 1197 passing.

```bash
git add src/modules/video-rooms/events/
git commit -m "feat(video-rooms): VR-9 chat domain events"
```

---

### Task 4: Chat repository

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-chat.repository.ts`
- Create: `src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`
- Modify: `src/modules/video-rooms/repositories/index.ts`

**Interfaces:**
- Consumes: Task 1's Prisma models; `PrismaService` from `src/infra/prisma/prisma.service`.
- Produces: `VideoRoomChatRepository` with the exact methods below. Later tasks call **only** these — no service touches Prisma.

```typescript
createMessage(input: CreateMessageInput): Promise<VideoRoomMessage>
findMessage(id: string): Promise<VideoRoomMessage | null>
listMessages(roomId: string, opts: ListMessagesOptions): Promise<[VideoRoomMessage[], number]>
listMessagesByIds(ids: string[]): Promise<VideoRoomMessage[]>
searchMessages(roomId: string, opts: SearchMessagesOptions): Promise<[VideoRoomMessage[], number]>
editMessage(id: string, content: string): Promise<VideoRoomMessage>
softDeleteMessage(id: string, byUserId: string): Promise<void>
recallMessage(id: string): Promise<void>
createPin(input: {roomId,messageId,pinnedBy}): Promise<VideoRoomMessagePin>
findActivePin(roomId: string, messageId: string): Promise<VideoRoomMessagePin | null>
listActivePins(roomId: string): Promise<VideoRoomMessagePin[]>
countActivePins(roomId: string): Promise<number>
deactivatePin(id: string, unpinnedBy: string): Promise<void>
upsertCursor(input: UpsertCursorInput): Promise<void>
findCursor(roomId: string, userId: string): Promise<VideoRoomChatCursor | null>
listReaders(roomId: string, since: Date): Promise<VideoRoomChatCursor[]>
countUnread(roomId: string, since: Date | null): Promise<number>
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`:

```typescript
import { VideoRoomMessageType } from '@prisma/client';
import { VideoRoomChatRepository } from './video-room-chat.repository';

describe('VideoRoomChatRepository', () => {
  let prisma: {
    videoRoomMessage: Record<string, jest.Mock>;
    videoRoomMessagePin: Record<string, jest.Mock>;
    videoRoomChatCursor: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let repo: VideoRoomChatRepository;

  beforeEach(() => {
    prisma = {
      videoRoomMessage: {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
      },
      videoRoomMessagePin: {
        create: jest.fn().mockResolvedValue({ id: 'p1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      videoRoomChatCursor: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = new VideoRoomChatRepository(prisma as never);
  });

  it('creates a message with normalised nullable fields', async () => {
    await repo.createMessage({
      roomId: 'r1',
      senderId: 'u1',
      type: VideoRoomMessageType.TEXT,
      content: 'hello',
      mentions: ['u2'],
    });

    expect(prisma.videoRoomMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        roomId: 'r1',
        content: 'hello',
        mentions: ['u2'],
        mentionScope: null,
        replyToId: null,
        forwardedFromId: null,
      }),
    });
  });

  it('hides deleted and recalled rows from non-moderators', async () => {
    await repo.listMessages('r1', { skip: 0, take: 20, includeDeleted: false });

    const where = prisma.$transaction.mock.calls[0][0];
    expect(prisma.videoRoomMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roomId: 'r1', deletedAt: null, recalledAt: null }),
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(where).toBeDefined();
  });

  it('recalled rows stay hidden even for moderators', async () => {
    // Delete is moderator-visible; recall is the sender's unsend and is
    // withheld from EVERYONE, including moderators.
    await repo.listMessages('r1', { skip: 0, take: 20, includeDeleted: true });

    expect(prisma.videoRoomMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roomId: 'r1', recalledAt: null }),
      }),
    );
    expect(prisma.videoRoomMessage.findMany.mock.calls[0][0].where.deletedAt).toBeUndefined();
  });

  it('uses keyset pagination when a before-cursor is supplied', async () => {
    prisma.videoRoomMessage.findUnique.mockResolvedValue({ createdAt: new Date('2026-07-21') });

    await repo.listMessages('r1', { skip: 0, take: 20, includeDeleted: false, before: 'm9' });

    const call = prisma.videoRoomMessage.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ lt: new Date('2026-07-21') });
    // Keyset and offset are mutually exclusive — skip must not be applied.
    expect(call.skip).toBeUndefined();
  });

  it('advances a cursor via upsert', async () => {
    const at = new Date('2026-07-21T10:00:00Z');
    await repo.upsertCursor({ roomId: 'r1', userId: 'u1', readMessageId: 'm5', readAt: at });

    expect(prisma.videoRoomChatCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId_userId: { roomId: 'r1', userId: 'u1' } },
        create: expect.objectContaining({ lastReadMessageId: 'm5', lastReadAt: at }),
        update: expect.objectContaining({ lastReadMessageId: 'm5', lastReadAt: at }),
      }),
    );
  });

  it('lists readers as cursors at or past a message timestamp', async () => {
    const since = new Date('2026-07-21T10:00:00Z');
    await repo.listReaders('r1', since);

    expect(prisma.videoRoomChatCursor.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', lastReadAt: { gte: since } },
    });
  });

  it('deactivates a pin rather than deleting it', async () => {
    await repo.deactivatePin('p1', 'u1');

    expect(prisma.videoRoomMessagePin.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ isActive: false, unpinnedBy: 'u1' }),
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`
Expected: FAIL — `Cannot find module './video-room-chat.repository'`

- [ ] **Step 3: Implement the repository**

Create `src/modules/video-rooms/repositories/video-room-chat.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomChatCursor,
  VideoRoomMessage,
  VideoRoomMessagePin,
  VideoRoomMessageType,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateMessageInput {
  roomId: string;
  senderId: string;
  type: VideoRoomMessageType;
  content: string;
  mentions: string[];
  mentionScope?: string | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  attachments?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}

export interface ListMessagesOptions {
  skip: number;
  take: number;
  /** Keyset cursor — only messages older than this id. Suppresses `skip`. */
  before?: string;
  /** Moderators see soft-deleted rows. Recalled rows are hidden from everyone. */
  includeDeleted: boolean;
  order?: 'asc' | 'desc';
}

export interface SearchMessagesOptions {
  skip: number;
  take: number;
  term?: string;
  senderId?: string;
  type?: VideoRoomMessageType;
  from?: Date;
  to?: Date;
}

export interface UpsertCursorInput {
  roomId: string;
  userId: string;
  readMessageId?: string;
  readAt?: Date;
  deliveredMessageId?: string;
  deliveredAt?: Date;
}

/**
 * Data layer for VR-9 chat: `video_room_messages`, `video_room_message_pins` and
 * `video_room_chat_cursors`. Pure persistence — every policy decision, rate check
 * and Redis interaction lives in the services. No service may touch Prisma
 * directly.
 *
 * Visibility rule encoded here once: soft-DELETED rows are visible to moderators
 * (that is what makes moderation auditable), but RECALLED rows are hidden from
 * everyone — recall is the sender's "unsend", so surfacing it to moderators would
 * defeat the feature.
 */
@Injectable()
export class VideoRoomChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Messages ----

  createMessage(input: CreateMessageInput): Promise<VideoRoomMessage> {
    return this.prisma.videoRoomMessage.create({
      data: {
        roomId: input.roomId,
        senderId: input.senderId,
        type: input.type,
        content: input.content,
        mentions: input.mentions,
        mentionScope: input.mentionScope ?? null,
        replyToId: input.replyToId ?? null,
        forwardedFromId: input.forwardedFromId ?? null,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  }

  findMessage(id: string): Promise<VideoRoomMessage | null> {
    return this.prisma.videoRoomMessage.findUnique({ where: { id } });
  }

  listMessagesByIds(ids: string[]): Promise<VideoRoomMessage[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.videoRoomMessage.findMany({ where: { id: { in: ids } } });
  }

  async listMessages(
    roomId: string,
    opts: ListMessagesOptions,
  ): Promise<[VideoRoomMessage[], number]> {
    const where: Prisma.VideoRoomMessageWhereInput = {
      roomId,
      recalledAt: null,
      ...(opts.includeDeleted ? {} : { deletedAt: null }),
    };

    if (opts.before) {
      const cursor = await this.prisma.videoRoomMessage.findUnique({
        where: { id: opts.before },
        select: { createdAt: true },
      });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    }

    return this.prisma.$transaction([
      this.prisma.videoRoomMessage.findMany({
        where,
        take: opts.take,
        ...(opts.before ? {} : { skip: opts.skip }),
        orderBy: { createdAt: opts.order ?? 'desc' },
      }),
      this.prisma.videoRoomMessage.count({ where }),
    ]);
  }

  searchMessages(
    roomId: string,
    opts: SearchMessagesOptions,
  ): Promise<[VideoRoomMessage[], number]> {
    const where: Prisma.VideoRoomMessageWhereInput = {
      roomId,
      deletedAt: null,
      recalledAt: null,
      ...(opts.term ? { content: { contains: opts.term, mode: 'insensitive' } } : {}),
      ...(opts.senderId ? { senderId: opts.senderId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.from || opts.to
        ? {
            createdAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.videoRoomMessage.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomMessage.count({ where }),
    ]);
  }

  editMessage(id: string, content: string): Promise<VideoRoomMessage> {
    return this.prisma.videoRoomMessage.update({
      where: { id },
      data: { content, editedAt: new Date(), editCount: { increment: 1 } },
    });
  }

  async softDeleteMessage(id: string, byUserId: string): Promise<void> {
    await this.prisma.videoRoomMessage.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: byUserId },
    });
  }

  async recallMessage(id: string): Promise<void> {
    await this.prisma.videoRoomMessage.update({
      where: { id },
      data: { recalledAt: new Date() },
    });
  }

  // ---- Pins ----

  createPin(input: {
    roomId: string;
    messageId: string;
    pinnedBy: string;
  }): Promise<VideoRoomMessagePin> {
    return this.prisma.videoRoomMessagePin.create({ data: input });
  }

  findActivePin(roomId: string, messageId: string): Promise<VideoRoomMessagePin | null> {
    return this.prisma.videoRoomMessagePin.findFirst({
      where: { roomId, messageId, isActive: true },
    });
  }

  listActivePins(roomId: string): Promise<VideoRoomMessagePin[]> {
    return this.prisma.videoRoomMessagePin.findMany({
      where: { roomId, isActive: true },
      orderBy: { pinnedAt: 'desc' },
    });
  }

  countActivePins(roomId: string): Promise<number> {
    return this.prisma.videoRoomMessagePin.count({ where: { roomId, isActive: true } });
  }

  async deactivatePin(id: string, unpinnedBy: string): Promise<void> {
    await this.prisma.videoRoomMessagePin.update({
      where: { id },
      data: { isActive: false, unpinnedBy, unpinnedAt: new Date() },
    });
  }

  // ---- Read cursors ----

  async upsertCursor(input: UpsertCursorInput): Promise<void> {
    const fields = {
      ...(input.readMessageId ? { lastReadMessageId: input.readMessageId } : {}),
      ...(input.readAt ? { lastReadAt: input.readAt } : {}),
      ...(input.deliveredMessageId ? { lastDeliveredMessageId: input.deliveredMessageId } : {}),
      ...(input.deliveredAt ? { lastDeliveredAt: input.deliveredAt } : {}),
    };
    await this.prisma.videoRoomChatCursor.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: { roomId: input.roomId, userId: input.userId, ...fields },
      update: fields,
    });
  }

  findCursor(roomId: string, userId: string): Promise<VideoRoomChatCursor | null> {
    return this.prisma.videoRoomChatCursor.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  /** Cursors at or past `since` — the derived reader list for a message. */
  listReaders(roomId: string, since: Date): Promise<VideoRoomChatCursor[]> {
    return this.prisma.videoRoomChatCursor.findMany({
      where: { roomId, lastReadAt: { gte: since } },
    });
  }

  /** Visible messages newer than a user's read mark. `null` ⇒ everything. */
  countUnread(roomId: string, since: Date | null): Promise<number> {
    return this.prisma.videoRoomMessage.count({
      where: {
        roomId,
        deletedAt: null,
        recalledAt: null,
        ...(since ? { createdAt: { gt: since } } : {}),
      },
    });
  }
}
```

- [ ] **Step 4: Export from the repositories barrel**

In `src/modules/video-rooms/repositories/index.ts`, add:

```typescript
export * from './video-room-chat.repository';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: no errors; 1204 passing.

```bash
git add src/modules/video-rooms/repositories/
git commit -m "feat(video-rooms): VR-9 chat repository (messages, pins, cursors)"
```

---

### Task 5: Extract the blocked-word engine to shared infrastructure

**The single riskiest task in the plan.** It touches shipped AR-4 code. The acceptance gate is that AR-4's existing specs pass with **zero edits to their assertions**.

**Files:**
- Create: `src/infra/content-moderation/blocked-word.repository.ts`
- Create: `src/infra/content-moderation/blocked-word.service.ts` (moved)
- Create: `src/infra/content-moderation/blocked-word.service.spec.ts` (moved)
- Create: `src/infra/content-moderation/blocked-word.seeder.service.ts` (moved)
- Create: `src/infra/content-moderation/content-moderation.constants.ts`
- Create: `src/infra/content-moderation/content-moderation.module.ts`
- Create: `src/infra/content-moderation/index.ts`
- Delete: `src/modules/audio-rooms/services/blocked-word.service.ts`, `blocked-word.service.spec.ts`, `chat-blocked-word.seeder.service.ts`
- Modify: `src/modules/audio-rooms/services/chat.service.ts` (import path only)
- Modify: `src/modules/audio-rooms/audio-rooms.module.ts` (drop the two providers)
- Modify: `src/modules/audio-rooms/services/index.ts`
- Modify: `src/app.module.ts` (register `ContentModerationModule`)

**Interfaces:**
- Consumes: `PrismaService`; `ChatBlockedWord` / `BlockedWordSeverity` / `BlockedWordAction` from `@prisma/client`.
- Produces: `BlockedWordService` with `scan(text: string): BlockedWordScan` and `invalidate(): Promise<void>`; `BlockedWordRepository` with `listEnabledWords()`, `listWords()`, `getWord()`, `findWord()`, `createWord()`, `updateWord()`, `deleteWord()`, `upsertSeedWord()`. `BlockedWordScan` keeps its exact existing shape: `{ matched, severity?, action?, matches, maskedText }`.

- [ ] **Step 1: Read the three files being moved, verbatim**

Run:
```bash
cat src/modules/audio-rooms/services/blocked-word.service.ts
cat src/modules/audio-rooms/services/chat-blocked-word.seeder.service.ts
grep -n "CHAT_MASK_TOKEN" src/modules/audio-rooms/constants/chat.constants.ts
```
Read the output fully before editing anything. **The logic is not being rewritten** — only its dependency on `ChatRepository` changes.

- [ ] **Step 2: Create the constants file**

Create `src/infra/content-moderation/content-moderation.constants.ts`:

```typescript
/** Replacement token substituted for a MILD blocked term. */
export const CHAT_MASK_TOKEN = '***';
```

Verify the value matches the existing one:

Run: `grep -n "CHAT_MASK_TOKEN" src/modules/audio-rooms/constants/chat.constants.ts`
If the shipped value differs from `'***'`, use the shipped value — this must not change behaviour.

- [ ] **Step 3: Create the repository (the dependency that had to change)**

`infra` must not import from `modules`, so the engine reads Prisma directly instead of through the audio-room `ChatRepository`.

Create `src/infra/content-moderation/blocked-word.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import {
  BlockedWordAction,
  BlockedWordSeverity,
  ChatBlockedWord,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Persistence for the platform-wide `chat_blocked_words` dictionary. The table
 * is global — it has no room or room-type scoping — which is why the engine
 * lives in infra rather than being owned by one room domain.
 */
@Injectable()
export class BlockedWordRepository {
  constructor(private readonly prisma: PrismaService) {}

  listEnabledWords(): Promise<ChatBlockedWord[]> {
    return this.prisma.chatBlockedWord.findMany({ where: { enabled: true } });
  }

  listWords(
    skip: number,
    take: number,
    filter: { language?: string; enabled?: boolean },
  ): Promise<[ChatBlockedWord[], number]> {
    const where: Prisma.ChatBlockedWordWhereInput = {
      ...(filter.language ? { language: filter.language } : {}),
      ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.chatBlockedWord.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.chatBlockedWord.count({ where }),
    ]);
  }

  getWord(id: string): Promise<ChatBlockedWord | null> {
    return this.prisma.chatBlockedWord.findUnique({ where: { id } });
  }

  findWord(pattern: string, language: string): Promise<ChatBlockedWord | null> {
    return this.prisma.chatBlockedWord.findFirst({ where: { pattern, language } });
  }

  createWord(
    input: {
      pattern: string;
      isRegex: boolean;
      language: string;
      severity: BlockedWordSeverity;
      action: BlockedWordAction;
      enabled: boolean;
      notes: string | null;
    },
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.prisma.chatBlockedWord.create({
      data: { ...input, createdBy: actorId, updatedBy: actorId },
    });
  }

  updateWord(
    id: string,
    data: Prisma.ChatBlockedWordUpdateInput,
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.prisma.chatBlockedWord.update({
      where: { id },
      data: { ...data, updatedBy: actorId },
    });
  }

  async deleteWord(id: string): Promise<void> {
    await this.prisma.chatBlockedWord.delete({ where: { id } });
  }

  /** Idempotent seed helper: create a default word only if the pattern is new. */
  async upsertSeedWord(input: {
    pattern: string;
    isRegex: boolean;
    language: string;
    severity: BlockedWordSeverity;
    action: BlockedWordAction;
  }): Promise<boolean> {
    const existing = await this.prisma.chatBlockedWord.findFirst({
      where: { pattern: input.pattern, language: input.language },
      select: { id: true },
    });
    if (existing) return false;
    await this.prisma.chatBlockedWord.create({
      data: { ...input, enabled: true, notes: 'seed' },
    });
    return true;
  }
}
```

- [ ] **Step 4: Move the engine, changing only its imports and injected dependency**

Copy `src/modules/audio-rooms/services/blocked-word.service.ts` to `src/infra/content-moderation/blocked-word.service.ts` verbatim, then apply exactly these three changes:

1. Replace `import { CHAT_MASK_TOKEN } from '../constants/chat.constants';` with `import { CHAT_MASK_TOKEN } from './content-moderation.constants';`
2. Replace `import { ChatRepository } from '../repositories/chat.repository';` with `import { BlockedWordRepository } from './blocked-word.repository';`
3. In the constructor, replace the `ChatRepository` parameter with `BlockedWordRepository`:

```typescript
  constructor(
    private readonly words: BlockedWordRepository,
    private readonly config: ConfigService,
  ) {}
```

and update the single call site from `this.chatRepo.listEnabledWords()` to `this.words.listEnabledWords()`.

**Change nothing else.** Not the scan algorithm, not `SEVERITY_RANK`, not the `BlockedWordScan` shape, not the cache refresh timing.

- [ ] **Step 5: Move the seeder the same way**

Copy `src/modules/audio-rooms/services/chat-blocked-word.seeder.service.ts` to `src/infra/content-moderation/blocked-word.seeder.service.ts`, replacing its `ChatRepository` import and constructor parameter with `BlockedWordRepository` and its `invalidate` target with the moved `BlockedWordService`. Logic unchanged.

- [ ] **Step 6: Move the spec and repoint its imports only**

Copy `src/modules/audio-rooms/services/blocked-word.service.spec.ts` to `src/infra/content-moderation/blocked-word.service.spec.ts`. Change **only** the import path of the service under test and the mock's name (`chatRepo` → `words`). **Do not change a single assertion** — the assertions are the proof the move was behaviour-preserving.

- [ ] **Step 7: Create the module and barrel**

Create `src/infra/content-moderation/content-moderation.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { BlockedWordRepository } from './blocked-word.repository';
import { BlockedWordSeederService } from './blocked-word.seeder.service';
import { BlockedWordService } from './blocked-word.service';

/**
 * Platform-wide content moderation. The `chat_blocked_words` dictionary is global
 * — no room or room-type scoping — so the engine belongs here rather than being
 * owned by one room domain. Audio Rooms (AR-4) and Video Rooms (VR-9) both
 * consume it; neither owns it, and no cross-module dependency edge is created.
 */
@Global()
@Module({
  providers: [BlockedWordRepository, BlockedWordService, BlockedWordSeederService],
  exports: [BlockedWordRepository, BlockedWordService],
})
export class ContentModerationModule {}
```

Create `src/infra/content-moderation/index.ts`:

```typescript
export * from './blocked-word.repository';
export * from './blocked-word.service';
export * from './content-moderation.constants';
export * from './content-moderation.module';
```

- [ ] **Step 8: Rewire audio-rooms and register the module**

1. In `src/app.module.ts`, add `ContentModerationModule` to the `imports` array.
2. In `src/modules/audio-rooms/audio-rooms.module.ts`, remove `BlockedWordService` and `ChatBlockedWordSeederService` from `providers` and delete their imports (the `@Global` `ContentModerationModule` now supplies them).
3. In `src/modules/audio-rooms/services/chat.service.ts`, change the `BlockedWordService` import to `import { BlockedWordService } from 'src/infra/content-moderation';`. The constructor parameter and every `this.blockedWords.*` call site stay identical.
4. In `src/modules/audio-rooms/services/index.ts`, remove the two deleted exports.
5. Delete the three original files.
6. If `src/modules/audio-rooms/controllers/chat-admin.controller.ts` or `ChatRepository`'s word methods are still referenced, repoint them at `BlockedWordRepository`; delete the now-dead word methods from `src/modules/audio-rooms/repositories/chat.repository.ts`.

- [ ] **Step 9: Run the AR-4 regression gate — the acceptance criterion**

Run:
```bash
npx jest src/modules/audio-rooms/services/chat.service.spec.ts \
         src/infra/content-moderation/blocked-word.service.spec.ts --verbose
```
Expected: **all tests PASS with no assertion edits.** If any assertion had to change to make this pass, revert and redo the move — the behaviour drifted.

- [ ] **Step 10: Verify boundaries, types and full suite**

Run: `pnpm boundaries && npx tsc --noEmit && pnpm lint && pnpm test`
Expected: boundaries green (no `infra → modules` edge introduced); no type errors; 1204 passing.

- [ ] **Step 11: Commit**

```bash
git add src/infra/content-moderation/ src/modules/audio-rooms/ src/app.module.ts
git commit -m "refactor(infra): extract blocked-word engine to shared content-moderation module

The chat_blocked_words dictionary is global, so the engine was never
audio-room-owned. Moving it to infra lets VR-9 reuse it without creating a
video-rooms -> audio-rooms dependency edge. AR-4 behaviour is unchanged: its
specs pass with zero assertion edits."
```

---

### Task 6: Chat cache service (Redis read model)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat-cache.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat-cache.service.spec.ts`

**Interfaces:**
- Consumes: Task 2's key builders and `VideoRoomChatConfig`; `REDIS_CLIENT` / `RedisClient` from `src/infra/redis/redis.constants`; `ChatMessagePayload` from Task 3.
- Produces: `VideoRoomChatCacheService` with:
```typescript
pushRecent(roomId: string, message: ChatMessagePayload): Promise<void>
readRecent(roomId: string, limit: number): Promise<ChatMessagePayload[]>
invalidateRecent(roomId: string): Promise<void>
setPins(roomId: string, messageIds: string[]): Promise<void>
readPins(roomId: string): Promise<string[] | null>
markTyping(roomId: string, userId: string, ttlSeconds: number): Promise<void>
clearTyping(roomId: string, userId: string): Promise<void>
readTyping(roomId: string, nowMs: number): Promise<string[]>
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-chat-cache.service.spec.ts`:

```typescript
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';

const CFG = { recentBufferSize: 3, recentBufferTtlSeconds: 3600 };

function message(id: string) {
  return {
    roomId: 'r1',
    messageId: id,
    senderId: 'u1',
    type: 'TEXT',
    content: 'hi',
    mentions: [],
    mentionScope: null,
    replyToId: null,
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('VideoRoomChatCacheService', () => {
  let redis: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let service: VideoRoomChatCacheService;

  beforeEach(() => {
    redis = {
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      expire: jest.fn().mockResolvedValue(1),
      lrange: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      zadd: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
    };
    config = { get: jest.fn().mockReturnValue(CFG) };
    service = new VideoRoomChatCacheService(redis as never, config as never);
  });

  it('trims the ring buffer to the configured size', async () => {
    await service.pushRecent('r1', message('m1'));

    expect(redis.lpush).toHaveBeenCalledWith(
      'video-room:{r1}:chat:recent',
      JSON.stringify(message('m1')),
    );
    // LTRIM keeps indices 0..size-1 — a 3-message buffer keeps 0..2.
    expect(redis.ltrim).toHaveBeenCalledWith('video-room:{r1}:chat:recent', 0, 2);
    expect(redis.expire).toHaveBeenCalledWith('video-room:{r1}:chat:recent', 3600);
  });

  it('reads the buffer back as parsed payloads', async () => {
    redis.lrange.mockResolvedValue([JSON.stringify(message('m1'))]);

    const result = await service.readRecent('r1', 10);

    expect(redis.lrange).toHaveBeenCalledWith('video-room:{r1}:chat:recent', 0, 9);
    expect(result).toEqual([message('m1')]);
  });

  it('survives a corrupt buffer entry instead of throwing', async () => {
    // A poisoned cache entry must never take down the read path — the
    // buffer is a cache, and Postgres remains the source of truth.
    redis.lrange.mockResolvedValue(['not-json', JSON.stringify(message('m2'))]);

    const result = await service.readRecent('r1', 10);

    expect(result).toEqual([message('m2')]);
  });

  it('records a typing user with an absolute expiry score', async () => {
    await service.markTyping('r1', 'u1', 5);

    expect(redis.zadd).toHaveBeenCalledWith(
      'video-room:{r1}:chat:typing',
      expect.any(Number),
      'u1',
    );
    const score = redis.zadd.mock.calls[0][1];
    expect(score).toBeGreaterThan(Date.now());
  });

  it('drops expired typers when reading the roster', async () => {
    const now = 1_000_000;
    redis.zrangebyscore.mockResolvedValue(['u1']);

    const result = await service.readTyping('r1', now);

    expect(redis.zremrangebyscore).toHaveBeenCalledWith(
      'video-room:{r1}:chat:typing',
      '-inf',
      now,
    );
    expect(redis.zrangebyscore).toHaveBeenCalledWith(
      'video-room:{r1}:chat:typing',
      now,
      '+inf',
    );
    expect(result).toEqual(['u1']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-cache.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cache service**

Create `src/modules/video-rooms/services/video-room-chat-cache.service.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  videoRoomChatPinsKey,
  videoRoomChatRecentKey,
  videoRoomChatTypingKey,
} from '../constants/video-room-chat.constants';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import type { ChatMessagePayload } from '../events/video-room-chat.events';

/**
 * The Redis read model for VR-9 chat: a per-room ring buffer of recent messages,
 * the active pin set, and the typing roster. This is a CACHE, never a source of
 * truth — Postgres holds the durable record, so losing Redis costs a rebuild and
 * never data. Every key is single-key and `{roomId}`-hash-tagged, so every
 * operation is Redis-Cluster-safe.
 *
 * The ring buffer is what keeps 10k viewers joining a live room off Postgres:
 * they all request the same page 1, and it is served from memory.
 */
@Injectable()
export class VideoRoomChatCacheService {
  private readonly logger = new Logger(VideoRoomChatCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  private cfg() {
    return loadVideoRoomChatConfig(this.config);
  }

  // ---- Recent-message ring buffer ----

  async pushRecent(roomId: string, message: ChatMessagePayload): Promise<void> {
    const { recentBufferSize, recentBufferTtlSeconds } = this.cfg();
    const key = videoRoomChatRecentKey(roomId);
    await this.redis.lpush(key, JSON.stringify(message));
    await this.redis.ltrim(key, 0, recentBufferSize - 1);
    await this.redis.expire(key, recentBufferTtlSeconds);
  }

  /**
   * Newest-first recent messages. A corrupt entry is skipped rather than thrown:
   * this is a cache, and poisoning it must not break the read path.
   */
  async readRecent(roomId: string, limit: number): Promise<ChatMessagePayload[]> {
    const raw = await this.redis.lrange(videoRoomChatRecentKey(roomId), 0, limit - 1);
    const out: ChatMessagePayload[] = [];
    for (const entry of raw) {
      try {
        out.push(JSON.parse(entry) as ChatMessagePayload);
      } catch {
        this.logger.warn(`Discarding corrupt chat cache entry in room ${roomId}`);
      }
    }
    return out;
  }

  async invalidateRecent(roomId: string): Promise<void> {
    await this.redis.del(videoRoomChatRecentKey(roomId));
  }

  // ---- Pin set ----

  async setPins(roomId: string, messageIds: string[]): Promise<void> {
    const key = videoRoomChatPinsKey(roomId);
    await this.redis.del(key);
    if (messageIds.length > 0) await this.redis.sadd(key, ...messageIds);
  }

  /** Active pin ids, or null when the set has never been populated. */
  async readPins(roomId: string): Promise<string[] | null> {
    const members = await this.redis.smembers(videoRoomChatPinsKey(roomId));
    return members.length > 0 ? members : null;
  }

  // ---- Typing roster ----

  /**
   * Score is the ABSOLUTE expiry instant, not a TTL, so a stale entry is
   * self-evident to any reader on any instance without a sweeper.
   */
  async markTyping(roomId: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.redis.zadd(videoRoomChatTypingKey(roomId), Date.now() + ttlSeconds * 1000, userId);
  }

  async clearTyping(roomId: string, userId: string): Promise<void> {
    await this.redis.zrem(videoRoomChatTypingKey(roomId), userId);
  }

  /** Currently-typing user ids, pruning anyone whose score has passed. */
  async readTyping(roomId: string, nowMs: number): Promise<string[]> {
    const key = videoRoomChatTypingKey(roomId);
    await this.redis.zremrangebyscore(key, '-inf', nowMs);
    return this.redis.zrangebyscore(key, nowMs, '+inf');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-cache.service.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1209 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat-cache.service.ts \
        src/modules/video-rooms/services/video-room-chat-cache.service.spec.ts
git commit -m "feat(video-rooms): VR-9 chat Redis read model (ring buffer, pins, typing)"
```

---

### Task 7: Rate limiter (rate · slow · flood · dedup · cooldown)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 keys + config; `CacheService`; `REDIS_CLIENT`.
- Produces: `VideoRoomChatRateLimiter` with `assertMaySend(roomId, userId, content, opts: { rateMax: number; slowModeSeconds: number }): Promise<void>` (throws `BusinessException`) and `applySlowMode(roomId, userId, seconds): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`:

```typescript
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatRateLimiter } from './video-room-chat-rate-limiter.service';

const CFG = {
  rateWindowSeconds: 60,
  dedupWindowSeconds: 30,
  floodBurstMax: 5,
  floodBurstWindowSeconds: 2,
  cooldownSteps: [10, 30, 120],
};

const OPTS = { rateMax: 20, slowModeSeconds: 0 };

describe('VideoRoomChatRateLimiter', () => {
  let cache: { increment: jest.Mock; exists: jest.Mock };
  let redis: { set: jest.Mock };
  let config: { get: jest.Mock };
  let limiter: VideoRoomChatRateLimiter;

  beforeEach(() => {
    cache = {
      increment: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(false),
    };
    redis = { set: jest.fn().mockResolvedValue('OK') };
    config = { get: jest.fn().mockReturnValue(CFG) };
    limiter = new VideoRoomChatRateLimiter(cache as never, redis as never, config as never);
  });

  it('allows a message inside every limit', async () => {
    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).resolves.toBeUndefined();
  });

  it('rejects when an active cooldown is present', async () => {
    cache.exists.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':cd:')),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_RATE_LIMITED,
    });
  });

  it('rejects when the per-minute rate cap is exceeded', async () => {
    cache.increment.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':rate:') ? 21 : 1),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_RATE_LIMITED,
    });
  });

  it('rejects while slow mode is active', async () => {
    cache.exists.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':slow:')),
    );

    await expect(
      limiter.assertMaySend('r1', 'u1', 'hello', { rateMax: 20, slowModeSeconds: 10 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.CHAT_SLOW_MODE });
  });

  it('rejects a burst and arms an escalating cooldown', async () => {
    cache.increment.mockImplementation((key: string) => {
      if (key.includes(':flood:')) return Promise.resolve(6);
      if (key.includes(':viol:')) return Promise.resolve(2);
      return Promise.resolve(1);
    });

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_RATE_LIMITED,
    });
    // Second violation → the second rung of the ladder (30s), not the first.
    expect(redis.set).toHaveBeenCalledWith(
      'video-room:{r1}:chat:cd:u1',
      '1',
      'EX',
      30,
    );
  });

  it('caps the cooldown ladder at its last rung', async () => {
    cache.increment.mockImplementation((key: string) => {
      if (key.includes(':flood:')) return Promise.resolve(6);
      if (key.includes(':viol:')) return Promise.resolve(99);
      return Promise.resolve(1);
    });

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
    expect(redis.set).toHaveBeenCalledWith('video-room:{r1}:chat:cd:u1', '1', 'EX', 120);
  });

  it('rejects a duplicate message inside the window', async () => {
    // SET NX returns null when the key already exists ⇒ duplicate.
    redis.set.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':dedup:') ? null : 'OK'),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.DUPLICATE_MESSAGE,
    });
  });

  it('hashes content case-insensitively so casing tricks still dedupe', async () => {
    await limiter.assertMaySend('r1', 'u1', 'Hello', OPTS);
    const firstKey = redis.set.mock.calls.find((c) => String(c[0]).includes(':dedup:'))![0];

    redis.set.mockClear();
    await limiter.assertMaySend('r1', 'u1', 'hello', OPTS);
    const secondKey = redis.set.mock.calls.find((c) => String(c[0]).includes(':dedup:'))![0];

    expect(firstKey).toBe(secondKey);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the limiter**

Create `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import {
  videoRoomChatCooldownKey,
  videoRoomChatDedupKey,
  videoRoomChatFloodKey,
  videoRoomChatRateKey,
  videoRoomChatSlowKey,
  videoRoomChatViolationKey,
} from '../constants/video-room-chat.constants';

export interface RateLimitOptions {
  rateMax: number;
  slowModeSeconds: number;
}

/**
 * VR-9 anti-abuse. Five Redis gates evaluated in a deliberate order —
 * cooldown → rate → slow mode → flood → duplicate — so the cheapest, most
 * decisive rejection happens first and a user already serving a cooldown never
 * burns further counters.
 *
 * Deliberately stops at a cooldown. AR-4's equivalent escalates to auto-mute and
 * auto-kick, but "Moderation Actions" is out of scope for VR-9: same detection,
 * no enforcement this phase is not scoped for.
 */
@Injectable()
export class VideoRoomChatRateLimiter {
  constructor(
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  async assertMaySend(
    roomId: string,
    userId: string,
    content: string,
    opts: RateLimitOptions,
  ): Promise<void> {
    const cfg = loadVideoRoomChatConfig(this.config);

    // 1. Serving a cooldown? Nothing else matters.
    if (await this.cache.exists(videoRoomChatCooldownKey(roomId, userId))) {
      throw this.tooFast('You are temporarily cooled down — please wait before sending again.');
    }

    // 2. Rolling per-minute cap.
    const rate = await this.cache.increment(videoRoomChatRateKey(roomId, userId), {
      ttlSeconds: cfg.rateWindowSeconds,
    });
    if (rate > opts.rateMax) {
      throw this.tooFast('You are sending messages too quickly.');
    }

    // 3. Room slow mode.
    if (
      opts.slowModeSeconds > 0 &&
      (await this.cache.exists(videoRoomChatSlowKey(roomId, userId)))
    ) {
      throw new BusinessException(
        ERROR_CODES.CHAT_SLOW_MODE,
        'Slow mode is enabled — please wait before sending again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 4. Burst detection → arm the escalating cooldown.
    const burst = await this.cache.increment(videoRoomChatFloodKey(roomId, userId), {
      ttlSeconds: cfg.floodBurstWindowSeconds,
    });
    if (burst > cfg.floodBurstMax) {
      await this.armCooldown(roomId, userId, cfg.cooldownSteps);
      throw this.tooFast('Too many messages at once — slow down.');
    }

    // 5. Duplicate suppression (atomic SET NX).
    const hash = createHash('sha1').update(content.toLowerCase()).digest('hex');
    const claimed = await this.redis.set(
      videoRoomChatDedupKey(roomId, userId, hash),
      '1',
      'EX',
      cfg.dedupWindowSeconds,
      'NX',
    );
    if (claimed === null) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_MESSAGE,
        'Duplicate message ignored.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Start this sender's slow-mode window after a successful send. */
  async applySlowMode(roomId: string, userId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    await this.redis.set(videoRoomChatSlowKey(roomId, userId), '1', 'EX', seconds);
  }

  /**
   * Escalate through the cooldown ladder. The rolling violation counter picks the
   * rung; repeat offenders wait longer, and the ladder saturates at its last rung
   * rather than running off the end of the array.
   */
  private async armCooldown(roomId: string, userId: string, steps: number[]): Promise<void> {
    if (steps.length === 0) return;
    const violations = await this.cache.increment(videoRoomChatViolationKey(roomId, userId), {
      ttlSeconds: 3600,
    });
    const seconds = steps[Math.min(violations, steps.length) - 1];
    await this.redis.set(videoRoomChatCooldownKey(roomId, userId), '1', 'EX', seconds);
  }

  private tooFast(message: string): BusinessException {
    return new BusinessException(
      ERROR_CODES.CHAT_RATE_LIMITED,
      message,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1217 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat-rate-limiter.service.*
git commit -m "feat(video-rooms): VR-9 chat rate limiting, flood detection and cooldowns"
```

---

### Task 8: Mention resolver

**Files:**
- Create: `src/modules/video-rooms/services/video-room-mention-resolver.service.ts`
- Create: `src/modules/video-rooms/services/video-room-mention-resolver.service.spec.ts`

**Interfaces:**
- Consumes: `USERS_SERVICE` / `IUsersService` from `src/modules/users/interfaces/users.service.interface` (cross-module access via `interfaces/` — the AR-4 precedent, boundary-legal), specifically `findByUsername(username): Promise<UserIdentity | null>`; `VideoRoomRolesRepository.listActiveByRoom(roomId)` (EXISTING — do not add a method); Task 2's `VIDEO_ROOM_CHAT_MENTION_RE` + group-mention constants.
- Produces: `VideoRoomMentionResolver.resolve(content, ctx: { roomId, ownerId, senderId, max }): Promise<{ userIds: string[]; scope: string | null }>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-mention-resolver.service.spec.ts`:

```typescript
import { VideoRoomMentionResolver } from './video-room-mention-resolver.service';

const CTX = { roomId: 'r1', ownerId: 'owner-1', senderId: 'u1', max: 3 };

describe('VideoRoomMentionResolver', () => {
  let users: { findByUsername: jest.Mock };
  let roles: { listActiveByRoom: jest.Mock };
  let resolver: VideoRoomMentionResolver;

  beforeEach(() => {
    users = { findByUsername: jest.fn().mockResolvedValue(null) };
    roles = { listActiveByRoom: jest.fn().mockResolvedValue([]) };
    resolver = new VideoRoomMentionResolver(users as never, roles as never);
  });

  it('returns nothing when there are no mentions', async () => {
    const result = await resolver.resolve('just a message', CTX);
    expect(result).toEqual({ userIds: [], scope: null });
    expect(users.findByUsername).not.toHaveBeenCalled();
  });

  it('resolves @username to a user id', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u2' });
    const result = await resolver.resolve('hey @alice', CTX);
    expect(users.findByUsername).toHaveBeenCalledWith('alice');
    expect(result.userIds).toEqual(['u2']);
  });

  it('never resolves a self-mention', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u1' });
    const result = await resolver.resolve('@me talking to myself', CTX);
    expect(result.userIds).toEqual([]);
  });

  it('maps @owner to the room owner with an OWNER scope', async () => {
    const result = await resolver.resolve('@owner please look', CTX);
    expect(result).toEqual({ userIds: ['owner-1'], scope: 'OWNER' });
    // A group token must not be looked up as a username.
    expect(users.findByUsername).not.toHaveBeenCalledWith('owner');
  });

  it('maps @admins to the elevated grant holders', async () => {
    roles.listActiveByRoom.mockResolvedValue([{ userId: 'a1' }, { userId: 'a2' }]);
    const result = await resolver.resolve('@admins help', CTX);
    expect(result).toEqual({ userIds: ['a1', 'a2'], scope: 'ADMINS' });
  });

  it('caps the resolved set at max', async () => {
    users.findByUsername.mockImplementation((name: string) =>
      Promise.resolve({ id: `id-${name}` }),
    );
    const result = await resolver.resolve('@aaa @bbb @ccc @ddd @eee', CTX);
    expect(result.userIds).toHaveLength(3);
  });

  it('deduplicates a username repeated in one message', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u2' });
    const result = await resolver.resolve('@alice and again @alice', CTX);
    expect(result.userIds).toEqual(['u2']);
    expect(users.findByUsername).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-mention-resolver.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Check the users interface for the exact lookup method**

Run: `grep -n "findByUsername\|interface IUsersService" -A 3 src/modules/users/interfaces/users.service.interface.ts`
Use whatever signature is shipped. If the method is named differently, use the shipped name in both the implementation and the spec.

- [ ] **Step 4: REUSE the existing elevated-role lookup — add NOTHING**

**Audited 2026-07-21: `VideoRoomRolesRepository.listActiveByRoom(roomId, now?)` already
exists and is exactly what `@admins` needs.** It returns every non-expired grant in the
room, filtered through the repository's shared private `notExpired(now)` helper — the same
helper `findActive`, `countByRole` and the rest use.

```typescript
  /** All active elevated grants in a room (role listing, effective-role reporting). */
  async listActiveByRoom(roomId: string, now: Date = new Date()): Promise<VideoRoomRole[]>
```

**Do NOT add `listElevatedUserIds`.** An earlier draft of this plan told you to write a new
method with its own inline `OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]`.
That would duplicate expiry semantics that already exist in one place — and duplicated
expiry logic is precisely the kind of thing that drifts and then silently grants a lapsed
admin `@admins` reach. Reuse the shipped method and map in the resolver:

```typescript
      const grants = await this.roles.listActiveByRoom(ctx.roomId);
      const ids = [...new Set(grants.map((g) => g.userId))].filter((id) => id !== ctx.senderId);
      return { userIds: ids.slice(0, ctx.max), scope: 'ADMINS' };
```

The spec mocks `listActiveByRoom` accordingly — it returns grant OBJECTS (`{ userId }`), not
bare id strings, so the resolver does the mapping.

- [ ] **Step 5: Implement the resolver**

Create `src/modules/video-rooms/services/video-room-mention-resolver.service.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import { VIDEO_ROOM_CHAT_MENTION_RE } from '../constants/video-room-chat.constants';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';

export interface MentionContext {
  roomId: string;
  ownerId: string;
  senderId: string;
  max: number;
}

export interface ResolvedMentions {
  userIds: string[];
  /** 'OWNER' | 'ADMINS' for a group mention; null for direct @username mentions. */
  scope: string | null;
}

/**
 * Resolves `@username`, `@owner` and `@admins` tokens to user ids.
 *
 * Group tokens are checked BEFORE username lookup, so a user who registers the
 * username "owner" cannot hijack `@owner` broadcasts. Self-mentions are dropped
 * (nobody needs to be notified of their own message) and the result is capped, so
 * a message packed with mentions cannot fan out unboundedly.
 *
 * Users are reached through the cross-module `USERS_SERVICE` contract — never by
 * importing the users module's internals.
 */
@Injectable()
export class VideoRoomMentionResolver {
  constructor(
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    private readonly roles: VideoRoomRolesRepository,
  ) {}

  async resolve(content: string, ctx: MentionContext): Promise<ResolvedMentions> {
    const tokens = new Set<string>();
    for (const match of content.matchAll(VIDEO_ROOM_CHAT_MENTION_RE)) {
      tokens.add(match[1].toLowerCase());
    }
    if (tokens.size === 0) return { userIds: [], scope: null };

    // Group mentions win over any same-named user account.
    if (tokens.has('owner')) {
      return { userIds: ctx.ownerId === ctx.senderId ? [] : [ctx.ownerId], scope: 'OWNER' };
    }
    if (tokens.has('admins')) {
      const grants = await this.roles.listActiveByRoom(ctx.roomId);
      const ids = [...new Set(grants.map((g) => g.userId))].filter((id) => id !== ctx.senderId);
      return { userIds: ids.slice(0, ctx.max), scope: 'ADMINS' };
    }

    const ids = new Set<string>();
    for (const username of tokens) {
      if (ids.size >= ctx.max) break;
      const user = await this.users.findByUsername(username);
      if (user && user.id !== ctx.senderId) ids.add(user.id);
    }
    return { userIds: [...ids], scope: null };
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-mention-resolver.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm boundaries && pnpm test`
Expected: boundaries green (users reached via `interfaces/`); 1224 passing.

```bash
git add src/modules/video-rooms/services/video-room-mention-resolver.service.* \
        src/modules/video-rooms/repositories/video-room-roles.repository.ts
git commit -m "feat(video-rooms): VR-9 mention resolver (@user, @owner, @admins)"
```

---

### Task 9: Chat policy service — the authorization gate

**The most important task in the plan.** VR-7's post-mortem records what happened when video-room authorization was spread across services: a coarse gate sat beside the fine matrix, won where they overlapped, and the PRD's admin restrictions went unenforced for six phases. Chat has more gates than RBAC did, so they live in one service with an exhaustively enumerated test matrix.

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat-policy.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat-policy.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomsRepository.findById` / `.getSettings` / `.getMember`; `VideoRoomPermissionService.resolveEffectiveRole`; `VideoRoomModerationRepository.findActiveMute` / `.findActiveBlock`; Task 2 config.
- Produces:
```typescript
assertCanSend(actor: RoomActor, roomId: string, input: SendPolicyInput): Promise<SendPolicyResult>
assertCanEdit(actor: RoomActor, roomId: string, message: VideoRoomMessage): Promise<void>
assertCanDelete(actor: RoomActor, roomId: string, message: VideoRoomMessage): Promise<{ byModerator: boolean }>
assertCanRecall(actor: RoomActor, roomId: string, message: VideoRoomMessage): Promise<void>
assertActiveMember(roomId: string, userId: string): Promise<void>
// SendPolicyInput  = { type: VideoRoomMessageType; contentLength: number; attachmentCount: number }
// SendPolicyResult = { room: VideoRoom; settings: VideoRoomSettings; role: VideoRoomMemberRole | null }
```

- [ ] **Step 1: Write the failing test — the full mode × role matrix**

Create `src/modules/video-rooms/services/video-room-chat-policy.service.spec.ts`:

```typescript
import {
  VideoRoomChatMode,
  VideoRoomMemberRole,
  VideoRoomMessageType,
  VideoRoomStatus,
} from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';

const ROOM = { id: 'r1', ownerId: 'owner-1', status: VideoRoomStatus.LIVE };
const CFG = { messageMaxLength: 500, editWindowSeconds: 900, recallWindowSeconds: 120 };

function settings(over: Partial<Record<string, unknown>> = {}) {
  return {
    roomId: 'r1',
    allowChat: true,
    allowViewerChat: true,
    chatMode: VideoRoomChatMode.NORMAL,
    chatMaxMessageLength: 500,
    chatMaxAttachments: 1,
    chatRateLimitPerMinute: 20,
    slowModeSeconds: 0,
    ...over,
  };
}

const actor = (id: string): RoomActor => ({ id, roles: [] });
const TEXT = {
  type: VideoRoomMessageType.TEXT,
  contentLength: 5,
  attachmentCount: 0,
};

describe('VideoRoomChatPolicyService', () => {
  let rooms: { findById: jest.Mock; getSettings: jest.Mock; getMember: jest.Mock };
  let permissions: { resolveEffectiveRole: jest.Mock };
  let moderation: { findActiveMute: jest.Mock; findActiveBlock: jest.Mock };
  let config: { get: jest.Mock };
  let policy: VideoRoomChatPolicyService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getSettings: jest.fn().mockResolvedValue(settings()),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
    };
    permissions = {
      resolveEffectiveRole: jest.fn().mockResolvedValue(VideoRoomMemberRole.VIEWER),
    };
    moderation = {
      findActiveMute: jest.fn().mockResolvedValue(null),
      findActiveBlock: jest.fn().mockResolvedValue(null),
    };
    config = { get: jest.fn().mockReturnValue(CFG) };
    policy = new VideoRoomChatPolicyService(
      rooms as never,
      permissions as never,
      moderation as never,
      config as never,
    );
  });

  // ---- Preconditions ----

  it('rejects when the room does not exist', async () => {
    rooms.findById.mockResolvedValue(null);
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
    });
  });

  it('rejects when the room is not live', async () => {
    rooms.findById.mockResolvedValue({ ...ROOM, status: VideoRoomStatus.ENDED });
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_ENDED,
    });
  });

  it('rejects a non-member', async () => {
    rooms.getMember.mockResolvedValue(null);
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
    });
  });

  it('rejects an inactive member', async () => {
    rooms.getMember.mockResolvedValue({ isActive: false });
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
    });
  });

  it('rejects when chat is disabled, even for the owner', async () => {
    rooms.getSettings.mockResolvedValue(settings({ allowChat: false }));
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.OWNER);
    await expect(policy.assertCanSend(actor('owner-1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_DISABLED,
    });
  });

  it('rejects a blocked user', async () => {
    moderation.findActiveBlock.mockResolvedValue({ id: 'b1' });
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_BLOCKED,
    });
  });

  it('rejects a muted user', async () => {
    moderation.findActiveMute.mockResolvedValue({ id: 'm1' });
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.MEMBER_MUTED,
    });
  });

  // ---- Content bounds ----

  it('rejects an over-length message', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, contentLength: 501 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MESSAGE_TOO_LONG });
  });

  it('rejects an empty message', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, contentLength: 0 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MESSAGE_TOO_LONG });
  });

  it('applies the tighter emoji bound', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', {
        type: VideoRoomMessageType.EMOJI,
        contentLength: 65,
        attachmentCount: 0,
      }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MESSAGE_TOO_LONG });
  });

  it('rejects too many attachments', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, attachmentCount: 2 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ATTACHMENT_LIMIT });
  });

  it('refuses a client-supplied SYSTEM message', async () => {
    // SYSTEM rows are minted by the platform only; accepting one from a client
    // would let any member forge "Owner changed" notices.
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, type: VideoRoomMessageType.SYSTEM }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED });
  });

  // ---- The mode × role matrix ----

  const ROLES = [
    VideoRoomMemberRole.OWNER,
    VideoRoomMemberRole.ADMIN,
    VideoRoomMemberRole.MODERATOR,
    VideoRoomMemberRole.HOST,
    VideoRoomMemberRole.PARTICIPANT,
    VideoRoomMemberRole.VIEWER,
  ];

  // true ⇒ a plain TEXT message is allowed.
  const MATRIX: Record<string, Record<string, boolean>> = {
    [VideoRoomChatMode.NORMAL]: {
      OWNER: true, ADMIN: true, MODERATOR: true, HOST: true, PARTICIPANT: true, VIEWER: true,
    },
    [VideoRoomChatMode.PARTICIPANTS_ONLY]: {
      OWNER: true, ADMIN: true, MODERATOR: true, HOST: true, PARTICIPANT: true, VIEWER: false,
    },
    [VideoRoomChatMode.READ_ONLY]: {
      OWNER: true, ADMIN: true, MODERATOR: true, HOST: false, PARTICIPANT: false, VIEWER: false,
    },
    // ANNOUNCEMENT_ONLY bars TEXT from everyone — even the owner, who must
    // send an ANNOUNCEMENT instead.
    [VideoRoomChatMode.ANNOUNCEMENT_ONLY]: {
      OWNER: false, ADMIN: false, MODERATOR: false, HOST: false, PARTICIPANT: false, VIEWER: false,
    },
  };

  for (const mode of Object.keys(MATRIX)) {
    for (const role of ROLES) {
      const allowed = MATRIX[mode][role];
      it(`${mode} × ${role} ${allowed ? 'allows' : 'rejects'} a text message`, async () => {
        rooms.getSettings.mockResolvedValue(settings({ chatMode: mode }));
        permissions.resolveEffectiveRole.mockResolvedValue(role);

        const send = policy.assertCanSend(actor('u1'), 'r1', TEXT);
        if (allowed) {
          await expect(send).resolves.toMatchObject({ role });
        } else {
          await expect(send).rejects.toMatchObject({
            errorCode: ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED,
          });
        }
      });
    }
  }

  it('ANNOUNCEMENT_ONLY admits an ANNOUNCEMENT from an elevated role', async () => {
    rooms.getSettings.mockResolvedValue(
      settings({ chatMode: VideoRoomChatMode.ANNOUNCEMENT_ONLY }),
    );
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.ADMIN);

    await expect(
      policy.assertCanSend(actor('u1'), 'r1', {
        type: VideoRoomMessageType.ANNOUNCEMENT,
        contentLength: 10,
        attachmentCount: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('ignores allowViewerChat entirely — chatMode is the only source of truth', async () => {
    // The deprecated column must never affect a decision, in either direction.
    rooms.getSettings.mockResolvedValue(
      settings({ allowViewerChat: false, chatMode: VideoRoomChatMode.NORMAL }),
    );
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.VIEWER);

    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).resolves.toBeDefined();
  });

  it('platform admins bypass every mode restriction', async () => {
    rooms.getSettings.mockResolvedValue({
      ...settings({ chatMode: VideoRoomChatMode.READ_ONLY }),
    });
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.VIEWER);

    await expect(
      policy.assertCanSend({ id: 'staff', roles: ['ADMIN'] as never }, 'r1', TEXT),
    ).resolves.toBeDefined();
  });

  // ---- Edit / delete / recall ----

  const own = {
    id: 'm1',
    roomId: 'r1',
    senderId: 'u1',
    type: VideoRoomMessageType.TEXT,
    createdAt: new Date(),
    deletedAt: null,
    recalledAt: null,
  };

  it('lets an author edit inside the window', async () => {
    await expect(policy.assertCanEdit(actor('u1'), 'r1', own as never)).resolves.toBeUndefined();
  });

  it('refuses an edit by anyone but the author', async () => {
    await expect(policy.assertCanEdit(actor('u2'), 'r1', own as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
    });
  });

  it('refuses an edit after the window closes', async () => {
    const old = { ...own, createdAt: new Date(Date.now() - 901_000) };
    await expect(policy.assertCanEdit(actor('u1'), 'r1', old as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED,
    });
  });

  it('refuses editing a SYSTEM message', async () => {
    const sys = { ...own, type: VideoRoomMessageType.SYSTEM };
    await expect(policy.assertCanEdit(actor('u1'), 'r1', sys as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_NOT_EDITABLE,
    });
  });

  it('refuses editing a deleted message', async () => {
    const gone = { ...own, deletedAt: new Date() };
    await expect(policy.assertCanEdit(actor('u1'), 'r1', gone as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_NOT_EDITABLE,
    });
  });

  it('lets the author delete their own message, not as a moderator', async () => {
    await expect(policy.assertCanDelete(actor('u1'), 'r1', own as never)).resolves.toEqual({
      byModerator: false,
    });
  });

  it('lets a moderator delete someone else’s message', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);
    await expect(policy.assertCanDelete(actor('mod'), 'r1', own as never)).resolves.toEqual({
      byModerator: true,
    });
  });

  it('refuses a non-moderator deleting someone else’s message', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.VIEWER);
    await expect(
      policy.assertCanDelete(actor('u2'), 'r1', own as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN });
  });

  it('refuses a recall after the window, even for the author', async () => {
    const old = { ...own, createdAt: new Date(Date.now() - 121_000) };
    await expect(policy.assertCanRecall(actor('u1'), 'r1', old as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED,
    });
  });

  it('refuses a recall by a moderator — recall is the author’s alone', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);
    await expect(
      policy.assertCanRecall(actor('mod'), 'r1', own as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-policy.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the policy service**

Create `src/modules/video-rooms/services/video-room-chat-policy.service.ts`:

```typescript
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlatformRole,
  VideoRoom,
  VideoRoomChatMode,
  VideoRoomMemberRole,
  VideoRoomMessage,
  VideoRoomMessageType,
  VideoRoomSettings,
  VideoRoomStatus,
} from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH } from '../constants/video-room-chat.constants';
import { ELEVATED_VIDEO_ROOM_ROLES } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface SendPolicyInput {
  type: VideoRoomMessageType;
  contentLength: number;
  attachmentCount: number;
}

export interface SendPolicyResult {
  room: VideoRoom;
  settings: VideoRoomSettings;
  role: VideoRoomMemberRole | null;
}

/** Seat-derived roles — allowed to talk in PARTICIPANTS_ONLY. */
const SEATED_ROLES: readonly VideoRoomMemberRole[] = [
  VideoRoomMemberRole.HOST,
  VideoRoomMemberRole.PARTICIPANT,
];

/**
 * THE authorization decision point for VR-9 chat. Every gate — room state,
 * membership, chat enablement, chat mode, block, mute, length, type, attachments
 * — is asked here and nowhere else.
 *
 * This service exists because of what VR-7's post-mortem found: when video-room
 * authorization was spread across services, a coarse gate sat beside the fine
 * permission matrix, won wherever the two overlapped, and the PRD's admin
 * restrictions went unenforced for six phases. Chat has more gates than RBAC did,
 * so they get one service and one exhaustively enumerated test matrix.
 *
 * `chatMode` is the ONLY source of truth for who may send. The deprecated
 * `allowViewerChat` column is never read here — see the schema doc comment.
 */
@Injectable()
export class VideoRoomChatPolicyService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly config: ConfigService,
  ) {}

  async assertCanSend(
    actor: RoomActor,
    roomId: string,
    input: SendPolicyInput,
  ): Promise<SendPolicyResult> {
    const room = await this.loadLiveRoom(roomId);
    await this.assertActiveMember(roomId, actor.id);

    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowChat) {
      throw new BusinessException(
        ERROR_CODES.CHAT_DISABLED,
        'Chat is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.assertNotBlockedOrMuted(roomId, actor.id);

    const role = await this.permissions.resolveEffectiveRole(room, actor.id);
    this.assertContent(input, settings);
    this.assertMode(actor, input.type, role, settings?.chatMode ?? VideoRoomChatMode.NORMAL);

    return { room, settings: settings as VideoRoomSettings, role };
  }

  /** Edit: author only, inside the window, on a live text-ish message. */
  async assertCanEdit(actor: RoomActor, roomId: string, message: VideoRoomMessage): Promise<void> {
    if (message.senderId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'You can only edit your own messages.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (
      message.deletedAt ||
      message.recalledAt ||
      message.type === VideoRoomMessageType.SYSTEM
    ) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MESSAGE_NOT_EDITABLE,
        'This message cannot be edited.',
        HttpStatus.CONFLICT,
      );
    }
    const { editWindowSeconds } = loadVideoRoomChatConfig(this.config);
    if (this.ageSeconds(message.createdAt) > editWindowSeconds) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED,
        'The edit window for this message has closed.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Delete: the author, or anyone holding moderator authority. */
  async assertCanDelete(
    actor: RoomActor,
    roomId: string,
    message: VideoRoomMessage,
  ): Promise<{ byModerator: boolean }> {
    if (message.senderId === actor.id) return { byModerator: false };

    const room = await this.loadRoom(roomId);
    if (this.isPlatformAdmin(actor)) return { byModerator: true };

    const role = await this.permissions.resolveEffectiveRole(room, actor.id);
    if (role && ELEVATED_VIDEO_ROOM_ROLES.includes(role)) return { byModerator: true };

    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      'You do not have permission to delete this message.',
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Recall: the author alone, inside the window. Moderators are deliberately
   * excluded — recall withdraws a message from everyone, so letting a moderator
   * recall would erase evidence rather than moderate it. Moderators delete.
   */
  async assertCanRecall(
    actor: RoomActor,
    _roomId: string,
    message: VideoRoomMessage,
  ): Promise<void> {
    if (message.senderId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the sender may recall a message.',
        HttpStatus.FORBIDDEN,
      );
    }
    const { recallWindowSeconds } = loadVideoRoomChatConfig(this.config);
    if (this.ageSeconds(message.createdAt) > recallWindowSeconds) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED,
        'The recall window for this message has closed.',
        HttpStatus.CONFLICT,
      );
    }
  }

  async assertActiveMember(roomId: string, userId: string): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You are not a member of this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ---- Internals ----

  private async loadRoom(roomId: string): Promise<VideoRoom> {
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

  private async loadLiveRoom(roomId: string): Promise<VideoRoom> {
    const room = await this.loadRoom(roomId);
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ENDED,
        'This room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    return room;
  }

  private async assertNotBlockedOrMuted(roomId: string, userId: string): Promise<void> {
    if (await this.moderation.findActiveBlock(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'You are blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (await this.moderation.findActiveMute(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.MEMBER_MUTED,
        'You are muted in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertContent(input: SendPolicyInput, settings: VideoRoomSettings | null): void {
    const max =
      input.type === VideoRoomMessageType.EMOJI
        ? VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH
        : (settings?.chatMaxMessageLength ??
          loadVideoRoomChatConfig(this.config).messageMaxLength);

    if (input.contentLength === 0 || input.contentLength > max) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_TOO_LONG,
        `Message must be between 1 and ${max} characters.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.attachmentCount > (settings?.chatMaxAttachments ?? 1)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ATTACHMENT_LIMIT,
        'Too many attachments on this message.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * The mode × role matrix. Platform staff bypass entirely; SYSTEM rows are
   * platform-minted and never accepted from a client (otherwise any member could
   * forge an "Owner changed" notice).
   */
  private assertMode(
    actor: RoomActor,
    type: VideoRoomMessageType,
    role: VideoRoomMemberRole | null,
    mode: VideoRoomChatMode,
  ): void {
    if (type === VideoRoomMessageType.SYSTEM) {
      throw this.modeError('System messages cannot be sent by clients.');
    }
    if (this.isPlatformAdmin(actor)) return;

    const elevated = role !== null && ELEVATED_VIDEO_ROOM_ROLES.includes(role);
    const seated = role !== null && SEATED_ROLES.includes(role);

    switch (mode) {
      case VideoRoomChatMode.NORMAL:
        return;
      case VideoRoomChatMode.PARTICIPANTS_ONLY:
        if (elevated || seated) return;
        throw this.modeError('Only participants may chat in this room right now.');
      case VideoRoomChatMode.READ_ONLY:
        if (elevated) return;
        throw this.modeError('This room is in read-only mode.');
      case VideoRoomChatMode.ANNOUNCEMENT_ONLY:
        if (elevated && type === VideoRoomMessageType.ANNOUNCEMENT) return;
        throw this.modeError('Only announcements may be posted in this room right now.');
    }
  }

  private modeError(message: string): BusinessException {
    return new BusinessException(
      ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED,
      message,
      HttpStatus.FORBIDDEN,
    );
  }

  private isPlatformAdmin(actor: RoomActor): boolean {
    return actor.roles.includes(PlatformRole.ADMIN) || actor.roles.includes(PlatformRole.SUPER_ADMIN);
  }

  private ageSeconds(at: Date): number {
    return (Date.now() - at.getTime()) / 1000;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-policy.service.spec.ts`
Expected: PASS — 24 matrix cases + 22 others = 46 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1270 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat-policy.service.*
git commit -m "feat(video-rooms): VR-9 chat policy service with exhaustive mode x role matrix"
```

---

### Task 10: Chat service — send

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomChatPolicyService` (Task 9), `VideoRoomChatRateLimiter` (Task 7), `BlockedWordService` from `src/infra/content-moderation` (Task 5), `VideoRoomMentionResolver` (Task 8), `VideoRoomChatRepository` (Task 4), `VideoRoomChatCacheService` (Task 6), `EVENT_BUS`.
- Produces:
```typescript
send(actor: RoomActor, roomId: string, dto: SendChatMessageDto, audit?: ChatAuditContext): Promise<VideoRoomMessage>
toPayload(message: VideoRoomMessage): ChatMessagePayload   // reused by Tasks 11, 13, 17
```
`SendChatMessageDto` is defined in Task 18; for this task treat it as `{ content: string; type?: VideoRoomMessageType; replyToId?: string; attachments?: unknown[]; forwardedFromId?: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-chat.service.spec.ts`:

```typescript
import { VideoRoomMessageType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatService } from './video-room-chat.service';

const ACTOR: RoomActor = { id: 'u1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const SETTINGS = { chatRateLimitPerMinute: 20, slowModeSeconds: 0 };
const MESSAGE = {
  id: 'm1',
  roomId: 'r1',
  senderId: 'u1',
  type: VideoRoomMessageType.TEXT,
  content: 'hello',
  mentions: [],
  mentionScope: null,
  replyToId: null,
  createdAt: new Date('2026-07-21T00:00:00Z'),
};

describe('VideoRoomChatService.send', () => {
  let policy: { assertCanSend: jest.Mock };
  let limiter: { assertMaySend: jest.Mock; applySlowMode: jest.Mock };
  let words: { scan: jest.Mock };
  let mentions: { resolve: jest.Mock };
  let repo: { createMessage: jest.Mock; findMessage: jest.Mock };
  let cache: { pushRecent: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomChatService;

  beforeEach(() => {
    policy = {
      assertCanSend: jest.fn().mockResolvedValue({ room: ROOM, settings: SETTINGS, role: 'VIEWER' }),
    };
    limiter = { assertMaySend: jest.fn(), applySlowMode: jest.fn() };
    words = { scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: '' }) };
    mentions = { resolve: jest.fn().mockResolvedValue({ userIds: [], scope: null }) };
    repo = {
      createMessage: jest.fn().mockResolvedValue(MESSAGE),
      findMessage: jest.fn().mockResolvedValue(null),
    };
    cache = { pushRecent: jest.fn() };
    bus = { publish: jest.fn() };
    service = new VideoRoomChatService(
      policy as never,
      limiter as never,
      words as never,
      mentions as never,
      repo as never,
      cache as never,
      bus as never,
    );
  });

  it('runs the gates in order: policy, then rate limit, then persist', async () => {
    await service.send(ACTOR, 'r1', { content: 'hello' });

    const policyOrder = policy.assertCanSend.mock.invocationCallOrder[0];
    const limiterOrder = limiter.assertMaySend.mock.invocationCallOrder[0];
    const createOrder = repo.createMessage.mock.invocationCallOrder[0];
    expect(policyOrder).toBeLessThan(limiterOrder);
    expect(limiterOrder).toBeLessThan(createOrder);
  });

  it('persists before broadcasting — nothing after the insert can reject', async () => {
    await service.send(ACTOR, 'r1', { content: 'hello' });

    expect(repo.createMessage.mock.invocationCallOrder[0]).toBeLessThan(
      bus.publish.mock.invocationCallOrder[0],
    );
    expect(cache.pushRecent).toHaveBeenCalledWith('r1', expect.objectContaining({ messageId: 'm1' }));
  });

  it('trims content before length checks and storage', async () => {
    await service.send(ACTOR, 'r1', { content: '  hello  ' });

    expect(policy.assertCanSend).toHaveBeenCalledWith(
      ACTOR,
      'r1',
      expect.objectContaining({ contentLength: 5 }),
    );
    expect(repo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello' }),
    );
  });

  it('stores the masked text when a MILD word matched', async () => {
    words.scan.mockReturnValue({
      matched: true,
      action: 'MASK',
      severity: 'MILD',
      matches: ['darn'],
      maskedText: '***',
    });

    await service.send(ACTOR, 'r1', { content: 'darn' });

    expect(repo.createMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '***' }));
  });

  it('rejects on REJECT and never persists', async () => {
    words.scan.mockReturnValue({
      matched: true,
      action: 'REJECT',
      severity: 'OFFENSIVE',
      matches: ['x'],
      maskedText: '***',
    });

    await expect(service.send(ACTOR, 'r1', { content: 'x' })).rejects.toMatchObject({
      errorCode: ERROR_CODES.BLOCKED_WORD,
    });
    expect(repo.createMessage).not.toHaveBeenCalled();
  });

  it('rejects on ESCALATE without taking a moderation action', async () => {
    // Detection yes, enforcement no — Moderation Actions is out of VR-9 scope.
    words.scan.mockReturnValue({
      matched: true,
      action: 'ESCALATE',
      severity: 'CRITICAL',
      matches: ['x'],
      maskedText: '***',
    });

    await expect(service.send(ACTOR, 'r1', { content: 'x' })).rejects.toMatchObject({
      errorCode: ERROR_CODES.BLOCKED_WORD,
    });
  });

  it('publishes a mention event only when mentions resolved', async () => {
    mentions.resolve.mockResolvedValue({ userIds: ['u2'], scope: null });
    repo.createMessage.mockResolvedValue({ ...MESSAGE, mentions: ['u2'] });

    await service.send(ACTOR, 'r1', { content: 'hi @bob' });

    const names = bus.publish.mock.calls.map((c) => c[0].name);
    expect(names).toContain('video_room.chat_message_sent');
    expect(names).toContain('video_room.chat_mentioned');
  });

  it('does not publish a mention event when there are none', async () => {
    await service.send(ACTOR, 'r1', { content: 'hello' });

    const names = bus.publish.mock.calls.map((c) => c[0].name);
    expect(names).not.toContain('video_room.chat_mentioned');
  });

  it('rejects a reply whose target is missing or from another room', async () => {
    repo.findMessage.mockResolvedValue({ id: 'm9', roomId: 'other', deletedAt: null });

    await expect(
      service.send(ACTOR, 'r1', { content: 'hi', replyToId: 'm9' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_REPLY_TARGET_INVALID });
  });

  it('allows replying to a deleted parent (tombstone rendering)', async () => {
    repo.findMessage.mockResolvedValue({ id: 'm9', roomId: 'r1', deletedAt: new Date() });

    await expect(
      service.send(ACTOR, 'r1', { content: 'hi', replyToId: 'm9' }),
    ).resolves.toBeDefined();
  });

  it('arms slow mode after a successful send', async () => {
    policy.assertCanSend.mockResolvedValue({
      room: ROOM,
      settings: { ...SETTINGS, slowModeSeconds: 10 },
      role: 'VIEWER',
    });

    await service.send(ACTOR, 'r1', { content: 'hello' });

    expect(limiter.applySlowMode).toHaveBeenCalledWith('r1', 'u1', 10);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the send path**

Create `src/modules/video-rooms/services/video-room-chat.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BlockedWordAction, VideoRoomMessage, VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { BlockedWordService } from 'src/infra/content-moderation';
import {
  ChatMentionedEvent,
  ChatMessageSentEvent,
  type ChatAuditContext,
  type ChatMessagePayload,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';
import { VideoRoomChatRateLimiter } from './video-room-chat-rate-limiter.service';
import { VideoRoomMentionResolver } from './video-room-mention-resolver.service';

export interface SendChatMessageInput {
  content: string;
  type?: VideoRoomMessageType;
  replyToId?: string;
  forwardedFromId?: string;
  attachments?: unknown[];
}

/**
 * VR-9 chat commands. The send path runs its gates in a deliberate order —
 * policy → rate limit → word scan → mention resolution → persist → cache →
 * publish — so that every rejection happens BEFORE the insert. Nothing after the
 * write can fail the message, which is what removes the partial-write window.
 *
 * Persist-then-broadcast: the durable row exists (real id, real ordering) before
 * any client hears about it. The Redis ring buffer is written alongside purely to
 * keep the read path off Postgres.
 */
@Injectable()
export class VideoRoomChatService {
  constructor(
    private readonly policy: VideoRoomChatPolicyService,
    private readonly limiter: VideoRoomChatRateLimiter,
    private readonly words: BlockedWordService,
    private readonly mentions: VideoRoomMentionResolver,
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async send(
    actor: RoomActor,
    roomId: string,
    dto: SendChatMessageInput,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomMessage> {
    const content = dto.content.trim();
    const type = dto.type ?? VideoRoomMessageType.TEXT;
    const attachments = dto.attachments ?? [];

    // 1. Authorization + content bounds.
    const { room, settings } = await this.policy.assertCanSend(actor, roomId, {
      type,
      contentLength: content.length,
      attachmentCount: attachments.length,
    });

    // 2. Anti-abuse.
    await this.limiter.assertMaySend(roomId, actor.id, content, {
      rateMax: settings?.chatRateLimitPerMinute ?? 20,
      slowModeSeconds: settings?.slowModeSeconds ?? 0,
    });

    // 3. Reply target must exist and belong to this room. A DELETED parent is
    //    fine — the client renders a tombstone rather than losing the thread.
    if (dto.replyToId) await this.assertReplyTarget(roomId, dto.replyToId);

    // 4. Blocked-word scan: mask and continue, or reject. No auto-discipline.
    const finalContent = this.applyWordScan(content);

    // 5. Mentions.
    const resolved = await this.mentions.resolve(content, {
      roomId,
      ownerId: room.ownerId,
      senderId: actor.id,
      max: 10,
    });

    // 6. Durable write.
    const message = await this.repo.createMessage({
      roomId,
      senderId: actor.id,
      type,
      content: finalContent,
      mentions: resolved.userIds,
      mentionScope: resolved.scope,
      replyToId: dto.replyToId ?? null,
      forwardedFromId: dto.forwardedFromId ?? null,
      ...(attachments.length > 0 ? { attachments: attachments as never } : {}),
    });

    // 7. Cache + fan-out.
    const payload = this.toPayload(message);
    await this.cache.pushRecent(roomId, payload);
    await this.bus.publish(new ChatMessageSentEvent({ ...payload, audit }));

    if (resolved.userIds.length > 0) {
      await this.bus.publish(
        new ChatMentionedEvent({
          roomId,
          messageId: message.id,
          senderId: actor.id,
          recipientIds: resolved.userIds,
          scope: resolved.scope,
        }),
      );
    }

    await this.limiter.applySlowMode(roomId, actor.id, settings?.slowModeSeconds ?? 0);
    return message;
  }

  /** The wire shape every message-carrying event and response uses. */
  toPayload(message: VideoRoomMessage): ChatMessagePayload {
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    return {
      roomId: message.roomId,
      messageId: message.id,
      senderId: message.senderId,
      type: message.type,
      content: message.content,
      mentions: message.mentions,
      mentionScope: message.mentionScope,
      replyToId: message.replyToId,
      createdAt: message.createdAt.toISOString(),
      ...(typeof metadata.announcementId === 'string'
        ? { announcementId: metadata.announcementId }
        : {}),
      ...(typeof metadata.systemEvent === 'string' ? { systemEvent: metadata.systemEvent } : {}),
    };
  }

  private async assertReplyTarget(roomId: string, replyToId: string): Promise<void> {
    const parent = await this.repo.findMessage(replyToId);
    if (!parent || parent.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_REPLY_TARGET_INVALID,
        'The message you are replying to does not exist in this room.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * MASK ⇒ store the masked text and continue. REJECT and ESCALATE both refuse
   * the message. VR-9 stops there: AR-4 escalates CRITICAL hits into auto-reports
   * and auto-mutes, but Moderation Actions is out of scope for this phase.
   */
  private applyWordScan(content: string): string {
    const scan = this.words.scan(content);
    if (!scan.matched) return content;
    if (scan.action === BlockedWordAction.MASK) return scan.maskedText;
    throw new BusinessException(
      ERROR_CODES.BLOCKED_WORD,
      'Your message was blocked by the community guidelines filter.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1281 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat.service.*
git commit -m "feat(video-rooms): VR-9 chat send path (persist-then-broadcast)"
```

---

### Task 11: Chat service — edit, delete, recall

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-chat.service.ts`
- Modify: `src/modules/video-rooms/services/video-room-chat.service.spec.ts`

**Interfaces:**
- Consumes: everything from Task 10, plus `VideoRoomChatRepository.editMessage` / `.softDeleteMessage` / `.recallMessage` / `.findActivePin` / `.deactivatePin`, and `VideoRoomChatCacheService.invalidateRecent`.
- Produces:
```typescript
edit(actor: RoomActor, roomId: string, messageId: string, content: string, audit?: ChatAuditContext): Promise<VideoRoomMessage>
remove(actor: RoomActor, roomId: string, messageId: string, audit?: ChatAuditContext): Promise<void>
recall(actor: RoomActor, roomId: string, messageId: string, audit?: ChatAuditContext): Promise<void>
```

- [ ] **Step 1: Append the failing tests**

Add to `src/modules/video-rooms/services/video-room-chat.service.spec.ts`, inside the existing `describe` (or as a sibling `describe` reusing the same `beforeEach` setup — extract the setup into a helper if you prefer):

```typescript
describe('VideoRoomChatService edit/delete/recall', () => {
  let policy: {
    assertCanSend: jest.Mock;
    assertCanEdit: jest.Mock;
    assertCanDelete: jest.Mock;
    assertCanRecall: jest.Mock;
  };
  let repo: Record<string, jest.Mock>;
  let cache: { pushRecent: jest.Mock; invalidateRecent: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomChatService;

  const stored = {
    id: 'm1',
    roomId: 'r1',
    senderId: 'u1',
    type: VideoRoomMessageType.TEXT,
    content: 'hello',
    mentions: [],
    mentionScope: null,
    replyToId: null,
    metadata: null,
    deletedAt: null,
    recalledAt: null,
    createdAt: new Date('2026-07-21T00:00:00Z'),
  };

  beforeEach(() => {
    policy = {
      assertCanSend: jest.fn(),
      assertCanEdit: jest.fn(),
      assertCanDelete: jest.fn().mockResolvedValue({ byModerator: false }),
      assertCanRecall: jest.fn(),
    };
    repo = {
      findMessage: jest.fn().mockResolvedValue(stored),
      editMessage: jest.fn().mockResolvedValue({ ...stored, content: 'edited', editedAt: new Date() }),
      softDeleteMessage: jest.fn(),
      recallMessage: jest.fn(),
      findActivePin: jest.fn().mockResolvedValue(null),
      deactivatePin: jest.fn(),
    };
    cache = { pushRecent: jest.fn(), invalidateRecent: jest.fn() };
    bus = { publish: jest.fn() };
    service = new VideoRoomChatService(
      policy as never,
      { assertMaySend: jest.fn(), applySlowMode: jest.fn() } as never,
      { scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: '' }) } as never,
      { resolve: jest.fn() } as never,
      repo as never,
      cache as never,
      bus as never,
    );
  });

  it('404s when the message is not in this room', async () => {
    repo.findMessage.mockResolvedValue({ ...stored, roomId: 'other' });
    await expect(service.edit({ id: 'u1', roles: [] }, 'r1', 'm1', 'x')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('edits and invalidates the cached buffer', async () => {
    await service.edit({ id: 'u1', roles: [] }, 'r1', 'm1', ' edited ');

    expect(policy.assertCanEdit).toHaveBeenCalled();
    expect(repo.editMessage).toHaveBeenCalledWith('m1', 'edited');
    // The buffer holds a stale copy of this message — drop it rather than
    // trying to surgically rewrite an entry inside a Redis list.
    expect(cache.invalidateRecent).toHaveBeenCalledWith('r1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_edited');
  });

  it('soft-deletes and reports moderator provenance on the event', async () => {
    policy.assertCanDelete.mockResolvedValue({ byModerator: true });

    await service.remove({ id: 'mod', roles: [] }, 'r1', 'm1');

    expect(repo.softDeleteMessage).toHaveBeenCalledWith('m1', 'mod');
    expect(bus.publish.mock.calls[0][0].payload.byModerator).toBe(true);
  });

  it('unpins a pinned message when it is deleted', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });

    await service.remove({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(repo.deactivatePin).toHaveBeenCalledWith('p1', 'u1');
  });

  it('delete is idempotent — a second call is a no-op', async () => {
    repo.findMessage.mockResolvedValue({ ...stored, deletedAt: new Date() });

    await service.remove({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(repo.softDeleteMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('recalls and unpins', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });

    await service.recall({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(policy.assertCanRecall).toHaveBeenCalled();
    expect(repo.recallMessage).toHaveBeenCalledWith('m1');
    expect(repo.deactivatePin).toHaveBeenCalledWith('p1', 'u1');
    expect(cache.invalidateRecent).toHaveBeenCalledWith('r1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_recalled');
  });

  it('recall is idempotent', async () => {
    repo.findMessage.mockResolvedValue({ ...stored, recalledAt: new Date() });

    await service.recall({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(repo.recallMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts`
Expected: FAIL — `service.edit is not a function`.

- [ ] **Step 3: Add the three methods**

Append to `VideoRoomChatService` (and add the three event imports to the existing import block):

```typescript
  /**
   * Edit an existing message. The Redis buffer holds a stale copy, so it is
   * invalidated wholesale rather than surgically rewritten — a Redis list has no
   * addressable update, and refilling from Postgres is cheap and always correct.
   */
  async edit(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    content: string,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomMessage> {
    const message = await this.load(roomId, messageId);
    await this.policy.assertCanEdit(actor, roomId, message);

    const trimmed = content.trim();
    const updated = await this.repo.editMessage(messageId, trimmed);
    await this.cache.invalidateRecent(roomId);
    await this.bus.publish(
      new ChatMessageEditedEvent({
        roomId,
        messageId,
        editorId: actor.id,
        content: trimmed,
        editedAt: (updated.editedAt ?? new Date()).toISOString(),
        audit,
      }),
    );
    return updated;
  }

  /** Soft delete. Idempotent: a repeat call emits nothing and changes nothing. */
  async remove(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    const message = await this.load(roomId, messageId);
    if (message.deletedAt) return;

    const { byModerator } = await this.policy.assertCanDelete(actor, roomId, message);
    await this.repo.softDeleteMessage(messageId, actor.id);
    await this.unpinIfPinned(roomId, messageId, actor.id);
    await this.cache.invalidateRecent(roomId);
    await this.bus.publish(
      new ChatMessageDeletedEvent({ roomId, messageId, deletedBy: actor.id, byModerator, audit }),
    );
  }

  /** The sender's own unsend. Idempotent, and withheld from everyone on read. */
  async recall(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    const message = await this.load(roomId, messageId);
    if (message.recalledAt) return;

    await this.policy.assertCanRecall(actor, roomId, message);
    await this.repo.recallMessage(messageId);
    await this.unpinIfPinned(roomId, messageId, actor.id);
    await this.cache.invalidateRecent(roomId);
    await this.bus.publish(
      new ChatMessageRecalledEvent({ roomId, messageId, senderId: actor.id, audit }),
    );
  }

  private async load(roomId: string, messageId: string): Promise<VideoRoomMessage> {
    const message = await this.repo.findMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_NOT_FOUND,
        'Message not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return message;
  }

  /** A withdrawn message must not stay pinned to the top of the room. */
  private async unpinIfPinned(roomId: string, messageId: string, actorId: string): Promise<void> {
    const pin = await this.repo.findActivePin(roomId, messageId);
    if (pin) await this.repo.deactivatePin(pin.id, actorId);
  }
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1288 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat.service.*
git commit -m "feat(video-rooms): VR-9 message edit, delete and recall"
```

---

### Task 12: Pin service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat-pin.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomPermissionService.assertPermission(actor, room, VideoRoomPermission.PIN_MESSAGES)`, `VideoRoomsRepository.findById`, `VideoRoomChatRepository` pin methods, `VideoRoomChatCacheService.setPins`, `LockService.withLock`, Task 2's `videoRoomChatPinLockKey`, config `maxPins`.
- Produces:
```typescript
pin(actor: RoomActor, roomId: string, messageId: string, audit?: ChatAuditContext): Promise<VideoRoomMessagePin>
unpin(actor: RoomActor, roomId: string, messageId: string, audit?: ChatAuditContext): Promise<void>
listPinned(roomId: string): Promise<VideoRoomMessage[]>
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts`:

```typescript
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatPinService } from './video-room-chat-pin.service';

const ACTOR = { id: 'u1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const MSG = { id: 'm1', roomId: 'r1', deletedAt: null, recalledAt: null };

describe('VideoRoomChatPinService', () => {
  let permissions: { assertPermission: jest.Mock };
  let rooms: { findById: jest.Mock };
  let repo: Record<string, jest.Mock>;
  let cache: { setPins: jest.Mock };
  let locks: { withLock: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomChatPinService;

  beforeEach(() => {
    permissions = { assertPermission: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue(ROOM) };
    repo = {
      findMessage: jest.fn().mockResolvedValue(MSG),
      findActivePin: jest.fn().mockResolvedValue(null),
      countActivePins: jest.fn().mockResolvedValue(0),
      createPin: jest.fn().mockResolvedValue({ id: 'p1' }),
      deactivatePin: jest.fn(),
      listActivePins: jest.fn().mockResolvedValue([]),
      listMessagesByIds: jest.fn().mockResolvedValue([]),
    };
    cache = { setPins: jest.fn() };
    // withLock must actually run the callback so the guarded logic is tested.
    locks = { withLock: jest.fn((_key, fn) => fn()) };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue({ maxPins: 3 }) };
    service = new VideoRoomChatPinService(
      permissions as never,
      rooms as never,
      repo as never,
      cache as never,
      locks as never,
      bus as never,
      config as never,
    );
  });

  it('requires PIN_MESSAGES before touching anything', async () => {
    permissions.assertPermission.mockRejectedValue(new Error('denied'));
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toThrow('denied');
    expect(repo.createPin).not.toHaveBeenCalled();
  });

  it('pins under a per-room lock so the cap cannot be raced', async () => {
    await service.pin(ACTOR as never, 'r1', 'm1');

    expect(locks.withLock).toHaveBeenCalledWith('video-room:chat:pin:{r1}', expect.any(Function));
    expect(repo.createPin).toHaveBeenCalledWith({
      roomId: 'r1',
      messageId: 'm1',
      pinnedBy: 'u1',
    });
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_pinned');
  });

  it('refuses to pin a message from another room', async () => {
    repo.findMessage.mockResolvedValue({ ...MSG, roomId: 'other' });
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('refuses to pin a deleted message', async () => {
    repo.findMessage.mockResolvedValue({ ...MSG, deletedAt: new Date() });
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('refuses a duplicate pin', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.ALREADY_PINNED,
    });
  });

  it('enforces the pin cap', async () => {
    repo.countActivePins.mockResolvedValue(3);
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.PIN_LIMIT_REACHED,
    });
  });

  it('refreshes the Redis pin set after pinning', async () => {
    repo.listActivePins.mockResolvedValue([{ messageId: 'm1' }, { messageId: 'm2' }]);
    await service.pin(ACTOR as never, 'r1', 'm1');
    expect(cache.setPins).toHaveBeenCalledWith('r1', ['m1', 'm2']);
  });

  it('unpins an active pin', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });
    await service.unpin(ACTOR as never, 'r1', 'm1');

    expect(repo.deactivatePin).toHaveBeenCalledWith('p1', 'u1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_unpinned');
  });

  it('404s when unpinning something that is not pinned', async () => {
    await expect(service.unpin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.PIN_NOT_FOUND,
    });
  });

  it('lists pinned messages in one batched query, not N+1', async () => {
    repo.listActivePins.mockResolvedValue([{ messageId: 'm1' }, { messageId: 'm2' }]);
    repo.listMessagesByIds.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);

    const result = await service.listPinned('r1');

    expect(repo.listMessagesByIds).toHaveBeenCalledWith(['m1', 'm2']);
    expect(repo.findMessage).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pin service**

Create `src/modules/video-rooms/services/video-room-chat-pin.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessage, VideoRoomMessagePin } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { videoRoomChatPinLockKey } from '../constants/video-room-chat.constants';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  ChatMessagePinnedEvent,
  ChatMessageUnpinnedEvent,
  type ChatAuditContext,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

/**
 * Pin / unpin, gated on the VR-1 `PIN_MESSAGES` permission that has sat unused
 * in the matrix since VR-1. Every mutation runs under a per-room lock so the pin
 * cap cannot be raced by two moderators pinning simultaneously — the check and
 * the insert must be atomic together, not merely individually correct.
 */
@Injectable()
export class VideoRoomChatPinService {
  constructor(
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async pin(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomMessagePin> {
    const room = await this.loadRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.PIN_MESSAGES);
    const { maxPins } = loadVideoRoomChatConfig(this.config);

    return this.locks.withLock(videoRoomChatPinLockKey(roomId), async () => {
      const message = await this.repo.findMessage(messageId);
      if (!message || message.roomId !== roomId || message.deletedAt || message.recalledAt) {
        throw new BusinessException(
          ERROR_CODES.MESSAGE_NOT_FOUND,
          'Message not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (await this.repo.findActivePin(roomId, messageId)) {
        throw new BusinessException(
          ERROR_CODES.ALREADY_PINNED,
          'That message is already pinned.',
          HttpStatus.CONFLICT,
        );
      }
      if ((await this.repo.countActivePins(roomId)) >= maxPins) {
        throw new BusinessException(
          ERROR_CODES.PIN_LIMIT_REACHED,
          `A room may have at most ${maxPins} pinned messages.`,
          HttpStatus.CONFLICT,
        );
      }

      const pin = await this.repo.createPin({ roomId, messageId, pinnedBy: actor.id });
      await this.refreshPinCache(roomId);
      await this.bus.publish(
        new ChatMessagePinnedEvent({ roomId, messageId, pinnedBy: actor.id, audit }),
      );
      return pin;
    });
  }

  async unpin(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    const room = await this.loadRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.PIN_MESSAGES);

    await this.locks.withLock(videoRoomChatPinLockKey(roomId), async () => {
      const pin = await this.repo.findActivePin(roomId, messageId);
      if (!pin) {
        throw new BusinessException(
          ERROR_CODES.PIN_NOT_FOUND,
          'That message is not pinned.',
          HttpStatus.NOT_FOUND,
        );
      }
      await this.repo.deactivatePin(pin.id, actor.id);
      await this.refreshPinCache(roomId);
      await this.bus.publish(
        new ChatMessageUnpinnedEvent({ roomId, messageId, unpinnedBy: actor.id, audit }),
      );
    });
  }

  /** Pinned messages, hydrated in ONE batched query (AR-4 loops per pin). */
  async listPinned(roomId: string): Promise<VideoRoomMessage[]> {
    const pins = await this.repo.listActivePins(roomId);
    return this.repo.listMessagesByIds(pins.map((p) => p.messageId));
  }

  private async refreshPinCache(roomId: string): Promise<void> {
    const pins = await this.repo.listActivePins(roomId);
    await this.cache.setPins(
      roomId,
      pins.map((p) => p.messageId),
    );
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1298 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat-pin.service.*
git commit -m "feat(video-rooms): VR-9 pin/unpin with lock-guarded cap"
```

---

### Task 13: Announcement service (existing table + stream projection)

Consumes the `video_room_announcements` table and the `VideoRoomEventsRepository` announcement CRUD that VR-1 landed with **zero call sites**.

**Files:**
- Create: `src/modules/video-rooms/services/video-room-announcement.service.ts`
- Create: `src/modules/video-rooms/services/video-room-announcement.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomEventsRepository.createAnnouncement` / `.listAnnouncements` / `.updateAnnouncement` / `.softDeleteAnnouncement`; `VideoRoomChatRepository.createMessage` / `.editMessage` / `.softDeleteMessage`; `VideoRoomPermissionService`; `VideoRoomChatPinService`.
- Produces:
```typescript
create(actor, roomId, dto: { content: string; isPinned?: boolean }, audit?): Promise<VideoRoomAnnouncement>
update(actor, roomId, announcementId, dto: { content?: string; isPinned?: boolean }, audit?): Promise<VideoRoomAnnouncement>
remove(actor, roomId, announcementId, audit?): Promise<void>
list(roomId: string): Promise<VideoRoomAnnouncement[]>
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-announcement.service.spec.ts`:

```typescript
import { VideoRoomMessageType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomAnnouncementService } from './video-room-announcement.service';

const ACTOR = { id: 'u1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const ANN = { id: 'a1', roomId: 'r1', authorId: 'u1', content: 'hello', isPinned: false };

describe('VideoRoomAnnouncementService', () => {
  let permissions: { assertPermission: jest.Mock };
  let rooms: { findById: jest.Mock };
  let events: Record<string, jest.Mock>;
  let chat: Record<string, jest.Mock>;
  let pins: { pin: jest.Mock; unpin: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomAnnouncementService;

  beforeEach(() => {
    permissions = { assertPermission: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue(ROOM) };
    events = {
      createAnnouncement: jest.fn().mockResolvedValue(ANN),
      listAnnouncements: jest.fn().mockResolvedValue([ANN]),
      updateAnnouncement: jest.fn().mockResolvedValue({ ...ANN, content: 'edited' }),
      softDeleteAnnouncement: jest.fn().mockResolvedValue(ANN),
    };
    chat = {
      createMessage: jest.fn().mockResolvedValue({ id: 'm1', createdAt: new Date() }),
      editMessage: jest.fn(),
      softDeleteMessage: jest.fn(),
    };
    pins = { pin: jest.fn(), unpin: jest.fn() };
    bus = { publish: jest.fn() };
    service = new VideoRoomAnnouncementService(
      permissions as never,
      rooms as never,
      events as never,
      chat as never,
      pins as never,
      bus as never,
    );
  });

  it('requires MANAGE_ANNOUNCEMENTS', async () => {
    permissions.assertPermission.mockRejectedValue(new Error('denied'));
    await expect(service.create(ACTOR as never, 'r1', { content: 'x' })).rejects.toThrow('denied');
    expect(events.createAnnouncement).not.toHaveBeenCalled();
  });

  it('writes the announcement row first, then projects a stream message linked back to it', async () => {
    await service.create(ACTOR as never, 'r1', { content: 'hello' });

    expect(events.createAnnouncement.mock.invocationCallOrder[0]).toBeLessThan(
      chat.createMessage.mock.invocationCallOrder[0],
    );
    expect(chat.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        type: VideoRoomMessageType.ANNOUNCEMENT,
        content: 'hello',
        metadata: { announcementId: 'a1' },
      }),
    );
  });

  it('pins the projected message when isPinned is set', async () => {
    await service.create(ACTOR as never, 'r1', { content: 'hello', isPinned: true });
    expect(pins.pin).toHaveBeenCalledWith(ACTOR, 'r1', 'm1', undefined);
  });

  it('publishes the created event carrying both ids', async () => {
    await service.create(ACTOR as never, 'r1', { content: 'hello' });

    const event = bus.publish.mock.calls[0][0];
    expect(event.name).toBe('video_room.chat_announcement_created');
    expect(event.payload).toMatchObject({ announcementId: 'a1', messageId: 'm1' });
  });

  it('keeps the projected message in sync on update', async () => {
    events.listAnnouncements.mockResolvedValue([ANN]);
    await service.update(ACTOR as never, 'r1', 'a1', { content: 'edited' });

    expect(events.updateAnnouncement).toHaveBeenCalled();
    expect(chat.editMessage).toHaveBeenCalledWith('m1', 'edited');
  });

  it('soft-deletes the projected message when the announcement is removed', async () => {
    await service.remove(ACTOR as never, 'r1', 'a1');

    expect(events.softDeleteAnnouncement).toHaveBeenCalledWith('a1', 'u1');
    expect(chat.softDeleteMessage).toHaveBeenCalledWith('m1', 'u1');
  });

  it('404s on an announcement from another room', async () => {
    events.listAnnouncements.mockResolvedValue([]);
    await expect(
      service.update(ACTOR as never, 'r1', 'missing', { content: 'x' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND });
  });

  it('survives a missing projection — the announcement table is the record of truth', async () => {
    // A lost projection is cosmetic, never data loss. It must not block the
    // announcement's own lifecycle.
    service = new VideoRoomAnnouncementService(
      permissions as never,
      rooms as never,
      { ...events, listAnnouncements: jest.fn().mockResolvedValue([{ ...ANN, messageId: null }]) } as never,
      chat as never,
      pins as never,
      bus as never,
    );

    await expect(service.remove(ACTOR as never, 'r1', 'a1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-announcement.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Store the projection link**

The projection needs a stable announcement→message link. `video_room_announcements` has no `messageId` column, so store it on the **message** side (`metadata.announcementId`, already written above) and resolve the reverse direction by querying messages. Add this lookup to `VideoRoomChatRepository`:

```typescript
  /** The ANNOUNCEMENT-type message projecting a given announcement, if any. */
  findByAnnouncementId(roomId: string, announcementId: string): Promise<VideoRoomMessage | null> {
    return this.prisma.videoRoomMessage.findFirst({
      where: {
        roomId,
        type: VideoRoomMessageType.ANNOUNCEMENT,
        metadata: { path: ['announcementId'], equals: announcementId },
      },
    });
  }
```

Add a matching repository spec case:

```typescript
  it('finds a projected message by announcement id via metadata path', async () => {
    await repo.findByAnnouncementId('r1', 'a1');
    expect(prisma.videoRoomMessage.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        roomId: 'r1',
        metadata: { path: ['announcementId'], equals: 'a1' },
      }),
    });
  });
```
(Add `findFirst: jest.fn().mockResolvedValue(null)` to the `videoRoomMessage` mock in that spec.)

- [ ] **Step 4: Implement the announcement service**

Create `src/modules/video-rooms/services/video-room-announcement.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { VideoRoomAnnouncement, VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  ChatAnnouncementCreatedEvent,
  ChatAnnouncementDeletedEvent,
  ChatAnnouncementUpdatedEvent,
  type ChatAuditContext,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomChatPinService } from './video-room-chat-pin.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

/**
 * Room announcements. `video_room_announcements` — built in VR-1 and unused until
 * now — stays the editable RECORD OF RECORD; every announcement is additionally
 * projected into the chat stream as an ANNOUNCEMENT-type message linked back via
 * `metadata.announcementId`, so it appears inline where the PRD says it should.
 *
 * The announcement row is always written FIRST. If the projection fails, the
 * announcement still exists and the loss is cosmetic — never the other way
 * round.
 */
@Injectable()
export class VideoRoomAnnouncementService {
  private readonly logger = new Logger(VideoRoomAnnouncementService.name);

  constructor(
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
    private readonly announcements: VideoRoomEventsRepository,
    private readonly chat: VideoRoomChatRepository,
    private readonly pins: VideoRoomChatPinService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async create(
    actor: RoomActor,
    roomId: string,
    dto: { content: string; isPinned?: boolean },
    audit?: ChatAuditContext,
  ): Promise<VideoRoomAnnouncement> {
    await this.authorize(actor, roomId);
    const content = dto.content.trim();

    const announcement = await this.announcements.createAnnouncement({
      roomId,
      authorId: actor.id,
      content,
      isPinned: dto.isPinned ?? false,
    });

    const message = await this.chat.createMessage({
      roomId,
      senderId: actor.id,
      type: VideoRoomMessageType.ANNOUNCEMENT,
      content,
      mentions: [],
      metadata: { announcementId: announcement.id },
    });

    if (dto.isPinned) await this.pins.pin(actor, roomId, message.id, audit);

    await this.bus.publish(
      new ChatAnnouncementCreatedEvent({
        roomId,
        announcementId: announcement.id,
        messageId: message.id,
        authorId: actor.id,
        content,
        isPinned: dto.isPinned ?? false,
        audit,
      }),
    );
    return announcement;
  }

  async update(
    actor: RoomActor,
    roomId: string,
    announcementId: string,
    dto: { content?: string; isPinned?: boolean },
    audit?: ChatAuditContext,
  ): Promise<VideoRoomAnnouncement> {
    await this.authorize(actor, roomId);
    await this.assertExists(roomId, announcementId);

    const content = dto.content?.trim();
    const updated = await this.announcements.updateAnnouncement(
      announcementId,
      {
        ...(content !== undefined ? { content } : {}),
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
      },
      actor.id,
    );

    const projection = await this.chat.findByAnnouncementId(roomId, announcementId);
    if (projection && content !== undefined) {
      await this.chat.editMessage(projection.id, content);
    }
    if (projection && dto.isPinned !== undefined) {
      await (dto.isPinned
        ? this.pins.pin(actor, roomId, projection.id, audit)
        : this.pins.unpin(actor, roomId, projection.id, audit)
      ).catch((error: Error) =>
        // Pin state is presentational; an already-pinned/not-pinned conflict
        // must not fail the announcement edit itself.
        this.logger.warn(`Announcement ${announcementId} pin sync skipped: ${error.message}`),
      );
    }

    await this.bus.publish(
      new ChatAnnouncementUpdatedEvent({
        roomId,
        announcementId,
        messageId: projection?.id ?? null,
        actorId: actor.id,
        content: updated.content,
        isPinned: updated.isPinned,
        audit,
      }),
    );
    return updated;
  }

  async remove(
    actor: RoomActor,
    roomId: string,
    announcementId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    await this.authorize(actor, roomId);
    await this.assertExists(roomId, announcementId);

    await this.announcements.softDeleteAnnouncement(announcementId, actor.id);

    const projection = await this.chat.findByAnnouncementId(roomId, announcementId);
    if (projection) await this.chat.softDeleteMessage(projection.id, actor.id);

    await this.bus.publish(
      new ChatAnnouncementDeletedEvent({
        roomId,
        announcementId,
        messageId: projection?.id ?? null,
        actorId: actor.id,
        audit,
      }),
    );
  }

  list(roomId: string): Promise<VideoRoomAnnouncement[]> {
    return this.announcements.listAnnouncements(roomId);
  }

  private async authorize(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.permissions.assertPermission(
      actor,
      room,
      VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
    );
  }

  private async assertExists(roomId: string, announcementId: string): Promise<void> {
    const all = await this.announcements.listAnnouncements(roomId);
    if (!all.some((a) => a.id === announcementId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND,
        'Announcement not found.',
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx jest src/modules/video-rooms/services/video-room-announcement.service.spec.ts \
         src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts
```
Expected: PASS — 8 + 8 tests.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1307 passing.

```bash
git add src/modules/video-rooms/services/video-room-announcement.service.* \
        src/modules/video-rooms/repositories/video-room-chat.repository.*
git commit -m "feat(video-rooms): VR-9 announcements over the existing VR-1 table with stream projection"
```

---

### Task 14: Query service — history, search, unread

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat-query.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat-query.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomChatRepository` read methods, `VideoRoomChatCacheService.readRecent`, `VideoRoomChatPolicyService.assertActiveMember`, `VideoRoomPermissionService`, `buildPaginated` / `Paginated`.
- Produces:
```typescript
history(actor, roomId, q: HistoryQuery): Promise<Paginated<ChatMessagePayload>>
search(actor, roomId, q: SearchQuery): Promise<Paginated<ChatMessagePayload>>
unreadCount(actor, roomId): Promise<{ unread: number }>
// HistoryQuery = { page, limit, skip, before?, order?: 'asc'|'desc' }
// SearchQuery  = { page, limit, skip, q?, senderId?, type?, from?, to? }
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-chat-query.service.spec.ts`:

```typescript
import { VideoRoomMemberRole } from '@prisma/client';
import { VideoRoomChatQueryService } from './video-room-chat-query.service';

const ACTOR = { id: 'u1', roles: [] };
const ROW = {
  id: 'm1',
  roomId: 'r1',
  senderId: 'u1',
  type: 'TEXT',
  content: 'hi',
  mentions: [],
  mentionScope: null,
  replyToId: null,
  metadata: null,
  createdAt: new Date('2026-07-21T00:00:00Z'),
};

describe('VideoRoomChatQueryService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: { readRecent: jest.Mock };
  let policy: { assertActiveMember: jest.Mock };
  let rooms: { findById: jest.Mock };
  let permissions: { resolveEffectiveRole: jest.Mock };
  let service: VideoRoomChatQueryService;

  beforeEach(() => {
    repo = {
      listMessages: jest.fn().mockResolvedValue([[ROW], 1]),
      searchMessages: jest.fn().mockResolvedValue([[ROW], 1]),
      findCursor: jest.fn().mockResolvedValue(null),
      countUnread: jest.fn().mockResolvedValue(7),
    };
    cache = { readRecent: jest.fn().mockResolvedValue([]) };
    policy = { assertActiveMember: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'o1' }) };
    permissions = {
      resolveEffectiveRole: jest.fn().mockResolvedValue(VideoRoomMemberRole.VIEWER),
    };
    service = new VideoRoomChatQueryService(
      repo as never,
      cache as never,
      policy as never,
      rooms as never,
      permissions as never,
    );
  });

  it('serves page 1 from the Redis ring buffer without touching Postgres', async () => {
    cache.readRecent.mockResolvedValue([{ messageId: 'm1', roomId: 'r1' }]);

    const result = await service.history(ACTOR as never, 'r1', {
      page: 1,
      limit: 20,
      skip: 0,
    });

    expect(cache.readRecent).toHaveBeenCalledWith('r1', 20);
    expect(repo.listMessages).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it('falls through to Postgres on a cold buffer', async () => {
    cache.readRecent.mockResolvedValue([]);

    await service.history(ACTOR as never, 'r1', { page: 1, limit: 20, skip: 0 });

    expect(repo.listMessages).toHaveBeenCalled();
  });

  it('never uses the buffer for deep pages or keyset reads', async () => {
    await service.history(ACTOR as never, 'r1', { page: 2, limit: 20, skip: 20 });
    expect(cache.readRecent).not.toHaveBeenCalled();

    cache.readRecent.mockClear();
    await service.history(ACTOR as never, 'r1', { page: 1, limit: 20, skip: 0, before: 'm9' });
    expect(cache.readRecent).not.toHaveBeenCalled();
  });

  it('shows soft-deleted rows to moderators only', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);

    await service.history(ACTOR as never, 'r1', { page: 2, limit: 20, skip: 20 });

    expect(repo.listMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ includeDeleted: true }),
    );
  });

  it('hides soft-deleted rows from ordinary members', async () => {
    await service.history(ACTOR as never, 'r1', { page: 2, limit: 20, skip: 20 });

    expect(repo.listMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ includeDeleted: false }),
    );
  });

  it('requires active membership before reading anything', async () => {
    policy.assertActiveMember.mockRejectedValue(new Error('not a member'));
    await expect(
      service.history(ACTOR as never, 'r1', { page: 1, limit: 20, skip: 0 }),
    ).rejects.toThrow('not a member');
  });

  it('passes every search filter through', async () => {
    const from = new Date('2026-07-01');
    await service.search(ACTOR as never, 'r1', {
      page: 1,
      limit: 20,
      skip: 0,
      q: 'hello',
      senderId: 'u2',
      from,
    });

    expect(repo.searchMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ term: 'hello', senderId: 'u2', from }),
    );
  });

  it('counts everything unread when the user has no cursor yet', async () => {
    const result = await service.unreadCount(ACTOR as never, 'r1');
    expect(repo.countUnread).toHaveBeenCalledWith('r1', null);
    expect(result).toEqual({ unread: 7 });
  });

  it('counts from the read mark once a cursor exists', async () => {
    const at = new Date('2026-07-21T00:00:00Z');
    repo.findCursor.mockResolvedValue({ lastReadAt: at });

    await service.unreadCount(ACTOR as never, 'r1');

    expect(repo.countUnread).toHaveBeenCalledWith('r1', at);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-query.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the query service**

Create `src/modules/video-rooms/services/video-room-chat-query.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { VideoRoomMessage, VideoRoomMessageType } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type { ChatMessagePayload } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ELEVATED_VIDEO_ROOM_ROLES } from '../constants/video-room-permissions';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface HistoryQuery {
  page: number;
  limit: number;
  skip: number;
  before?: string;
  order?: 'asc' | 'desc';
}

export interface SearchQuery {
  page: number;
  limit: number;
  skip: number;
  q?: string;
  senderId?: string;
  type?: VideoRoomMessageType;
  from?: Date;
  to?: Date;
}

/**
 * The read side of VR-9 chat (CQRS-ready split, mirroring VR-2's
 * lifecycle/query separation).
 *
 * The Redis ring buffer is consulted ONLY for the natural hot path: page 1,
 * newest-first, no keyset cursor. That is the request 10k viewers all issue when
 * they join a live room, and serving it from memory is the entire point. Deep
 * pages and keyset reads go to Postgres, where the composite indexes live.
 */
@Injectable()
export class VideoRoomChatQueryService {
  constructor(
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    private readonly policy: VideoRoomChatPolicyService,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
  ) {}

  async history(
    actor: RoomActor,
    roomId: string,
    q: HistoryQuery,
  ): Promise<Paginated<ChatMessagePayload>> {
    await this.policy.assertActiveMember(roomId, actor.id);

    const isHotPage = q.page === 1 && !q.before && (q.order ?? 'desc') === 'desc';
    if (isHotPage) {
      const cached = await this.cache.readRecent(roomId, q.limit);
      if (cached.length > 0) return buildPaginated(cached, cached.length, q.page, q.limit);
    }

    const includeDeleted = await this.canSeeDeleted(actor, roomId);
    const [rows, total] = await this.repo.listMessages(roomId, {
      skip: q.skip,
      take: q.limit,
      before: q.before,
      includeDeleted,
      order: q.order,
    });
    return buildPaginated(rows.map((r) => this.toPayload(r)), total, q.page, q.limit);
  }

  async search(
    actor: RoomActor,
    roomId: string,
    q: SearchQuery,
  ): Promise<Paginated<ChatMessagePayload>> {
    await this.policy.assertActiveMember(roomId, actor.id);

    const [rows, total] = await this.repo.searchMessages(roomId, {
      skip: q.skip,
      take: q.limit,
      term: q.q,
      senderId: q.senderId,
      type: q.type,
      from: q.from,
      to: q.to,
    });
    return buildPaginated(rows.map((r) => this.toPayload(r)), total, q.page, q.limit);
  }

  /** Visible messages newer than the caller's read mark. */
  async unreadCount(actor: RoomActor, roomId: string): Promise<{ unread: number }> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const cursor = await this.repo.findCursor(roomId, actor.id);
    const unread = await this.repo.countUnread(roomId, cursor?.lastReadAt ?? null);
    return { unread };
  }

  /** Moderators see soft-deleted rows; recalled rows stay hidden from everyone. */
  private async canSeeDeleted(actor: RoomActor, roomId: string): Promise<boolean> {
    const room = await this.rooms.findById(roomId);
    if (!room) return false;
    const role = await this.permissions.resolveEffectiveRole(room, actor.id);
    return role !== null && ELEVATED_VIDEO_ROOM_ROLES.includes(role);
  }

  private toPayload(message: VideoRoomMessage): ChatMessagePayload {
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    return {
      roomId: message.roomId,
      messageId: message.id,
      senderId: message.senderId,
      type: message.type,
      // A soft-deleted row reaching a moderator keeps its content; for everyone
      // else the repository filtered it out before we got here.
      content: message.content,
      mentions: message.mentions,
      mentionScope: message.mentionScope,
      replyToId: message.replyToId,
      createdAt: message.createdAt.toISOString(),
      ...(typeof metadata.announcementId === 'string'
        ? { announcementId: metadata.announcementId }
        : {}),
      ...(typeof metadata.systemEvent === 'string' ? { systemEvent: metadata.systemEvent } : {}),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-query.service.spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1316 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat-query.service.*
git commit -m "feat(video-rooms): VR-9 chat history, search and unread counts"
```

---

### Task 15: Typing service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-typing.service.ts`
- Create: `src/modules/video-rooms/services/video-room-typing.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomChatCacheService.markTyping` / `.clearTyping` / `.readTyping`, `VideoRoomChatPolicyService.assertActiveMember`, `EVENT_BUS`, config `typingTtlSeconds`.
- Produces: `start(actor, roomId)`, `stop(actor, roomId)`, `roster(roomId): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-typing.service.spec.ts`:

```typescript
import { VideoRoomTypingService } from './video-room-typing.service';

const ACTOR = { id: 'u1', roles: [] };

describe('VideoRoomTypingService', () => {
  let cache: { markTyping: jest.Mock; clearTyping: jest.Mock; readTyping: jest.Mock };
  let policy: { assertActiveMember: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomTypingService;

  beforeEach(() => {
    cache = {
      markTyping: jest.fn(),
      clearTyping: jest.fn(),
      readTyping: jest.fn().mockResolvedValue(['u1', 'u2']),
    };
    policy = { assertActiveMember: jest.fn() };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue({ typingTtlSeconds: 5 }) };
    service = new VideoRoomTypingService(
      cache as never,
      policy as never,
      bus as never,
      config as never,
    );
  });

  it('marks the user typing with the configured TTL and announces it', async () => {
    await service.start(ACTOR as never, 'r1');

    expect(policy.assertActiveMember).toHaveBeenCalledWith('r1', 'u1');
    expect(cache.markTyping).toHaveBeenCalledWith('r1', 'u1', 5);
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_typing_started');
  });

  it('clears the marker and announces a stop', async () => {
    await service.stop(ACTOR as never, 'r1');

    expect(cache.clearTyping).toHaveBeenCalledWith('r1', 'u1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_typing_stopped');
  });

  it('reads the roster, letting the cache prune expired entries', async () => {
    const roster = await service.roster('r1');
    expect(cache.readTyping).toHaveBeenCalledWith('r1', expect.any(Number));
    expect(roster).toEqual(['u1', 'u2']);
  });

  it('rejects a non-member typing', async () => {
    policy.assertActiveMember.mockRejectedValue(new Error('not a member'));
    await expect(service.start(ACTOR as never, 'r1')).rejects.toThrow('not a member');
    expect(cache.markTyping).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-typing.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the typing service**

Create `src/modules/video-rooms/services/video-room-typing.service.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import {
  ChatTypingStartedEvent,
  ChatTypingStoppedEvent,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';

/**
 * Typing indicators — entirely ephemeral, entirely Redis. Nothing is persisted:
 * a typing signal has no value one second after it stops being true.
 *
 * A forgotten "stop" (tab closed, network dropped, process killed) self-heals
 * because the roster entry carries an absolute expiry that any reader on any
 * instance prunes. There is no sweeper to run and nothing to leak.
 */
@Injectable()
export class VideoRoomTypingService {
  constructor(
    private readonly cache: VideoRoomChatCacheService,
    private readonly policy: VideoRoomChatPolicyService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async start(actor: RoomActor, roomId: string): Promise<void> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const { typingTtlSeconds } = loadVideoRoomChatConfig(this.config);
    await this.cache.markTyping(roomId, actor.id, typingTtlSeconds);
    await this.bus.publish(new ChatTypingStartedEvent({ roomId, userId: actor.id }));
  }

  async stop(actor: RoomActor, roomId: string): Promise<void> {
    await this.policy.assertActiveMember(roomId, actor.id);
    await this.cache.clearTyping(roomId, actor.id);
    await this.bus.publish(new ChatTypingStoppedEvent({ roomId, userId: actor.id }));
  }

  /** Currently-typing user ids (expired entries pruned on read). */
  roster(roomId: string): Promise<string[]> {
    return this.cache.readTyping(roomId, Date.now());
  }
}
```

- [ ] **Step 4: Run the test, verify, commit**

Run: `npx jest src/modules/video-rooms/services/video-room-typing.service.spec.ts`
Expected: PASS — 4 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1320 passing.

```bash
git add src/modules/video-rooms/services/video-room-typing.service.*
git commit -m "feat(video-rooms): VR-9 typing indicators (ephemeral, self-healing)"
```

---

### Task 16: Read-receipt service (cursors)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-chat-receipt.service.ts`
- Create: `src/modules/video-rooms/services/video-room-chat-receipt.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomChatRepository.findMessage` / `.findCursor` / `.upsertCursor` / `.listReaders`, `VideoRoomChatPolicyService.assertActiveMember`, `CacheService`, `REDIS_CLIENT`, `EVENT_BUS`, config `receiptThrottleMs`.
- Produces:
```typescript
markDelivered(actor, roomId, messageId): Promise<void>
markRead(actor, roomId, messageId): Promise<void>
readers(actor, roomId, messageId): Promise<{ userIds: string[] }>
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-chat-receipt.service.spec.ts`:

```typescript
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatReceiptService } from './video-room-chat-receipt.service';

const ACTOR = { id: 'u1', roles: [] };
const AT = new Date('2026-07-21T10:00:00Z');
const MSG = { id: 'm5', roomId: 'r1', createdAt: AT };

describe('VideoRoomChatReceiptService', () => {
  let repo: Record<string, jest.Mock>;
  let policy: { assertActiveMember: jest.Mock };
  let redis: { set: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomChatReceiptService;

  beforeEach(() => {
    repo = {
      findMessage: jest.fn().mockResolvedValue(MSG),
      findCursor: jest.fn().mockResolvedValue(null),
      upsertCursor: jest.fn(),
      listReaders: jest.fn().mockResolvedValue([{ userId: 'u2' }, { userId: 'u3' }]),
    };
    policy = { assertActiveMember: jest.fn() };
    redis = { set: jest.fn().mockResolvedValue('OK') };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue({ receiptThrottleMs: 2000 }) };
    service = new VideoRoomChatReceiptService(
      repo as never,
      policy as never,
      redis as never,
      bus as never,
      config as never,
    );
  });

  it('advances the read cursor and publishes', async () => {
    await service.markRead(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: 'u1',
      readMessageId: 'm5',
      readAt: AT,
    });
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_read');
  });

  it('ignores a cursor that would move BACKWARDS', async () => {
    // Out-of-order receipts are normal on a lossy mobile connection. A
    // high-water mark that can retreat is not a high-water mark.
    repo.findCursor.mockResolvedValue({ lastReadAt: new Date('2026-07-21T11:00:00Z') });

    await service.markRead(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('advances when the new mark is strictly newer', async () => {
    repo.findCursor.mockResolvedValue({ lastReadAt: new Date('2026-07-21T09:00:00Z') });
    await service.markRead(ACTOR as never, 'r1', 'm5');
    expect(repo.upsertCursor).toHaveBeenCalled();
  });

  it('throttles repeated receipts inside the window', async () => {
    // SET NX returns null ⇒ a receipt was already recorded very recently.
    redis.set.mockResolvedValue(null);

    await service.markRead(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).not.toHaveBeenCalled();
  });

  it('advances the delivered cursor independently of read', async () => {
    await service.markDelivered(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: 'u1',
      deliveredMessageId: 'm5',
      deliveredAt: AT,
    });
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_delivered');
  });

  it('404s on a message from another room', async () => {
    repo.findMessage.mockResolvedValue({ ...MSG, roomId: 'other' });
    await expect(service.markRead(ACTOR as never, 'r1', 'm5')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('derives the reader list from cursors at or past the message', async () => {
    const result = await service.readers(ACTOR as never, 'r1', 'm5');

    expect(repo.listReaders).toHaveBeenCalledWith('r1', AT);
    expect(result).toEqual({ userIds: ['u2', 'u3'] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-receipt.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the receipt service**

Create `src/modules/video-rooms/services/video-room-chat-receipt.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessage } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { videoRoomChatCursorKey } from '../constants/video-room-chat.constants';
import {
  ChatMessageDeliveredEvent,
  ChatMessageReadEvent,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';

/**
 * Read receipts as a HIGH-WATER MARK, one row per (room, user) — never one row
 * per (message, user). A 10k-viewer room at 500 msg/min would generate 5M receipt
 * rows a minute under the per-message shape; here it generates 10k rows total,
 * updated in place. The reader list is derived, not stored:
 *   readers(M) = cursors whose lastReadAt >= M.createdAt
 *
 * Two properties make this safe on a lossy mobile connection: the cursor only
 * ever moves FORWARD (an out-of-order receipt is dropped, not applied), and
 * repeated receipts are throttled through a short Redis NX window so a chatty
 * client cannot turn scroll events into a write storm.
 */
@Injectable()
export class VideoRoomChatReceiptService {
  constructor(
    private readonly repo: VideoRoomChatRepository,
    private readonly policy: VideoRoomChatPolicyService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async markDelivered(actor: RoomActor, roomId: string, messageId: string): Promise<void> {
    const message = await this.prepare(actor, roomId, messageId, 'delivered');
    if (!message) return;

    await this.repo.upsertCursor({
      roomId,
      userId: actor.id,
      deliveredMessageId: messageId,
      deliveredAt: message.createdAt,
    });
    await this.bus.publish(
      new ChatMessageDeliveredEvent({
        roomId,
        userId: actor.id,
        messageId,
        at: message.createdAt.toISOString(),
      }),
    );
  }

  async markRead(actor: RoomActor, roomId: string, messageId: string): Promise<void> {
    const message = await this.prepare(actor, roomId, messageId, 'read');
    if (!message) return;

    const cursor = await this.repo.findCursor(roomId, actor.id);
    // Monotonic: a mark that would move the cursor backwards is discarded.
    if (cursor?.lastReadAt && cursor.lastReadAt >= message.createdAt) return;

    await this.repo.upsertCursor({
      roomId,
      userId: actor.id,
      readMessageId: messageId,
      readAt: message.createdAt,
    });
    await this.bus.publish(
      new ChatMessageReadEvent({
        roomId,
        userId: actor.id,
        messageId,
        at: message.createdAt.toISOString(),
      }),
    );
  }

  /** Who has read at least as far as this message. */
  async readers(
    actor: RoomActor,
    roomId: string,
    messageId: string,
  ): Promise<{ userIds: string[] }> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const message = await this.load(roomId, messageId);
    const cursors = await this.repo.listReaders(roomId, message.createdAt);
    return { userIds: cursors.map((c) => c.userId) };
  }

  /**
   * Shared preamble: membership, message lookup, and the throttle claim.
   * Returns null when the throttle rejects, meaning the caller should no-op.
   */
  private async prepare(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    kind: 'read' | 'delivered',
  ): Promise<VideoRoomMessage | null> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const message = await this.load(roomId, messageId);

    const { receiptThrottleMs } = loadVideoRoomChatConfig(this.config);
    const claimed = await this.redis.set(
      `${videoRoomChatCursorKey(roomId, actor.id)}:${kind}`,
      messageId,
      'PX',
      receiptThrottleMs,
      'NX',
    );
    return claimed === null ? null : message;
  }

  private async load(roomId: string, messageId: string): Promise<VideoRoomMessage> {
    const message = await this.repo.findMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_NOT_FOUND,
        'Message not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return message;
  }
}
```

- [ ] **Step 4: Run the test, verify, commit**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-receipt.service.spec.ts`
Expected: PASS — 7 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1327 passing.

```bash
git add src/modules/video-rooms/services/video-room-chat-receipt.service.*
git commit -m "feat(video-rooms): VR-9 read receipts as monotonic high-water cursors"
```

---

### Task 17: System messages + the policy map

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-system-message.policy.ts`
- Create: `src/modules/video-rooms/services/video-room-system-message.service.ts`
- Create: `src/modules/video-rooms/services/video-room-system-message.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomChatRepository.createMessage`, `VideoRoomChatCacheService.pushRecent`, `VideoRoomPresenceService` (viewer count), `EVENT_BUS`, config thresholds, `VIDEO_ROOM_SYSTEM_ACTOR_ID`.
- Produces: `SYSTEM_MESSAGE_POLICY` (a `Record<string, SystemMessagePolicy>`) and `VideoRoomSystemMessageService.emit(kind: string, roomId: string, data: Record<string, unknown>): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-system-message.service.spec.ts`:

```typescript
import { VideoRoomMessageType } from '@prisma/client';
import { VideoRoomSystemMessageService } from './video-room-system-message.service';

const CFG = {
  systemMessageBroadcastOnlyAboveViewers: 200,
  systemMessageSuppressAboveViewers: 2000,
};

describe('VideoRoomSystemMessageService', () => {
  let repo: { createMessage: jest.Mock };
  let cache: { pushRecent: jest.Mock };
  let presence: { viewerCount: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomSystemMessageService;

  beforeEach(() => {
    repo = {
      createMessage: jest.fn().mockResolvedValue({
        id: 'm1',
        roomId: 'r1',
        senderId: '00000000-0000-0000-0000-000000000000',
        type: VideoRoomMessageType.SYSTEM,
        content: 'x',
        mentions: [],
        mentionScope: null,
        replyToId: null,
        metadata: { systemEvent: 'USER_JOINED' },
        createdAt: new Date(),
      }),
    };
    cache = { pushRecent: jest.fn() };
    presence = { viewerCount: jest.fn().mockResolvedValue(10) };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue(CFG) };
    service = new VideoRoomSystemMessageService(
      repo as never,
      cache as never,
      presence as never,
      bus as never,
      config as never,
    );
  });

  it('persists a lifecycle event and broadcasts it', async () => {
    await service.emit('OWNER_CHANGED', 'r1', { newOwnerId: 'u2' });

    expect(repo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VideoRoomMessageType.SYSTEM,
        senderId: '00000000-0000-0000-0000-000000000000',
      }),
    );
    expect(bus.publish).toHaveBeenCalled();
  });

  it('persists a viewer join in a small room', async () => {
    await service.emit('VIEWER_JOINED', 'r1', { userId: 'u2' });
    expect(repo.createMessage).toHaveBeenCalled();
  });

  it('broadcasts but does NOT persist a viewer join in a large room', async () => {
    // Above the threshold a join message is churn, not conversation. Persisting
    // it would leave totalChatMessages measuring turnover instead of chat.
    presence.viewerCount.mockResolvedValue(500);

    await service.emit('VIEWER_JOINED', 'r1', { userId: 'u2' });

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('suppresses a viewer join entirely in a huge room', async () => {
    presence.viewerCount.mockResolvedValue(5000);

    await service.emit('VIEWER_JOINED', 'r1', { userId: 'u2' });

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('NEVER suppresses a lifecycle event, however large the room', async () => {
    presence.viewerCount.mockResolvedValue(50_000);

    await service.emit('ROOM_CLOSED', 'r1', {});

    expect(repo.createMessage).toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('ignores an unmapped kind rather than emitting something wrong', async () => {
    await service.emit('NOT_A_REAL_EVENT', 'r1', {});

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('never counts viewers for an always-persist event', async () => {
    await service.emit('SEAT_APPROVED', 'r1', { userId: 'u2' });
    expect(presence.viewerCount).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-system-message.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the policy map**

Create `src/modules/video-rooms/constants/video-room-system-message.policy.ts`:

```typescript
/**
 * What happens when a domain event becomes a system message.
 *
 * Persisting one message per join would make chat unusable in exactly the rooms
 * VR-9 was built for: a 10k-viewer room churning viewers writes more system rows
 * than human messages, buries real conversation, and leaves
 * `VideoRoomStatistics.totalChatMessages` measuring turnover rather than chat.
 *
 * So high-frequency, low-value events degrade with room size — broadcast-only
 * past one threshold, suppressed past a second — while lifecycle and moderation
 * events always persist no matter how large the room.
 */
export interface SystemMessagePolicy {
  /** Human-readable template; `{userId}` etc. are substituted by the service. */
  template: string;
  /** Write a durable row. */
  persist: boolean;
  /** Degrade to broadcast-only above `videoRoomChat.systemMessageBroadcastOnlyAboveViewers`. */
  degradesWithRoomSize: boolean;
}

export const SYSTEM_MESSAGE_POLICY: Record<string, SystemMessagePolicy> = {
  // ---- Always persist: lifecycle, ownership, moderation, seat decisions ----
  ROOM_LOCKED: { template: 'The room was locked.', persist: true, degradesWithRoomSize: false },
  ROOM_UNLOCKED: { template: 'The room was unlocked.', persist: true, degradesWithRoomSize: false },
  ROOM_CLOSED: { template: 'The room has ended.', persist: true, degradesWithRoomSize: false },
  OWNER_CHANGED: { template: 'Room ownership was transferred.', persist: true, degradesWithRoomSize: false },
  SEAT_APPROVED: { template: 'A seat request was approved.', persist: true, degradesWithRoomSize: false },
  SEAT_REJECTED: { template: 'A seat request was rejected.', persist: true, degradesWithRoomSize: false },
  SEAT_INVITATION: { template: 'A user was invited to a seat.', persist: true, degradesWithRoomSize: false },
  PROMOTED: { template: 'A viewer was promoted to the stage.', persist: true, degradesWithRoomSize: false },
  DEMOTED: { template: 'A participant was moved to the audience.', persist: true, degradesWithRoomSize: false },

  // ---- Degrade with room size: presence churn ----
  USER_JOINED: { template: 'A user joined the room.', persist: true, degradesWithRoomSize: true },
  USER_LEFT: { template: 'A user left the room.', persist: true, degradesWithRoomSize: true },
  VIEWER_JOINED: { template: 'A viewer joined.', persist: true, degradesWithRoomSize: true },
  VIEWER_LEFT: { template: 'A viewer left.', persist: true, degradesWithRoomSize: true },
};
```

- [ ] **Step 4: Implement the service**

Create `src/modules/video-rooms/services/video-room-system-message.service.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { SYSTEM_MESSAGE_POLICY } from '../constants/video-room-system-message.policy';
import { VIDEO_ROOM_SYSTEM_ACTOR_ID } from '../constants/video-room.constants';
import {
  ChatMessageSentEvent,
  type ChatMessagePayload,
} from '../events/video-room-chat.events';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomPresenceService } from './video-room-presence.service';

/**
 * Turns domain events into chat system messages, governed by
 * `SYSTEM_MESSAGE_POLICY`. An UNMAPPED kind emits nothing at all — the VR-8
 * lesson that silence always beats guessing at the right message.
 */
@Injectable()
export class VideoRoomSystemMessageService {
  constructor(
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    private readonly presence: VideoRoomPresenceService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async emit(kind: string, roomId: string, data: Record<string, unknown>): Promise<void> {
    const policy = SYSTEM_MESSAGE_POLICY[kind];
    if (!policy) return;

    let persist = policy.persist;

    if (policy.degradesWithRoomSize) {
      const cfg = loadVideoRoomChatConfig(this.config);
      const viewers = await this.presence.viewerCount(roomId);
      if (viewers > cfg.systemMessageSuppressAboveViewers) return;
      if (viewers > cfg.systemMessageBroadcastOnlyAboveViewers) persist = false;
    }

    const payload = persist
      ? await this.persistRow(kind, roomId, policy.template, data)
      : this.ephemeralPayload(kind, roomId, policy.template, data);

    await this.bus.publish(new ChatMessageSentEvent(payload));
  }

  private async persistRow(
    kind: string,
    roomId: string,
    content: string,
    data: Record<string, unknown>,
  ): Promise<ChatMessagePayload> {
    const message = await this.repo.createMessage({
      roomId,
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      mentions: [],
      metadata: { systemEvent: kind, ...data } as never,
    });
    const payload: ChatMessagePayload = {
      roomId,
      messageId: message.id,
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: message.createdAt.toISOString(),
      systemEvent: kind,
    };
    await this.cache.pushRecent(roomId, payload);
    return payload;
  }

  /** Broadcast-only: no row, no id — clients render it and forget it. */
  private ephemeralPayload(
    kind: string,
    roomId: string,
    content: string,
    _data: Record<string, unknown>,
  ): ChatMessagePayload {
    return {
      roomId,
      messageId: '',
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: new Date().toISOString(),
      systemEvent: kind,
    };
  }
}
```

- [ ] **Step 5: Confirm the presence method name**

Run: `grep -n "viewerCount\|async count" src/modules/video-rooms/services/video-room-presence.service.ts`
If the viewer-count method has a different name, use the shipped name in both the service and its spec.

- [ ] **Step 6: Run the test, verify, commit**

Run: `npx jest src/modules/video-rooms/services/video-room-system-message.service.spec.ts`
Expected: PASS — 7 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1334 passing.

```bash
git add src/modules/video-rooms/services/video-room-system-message.service.* \
        src/modules/video-rooms/constants/video-room-system-message.policy.ts
git commit -m "feat(video-rooms): VR-9 system messages with room-size degradation policy"
```

---

### Task 18: DTOs

**Files:**
- Create: `src/modules/video-rooms/dto/chat/send-chat-message.dto.ts`
- Create: `src/modules/video-rooms/dto/chat/edit-chat-message.dto.ts`
- Create: `src/modules/video-rooms/dto/chat/pin-chat-message.dto.ts`
- Create: `src/modules/video-rooms/dto/chat/list-chat-messages.dto.ts`
- Create: `src/modules/video-rooms/dto/chat/search-chat-messages.dto.ts`
- Create: `src/modules/video-rooms/dto/chat/chat-receipt.dto.ts`
- Create: `src/modules/video-rooms/dto/chat/chat-message.view.ts`
- Create: `src/modules/video-rooms/dto/chat/index.ts`
- Modify: `src/modules/video-rooms/dto/index.ts`

**Interfaces:**
- Consumes: Task 1's enums; Task 2's bounds; the existing `PaginationQueryDto` base used by `list-video-rooms.dto.ts`.
- Produces: `SendChatMessageDto`, `EditChatMessageDto`, `PinChatMessageDto`, `ListChatMessagesDto`, `SearchChatMessagesDto`, `ChatReceiptDto`, `ChatMessageView`. The **existing** `CreateVideoRoomAnnouncementDto` / `UpdateVideoRoomAnnouncementDto` are reused unchanged from `dto/announcement.dto.ts`.

- [ ] **Step 1: Read the shipped pagination DTO base**

Run: `sed -n '1,40p' src/modules/video-rooms/dto/list-video-rooms.dto.ts`
Use whatever base class / `skip` getter convention it establishes — `ListChatMessagesDto` and `SearchChatMessagesDto` must extend the same one so `page`/`limit`/`skip` behave identically across the module.

- [ ] **Step 2: Write the DTO validation test**

Create `src/modules/video-rooms/dto/chat/chat-dto.spec.ts`:

```typescript
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendChatMessageDto } from './send-chat-message.dto';
import { SearchChatMessagesDto } from './search-chat-messages.dto';

describe('chat DTO validation', () => {
  it('accepts a plain text message', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: 'hello' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects empty content', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: '' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an unknown message type', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: 'x', type: 'TELEPATHY' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects a non-uuid replyToId', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: 'x', replyToId: 'nope' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('coerces search dates from ISO strings', async () => {
    const dto = plainToInstance(SearchChatMessagesDto, { q: 'hi', from: '2026-07-01' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.from).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/chat/chat-dto.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the DTOs**

Create `src/modules/video-rooms/dto/chat/send-chat-message.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMessageType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH } from '../../constants/video-room-chat.constants';

/**
 * Send a room chat message. The hard ceiling here is a safety bound; the room's
 * own `chatMaxMessageLength` is enforced by ChatPolicyService, which is the only
 * place that knows the room's settings.
 *
 * SYSTEM is intentionally NOT an accepted type — system rows are platform-minted
 * (ChatPolicyService rejects a client-supplied SYSTEM message outright).
 */
export class SendChatMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 4000, example: 'hey @alice 👋' })
  @IsString()
  @Length(1, 4000)
  content!: string;

  @ApiPropertyOptional({
    enum: VideoRoomMessageType,
    default: VideoRoomMessageType.TEXT,
    description: `Emoji messages are capped at ${VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH} characters.`,
  })
  @IsOptional()
  @IsEnum(VideoRoomMessageType)
  type?: VideoRoomMessageType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Message being replied to.' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Original message, when forwarding.' })
  @IsOptional()
  @IsUUID()
  forwardedFromId?: string;

  @ApiPropertyOptional({
    type: [Object],
    description: 'Future-ready attachment descriptors. No upload pipeline ships in VR-9.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  attachments?: unknown[];
}
```

Create `src/modules/video-rooms/dto/chat/edit-chat-message.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Edit a message's content. Author-only, inside the edit window. */
export class EditChatMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @IsString()
  @Length(1, 4000)
  content!: string;
}
```

Create `src/modules/video-rooms/dto/chat/pin-chat-message.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Pin a message. Requires the PIN_MESSAGES permission. */
export class PinChatMessageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId!: string;
}
```

Create `src/modules/video-rooms/dto/chat/list-chat-messages.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/**
 * Chat history. Supports BOTH pagination styles on purpose: `before` gives
 * keyset pagination (stable and cheap at depth — the scalable path), while
 * `page`/`limit` keeps parity with the platform's paginated envelope. Supplying
 * `before` suppresses `skip`.
 */
export class ListChatMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Keyset cursor: messages older than this id.' })
  @IsOptional()
  @IsUUID()
  before?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
```

If `src/common/dto/pagination.dto.ts` does not exist under that exact path, use whatever base `list-video-rooms.dto.ts` extends (confirmed in Step 1) and adjust the import.

Create `src/modules/video-rooms/dto/chat/search-chat-messages.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMessageType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { VIDEO_ROOM_CHAT_SEARCH_TERM_MAX } from '../../constants/video-room-chat.constants';

/** Search room chat by keyword, sender, type and date range. */
export class SearchChatMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_CHAT_SEARCH_TERM_MAX, example: 'hello' })
  @IsOptional()
  @IsString()
  @Length(1, VIDEO_ROOM_CHAT_SEARCH_TERM_MAX)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  senderId?: string;

  @ApiPropertyOptional({ enum: VideoRoomMessageType })
  @IsOptional()
  @IsEnum(VideoRoomMessageType)
  type?: VideoRoomMessageType;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
```

Create `src/modules/video-rooms/dto/chat/chat-receipt.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Advance a delivered/read cursor to a given message. */
export class ChatReceiptDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId!: string;
}
```

Create `src/modules/video-rooms/dto/chat/chat-message.view.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMessageType } from '@prisma/client';

/**
 * The client-facing message status. SENDING and FAILED are CLIENT-ONLY (the row
 * does not exist server-side yet); DELIVERED and READ are per-recipient facts
 * derived from `video_room_chat_cursors`, never properties of the message. Only
 * SENT / EDITED / DELETED / RECALLED are derivable from the row itself.
 */
export enum ChatMessageStatus {
  SENDING = 'SENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  EDITED = 'EDITED',
  DELETED = 'DELETED',
  RECALLED = 'RECALLED',
  FAILED = 'FAILED',
}

/** Swagger response shape for a chat message. */
export class ChatMessageView {
  @ApiProperty({ format: 'uuid' }) messageId!: string;
  @ApiProperty({ format: 'uuid' }) roomId!: string;
  @ApiProperty({ format: 'uuid' }) senderId!: string;
  @ApiProperty({ enum: VideoRoomMessageType }) type!: VideoRoomMessageType;
  @ApiProperty() content!: string;
  @ApiProperty({ enum: ChatMessageStatus }) status!: ChatMessageStatus;
  @ApiProperty({ type: [String], format: 'uuid' }) mentions!: string[];
  @ApiPropertyOptional({ nullable: true }) mentionScope!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) replyToId!: string | null;
  @ApiPropertyOptional({ format: 'uuid' }) announcementId?: string;
  @ApiPropertyOptional() systemEvent?: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
```

Create `src/modules/video-rooms/dto/chat/index.ts`:

```typescript
export * from './chat-message.view';
export * from './chat-receipt.dto';
export * from './edit-chat-message.dto';
export * from './list-chat-messages.dto';
export * from './pin-chat-message.dto';
export * from './search-chat-messages.dto';
export * from './send-chat-message.dto';
```

Add to `src/modules/video-rooms/dto/index.ts`:

```typescript
export * from './chat';
```

- [ ] **Step 5: Run the test, verify, commit**

Run: `npx jest src/modules/video-rooms/dto/chat/chat-dto.spec.ts`
Expected: PASS — 5 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1339 passing.

```bash
git add src/modules/video-rooms/dto/
git commit -m "feat(video-rooms): VR-9 chat DTOs and response views"
```

---

### Task 19: REST controller

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-chat.controller.ts`
- Create: `src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`
- Modify: `src/modules/video-rooms/controllers/index.ts`

**Interfaces:**
- Consumes: all Task 10–17 services; `CurrentUser`, `NotGuest`, `ParseUuidPipe`, `RequestMeta`, `AuthenticatedUser`, `RequestMetadata`.
- Produces: 14 routes under `video-rooms`. `actor(user)` and `audit(meta)` are private helpers.

- [ ] **Step 1: Read a shipped controller for the exact decorator conventions**

Run: `sed -n '1,70p' src/modules/video-rooms/controllers/video-rooms-seats.controller.ts`
Match its guard/decorator/Swagger style exactly.

- [ ] **Step 2: Write the failing controller test**

Create `src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`:

```typescript
import { VideoRoomsChatController } from './video-rooms-chat.controller';

const USER = { id: 'u1', roles: [] } as never;
const META = { requestId: 'req-1', ip: '10.0.0.1', userAgent: 'jest' } as never;

describe('VideoRoomsChatController', () => {
  let chat: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let pins: Record<string, jest.Mock>;
  let announcements: Record<string, jest.Mock>;
  let receipts: Record<string, jest.Mock>;
  let controller: VideoRoomsChatController;

  beforeEach(() => {
    chat = { send: jest.fn(), edit: jest.fn(), remove: jest.fn(), recall: jest.fn() };
    query = { history: jest.fn(), search: jest.fn(), unreadCount: jest.fn() };
    pins = { pin: jest.fn(), unpin: jest.fn(), listPinned: jest.fn() };
    announcements = { create: jest.fn(), update: jest.fn(), remove: jest.fn(), list: jest.fn() };
    receipts = { readers: jest.fn() };
    controller = new VideoRoomsChatController(
      chat as never,
      query as never,
      pins as never,
      announcements as never,
      receipts as never,
    );
  });

  it('threads the request audit context into send', async () => {
    await controller.send(USER, 'r1', { content: 'hi' } as never, META);

    expect(chat.send).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      'r1',
      { content: 'hi' },
      { ip: '10.0.0.1', requestId: 'req-1', userAgent: 'jest' },
    );
  });

  it('passes the message id through on edit', async () => {
    await controller.edit(USER, 'r1', 'm1', { content: 'x' } as never, META);
    expect(chat.edit).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      'r1',
      'm1',
      'x',
      expect.any(Object),
    );
  });

  it('routes recall separately from delete', async () => {
    await controller.recall(USER, 'r1', 'm1', META);
    expect(chat.recall).toHaveBeenCalled();
    expect(chat.remove).not.toHaveBeenCalled();
  });

  it('takes the unpin target from the path, not the body', async () => {
    await controller.unpin(USER, 'r1', 'm1', META);
    expect(pins.unpin).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', 'm1', expect.any(Object));
  });

  it('delegates history and search to the query service', async () => {
    await controller.history(USER, 'r1', { page: 1, limit: 20, skip: 0 } as never);
    await controller.search(USER, 'r1', { page: 1, limit: 20, skip: 0, q: 'x' } as never);
    expect(query.history).toHaveBeenCalled();
    expect(query.search).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the controller**

Create `src/modules/video-rooms/controllers/video-rooms-chat.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  CreateVideoRoomAnnouncementDto,
  UpdateVideoRoomAnnouncementDto,
} from '../dto/announcement.dto';
import {
  ChatMessageView,
  EditChatMessageDto,
  ListChatMessagesDto,
  PinChatMessageDto,
  SearchChatMessagesDto,
  SendChatMessageDto,
} from '../dto/chat';
import type { ChatAuditContext } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomAnnouncementService } from '../services/video-room-announcement.service';
import { VideoRoomChatPinService } from '../services/video-room-chat-pin.service';
import { VideoRoomChatQueryService } from '../services/video-room-chat-query.service';
import { VideoRoomChatReceiptService } from '../services/video-room-chat-receipt.service';
import { VideoRoomChatService } from '../services/video-room-chat.service';

/**
 * VR-9 chat REST surface (base `video-rooms/:id/chat/...`). Durable commands live
 * here — auditable, idempotent, and consistent with every shipped video-room
 * controller. The EPHEMERAL signals (typing, delivered, read) are served by
 * `VideoRoomChatGateway` over the socket instead, where an HTTP round trip per
 * keystroke would be waste.
 *
 * JWT-guarded globally. Every authorization decision lives in
 * `VideoRoomChatPolicyService` / `VideoRoomPermissionService`, never here.
 */
@ApiTags('video-room-chat')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsChatController {
  constructor(
    private readonly chat: VideoRoomChatService,
    private readonly query: VideoRoomChatQueryService,
    private readonly pins: VideoRoomChatPinService,
    private readonly announcements: VideoRoomAnnouncementService,
    private readonly receipts: VideoRoomChatReceiptService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  private audit(meta: RequestMetadata): ChatAuditContext {
    return { ip: meta.ip, requestId: meta.requestId, userAgent: meta.userAgent };
  }

  // ---- Messages ----

  @Post(':id/chat/messages')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Send a chat message (text/emoji/gif)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 201, type: ChatMessageView })
  @ApiResponse({ status: 403, description: 'CHAT_DISABLED · VIDEO_ROOM_CHAT_MODE_RESTRICTED · MEMBER_MUTED · VIDEO_ROOM_BLOCKED · VIDEO_ROOM_NOT_MEMBER' })
  @ApiResponse({ status: 409, description: 'DUPLICATE_MESSAGE · VIDEO_ROOM_ENDED' })
  @ApiResponse({ status: 422, description: 'BLOCKED_WORD' })
  @ApiResponse({ status: 429, description: 'CHAT_RATE_LIMITED · CHAT_SLOW_MODE' })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SendChatMessageDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.chat.send(this.actor(user), id, dto, this.audit(meta));
  }

  @Patch(':id/chat/messages/:messageId')
  @NotGuest()
  @ApiOperation({ summary: 'Edit your own message (inside the edit window)' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — not the author' })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED · VIDEO_ROOM_MESSAGE_NOT_EDITABLE' })
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: EditChatMessageDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.chat.edit(this.actor(user), id, messageId, dto.content, this.audit(meta));
  }

  @Delete(':id/chat/messages/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({
    summary: 'Delete a message (author, or a moderator)',
    description:
      'Soft delete. Content is withheld from non-moderators but the row is retained for audit. To withdraw your own message from everyone, use recall instead.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.chat.remove(this.actor(user), id, messageId, this.audit(meta));
  }

  @Post(':id/chat/messages/:messageId/recall')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({
    summary: 'Recall your own message (inside the recall window)',
    description:
      'Withdraws the message from every client, including moderators. Author only — moderators delete, they do not recall.',
  })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED' })
  recall(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.chat.recall(this.actor(user), id, messageId, this.audit(meta));
  }

  // ---- Reads ----

  @Get(':id/chat/messages')
  @ApiOperation({
    summary: 'Chat history',
    description:
      'Cursor pagination via `before` (scalable), or page/limit. Page 1 newest-first is served from the Redis ring buffer.',
  })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListChatMessagesDto,
  ) {
    return this.query.history(this.actor(user), id, q);
  }

  @Get(':id/chat/search')
  @ApiOperation({ summary: 'Search chat by keyword, sender, type or date range' })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: SearchChatMessagesDto,
  ) {
    return this.query.search(this.actor(user), id, q);
  }

  @Get(':id/chat/unread')
  @ApiOperation({ summary: 'Unread message count for the caller' })
  unread(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    return this.query.unreadCount(this.actor(user), id);
  }

  @Get(':id/chat/messages/:messageId/readers')
  @ApiOperation({
    summary: 'Who has read this message',
    description: 'Derived from read cursors — no per-message receipt rows exist.',
  })
  readers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    return this.receipts.readers(this.actor(user), id, messageId);
  }

  // ---- Pins ----

  @Get(':id/chat/pinned')
  @ApiOperation({ summary: 'Pinned messages in the room' })
  listPinned(@Param('id', ParseUuidPipe) id: string) {
    return this.pins.listPinned(id);
  }

  @Post(':id/chat/pin')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Pin a message', description: 'Requires PIN_MESSAGES.' })
  @ApiResponse({ status: 409, description: 'ALREADY_PINNED · PIN_LIMIT_REACHED' })
  pin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: PinChatMessageDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.pins.pin(this.actor(user), id, dto.messageId, this.audit(meta));
  }

  @Delete(':id/chat/pin/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({ summary: 'Unpin a message', description: 'Requires PIN_MESSAGES.' })
  @ApiResponse({ status: 404, description: 'PIN_NOT_FOUND' })
  unpin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.pins.unpin(this.actor(user), id, messageId, this.audit(meta));
  }

  // ---- Announcements ----

  @Get(':id/chat/announcements')
  @ApiOperation({ summary: 'Announcement history (pinned first, then newest)' })
  listAnnouncements(@Param('id', ParseUuidPipe) id: string) {
    return this.announcements.list(id);
  }

  @Post(':id/chat/announcements')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({
    summary: 'Post an announcement',
    description:
      'Requires MANAGE_ANNOUNCEMENTS. Also projects an ANNOUNCEMENT-type message into the chat stream.',
  })
  createAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateVideoRoomAnnouncementDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.announcements.create(this.actor(user), id, dto, this.audit(meta));
  }

  @Patch(':id/chat/announcements/:announcementId')
  @NotGuest()
  @ApiOperation({ summary: 'Edit an announcement', description: 'Requires MANAGE_ANNOUNCEMENTS.' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND' })
  updateAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('announcementId', ParseUuidPipe) announcementId: string,
    @Body() dto: UpdateVideoRoomAnnouncementDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.announcements.update(this.actor(user), id, announcementId, dto, this.audit(meta));
  }

  @Delete(':id/chat/announcements/:announcementId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({ summary: 'Remove an announcement', description: 'Requires MANAGE_ANNOUNCEMENTS.' })
  removeAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('announcementId', ParseUuidPipe) announcementId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.announcements.remove(this.actor(user), id, announcementId, this.audit(meta));
  }
}
```

Add to `src/modules/video-rooms/controllers/index.ts`:

```typescript
export * from './video-rooms-chat.controller';
```

- [ ] **Step 5: Run the test, verify, commit**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`
Expected: PASS — 5 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1344 passing.

```bash
git add src/modules/video-rooms/controllers/
git commit -m "feat(video-rooms): VR-9 chat REST controller with full Swagger"
```

---

### Task 20: Socket gateway (inbound ephemeral)

**Files:**
- Create: `src/modules/video-rooms/gateway/video-room-chat.gateway.ts`
- Create: `src/modules/video-rooms/gateway/video-room-chat.gateway.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTypingService`, `VideoRoomChatReceiptService`, `VIDEO_ROOM_CHAT_INBOUND_EVENTS`, `SOCKET_NAMESPACES.VIDEO_ROOM`.
- Produces: `VideoRoomChatGateway` with four `@SubscribeMessage` handlers.

- [ ] **Step 1: Read the casino gateway — the only inbound precedent**

Run: `sed -n '1,60p;120,180p' src/modules/casino/gateway/casino.gateway.ts`
Match how it declares the namespace, resolves the authenticated user from the socket, and shapes its handler signatures.

- [ ] **Step 2: Write the failing gateway test**

Create `src/modules/video-rooms/gateway/video-room-chat.gateway.spec.ts`:

```typescript
import { VideoRoomChatGateway } from './video-room-chat.gateway';

function socket(userId = 'u1') {
  return { data: { user: { id: userId, roles: [] } } } as never;
}

describe('VideoRoomChatGateway', () => {
  let typing: { start: jest.Mock; stop: jest.Mock };
  let receipts: { markDelivered: jest.Mock; markRead: jest.Mock };
  let gateway: VideoRoomChatGateway;

  beforeEach(() => {
    typing = { start: jest.fn(), stop: jest.fn() };
    receipts = { markDelivered: jest.fn(), markRead: jest.fn() };
    gateway = new VideoRoomChatGateway(typing as never, receipts as never);
  });

  it('starts typing for the authenticated socket user', async () => {
    await gateway.typingStart(socket(), { roomId: 'r1' });
    expect(typing.start).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1');
  });

  it('stops typing', async () => {
    await gateway.typingStop(socket(), { roomId: 'r1' });
    expect(typing.stop).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1');
  });

  it('records a delivered receipt', async () => {
    await gateway.messageDelivered(socket(), { roomId: 'r1', messageId: 'm1' });
    expect(receipts.markDelivered).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', 'm1');
  });

  it('records a read receipt', async () => {
    await gateway.messageRead(socket(), { roomId: 'r1', messageId: 'm1' });
    expect(receipts.markRead).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', 'm1');
  });

  it('ignores an unauthenticated socket instead of throwing', async () => {
    // A gateway handler that throws can tear the connection down. Ephemeral
    // signals are not worth a disconnect.
    await expect(
      gateway.typingStart({ data: {} } as never, { roomId: 'r1' }),
    ).resolves.toBeUndefined();
    expect(typing.start).not.toHaveBeenCalled();
  });

  it('swallows a service rejection — a bad typing ping must not kill the socket', async () => {
    typing.start.mockRejectedValue(new Error('not a member'));
    await expect(gateway.typingStart(socket(), { roomId: 'r1' })).resolves.toBeUndefined();
  });

  it('ignores a payload with no roomId', async () => {
    await gateway.typingStart(socket(), {} as never);
    expect(typing.start).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/gateway/video-room-chat.gateway.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the gateway**

Create `src/modules/video-rooms/gateway/video-room-chat.gateway.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';
import { VIDEO_ROOM_CHAT_INBOUND_EVENTS } from '../constants/video-room.constants';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatReceiptService } from '../services/video-room-chat-receipt.service';
import { VideoRoomTypingService } from '../services/video-room-typing.service';

interface TypingPayload {
  roomId?: string;
}
interface ReceiptPayload {
  roomId?: string;
  messageId?: string;
}

/**
 * Inbound chat socket handlers — EPHEMERAL SIGNALS ONLY. Durable commands (send,
 * edit, delete, pin, announce) go over REST, where they are auditable and
 * idempotent; typing pings and receipts come here because an HTTP round trip per
 * keystroke is pure waste at scale.
 *
 * This is a transport adapter with no logic of its own: it resolves the actor
 * from the authenticated socket and delegates to the same services the REST
 * controller uses. Every handler is fail-soft — a rejected typing ping must
 * never tear down a live video connection, so failures are logged, not thrown.
 */
@Injectable()
@WebSocketGateway({ namespace: SOCKET_NAMESPACES.VIDEO_ROOM })
export class VideoRoomChatGateway {
  private readonly logger = new Logger(VideoRoomChatGateway.name);

  constructor(
    private readonly typing: VideoRoomTypingService,
    private readonly receipts: VideoRoomChatReceiptService,
  ) {}

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.TYPING_START)
  async typingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: TypingPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId) return;
    await this.guard(() => this.typing.start(actor, body.roomId as string));
  }

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.TYPING_STOP)
  async typingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: TypingPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId) return;
    await this.guard(() => this.typing.stop(actor, body.roomId as string));
  }

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.MESSAGE_DELIVERED)
  async messageDelivered(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ReceiptPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId || !body?.messageId) return;
    await this.guard(() =>
      this.receipts.markDelivered(actor, body.roomId as string, body.messageId as string),
    );
  }

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.MESSAGE_READ)
  async messageRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ReceiptPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId || !body?.messageId) return;
    await this.guard(() =>
      this.receipts.markRead(actor, body.roomId as string, body.messageId as string),
    );
  }

  private actor(client: Socket): RoomActor | null {
    const user = (client.data as { user?: RoomActor } | undefined)?.user;
    return user?.id ? { id: user.id, roles: user.roles ?? [] } : null;
  }

  /** Fail-soft: an ephemeral signal is never worth dropping the connection. */
  private async guard(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.debug(`Chat socket signal ignored: ${(error as Error).message}`);
    }
  }
}
```

- [ ] **Step 5: Run the test, verify, commit**

Run: `npx jest src/modules/video-rooms/gateway/video-room-chat.gateway.spec.ts`
Expected: PASS — 7 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1351 passing.

```bash
git add src/modules/video-rooms/gateway/
git commit -m "feat(video-rooms): VR-9 inbound chat gateway (typing + receipts)"
```

---

### Task 21: Socket and system-message listeners

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-chat-socket.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-socket.listener.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-system.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-system.listener.spec.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`

**Interfaces:**
- Consumes: `EVENT_BUS`, `SocketManager.emitToNamespaceRoom` / `.emitToUserEverywhere`, `VIDEO_ROOM_CHAT_EVENTS`, `VIDEO_ROOM_SOCKET_EVENTS`, `VIDEO_ROOM_EVENTS`, `VIDEO_ROOM_ROLE_EVENTS`, `VIDEO_ROOM_SEAT_EVENTS`, `VideoRoomSystemMessageService.emit`.
- Produces: two `OnModuleInit` listeners. No public API.

- [ ] **Step 1: Write the failing socket-listener test**

Create `src/modules/video-rooms/listeners/video-room-chat-socket.listener.spec.ts`:

```typescript
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatSocketListener } from './video-room-chat-socket.listener';

describe('VideoRoomChatSocketListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let sockets: { emitToNamespaceRoom: jest.Mock; emitToUserEverywhere: jest.Mock };
  let listener: VideoRoomChatSocketListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    listener = new VideoRoomChatSocketListener(bus as never, sockets as never);
    listener.onModuleInit();
  });

  it('subscribes to every chat event exactly once', () => {
    const subscribed = Object.keys(handlers).sort();
    expect(subscribed).toEqual(Object.values(VIDEO_ROOM_CHAT_EVENTS).sort());
    expect(bus.subscribe).toHaveBeenCalledTimes(14);
  });

  it('broadcasts a sent message into the room', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', messageId: 'm1' },
    });

    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.chat_message_sent',
      { roomId: 'r1', messageId: 'm1' },
    );
  });

  it('routes a mention point-to-point, not to the whole room', () => {
    // Broadcasting a mention would tell everyone who was mentioned; each
    // recipient gets their own notice instead.
    handlers[VIDEO_ROOM_CHAT_EVENTS.MENTIONED]({
      payload: { roomId: 'r1', messageId: 'm1', recipientIds: ['u2', 'u3'] },
    });

    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledTimes(2);
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u2',
      'video_room.chat_mentioned',
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('strips the audit block before it reaches clients', () => {
    // ip / requestId are for the audit trail, not for other room members.
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', messageId: 'm1', audit: { ip: '10.0.0.1', requestId: 'x' } },
    });

    const payload = sockets.emitToNamespaceRoom.mock.calls[0][3];
    expect(payload.audit).toBeUndefined();
    expect(payload.messageId).toBe('m1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-socket.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the socket listener**

Create `src/modules/video-rooms/listeners/video-room-chat-socket.listener.ts`:

```typescript
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';

/**
 * Bridges VR-9 chat domain events on the EVENT_BUS to realtime
 * `video_room.chat_*` broadcasts in the `/video-room` namespace (cross-instance
 * via the Redis adapter). Chat services never touch sockets.
 *
 * Bus event → socket event is declared as an exhaustive MAP rather than derived,
 * so adding a bus event without deciding how it reaches clients is a visible
 * omission instead of a silent one (the VR-8 `REQUEST_RESOLUTION_EVENTS` lesson).
 */
const BROADCAST_EVENTS: Record<string, string> = {
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_SENT,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_EDITED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_EDITED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_DELETED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_RECALLED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_RECALLED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_PINNED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_UNPINNED,
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]:
    VIDEO_ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT_CREATED,
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED]:
    VIDEO_ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT_UPDATED,
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED]:
    VIDEO_ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT_DELETED,
  [VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_TYPING_STARTED,
  [VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_TYPING_STOPPED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELIVERED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_DELIVERED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_READ,
};

@Injectable()
export class VideoRoomChatSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    for (const [busEvent, socketEvent] of Object.entries(BROADCAST_EVENTS)) {
      this.bus.subscribe<{ payload: Record<string, unknown> }>(busEvent, (event) => {
        const { roomId } = event.payload as { roomId: string };
        this.sockets.emitToNamespaceRoom(
          VIDEO_ROOM_NAMESPACE,
          roomId,
          socketEvent,
          this.strip(event.payload),
        );
      });
    }

    // Mentions are point-to-point: broadcasting would tell the whole room who
    // was mentioned, which is neither useful nor private.
    this.bus.subscribe<{ payload: { recipientIds: string[] } & Record<string, unknown> }>(
      VIDEO_ROOM_CHAT_EVENTS.MENTIONED,
      (event) => {
        const payload = this.strip(event.payload);
        for (const userId of event.payload.recipientIds) {
          this.sockets.emitToUserEverywhere(
            userId,
            VIDEO_ROOM_SOCKET_EVENTS.CHAT_MENTIONED,
            payload,
          );
        }
      },
    );
  }

  /** The audit block is for the audit trail, never for other room members. */
  private strip(payload: Record<string, unknown>): Record<string, unknown> {
    const { audit: _audit, ...rest } = payload;
    return rest;
  }
}
```

- [ ] **Step 4: Write the failing system-listener test**

Create `src/modules/video-rooms/listeners/video-room-chat-system.listener.spec.ts`:

```typescript
import { VideoRoomChatSystemListener } from './video-room-chat-system.listener';

describe('VideoRoomChatSystemListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let system: { emit: jest.Mock };
  let listener: VideoRoomChatSystemListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    system = { emit: jest.fn() };
    listener = new VideoRoomChatSystemListener(bus as never, system as never);
    listener.onModuleInit();
  });

  it('subscribes to all 13 system-message triggers', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(13);
  });

  it('maps a viewer join to VIEWER_JOINED', () => {
    handlers['video_room.viewer_joined']({ payload: { roomId: 'r1', userId: 'u2' } });
    expect(system.emit).toHaveBeenCalledWith('VIEWER_JOINED', 'r1', { userId: 'u2' });
  });

  it('maps ownership transfer to OWNER_CHANGED', () => {
    handlers['video_room.ownership_transferred']({
      payload: { roomId: 'r1', newOwnerId: 'u9', previousOwnerId: 'u1' },
    });
    expect(system.emit).toHaveBeenCalledWith(
      'OWNER_CHANGED',
      'r1',
      expect.objectContaining({ newOwnerId: 'u9' }),
    );
  });

  it('splits the lock event into LOCKED and UNLOCKED by its flag', () => {
    // One bus event carries both states; emitting "locked" for an unlock
    // would tell the room the opposite of what happened.
    handlers['video_room.locked']({ payload: { roomId: 'r1', isLocked: false } });
    expect(system.emit).toHaveBeenCalledWith('ROOM_UNLOCKED', 'r1', expect.any(Object));

    system.emit.mockClear();
    handlers['video_room.locked']({ payload: { roomId: 'r1', isLocked: true } });
    expect(system.emit).toHaveBeenCalledWith('ROOM_LOCKED', 'r1', expect.any(Object));
  });

  it('emits nothing for a seat resolution it has no mapping for', () => {
    handlers['video_room.seat_request_resolved']({
      payload: { roomId: 'r1', status: 'CANCELLED' },
    });
    expect(system.emit).not.toHaveBeenCalled();
  });

  it('maps ACCEPTED and REJECTED seat resolutions', () => {
    handlers['video_room.seat_request_resolved']({
      payload: { roomId: 'r1', status: 'ACCEPTED', userId: 'u2' },
    });
    expect(system.emit).toHaveBeenCalledWith('SEAT_APPROVED', 'r1', expect.any(Object));

    system.emit.mockClear();
    handlers['video_room.seat_request_resolved']({
      payload: { roomId: 'r1', status: 'REJECTED', userId: 'u2' },
    });
    expect(system.emit).toHaveBeenCalledWith('SEAT_REJECTED', 'r1', expect.any(Object));
  });
});
```

- [ ] **Step 5: Implement the system listener**

Create `src/modules/video-rooms/listeners/video-room-chat-system.listener.ts`:

```typescript
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_ROLE_EVENTS } from '../events/video-room-role.events';
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomSystemMessageService } from '../services/video-room-system-message.service';

/** Seat-request resolutions that become a system message. Others emit nothing. */
const SEAT_RESOLUTION_KINDS: Record<string, string> = {
  ACCEPTED: 'SEAT_APPROVED',
  PROMOTED: 'SEAT_APPROVED',
  REJECTED: 'SEAT_REJECTED',
};

/**
 * Turns existing VR-2/3/6/7/8 domain events into chat system messages. Every one
 * of the brief's 13 triggers already exists as a published event, so this adds
 * ZERO new event plumbing — it only decides which existing events deserve a line
 * in the chat stream, and the policy map decides whether that line is persisted.
 *
 * Unmapped cases emit nothing at all, which is always safer than emitting the
 * wrong thing.
 */
@Injectable()
export class VideoRoomChatSystemListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomChatSystemListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly system: VideoRoomSystemMessageService,
  ) {}

  onModuleInit(): void {
    this.simple(VIDEO_ROOM_EVENTS.USER_JOINED, 'USER_JOINED');
    this.simple(VIDEO_ROOM_EVENTS.USER_LEFT, 'USER_LEFT');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_JOINED, 'VIEWER_JOINED');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_LEFT, 'VIEWER_LEFT');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, 'PROMOTED');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_DEMOTED, 'DEMOTED');
    this.simple(VIDEO_ROOM_EVENTS.CLOSED, 'ROOM_CLOSED');
    this.simple(VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED, 'OWNER_CHANGED');
    this.simple(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, 'SEAT_INVITATION');

    // One bus event carries both lock states — split it, or the room is told
    // the opposite of what happened.
    this.bus.subscribe<{ payload: { roomId: string; isLocked: boolean } }>(
      VIDEO_ROOM_EVENTS.LOCKED,
      (event) =>
        this.dispatch(
          event.payload.isLocked ? 'ROOM_LOCKED' : 'ROOM_UNLOCKED',
          event.payload.roomId,
          event.payload,
        ),
    );

    this.bus.subscribe<{ payload: { roomId: string; status: string } }>(
      VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED,
      (event) => {
        const kind = SEAT_RESOLUTION_KINDS[event.payload.status];
        if (kind) this.dispatch(kind, event.payload.roomId, event.payload);
      },
    );
  }

  private simple(busEvent: string, kind: string): void {
    this.bus.subscribe<{ payload: { roomId: string } & Record<string, unknown> }>(
      busEvent,
      (event) => this.dispatch(kind, event.payload.roomId, event.payload),
    );
  }

  /**
   * Fire-and-forget: a system message is a courtesy, so a failure here must
   * never propagate back into the domain flow that triggered it.
   */
  private dispatch(kind: string, roomId: string, data: Record<string, unknown>): void {
    const { roomId: _roomId, ...rest } = data;
    void this.system
      .emit(kind, roomId, rest)
      .catch((error: Error) =>
        this.logger.warn(`System message ${kind} for room ${roomId} failed: ${error.message}`),
      );
  }
}
```

Add both to `src/modules/video-rooms/listeners/index.ts`:

```typescript
export * from './video-room-chat-socket.listener';
export * from './video-room-chat-system.listener';
```

- [ ] **Step 6: Run both tests, verify, commit**

Run:
```bash
npx jest src/modules/video-rooms/listeners/video-room-chat-socket.listener.spec.ts \
         src/modules/video-rooms/listeners/video-room-chat-system.listener.spec.ts
```
Expected: PASS — 4 + 6 tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1361 passing.

```bash
git add src/modules/video-rooms/listeners/
git commit -m "feat(video-rooms): VR-9 chat socket relay and system-message listeners"
```

---

### Task 22: Metrics and audit listener

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts`
- Modify: `src/modules/video-rooms/video-rooms.metrics.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-audit.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts`

**Interfaces:**
- Consumes: `MetricsService` registry (existing pattern), `VideoRoomEventsRepository.appendEvent`, `EVENT_BUS`.
- Produces: 9 metric families with `incChatMessage(type)`, `observeChatLatency(seconds)`, `observeChatDelivery(seconds)`, `observeChatRead(seconds)`, `incTypingEvent()`, `incAnnouncement(action)`, `setPinnedMessages(roomId, count)`, `incSpamDetected(kind)`, `incChatRateLimitViolation()`.

- [ ] **Step 1: Add the metric families**

In `src/modules/video-rooms/video-rooms.metrics.ts`, add the private fields alongside the existing VR-8/VR-5 blocks:

```typescript
  // ---- VR-9 chat ----
  private readonly chatMessages: Counter<'type'>;
  private readonly chatMessageLatency: Histogram;
  private readonly chatDeliveryLatency: Histogram;
  private readonly chatReadLatency: Histogram;
  private readonly typingEvents: Counter;
  private readonly chatAnnouncements: Counter<'action'>;
  private readonly pinnedMessages: Gauge;
  private readonly spamDetected: Counter<'kind'>;
  private readonly chatRateLimitViolations: Counter;
```

In the constructor, register them (matching the existing `registers` variable):

```typescript
    this.chatMessages = new Counter({
      name: 'video_rooms_chat_messages_total',
      help: 'Video-room chat messages sent, by type',
      labelNames: ['type'],
      registers,
    });
    this.chatMessageLatency = new Histogram({
      name: 'video_rooms_chat_message_latency_seconds',
      help: 'Time from send request to socket broadcast',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers,
    });
    this.chatDeliveryLatency = new Histogram({
      name: 'video_rooms_chat_delivery_latency_seconds',
      help: 'Time from message creation to a delivered receipt',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers,
    });
    this.chatReadLatency = new Histogram({
      name: 'video_rooms_chat_read_latency_seconds',
      help: 'Time from message creation to a read receipt',
      buckets: [1, 5, 15, 30, 60, 300, 900],
      registers,
    });
    this.typingEvents = new Counter({
      name: 'video_rooms_chat_typing_events_total',
      help: 'Typing start/stop signals received',
      registers,
    });
    this.chatAnnouncements = new Counter({
      name: 'video_rooms_chat_announcements_total',
      help: 'Announcement lifecycle actions',
      labelNames: ['action'],
      registers,
    });
    this.pinnedMessages = new Gauge({
      name: 'video_rooms_chat_pinned_messages',
      help: 'Currently pinned messages per room',
      registers,
    });
    this.spamDetected = new Counter({
      name: 'video_rooms_chat_spam_detected_total',
      help: 'Spam signals detected, by kind (flood/duplicate/blocked_word)',
      labelNames: ['kind'],
      registers,
    });
    this.chatRateLimitViolations = new Counter({
      name: 'video_rooms_chat_rate_limit_violations_total',
      help: 'Chat rate-limit rejections',
      registers,
    });
```

And the setters:

```typescript
  incChatMessage(type: string): void {
    this.chatMessages.inc({ type });
  }
  observeChatLatency(seconds: number): void {
    this.chatMessageLatency.observe(seconds);
  }
  observeChatDelivery(seconds: number): void {
    this.chatDeliveryLatency.observe(seconds);
  }
  observeChatRead(seconds: number): void {
    this.chatReadLatency.observe(seconds);
  }
  incTypingEvent(): void {
    this.typingEvents.inc();
  }
  incAnnouncement(action: string): void {
    this.chatAnnouncements.inc({ action });
  }
  setPinnedMessages(count: number): void {
    this.pinnedMessages.set(count);
  }
  incSpamDetected(kind: string): void {
    this.spamDetected.inc({ kind });
  }
  incChatRateLimitViolation(): void {
    this.chatRateLimitViolations.inc();
  }
```

- [ ] **Step 2: Write the metrics-listener test**

Create `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts`:

```typescript
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatMetricsListener } from './video-room-chat-metrics.listener';

describe('VideoRoomChatMetricsListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let metrics: Record<string, jest.Mock>;
  let listener: VideoRoomChatMetricsListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    metrics = {
      incChatMessage: jest.fn(),
      observeChatLatency: jest.fn(),
      observeChatDelivery: jest.fn(),
      observeChatRead: jest.fn(),
      incTypingEvent: jest.fn(),
      incAnnouncement: jest.fn(),
    };
    listener = new VideoRoomChatMetricsListener(bus as never, metrics as never);
    listener.onModuleInit();
  });

  it('counts a sent message by type', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', type: 'TEXT', createdAt: new Date().toISOString() },
      occurredAt: new Date().toISOString(),
    });
    expect(metrics.incChatMessage).toHaveBeenCalledWith('TEXT');
    expect(metrics.observeChatLatency).toHaveBeenCalled();
  });

  it('observes read latency from message creation to receipt', () => {
    const created = new Date('2026-07-21T10:00:00Z').toISOString();
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ]({
      payload: { roomId: 'r1', at: created },
      occurredAt: new Date('2026-07-21T10:00:30Z').toISOString(),
    });
    expect(metrics.observeChatRead).toHaveBeenCalledWith(30);
  });

  it('labels announcement actions distinctly', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({ payload: { roomId: 'r1' } });
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED]({ payload: { roomId: 'r1' } });
    expect(metrics.incAnnouncement).toHaveBeenCalledWith('created');
    expect(metrics.incAnnouncement).toHaveBeenCalledWith('deleted');
  });

  it('counts both typing directions', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED]({ payload: { roomId: 'r1' } });
    handlers[VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED]({ payload: { roomId: 'r1' } });
    expect(metrics.incTypingEvent).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Implement the metrics listener**

Create `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.ts`:

```typescript
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Chat observability, decoupled from the write path on purpose. Counting inside
 * `send()` would put a Prometheus call on the hot path and couple message
 * delivery to metrics; subscribing to the same bus event the socket listener
 * uses costs nothing and means metrics can never break a send (VR-4 precedent).
 */
@Injectable()
export class VideoRoomChatMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<{ payload: { type: string; createdAt: string }; occurredAt: string }>(
      VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT,
      (event) => {
        this.metrics.incChatMessage(event.payload.type);
        this.metrics.observeChatLatency(
          this.elapsed(event.payload.createdAt, event.occurredAt),
        );
      },
    );

    this.bus.subscribe<{ payload: { at: string }; occurredAt: string }>(
      VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELIVERED,
      (event) =>
        this.metrics.observeChatDelivery(this.elapsed(event.payload.at, event.occurredAt)),
    );

    this.bus.subscribe<{ payload: { at: string }; occurredAt: string }>(
      VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ,
      (event) => this.metrics.observeChatRead(this.elapsed(event.payload.at, event.occurredAt)),
    );

    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED, () =>
      this.metrics.incTypingEvent(),
    );
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED, () =>
      this.metrics.incTypingEvent(),
    );

    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED, () =>
      this.metrics.incAnnouncement('created'),
    );
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED, () =>
      this.metrics.incAnnouncement('updated'),
    );
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED, () =>
      this.metrics.incAnnouncement('deleted'),
    );
  }

  /** Seconds between two ISO instants, floored at 0 for clock skew. */
  private elapsed(from: string, to: string): number {
    return Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000);
  }
}
```

- [ ] **Step 4: Write the audit-listener test**

Create `src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts`:

```typescript
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatAuditListener } from './video-room-chat-audit.listener';

describe('VideoRoomChatAuditListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let events: { appendEvent: jest.Mock };
  let listener: VideoRoomChatAuditListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomChatAuditListener(bus as never, events as never);
    listener.onModuleInit();
  });

  it('records ip and requestId in the audit payload', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 'u1',
        audit: { ip: '10.0.0.1', requestId: 'req-9', userAgent: 'jest' },
      },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        actorId: 'u1',
        eventType: VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT,
        referenceId: 'm1',
        payload: expect.objectContaining({ ip: '10.0.0.1', requestId: 'req-9' }),
      }),
    );
  });

  it('still records an audit row when no request context was supplied', async () => {
    // Socket-originated and system-generated actions have no HTTP request.
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]({
      payload: { roomId: 'r1', messageId: 'm1', pinnedBy: 'u1' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', actorId: 'u1' }),
    );
  });

  it('audits the seven mutating actions the brief requires', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(7);
  });
});
```

- [ ] **Step 5: Implement the audit listener**

Create `src/modules/video-rooms/listeners/video-room-chat-audit.listener.ts`:

```typescript
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/** Audited actions → the payload field naming the acting user. */
const AUDITED: Record<string, string> = {
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]: 'senderId',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_EDITED]: 'editorId',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]: 'deletedBy',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]: 'pinnedBy',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED]: 'unpinnedBy',
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]: 'authorId',
  [VIDEO_ROOM_CHAT_EVENTS.MENTIONED]: 'senderId',
};

/**
 * Writes every mutating chat action to the append-only `video_room_events`
 * stream — the table VR-1 built for exactly this: an open `eventType` string and
 * a JSON payload.
 *
 * The brief requires ip and request id in the audit trail. They arrive on the
 * event's `audit` block, threaded from the controller's `@RequestMeta()`, which
 * is why chat services accept an audit context they otherwise never read.
 * Socket-originated and system-generated actions have no HTTP request, so the
 * block is absent and the row is written without it rather than skipped.
 */
@Injectable()
export class VideoRoomChatAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomChatAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    for (const [eventType, actorField] of Object.entries(AUDITED)) {
      this.bus.subscribe<{ payload: Record<string, unknown>; occurredAt: string }>(
        eventType,
        (event) => {
          const p = event.payload;
          const audit = (p.audit ?? {}) as Record<string, unknown>;
          void this.events
            .appendEvent({
              roomId: p.roomId as string,
              actorId: (p[actorField] as string) ?? null,
              eventType,
              referenceId: (p.messageId as string) ?? null,
              payload: {
                timestamp: event.occurredAt,
                ip: audit.ip ?? null,
                requestId: audit.requestId ?? null,
                userAgent: audit.userAgent ?? null,
              } as never,
            })
            .catch((error: Error) =>
              // Audit is important, but it must not break chat delivery.
              this.logger.error(`Chat audit write failed for ${eventType}: ${error.message}`),
            );
        },
      );
    }
  }
}
```

Add both listeners to `src/modules/video-rooms/listeners/index.ts`.

- [ ] **Step 6: Run the tests, verify, commit**

Run:
```bash
npx jest src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts \
         src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts \
         src/modules/video-rooms/video-rooms.metrics.spec.ts
```
Expected: PASS — 4 + 3 + existing metrics tests.

Run: `npx tsc --noEmit && pnpm lint && pnpm test`
Expected: 1368 passing.

```bash
git add src/modules/video-rooms/listeners/ src/modules/video-rooms/video-rooms.metrics.*
git commit -m "feat(video-rooms): VR-9 chat metrics and audit-trail listeners"
```

---

### Task 23: Module wiring, integration spec, and the regression gate

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/video-rooms/services/index.ts`
- Create: `src/modules/video-rooms/video-rooms-chat.integration.spec.ts`

**Interfaces:**
- Consumes: every provider from Tasks 6–22.
- Produces: a fully wired module. No new public API.

- [ ] **Step 1: Wire the module**

In `src/modules/video-rooms/video-rooms.module.ts`:

1. Add `VideoRoomsChatController` to `controllers`.
2. Add to `providers`, as a labelled block matching the existing per-phase grouping:

```typescript
    // VR-9 chat (REST commands + ephemeral socket signals, Redis read model,
    // policy gate, announcements over the VR-1 table, system messages).
    VideoRoomChatRepository,
    VideoRoomChatCacheService,
    VideoRoomChatRateLimiter,
    VideoRoomMentionResolver,
    VideoRoomChatPolicyService,
    VideoRoomChatService,
    VideoRoomChatQueryService,
    VideoRoomChatPinService,
    VideoRoomAnnouncementService,
    VideoRoomTypingService,
    VideoRoomChatReceiptService,
    VideoRoomSystemMessageService,
    VideoRoomChatGateway,
    VideoRoomChatSocketListener,
    VideoRoomChatSystemListener,
    VideoRoomChatMetricsListener,
    VideoRoomChatAuditListener,
```

3. Add the matching imports at the top of the file.
4. Export the new services from `src/modules/video-rooms/services/index.ts`.

- [ ] **Step 2: Write the integration spec**

Create `src/modules/video-rooms/video-rooms-chat.integration.spec.ts`:

```typescript
import { VideoRoomChatMode, VideoRoomMemberRole, VideoRoomMessageType, VideoRoomStatus } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatPolicyService } from './services/video-room-chat-policy.service';
import { VideoRoomChatService } from './services/video-room-chat.service';

/**
 * VR-9 wiring proof: the send path composed of REAL policy + REAL chat services
 * over mocked I/O. Unit specs prove each gate; this proves they compose in the
 * right order and that a rejection anywhere upstream stops the write.
 */
describe('VR-9 chat integration', () => {
  const ROOM = { id: 'r1', ownerId: 'owner-1', status: VideoRoomStatus.LIVE };
  const SETTINGS = {
    roomId: 'r1',
    allowChat: true,
    allowViewerChat: true,
    chatMode: VideoRoomChatMode.NORMAL,
    chatMaxMessageLength: 500,
    chatMaxAttachments: 1,
    chatRateLimitPerMinute: 20,
    slowModeSeconds: 0,
  };

  let rooms: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let repo: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let bus: { publish: jest.Mock };
  let chat: VideoRoomChatService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getSettings: jest.fn().mockResolvedValue(SETTINGS),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
    };
    permissions = {
      resolveEffectiveRole: jest.fn().mockResolvedValue(VideoRoomMemberRole.VIEWER),
    };
    moderation = {
      findActiveMute: jest.fn().mockResolvedValue(null),
      findActiveBlock: jest.fn().mockResolvedValue(null),
    };
    repo = {
      createMessage: jest.fn().mockResolvedValue({
        id: 'm1',
        roomId: 'r1',
        senderId: 'u1',
        type: VideoRoomMessageType.TEXT,
        content: 'hello',
        mentions: [],
        mentionScope: null,
        replyToId: null,
        metadata: null,
        createdAt: new Date('2026-07-21T00:00:00Z'),
      }),
      findMessage: jest.fn().mockResolvedValue(null),
    };
    cache = { pushRecent: jest.fn() };
    bus = { publish: jest.fn() };

    const config = {
      get: jest.fn().mockReturnValue({
        messageMaxLength: 500,
        editWindowSeconds: 900,
        recallWindowSeconds: 120,
      }),
    };
    const policy = new VideoRoomChatPolicyService(
      rooms as never,
      permissions as never,
      moderation as never,
      config as never,
    );
    chat = new VideoRoomChatService(
      policy,
      { assertMaySend: jest.fn(), applySlowMode: jest.fn() } as never,
      { scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: '' }) } as never,
      { resolve: jest.fn().mockResolvedValue({ userIds: [], scope: null }) } as never,
      repo as never,
      cache as never,
      bus as never,
    );
  });

  it('send → persist → cache → broadcast, in that order', async () => {
    await chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' });

    expect(repo.createMessage).toHaveBeenCalled();
    expect(cache.pushRecent).toHaveBeenCalled();
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_sent');
    expect(repo.createMessage.mock.invocationCallOrder[0]).toBeLessThan(
      bus.publish.mock.invocationCallOrder[0],
    );
  });

  it('a viewer is silenced by PARTICIPANTS_ONLY before anything is written', async () => {
    rooms.getSettings.mockResolvedValue({
      ...SETTINGS,
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
    });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED });

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(cache.pushRecent).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a seated participant still speaks in PARTICIPANTS_ONLY', async () => {
    rooms.getSettings.mockResolvedValue({
      ...SETTINGS,
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
    });
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.PARTICIPANT);

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).resolves.toBeDefined();
  });

  it('the deprecated allowViewerChat column changes nothing', async () => {
    rooms.getSettings.mockResolvedValue({ ...SETTINGS, allowViewerChat: false });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).resolves.toBeDefined();
  });

  it('a muted member is stopped before the write', async () => {
    moderation.findActiveMute.mockResolvedValue({ id: 'mute-1' });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MEMBER_MUTED });
    expect(repo.createMessage).not.toHaveBeenCalled();
  });

  it('an ended room refuses chat', async () => {
    rooms.findById.mockResolvedValue({ ...ROOM, status: VideoRoomStatus.ENDED });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ENDED });
  });
});
```

- [ ] **Step 3: Run the integration spec**

Run: `npx jest src/modules/video-rooms/video-rooms-chat.integration.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 4: Boot the application context to prove DI resolves**

A unit-tested provider graph can still fail to boot on a missing dependency. Run:

```bash
npx ts-node -e "
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
NestFactory.create(AppModule, { logger: false })
  .then(async (app) => { await app.init(); console.log('DI OK'); await app.close(); process.exit(0); })
  .catch((e) => { console.error('DI FAILED:', e.message); process.exit(1); });
"
```
Expected: `DI OK`. If it fails on a missing provider, add it to `video-rooms.module.ts` and re-run. (If the project has no `ts-node`, use `pnpm build && node -e` against `dist/` instead.)

- [ ] **Step 5: Run the FULL regression gate**

Run:
```bash
npx tsc --noEmit && pnpm lint && pnpm boundaries && pnpm test
```
Expected:
- tsc: no errors
- lint: no errors, no warnings (`--max-warnings 0`)
- boundaries: no violations — in particular **no `video-rooms → audio-rooms` edge** and no `infra → modules` edge
- tests: **1374 passing, 0 failing**, including AR-4's `chat.service.spec.ts` and the relocated `blocked-word.service.spec.ts` with unedited assertions

- [ ] **Step 6: Verify the Swagger surface is complete**

Run:
```bash
grep -c "@ApiOperation" src/modules/video-rooms/controllers/video-rooms-chat.controller.ts
```
Expected: `15` — one per route.

- [ ] **Step 7: Commit**

```bash
git add src/modules/video-rooms/
git commit -m "feat(video-rooms): VR-9 module wiring and chat integration spec

Completes Phase 9. Video Room chat ships with REST commands, ephemeral socket
signals, Redis-backed reads, cursor read receipts, announcements over the VR-1
table, system messages with room-size degradation, audit trail and metrics.
Purely additive: no column or table dropped."
```

---

## Task Dependency Graph

```
1 (schema) ─┬─▶ 2 (constants/config) ─┬─▶ 6 (cache) ──┐
            │                          ├─▶ 7 (limiter) ┤
            ├─▶ 3 (events) ────────────┤               ├─▶ 10 (send) ─▶ 11 (edit/del/recall)
            └─▶ 4 (repository) ────────┤               │        │
                                       ├─▶ 8 (mentions)┘        ├─▶ 12 (pin) ─▶ 13 (announce)
5 (blocked-word extraction) ───────────┴─▶ 9 (policy) ──────────┴─▶ 14 (query)
                                                                  ├─▶ 15 (typing)
                                                                  ├─▶ 16 (receipts)
                                                                  └─▶ 17 (system msgs)
                                                                        │
                                    18 (DTOs) ─▶ 19 (controller) ◀──────┤
                                                 20 (gateway)   ◀───────┤
                                                 21 (listeners) ◀───────┤
                                                 22 (metrics)   ◀───────┘
                                                       └─▶ 23 (wiring + integration)
```

**Parallelisable:** 6 / 7 / 8 are mutually independent once 2–4 land. 5 can run any time before 10. 15 / 16 / 17 are independent of each other once 9 lands.

---

## Plan Self-Review

Run against the spec with fresh eyes.

**1. Spec coverage** — every spec section maps to at least one task:

| Spec § | Requirement | Task(s) |
| --- | --- | --- |
| 4.1–4.5 | 3 tables + 2 enums + indexes + `pg_trgm` | 1 |
| 4.3 | derived status (no status column) | 1, 18 (`ChatMessageStatus` view) |
| 4.6 | 4 settings columns + `allowViewerChat` deprecation | 1, 9, 23 (integration proof) |
| 4.7 | mentions as an indexed array | 1, 8 |
| 5.1 | send-path gate order | 10, 23 |
| 5.2 | file layout | 1–23 |
| 5.3 | one policy service; decoupled metrics/audit | 9, 22 |
| 5.4 | boundary compliance | 5, 8, 23 |
| 6.1 | 15 REST routes | 19 |
| 6.2 | 4 inbound socket handlers | 2 (names), 20 |
| 6.3 | 15 outbound socket events | 2 (names), 21 |
| 6.4 | 14 bus events | 3 |
| 7 | 13 system-message triggers | 21 |
| 7.1 | room-size policy map | 17 |
| 8 | rate/slow/flood/dedup/cooldown | 7 |
| 8.1 | `videoRoomChat` config namespace | 2 |
| 9 | Redis keys | 2, 6, 7, 16 |
| 10 | audit with ip + requestId | 3 (audit block), 19 (`@RequestMeta`), 22 |
| 11 | 9 metric families | 22 |
| 12 | validations | 9, 18 |
| 12.1 | edit vs delete vs recall | 9, 11 |
| 13 | test plan | every task; 23 for the gate |
| 14 | Swagger on every route | 19, 23 (Step 6 count check) |
| 17 | definition of done | 23 |

No spec requirement is unimplemented.

**2. Placeholder scan** — no "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Every code step carries real code. Six tasks (5, 8, 17, 18, 19, 20) deliberately open with a step instructing the implementer to *read a shipped file first* rather than guessing at a signature the plan could not verify — those are verification steps with a concrete command and a stated fallback, not placeholders.

**3. Type consistency** — checked across task boundaries:

- `ChatMessagePayload` (Task 3) is produced by `VideoRoomChatService.toPayload` (10), consumed by the cache (6), query service (14) and system-message service (17). Field names match in all four.
- `ChatAuditContext` (Task 3) flows controller (19) → services (10, 11, 12, 13) → audit listener (22). Same three optional fields throughout.
- `VideoRoomChatRepository` method names in Task 4's "Produces" block are exactly what Tasks 10–17 call. `findByAnnouncementId` is added in Task 13 with its own spec case, not silently assumed.
- `SendPolicyResult` (Task 9) returns `{ room, settings, role }`; Task 10 destructures `{ room, settings }`. Consistent.
- `assertCanDelete` returns `{ byModerator }` in Task 9 and is destructured as such in Task 11.
- Metrics setter names in Task 22's "Produces" block match the listener's call sites in the same task.
- `VIDEO_ROOM_CHAT_INBOUND_EVENTS` is defined in Task 2 and consumed in Task 20.

**Two gaps found and fixed inline while reviewing:**
- Task 13 originally assumed a `messageId` column on `video_room_announcements` that does not exist — replaced with the `metadata.announcementId` lookup plus a new repository method and spec case.
- Task 9's `assertCanRecall` took a `roomId` it never used; kept in the signature for call-site symmetry but named `_roomId` so lint passes under `argsIgnorePattern: '^_'`.

**Test-count arithmetic:** 1192 baseline → 1374 at Task 23. Per-task expected totals in the plan add up to that figure.






