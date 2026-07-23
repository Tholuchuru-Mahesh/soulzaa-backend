# Video Room Phase 16 — Moderation, Safety & Compliance Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the additive moderator action layer + automated-moderation engine for Video Rooms (kick, blacklist, channel-based mute, warn, force-disconnect, report, 5-detector auto-mod, history, compliance audit) on top of the existing VR-1..VR-15 moderation seams.

**Architecture:** Option B — split-by-concern services (`VideoRoomModerationService` commands, `VideoRoomReportService`, `VideoRoomAutoModerationService`, `VideoRoomModerationQueryService`) over the reused `VideoRoomModerationRepository` (mutes/blocks/actions) plus 2 new repos (reports, warnings). Business logic in services; socket listeners are thin EVENT_BUS→realtime bridges; all DB via repositories; all thresholds config-driven.

**Tech Stack:** NestJS, Prisma (Postgres), BullMQ, ioredis, Socket.IO, prom-client, Jest, class-validator, Swagger.

**Reference blueprint:** `src/modules/audio-rooms/{services/moderation.service.ts, repositories/moderation.repository.ts, controllers/moderation.controller.ts, listeners/moderation-socket.listener.ts, events/audio-room-moderation.events.ts}` — mirror patterns, but DO NOT port ban/appeal/note concepts.

**Spec:** `docs/superpowers/specs/2026-07-23-video-room-phase16-moderation-safety-engine-design.md`

## Global Constraints

- **No Git.** Never `git add/commit/reset/push`. Work in the working tree only. Each task ends with a review STOP, not a commit.
- **Migration file-only.** Author the migration `.sql` + edit `.prisma` by hand and run `npx prisma generate` only. Never `prisma migrate dev/deploy/reset` (no DB reset).
- **Strictly additive / backward compatible.** No signature changes to existing services. Fill the existing `501` stubs; add new files, additive enum values, new Redis keys/queues/metrics/config-with-defaults.
- **No Prisma in services.** All DB access through repositories.
- **No hardcoded thresholds.** Every moderation threshold comes from the `videoRoom.moderation` config namespace.
- **Business logic in services only.** Socket listeners bridge domain events to realtime events and nothing else.
- **RBAC through the existing engine.** `VideoRoomPermissionService.assertPermission` + `assertOutranks` + owner-protection on every target action. Never hardcode permissions.
- **Immutable audit on every action.** `appendAction(...)` into `VideoRoomModerationAction`; `metadata` carries `{requestId, ip, userAgent}` from `@RequestMeta()`.
- **Exceptions:** `new BusinessException(ERROR_CODES.X, message, HttpStatus)` — the machine code field is `.errorCode` (NOT `.code`).
- **Per-task gate:** after each task run `npx tsc --noEmit`, `npx eslint <changed files>`, and the task's `jest` spec — all green — then STOP for review.
- **Do NOT implement:** ban (temp/perm/global), suspend/restore, appeals, auto-ban-escalation, ban expiration, AI/voice/image moderation.

---

## File structure (created unless noted)

```
prisma/schema/video_rooms_moderation.prisma                 MODIFY: +VideoRoomReport, +VideoRoomWarning, +enums, +action values
prisma/migrations/<ts>_video_room_phase16_moderation/migration.sql   CREATE (file-only)

src/config/configuration.ts                                 MODIFY: +videoRoom.moderation
src/config/env.validation.ts                                MODIFY: +VIDEO_ROOM_MOD_* env vars
src/common/exceptions/error-codes.ts                        MODIFY: +moderation codes

src/modules/video-rooms/constants/video-room-moderation.constants.ts   CREATE
src/modules/video-rooms/constants/video-room.constants.ts   MODIFY: +queue names in VIDEO_ROOM_QUEUES
src/modules/video-rooms/exceptions/video-room-moderation.exceptions.ts CREATE
src/modules/video-rooms/dto/moderation.dto.ts               MODIFY: +new DTOs
src/modules/video-rooms/repositories/video-room-moderation.repository.ts  MODIFY: +mirror helpers
src/modules/video-rooms/repositories/video-room-report.repository.ts      CREATE
src/modules/video-rooms/repositories/video-room-warning.repository.ts     CREATE
src/modules/video-rooms/metrics/video-room-moderation.metrics.ts          CREATE
src/modules/video-rooms/events/video-room-moderation.events.ts            CREATE
src/modules/video-rooms/services/video-room-moderation.service.ts         CREATE
src/modules/video-rooms/services/video-room-report.service.ts             CREATE
src/modules/video-rooms/services/video-room-moderation-query.service.ts   CREATE
src/modules/video-rooms/services/video-room-auto-moderation.service.ts    CREATE
src/modules/video-rooms/services/detectors/moderation-detector.interface.ts CREATE
src/modules/video-rooms/services/detectors/{spam,flood,duplicate,rapid-join-leave,excessive-reports}.detector.ts CREATE
src/modules/video-rooms/listeners/video-room-moderation-socket.listener.ts CREATE
src/modules/video-rooms/listeners/video-room-auto-moderation.listener.ts   CREATE
src/modules/video-rooms/scheduler/video-room-moderation-expiry.monitor.ts  CREATE
src/modules/video-rooms/processors/{moderation-processing,report-processing,moderation-cleanup}.processor.ts CREATE
src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts   CREATE (or MODIFY existing 501 stub)
src/modules/video-rooms/video-rooms.module.ts               MODIFY: register providers/queues/controller
```

**Before Task 1, the executing agent MUST read** (to match existing conventions, not invent):
`repositories/video-room-moderation.repository.ts`, `services/video-room-permission.service.ts`, `constants/video-room-permissions.ts`, `constants/video-room.constants.ts`, `dto/moderation.dto.ts`, `services/video-room-media.service.ts` (forceMute), `services/video-room-session.service.ts` (endUserRoomSessions), `services/video-room-event.service.ts`, `events/video-room-chat.events.ts` (MESSAGE_SENT/SPAM_DETECTED), `video-rooms.metrics.ts`, and the audio blueprint files listed above.

---

## Task 1: Prisma schema — reports, warnings, enum additions (file-only migration)

**Files:**
- Modify: `prisma/schema/video_rooms_moderation.prisma`
- Create: `prisma/migrations/<timestamp>_video_room_phase16_moderation/migration.sql`

**Interfaces:**
- Produces: Prisma models `VideoRoomReport`, `VideoRoomWarning`; enums `VideoRoomReportReason`, `VideoRoomReportStatus`; added `VideoRoomModerationActionType` values `FORCE_DISCONNECT, REPORT_REVIEWED, ROOM_MUTED, ROOM_UNMUTED, AUTO_MUTED, AUTO_KICKED, AUTO_FLAGGED`.

- [ ] **Step 1: Add enums + models to the schema**

```prisma
enum VideoRoomReportReason { USER MESSAGE SPAM HARASSMENT ABUSE FAKE_ACCOUNT OTHER }
enum VideoRoomReportStatus { PENDING REVIEWED DISMISSED ACTIONED }

model VideoRoomReport {
  id               String  @id @default(uuid()) @db.Uuid
  roomId           String  @db.Uuid
  reporterId       String  @db.Uuid
  targetUserId     String  @db.Uuid
  messageId        String? @db.Uuid
  reason           VideoRoomReportReason
  description      String?
  status           VideoRoomReportStatus @default(PENDING)
  reviewedBy       String? @db.Uuid
  reviewedAt       DateTime?
  resolutionAction String?
  createdBy        String?  @db.Uuid
  updatedBy        String?  @db.Uuid
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([roomId, status])
  @@index([targetUserId])
  @@index([reporterId])
  @@map("video_room_reports")
}

model VideoRoomWarning {
  id          String   @id @default(uuid()) @db.Uuid
  roomId      String   @db.Uuid
  userId      String   @db.Uuid
  moderatorId String   @db.Uuid
  reason      String
  metadata    Json?
  createdBy   String?  @db.Uuid
  updatedBy   String?  @db.Uuid
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([roomId, userId])
  @@index([userId])
  @@map("video_room_warnings")
}
```
Append the new values to the existing `VideoRoomModerationActionType` enum (do not reorder existing values).

- [ ] **Step 2: Regenerate the Prisma client (no DB migrate)**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" — no `migrate` invoked.

- [ ] **Step 3: Author the migration SQL by hand**

Create `migration.sql` with `CREATE TYPE "VideoRoomReportReason" ...`, `CREATE TYPE "VideoRoomReportStatus" ...`, `ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'FORCE_DISCONNECT'` (one `ADD VALUE` per new value), and `CREATE TABLE "video_room_reports"` / `"video_room_warnings"` with the indexes above. Match column types to the schema.

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (the new `Prisma.VideoRoomReport`/`VideoRoomWarning` types exist).

- [ ] **Step 5: STOP for review** (no commit).

---

## Task 2: Moderation constants + queue names

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-moderation.constants.ts`
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (add queue names to `VIDEO_ROOM_QUEUES`)
- Test: `src/modules/video-rooms/constants/video-room-moderation.constants.spec.ts`

**Interfaces:**
- Produces: key builders `mutesMirrorKey(roomId)`, `blocksMirrorKey(roomId)`, `moderationLockKey(roomId)`, `MODERATION_MONITOR_LOCK_KEY`, `spamCounterKey/floodCounterKey/dupKey/joinLeaveKey/reportCounterKey/cooldownKey(roomId,userId)`; `SYSTEM_MODERATOR_ID`; `VIDEO_ROOM_MODERATION_SOCKET_EVENTS` (userKicked… roomModerationUpdated); `VIDEO_ROOM_MODERATION_QUEUES = { PROCESSING, REPORT, CLEANUP }`; limit consts `VIDEO_ROOM_MODERATION_DESCRIPTION_MAX`, `VIDEO_ROOM_MODERATION_WARNING_METADATA_MAX`.

- [ ] **Step 1: Write the failing test**

```ts
import { mutesMirrorKey, blocksMirrorKey, moderationLockKey, spamCounterKey, VIDEO_ROOM_MODERATION_SOCKET_EVENTS, SYSTEM_MODERATOR_ID } from './video-room-moderation.constants';

describe('video-room-moderation.constants', () => {
  it('hash-tags room-scoped keys for cluster safety', () => {
    expect(mutesMirrorKey('r1')).toBe('video-room:{r1}:mutes');
    expect(blocksMirrorKey('r1')).toBe('video-room:{r1}:blocks');
    expect(moderationLockKey('r1')).toBe('video-room:moderation:{r1}');
    expect(spamCounterKey('r1', 'u1')).toBe('video-room:mod:spam:{r1}:u1');
  });
  it('exposes stable socket event names and a nil system id', () => {
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_KICKED).toBe('userKicked');
    expect(SYSTEM_MODERATOR_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`Cannot find module`).
Run: `npx jest video-room-moderation.constants.spec -t 'hash-tags'`

- [ ] **Step 3: Implement the constants file** with the key builders (hash-tag `{roomId}`), socket-event map, `SYSTEM_MODERATOR_ID = '00000000-0000-0000-0000-000000000000'`, and limits. Add `PROCESSING:'video-rooms-moderation'`, `REPORT:'video-rooms-report'`, `CLEANUP:'video-rooms-moderation-cleanup'` — export both here and merge into `VIDEO_ROOM_QUEUES` in `video-room.constants.ts`.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP for review.**

---

## Task 3: Config namespace + env validation

**Files:**
- Modify: `src/config/configuration.ts` (add `moderation` to `videoRoomConfig`)
- Modify: `src/config/env.validation.ts` (add `VIDEO_ROOM_MOD_*` with defaults)
- Test: `src/config/video-room-moderation-config.spec.ts`

**Interfaces:**
- Produces: `config.get('videoRoom').moderation` → `{ spamThreshold, spamWindowSec, floodThreshold, floodWindowSec, duplicateWindowSec, rapidJoinLeaveThreshold, rapidJoinLeaveWindowSec, excessiveReportsThreshold, excessiveReportsWindowSec, warningThreshold, autoMuteMinutes, autoActionCooldownSec, expiryMonitorIntervalMs, reasonMax, descriptionMax }`.

- [ ] **Step 1: Write the failing test** asserting `videoRoomConfig().moderation.autoMuteMinutes === 15` and `spamThreshold === 5` (defaults) when env unset.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Add env vars to `env.validation.ts` (e.g. `VIDEO_ROOM_MOD_SPAM_THRESHOLD` default 5, `..._FLOOD_THRESHOLD` 10, `..._FLOOD_WINDOW_SEC` 10, `..._DUP_WINDOW_SEC` 30, `..._RAPID_JOINLEAVE_THRESHOLD` 5, `..._RAPID_JOINLEAVE_WINDOW_SEC` 60, `..._EXCESSIVE_REPORTS_THRESHOLD` 5, `..._EXCESSIVE_REPORTS_WINDOW_SEC` 300, `..._WARNING_THRESHOLD` 3, `..._AUTO_MUTE_MINUTES` 15, `..._AUTO_ACTION_COOLDOWN_SEC` 30, `..._EXPIRY_MONITOR_INTERVAL_MS` 15000) mirroring the audio-room chat auto-mod defaults. Map them into `videoRoomConfig().moderation`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP.**

---

## Task 4: Error codes + moderation exceptions

**Files:**
- Modify: `src/common/exceptions/error-codes.ts`
- Create: `src/modules/video-rooms/exceptions/video-room-moderation.exceptions.ts`
- Test: `src/modules/video-rooms/exceptions/video-room-moderation.exceptions.spec.ts`

**Interfaces:**
- Produces: `ERROR_CODES` additions (`VIDEO_ROOM_ALREADY_BLOCKED`, `VIDEO_ROOM_BLOCK_NOT_FOUND`, `VIDEO_ROOM_ALREADY_MUTED`, `VIDEO_ROOM_MUTE_NOT_FOUND`, `VIDEO_ROOM_CANNOT_MODERATE_SELF`, `VIDEO_ROOM_DUPLICATE_REPORT`, `VIDEO_ROOM_REPORT_NOT_FOUND`, `VIDEO_ROOM_REPORT_NOT_PENDING`); exception classes `ModerationException, KickException, MuteException, BlacklistException, WarningException, ReportException, OwnerProtectionException` (each extends `BusinessException`).

- [ ] **Step 1: Write the failing test**

```ts
import { HttpStatus } from '@nestjs/common';
import { OwnerProtectionException, MuteException } from './video-room-moderation.exceptions';
import { ERROR_CODES } from 'src/common/exceptions';

it('carries errorCode + status', () => {
  const e = new OwnerProtectionException();
  expect(e.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER);
  expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
  const m = new MuteException(ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED, 'x', HttpStatus.CONFLICT);
  expect(m.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Add the codes to `ERROR_CODES` (reuse the existing `VIDEO_ROOM_CANNOT_MODERATE_OWNER`). Each exception is a thin `BusinessException` wrapper (mirror `video-room-pk.exceptions.ts`); `OwnerProtectionException` defaults to `(VIDEO_ROOM_CANNOT_MODERATE_OWNER, 'The room owner cannot be moderated.', FORBIDDEN)`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP.**

---

## Task 5: DTOs

**Files:**
- Modify: `src/modules/video-rooms/dto/moderation.dto.ts`
- Test: `src/modules/video-rooms/dto/moderation.dto.spec.ts`

**Interfaces:**
- Produces: `MuteChannel = 'chat' | 'mic'`; `KickVideoRoomUsersDto {userIds: string[]; reason?}`, `UnmuteVideoRoomUserDto {userId; channels?: MuteChannel[]}`, `MuteAllDto {channels?: MuteChannel[]}`, `WarnVideoRoomUserDto {userId; reason; metadata?}`, `ForceDisconnectDto {userId; reason?}`, `ReportVideoRoomUserDto {targetUserId; reason: VideoRoomReportReason; description?; messageId?}`, `ReviewReportDto {status: VideoRoomReportStatus; resolutionAction?}`, `ListModerationDto extends PaginationQueryDto {targetUserId?; userId?}`. Extend `MuteVideoRoomUserDto` with optional `channels?: MuteChannel[]`.

- [ ] **Step 1: Write failing validation tests** (valid payload passes; `userIds` empty array fails; `reason` over `reasonMax` fails; invalid `reason` enum fails) using `class-validator`'s `validate()`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement DTOs** with `@ApiProperty`/`@ApiPropertyOptional`, `@IsUUID`, `@IsArray`+`@ArrayNotEmpty`+`@IsUUID('4',{each:true})` for `userIds`, `@IsEnum`, `@IsOptional`, `@Length`. Reuse `MuteVideoRoomUserDto`/`BlockVideoRoomUserDto` unchanged except the additive `channels`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP.**

---

## Task 6: Extend moderation repository with Redis mirror helpers

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-room-moderation.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-moderation.repository.spec.ts` (extend existing)

**Interfaces:**
- Consumes: `@Inject(REDIS_CLIENT)` (add if absent, mirroring the audio moderation repo).
- Produces: `addMuteMirror(roomId,userId,ttlMs?)`, `removeMuteMirror(roomId,userId)`, `isMutedMirror(roomId,userId): Promise<boolean>`, and the same triad for blocks. (Keep existing `createMute/liftMute/createBlock/liftBlock/appendAction/listActions` untouched.)

- [ ] **Step 1: Write failing test** with an in-memory/ioredis-mock: `addMuteMirror('r','u')` then `isMutedMirror('r','u')===true`; after `removeMuteMirror` → false. Block triad likewise. TTL variant sets PX.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** using `SADD`/`SISMEMBER`/`SREM` on `mutesMirrorKey`/`blocksMirrorKey` plus a per-user key with optional `PX ttlMs` (mirror audio `addMuteCache`). No Prisma change.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP.**

---

## Task 7: VideoRoomReportRepository

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-report.repository.ts`
- Test: `...repositories/video-room-report.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `create(input): Promise<VideoRoomReport>`, `getById(id)`, `findOpen(roomId, reporterId, targetUserId, messageId?)`, `review(id, reviewerId, status, resolutionAction?)`, `list(roomId, {skip, take, targetUserId?}): Promise<[VideoRoomReport[], number]>`.

- [ ] **Step 1: Write failing test** (mock `PrismaService`): `create` calls `prisma.videoRoomReport.create` with audit cols; `list` returns `$transaction([findMany, count])` tuple ordered `createdAt desc`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** mirroring the audio `moderation.repository.ts` report methods, using `auditCreate(reporterId)`/`auditUpdate(reviewerId)`. Pagination tuple pattern.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP.**

---

## Task 8: VideoRoomWarningRepository

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-warning.repository.ts`
- Test: `...repositories/video-room-warning.repository.spec.ts`

**Interfaces:**
- Produces: `create({roomId,userId,moderatorId,reason,metadata?})`, `list(roomId, {skip, take, userId?}): Promise<[VideoRoomWarning[], number]>`, `count(roomId, userId): Promise<number>`.

- [ ] **Step 1: Write failing test** — `create` writes `prisma.videoRoomWarning.create` with `auditCreate(moderatorId)`; `count` calls `prisma.videoRoomWarning.count({where:{roomId,userId}})`.

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: PASS.** **Step 5: `tsc`+`eslint`+STOP.**

---

## Task 9: VideoRoomModerationMetrics

**Files:**
- Create: `src/modules/video-rooms/metrics/video-room-moderation.metrics.ts`
- Test: `...metrics/video-room-moderation.metrics.spec.ts`

**Interfaces:**
- Consumes: `MetricsService` (uses `.registry`).
- Produces: `incAction(action)`, `incKick(n=1)`, `incMute(channel)`, `incWarning()`, `incReport(reason)`, `incBlacklist()`, `incAutoAction(detector, action)`, `observeResponse(action, seconds)`.

- [ ] **Step 1: Write failing test** — after `incReport('SPAM')`, `registry.getSingleMetricAsString('video_rooms_moderation_reports_total')` contains `reason="SPAM"`.

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** copying the `VideoRoomsMetrics` template (`registers:[metrics.registry]`, `Counter`/`Histogram`). **Step 4: PASS.** **Step 5: gate + STOP.**

---

## Task 10: Moderation domain events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-moderation.events.ts`
- Test: `...events/video-room-moderation.events.spec.ts`

**Interfaces:**
- Produces: `VIDEO_ROOM_MODERATION_EVENTS` name registry + classes `UserKickedEvent, UserBlacklistedEvent, UserUnblacklistedEvent, UserMutedEvent, UserUnmutedEvent, UserWarnedEvent, UserForceDisconnectedEvent, UserReportedEvent, ReportReviewedEvent, RoomModerationUpdatedEvent, ModerationActionCompletedEvent` extending `DomainEvent<Payload>`. Payloads carry `{roomId, moderatorId, targetUserId, reason?, ...}`; `UserMutedEvent` adds `channels`; `UserReportedEvent` adds `{reportId, reporterId, reason, recipientIds}`.

- [ ] **Step 1: Write failing test** — `new UserKickedEvent({roomId,moderatorId,targetUserId,reason:null}).name === 'video_room.user_kicked'` and `.payload.roomId` set.

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** mirroring `audio-room-moderation.events.ts` (dot-namespaced names). **Step 4: PASS.** **Step 5: gate + STOP.**

---

## Task 11: VideoRoomModerationService — prereqs + kick + kickMany

**Files:**
- Create: `src/modules/video-rooms/services/video-room-moderation.service.ts`
- Test: `...services/video-room-moderation.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomModerationRepository`, `VideoRoomPermissionService`, `VideoRoomsRepository` (member ref/deactivate), `VideoRoomSessionService` (`endUserRoomSessions`), `SocketManager` (`disconnectUser`), `LockService`, `@Inject(EVENT_BUS) IEventBus`, `VideoRoomModerationMetrics`, `QueueService`, `ConfigService`.
- Produces: `assertPrereqs(roomId, actor, targetUserId, permission)` (private); `kick(actor, roomId, targetUserId, reason?)`; `kickMany(actor, roomId, targetUserIds[], reason?): Promise<{kicked:string[]; skipped:{userId,reason}[]}>`.

- [ ] **Step 1: Write failing tests**
  - `kick` throws `VIDEO_ROOM_CANNOT_MODERATE_SELF` when target===actor.
  - `kick` calls `permissions.assertPermission(actor, ref, KICK_USERS)` then `assertOutranks`; on success calls `repo.appendAction(KICK)`, `session.endUserRoomSessions`, `sockets.disconnectUser`, `bus.publish(UserKickedEvent)`.
  - owner target → `OwnerProtectionException`.
  - `kickMany` returns partial `{kicked, skipped}` when one target fails outranks.
  (Mock every dep; assert call order for the hard-disconnect + audit + publish.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Wrap mutations in `locks.withLock(moderationLockKey(roomId), fn)`. `assertPrereqs` = not-self → `assertPermission` → `assertOutranks` (permission service already throws owner-protection via `assertOutranks`/matrix; add explicit `OwnerProtectionException` if the target is owner). Build `ref = {id: room.id, ownerId: room.ownerId}` from `VideoRoomsRepository`. After deactivate + hard-disconnect, `appendAction`, publish, `metrics.incKick()`, enqueue notify on `VIDEO_ROOM_MODERATION_QUEUES.PROCESSING`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `tsc` + `eslint` + STOP.**

---

## Task 12: VideoRoomModerationService — blacklist + unblacklist

**Files:** Modify service + spec.

**Interfaces:**
- Produces: `blacklist(actor, roomId, targetUserId, reason?)`, `unblacklist(actor, roomId, targetUserId)`.

- [ ] **Step 1: Write failing tests** — perm `BLOCK_USERS`; `findActiveBlock` present → `BlacklistException` 409; on create → `repo.createBlock` + `addBlockMirror` + kick pipeline if active member + `appendAction(BLOCK)` + `bus.publish(UserBlacklistedEvent)`. `unblacklist`: none active → 404; else `liftBlock` + `removeBlockMirror` + `appendAction(UNBLOCK)` + publish.

- [ ] **Step 2–4:** FAIL → implement (reuse Task 11 kick pipeline for the eject) → PASS.

- [ ] **Step 5: gate + STOP.**

---

## Task 13: VideoRoomModerationService — mute + unmute + muteAll (channels)

**Files:** Modify service + spec.

**Interfaces:**
- Consumes: `VideoRoomMediaService.forceMute`, `VideoRoomChatPolicyService` (set room mode).
- Produces: `mute(actor, roomId, dto: MuteVideoRoomUserDto)`, `unmute(actor, roomId, userId, channels?)`, `muteAll(actor, roomId, channels?)`.

- [ ] **Step 1: Write failing tests**
  - `mute` with `channels:['chat']` → `findActiveMute` dup-guard (→ `MuteException` 409), `repo.createMute(type, expiresAt)`, `addMuteMirror`, `appendAction(MUTE_*)`, publish `UserMutedEvent{channels:['chat']}`. NO media call.
  - `mute` with `channels:['mic']` → calls `media.forceMute(actor, roomId, {targetUserId, muted:true})`, NO `createMute`.
  - `mute` default (undefined channels) → both.
  - `unmute` reverses per channel.
  - `muteAll` `chat` → `chatPolicy.setMode(roomId, READ_ONLY)`; `mic` → sweep non-elevated speakers via `media.forceMute`; `appendAction(ROOM_MUTED)`; publish `RoomModerationUpdatedEvent`.

- [ ] **Step 2–4:** FAIL → implement (`resolveExpiry` for TEMPORARY: `now + durationMinutes*60000`, require `durationMinutes>0`) → PASS.

- [ ] **Step 5: gate + STOP.**

---

## Task 14: VideoRoomModerationService — warn + forceDisconnect

**Files:** Modify service + spec.

**Interfaces:**
- Consumes: `VideoRoomWarningRepository`.
- Produces: `warn(actor, roomId, userId, reason, metadata?)`, `forceDisconnect(actor, roomId, userId, reason?)`.

- [ ] **Step 1: Write failing tests**
  - `warn` perm `MUTE_USERS`; `warningRepo.create`; `appendAction(WARN)`; publish `UserWarnedEvent`; `metrics.incWarning`; enqueue notify. **No** escalation branch.
  - `forceDisconnect` perm `KICK_USERS`; `session.endUserRoomSessions` + `sockets.disconnectUser`; `appendAction(FORCE_DISCONNECT)`; publish `UserForceDisconnectedEvent`; **no** membership deactivation, **no** mute/block row.

- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 15: VideoRoomModerationService — auto* system methods

**Files:** Modify service + spec.

**Interfaces:**
- Produces: `autoMute(roomId, userId, reason, meta?)`, `autoKick(roomId, userId, reason, meta?)`, `autoFlag(roomId, userId, reason, meta?)` — all use `SYSTEM_MODERATOR_ID` actor, run under lock, idempotent, no RBAC.

- [ ] **Step 1: Write failing tests**
  - `autoMute` idempotent (no-op if `findActiveMute`); creates TEMPORARY mute for `autoMuteMinutes`; `appendAction(AUTO_MUTED, {system:true})`; `metrics.incAutoAction`.
  - `autoKick` no-op if member inactive; else kick pipeline with system actor; `appendAction(AUTO_KICKED)`.
  - `autoFlag` opens a system `VideoRoomReport` (reporterId=SYSTEM) via `VideoRoomReportService.createSystemReport` (declared here, implemented in Task 16); `appendAction(AUTO_FLAGGED)`.

- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 16: VideoRoomReportService

**Files:**
- Create: `src/modules/video-rooms/services/video-room-report.service.ts`
- Test: `...services/video-room-report.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomReportRepository`, `VideoRoomsRepository` (room-exists + elevated recipients), `VideoRoomPermissionService`, `@Inject(EVENT_BUS)`, `QueueService`, `VideoRoomModerationMetrics`, `VideoRoomModerationRepository` (appendAction).
- Produces: `report(reporter, roomId, dto)`, `reviewReport(actor, roomId, reportId, dto)`, `listReports(actor, roomId, query)`, `createSystemReport(roomId, targetUserId, reason, meta?)`.

- [ ] **Step 1: Write failing tests**
  - `report`: not-self (`VIDEO_ROOM_CANNOT_MODERATE_SELF`); room missing → `VIDEO_ROOM_NOT_FOUND`; duplicate open (`findOpen`) → `VIDEO_ROOM_DUPLICATE_REPORT`; success → `create(PENDING)` + publish `UserReportedEvent{recipientIds}` + enqueue `REPORT` queue + `metrics.incReport`.
  - `reviewReport`: perm `MANAGE_PARTICIPANTS`; not found → 404; not PENDING → `VIDEO_ROOM_REPORT_NOT_PENDING`; success → `review` + `appendAction(REPORT_REVIEWED)` + publish `ReportReviewedEvent`.
  - `createSystemReport` writes reporterId=SYSTEM_MODERATOR_ID.

- [ ] **Step 2–4:** FAIL → implement (recipients = elevated roles ∪ owner − reporter) → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 17: VideoRoomModerationQueryService

**Files:**
- Create: `src/modules/video-rooms/services/video-room-moderation-query.service.ts`
- Test: `...services/video-room-moderation-query.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomModerationRepository` (listActions/listActiveMutes/listActiveBlocks), `VideoRoomWarningRepository`, `VideoRoomPermissionService`.
- Produces: `history(actor, roomId, query)`, `mutedUsers(actor, roomId, query)`, `blacklistedUsers(actor, roomId, query)`, `warnings(actor, roomId, query)`, each returning `buildPaginated(...)`. All gated by `hasAnyPermission(actor, ref, [KICK_USERS, BLOCK_USERS, MUTE_USERS])` (elevated read).

- [ ] **Step 1: Write failing tests** — each read asserts the elevated-permission gate and paginated shape.
- [ ] **Step 2–4:** FAIL → implement (add repo list methods for active mutes/blocks if missing) → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 18: Moderation socket listener (thin bridge)

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-moderation-socket.listener.ts`
- Test: `...listeners/video-room-moderation-socket.listener.spec.ts`

**Interfaces:**
- Consumes: `@Inject(EVENT_BUS) IEventBus`, `SocketManager`.
- Produces: `OnModuleInit` that `bus.subscribe`s each moderation event → emits the mapped `VIDEO_ROOM_MODERATION_SOCKET_EVENTS.*`. Kick/mute/blacklist/roomModerationUpdated → room broadcast (`emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE,...)`); warn → target user only; reported → each recipient only.

- [ ] **Step 1: Write failing test** — publishing `UserWarnedEvent` triggers `sockets.emitToUserEverywhere(targetUserId, 'userWarned', …)`; `UserKickedEvent` triggers `emitToNamespaceRoom(..., 'userKicked', …)`. NO business logic in the listener.

- [ ] **Step 2–4:** FAIL → implement mirroring `audio moderation-socket.listener.ts` → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 19: Auto-moderation engine + Detector interface + 5 detectors

**Files:**
- Create: `services/detectors/moderation-detector.interface.ts`, `services/detectors/{spam,flood,duplicate,rapid-join-leave,excessive-reports}.detector.ts`, `services/video-room-auto-moderation.service.ts`
- Test: one spec per detector + `video-room-auto-moderation.service.spec.ts`

**Interfaces:**
- Produces: `ModerationDetector { kind; evaluate(signal, cfg): Promise<DetectionResult|null> }`; `DetectionResult { action:'auto_mute'|'auto_kick'|'auto_flag'; reason; meta? }`; `ModerationSignal` union (`{type:'message', roomId, userId, contentHash, spamFlagged}` / `{type:'join_leave', roomId, userId}` / `{type:'report', roomId, targetUserId}`); `VideoRoomAutoModerationService.handle(signal): Promise<void>`.
- Consumes: `@Inject(REDIS_CLIENT)` (windowed counters), `ConfigService` (thresholds), `VideoRoomModerationService` (auto* actions), `VideoRoomModerationMetrics`.

- [ ] **Step 1: Write failing tests**
  - spam detector: after `spamThreshold` messages in window → `{action:'auto_mute'}`; reconciles with `spamFlagged` (if chat already flagged, count it once — do not double).
  - flood: `floodThreshold` msgs in `floodWindowSec` → auto_mute.
  - duplicate: same `contentHash` within `duplicateWindowSec` → auto_flag/auto_mute per config.
  - rapid-join-leave: `rapidJoinLeaveThreshold` cycles in window → auto_kick.
  - excessive-reports: `excessiveReportsThreshold` reports against target in window → auto_flag.
  - engine `handle`: runs matching detectors; first non-null → checks cooldown key → calls the right `moderation.auto*` → sets cooldown TTL → `metrics.incAutoAction`. Second signal within cooldown → no action.

- [ ] **Step 2–4:** FAIL → implement (Redis `INCR`+`EXPIRE` windowed counters keyed per Task 2; cooldown via `cooldownKey` SET NX PX) → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 20: Auto-moderation listener (signal subscription)

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-auto-moderation.listener.ts`
- Test: `...listeners/video-room-auto-moderation.listener.spec.ts`

**Interfaces:**
- Consumes: `@Inject(EVENT_BUS)`, `VideoRoomAutoModerationService`.
- Produces: `OnModuleInit` subscribing chat `MESSAGE_SENT` (+ `SPAM_DETECTED` for reconciliation) → `{type:'message'}`; member joined/left/reclaimed events → `{type:'join_leave'}`; `UserReportedEvent` → `{type:'report'}`; each mapped signal handed to `autoMod.handle(signal)`.

- [ ] **Step 1: Write failing test** — a published `MessageSentEvent` results in `autoMod.handle({type:'message', ...})`. Listener contains no detection logic.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 21: Queue processors (3) + registration

**Files:**
- Create: `processors/moderation-processing.processor.ts`, `processors/report-processing.processor.ts`, `processors/moderation-cleanup.processor.ts`
- Modify: `video-rooms.module.ts` (`BullModule.registerQueue` for the 3 names)
- Test: one `.spec.ts` per processor

**Interfaces:**
- Produces: three `@Processor(VIDEO_ROOM_MODERATION_QUEUES.*)` workers extending `BaseQueueWorker`, each implementing `handle(job)`: PROCESSING → dispatch notify to the shared `notifications` queue / notification service; REPORT → report intake/aggregation; CLEANUP → retention/expiry housekeeping (idempotent).

- [ ] **Step 1: Write failing test** — `handle({name:'notify', data})` invokes the injected notification enqueue; unknown job name is a safe no-op.
- [ ] **Step 2–4:** FAIL → implement (extend `BaseQueueWorker`, `QUEUE_CONCURRENCY`) → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 22: Expiry monitor (temp-mute sweep)

**Files:**
- Create: `src/modules/video-rooms/scheduler/video-room-moderation-expiry.monitor.ts`
- Test: `...scheduler/video-room-moderation-expiry.monitor.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomModerationRepository` (`expireMutes`/`findExpiredMutes`), `LockService`, `@Inject(EVENT_BUS)`, `ConfigService`.
- Produces: `OnModuleInit`/`OnModuleDestroy` interval (`expiryMonitorIntervalMs`) guarded by `MODERATION_MONITOR_LOCK_KEY`; each tick lifts expired mutes → mirror remove → `appendAction(UNMUTE,{reason:'expired'})` → publish `UserUnmutedEvent`.

- [ ] **Step 1: Write failing test** — a tick with one expired mute calls `liftMute` + `removeMuteMirror` + publishes `UserUnmutedEvent`; concurrent tick without the lock is skipped.
- [ ] **Step 2–4:** FAIL → implement (mirror `moderation-expiry.monitor.ts`) → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 23: Moderation controller (fill the 501 stubs)

**Files:**
- Create/Modify: `src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts`
- Test: `...controllers/video-rooms-moderation.controller.spec.ts`

**Interfaces:**
- Consumes: the 4 services, `@RequestMeta()`, `@CurrentUser()`.
- Produces: the REST surface in spec §7 under `@Controller('video-room')` (or existing base), `@ApiTags`/`@ApiBearerAuth`, `@NotGuest()` on `/report` only, `ParseUuidPipe` on ids, full `@ApiOperation`/`@ApiResponse` Swagger. Threads `RequestMetadata` into each command's audit metadata.

- [ ] **Step 1: Write failing tests** — each route delegates to its service method with `{id, roles}` actor and forwards `requestMeta`; `/report` allows non-elevated; history/list routes call the query service. Replace any `501` responses.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: gate + STOP.**

---

## Task 24: Module wiring + integration spec + boot verification

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Create: `src/modules/video-rooms/video-rooms-moderation.integration.spec.ts`

**Interfaces:**
- Produces: all new providers (4 services, 2 repos, metrics, 2 listeners, monitor, 3 processors, detectors) registered; 3 queues registered; controller added; providers exported where consumed elsewhere.

- [ ] **Step 1: Write failing integration spec** — a `Test.createTestingModule` wiring the moderation providers; exercise an end-to-end kick (permission → deactivate → hard-disconnect spy → audit row → event published) and a blacklist-then-join-rejected flow against the join-gate; assert Redis mirror populated.
- [ ] **Step 2: Run → FAIL** (unregistered providers / DI errors).
- [ ] **Step 3: Wire the module** (providers + `BullModule.registerQueue` + controller). Resolve DI (use `@Optional()`/module exports where a provider is consumed cross-service, per the VR-14 DI-gap lesson).
- [ ] **Step 4: Run integration spec → PASS; then run the FULL suite** `npx jest` — no regressions vs baseline.
- [ ] **Step 5: Boot verify** — `npx tsc --noEmit` clean, `npx eslint` clean on all new files, app module compiles. STOP for final review.

---

## Self-Review (against the spec)

**Spec coverage:** Kick/kickMany (T11), Blacklist add/remove (T12), Mute/Unmute/MuteAll channel-based (T13), Warn (T14, T8 table), Force-disconnect (T14), Auto-mod 5 detectors (T19–T20, T2 config), Report/Review (T16, T7 repo), Moderation history/muted/blacklisted/warnings (T17), Redis mirror sync (T6), Socket events (T18, T2), Event publishing (T10), BullMQ 3 queues (T21, T2), Audit/compliance (`appendAction` in T11–T16), Metrics (T9), Expiry monitor (T22), Exceptions (T4), DTOs (T5), Config (T3), Schema (T1), Controller+Swagger (T23), Module+integration (T24). No gaps.

**Placeholder scan:** No TBD/TODO; each task carries concrete test + implementation direction and exact interfaces.

**Type consistency:** `channels: MuteChannel[]` (T5) used consistently in T13/T18/T23; `autoMute/autoKick/autoFlag` names consistent T15/T19; `createSystemReport` declared T15, implemented T16; `addMuteMirror/removeMuteMirror/isMutedMirror` consistent T6/T13/T22; `VIDEO_ROOM_MODERATION_QUEUES` consistent T2/T21; socket-event constants consistent T2/T18.

**No-Git / file-only migration honored throughout; every task gate = tsc+eslint+jest+STOP.**
