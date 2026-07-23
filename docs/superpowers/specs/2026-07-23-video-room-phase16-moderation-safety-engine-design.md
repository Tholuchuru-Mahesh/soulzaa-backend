# VR-16 — Moderation, Safety & Compliance Engine (Video Rooms)

Status: **Design approved (2026-07-23) — awaiting plan.** Strictly additive. No Git. Migration file-only.

Owner workflow: Subagent-Driven TDD — one task at a time, failing test → implementation → passing test, run `tsc` + `eslint` + `jest` after every task, stop for review after each, never commit.

---

## 1. Objective

Implement the production-ready Moderation & Safety Engine for Soulzaa Video Rooms: the moderator **action layer** and **automated-moderation engine** on top of the moderation persistence/RBAC/enforcement seams already shipped in VR-1..VR-15. Supported actions: Kick (single + multi), Blacklist (add/remove), Mute/Unmute (channel-based: chat + microphone), Warn, Force Disconnect, User Report, Review Report, plus configurable Automated Moderation, Moderation History, and Compliance (immutable audit) Logging.

### Out of scope (explicit — PRD "DO NOT IMPLEMENT")

Temporary Ban · Permanent Ban · Global Ban · Suspend/Restore · Appeal System · Automatic Ban Escalation · Ban Expiration/Recovery/History · AI Content Moderation · Voice Moderation · Video-frame / Image analysis · Legal-compliance dashboard · Admin web panel · Platform-wide Trust & Safety.

The Video Room has **no ban feature**. `VideoRoomBlock` (durable, until-lifted) is the "Room Blacklist" and is the only bar-from-room primitive.

---

## 2. What already exists (reuse map — do NOT rebuild)

| Concern | Reused artifact | Location |
|---|---|---|
| Mute/Block/Audit persistence | `VideoRoomModerationRepository` — `createMute/findActiveMute/liftMute/expireMutes`, `createBlock/findActiveBlock/listActiveBlocks/liftBlock`, `appendAction/listActions` (write-side currently **dormant**) | `src/modules/video-rooms/repositories/video-room-moderation.repository.ts` |
| Tables + enums | `VideoRoomMute`, `VideoRoomBlock`, `VideoRoomModerationAction`; `VideoRoomModerationMuteType/Status/ActionType` | `prisma/schema/video_rooms_moderation.prisma` |
| RBAC | `VideoRoomPermissionService.assertPermission / assertOutranks / hasPermission`; perms `KICK_USERS, BLOCK_USERS, MUTE_USERS, ROOM_MUTE, MANAGE_PARTICIPANTS` | `src/modules/video-rooms/services/video-room-permission.service.ts`, `constants/video-room-permissions.ts` |
| Mic force-mute | media `forceMute(actor, roomId, {targetUserId, muted})` | `src/modules/video-rooms/services/video-room-media.service.ts:677` |
| Chat mute-all | chat-policy room modes (`READ_ONLY`, `ANNOUNCEMENT_ONLY`) + `assertNotBlockedOrMuted` read-enforcement | `src/modules/video-rooms/services/video-room-chat-policy.service.ts` |
| Join-gate blacklist | `join()` already calls `moderation.findActiveBlock` → throws `VIDEO_ROOM_BLOCKED` | `src/modules/video-rooms/services/video-room-member.service.ts:125` |
| Hard disconnect | `SocketManager.disconnectUser(server,userId)` / `disconnectUserEverywhere`; `VideoRoomSessionService.endUserRoomSessions(roomId,userId)` | `src/infra/socket/socket.manager.ts`, `src/modules/video-rooms/services/video-room-session.service.ts` |
| DTOs (stubbed) | `MuteVideoRoomUserDto`, `BlockVideoRoomUserDto` — controller returns **501 until this phase** | `src/modules/video-rooms/dto/moderation.dto.ts` |
| Chat signal | chat already emits `MESSAGE_SENT` **and** `SPAM_DETECTED` | `src/modules/video-rooms/events/video-room-chat.events.ts:63,227` |
| Event bus | `EVENT_BUS` / `IEventBus` publish; `onModuleInit` `bus.subscribe` listeners; façade `VideoRoomEventService` | `src/common/events/*`, `services/video-room-event.service.ts` |
| Metrics | `MetricsService.registry` + per-domain `prom-client` families (template: `VideoRoomsMetrics`) | `src/infra/observability/metrics.service.ts`, `video-rooms.metrics.ts` |
| Queues | module-local `BullModule.registerQueue` + `@Processor` extending `BaseQueueWorker`; `VIDEO_ROOM_QUEUES` | `src/infra/queue/*`, `constants/video-room.constants.ts:280` |
| Redis | `@Inject(REDIS_CLIENT)` + `CacheService` + `LockService`; keys `video-room:${roomId}:...` | `src/infra/redis/*` |
| Errors | `BusinessException(errorCode, message, status)` (field is `.errorCode`) + `ERROR_CODES` | `src/common/exceptions/*` |
| Config | `videoRoom` namespace (`registerAs('videoRoom', ...)`) | `src/config/configuration.ts:272` |
| Audit metadata | `@RequestMeta()` → `{requestId, ip, userAgent, timestamp}` threaded onto event `audit` block | `src/common/decorators/request-meta.decorator.ts` |
| Blueprint | Audio Room moderation vertical (mirror, don't copy audio-only concepts like ban/appeal) | `src/modules/audio-rooms/{services,controllers,repositories,events,listeners}/moderation*` |

The audio blueprint's ban/appeal/note concepts are **not** ported. Kick, mute, warn, report, auto-mod, socket fan-out, and the expiry monitor are.

---

## 3. Locked decisions

1. **Architecture = Option B (split-by-concern services):** `VideoRoomModerationService` (commands), `VideoRoomReportService`, `VideoRoomAutoModerationService`, `VideoRoomModerationQueryService`.
2. **Warnings = dedicated `VideoRoomWarning` table** (indexed count/history/metadata; searchable) **and** an immutable `appendAction(WARN)` entry. No auto-escalation.
3. **Kick + Blacklist = hard server-side disconnect** (`endUserRoomSessions` + `disconnectUser`) in addition to the domain event; rejoin barred by the existing join-gate for blacklist.
4. **3 dedicated module-local BullMQ queues:** `moderation-processing`, `report-processing`, `moderation-cleanup`.
5. **Full automated-moderation engine now** — 5 detectors, config-driven, pluggable `Detector` interface (AI-ready seam; no AI implemented).
6. **Channel-based mute:** `channels: ('chat'|'mic')[]` (default both). `chat` → durable `VideoRoomMute`; `mic` → delegate to existing media `forceMute` (no new media system).
7. **Reports = new `VideoRoomReport` table** + `VideoRoomReportReason` enum `{ USER, MESSAGE, SPAM, HARASSMENT, ABUSE, FAKE_ACCOUNT, OTHER }`; optional `messageId` for Message reports.
8. All business logic in services; socket listeners are thin bridges only; all DB via repositories (no Prisma in services); nothing hardcoded (thresholds config-driven).

---

## 4. Architecture

```
                         REST (fills 501 stubs)                Socket (/video-room, broadcast-only)
                                 │                                        ▲
        video-rooms-moderation.controller.ts                 video-room-moderation-socket.listener.ts
                                 │                                        │ (EVENT_BUS.subscribe → emit)
        ┌────────────────────────┼─────────────────────────────┐        │
        ▼                        ▼                              ▼        │
 VideoRoomModerationService  VideoRoomReportService   VideoRoomModerationQueryService
 (kick/kickMany/blacklist/    (report/reviewReport/    (history / muted-users /
  unblacklist/mute/unmute/     listReports)             blacklisted-users / warnings)
  warn/forceDisconnect/                    │
  muteAll + auto* system path)             │
        │           │        │             │
        │           │        │             ▼
        │           │        │      video-room-report.repository.ts  ── VideoRoomReport
        │           │        └───▶  video-room-warning.repository.ts  ── VideoRoomWarning
        │           └────────────▶  video-room-moderation.repository.ts (REUSE: mutes/blocks/actions)
        │
        ├─ permissions.assertPermission + assertOutranks (+ owner protection)
        ├─ media.forceMute (mic channel)          ├─ chat-policy mode (mute-all)
        ├─ session.endUserRoomSessions + sockets.disconnectUser (hard kick)
        ├─ bus.publish(<Moderation domain events>)  └─ appendAction(...) immutable audit
        │
        ▼
 VideoRoomAutoModerationService  ◀── video-room-auto-moderation.listener.ts
   (Detector registry)               (EVENT_BUS.subscribe: chat MESSAGE_SENT / SPAM_DETECTED,
   spam·flood·duplicate·              member joined/left, report created)
   rapid-join-leave·excessive-reports
   → autoMute / autoKick / autoFlag via VideoRoomModerationService (SYSTEM actor)

 Queues: moderation-processing · report-processing · moderation-cleanup (BaseQueueWorker)
 Scheduler: video-room-moderation-expiry.monitor.ts (temp-mute expiry sweep, Redis-locked)
 Metrics: VideoRoomModerationMetrics (registered on MetricsService.registry)
```

### Component responsibilities

- **VideoRoomModerationService** — every mutating command. Each command: (1) resolve actor + room ref, (2) `assertPermission(actor, ref, <perm>)` + `assertOutranks` + owner protection, (3) mutate via repositories + reused primitives, (4) `appendAction(...)` immutable audit, (5) `bus.publish(<event>)`, (6) enqueue async side-effects. Exposes internal `autoMute/autoKick/autoFlag(roomId, userId, reason, meta)` taking a `SYSTEM_MODERATOR_ID` actor for the auto-mod path (no RBAC, idempotent, under lock).
- **VideoRoomReportService** — `report` (`@NotGuest`, non-self, room-exists, dup-open guard), `reviewReport` (moderator-gated), `listReports`. Writes `VideoRoomReport`, appends action, publishes `UserReportedEvent`, notifies elevated recipients + enqueues `report-processing`.
- **VideoRoomAutoModerationService** — owns the `Detector` registry and the windowed Redis counters; maps `DetectionResult` → command-service auto action; enforces per-user cooldown. Config-driven thresholds. Reconciles with the pre-existing chat `SPAM_DETECTED` signal (consumes it; does not re-scan message text the chat layer already scanned).
- **VideoRoomModerationQueryService** — read models: paginated moderation history (from `VideoRoomModerationAction`), active muted-users, active blacklisted-users, per-user warnings + count. No mutations.

---

## 5. Storage

### 5.1 New tables (video-owned, `roomId String @db.Uuid`, no FKs — matches VR convention)

**`VideoRoomReport` → `video_room_reports`**
```
id           String  @id @default(uuid()) @db.Uuid
roomId       String  @db.Uuid
reporterId   String  @db.Uuid
targetUserId String  @db.Uuid
messageId    String? @db.Uuid          // set only for MESSAGE reports
reason       VideoRoomReportReason
description  String?
status       VideoRoomReportStatus @default(PENDING)
reviewedBy   String? @db.Uuid
reviewedAt   DateTime?
resolutionAction String?
createdBy/updatedBy/createdAt/updatedAt (audit cols)
@@index([roomId, status]) @@index([targetUserId]) @@index([reporterId])
```
Enums: `VideoRoomReportReason { USER, MESSAGE, SPAM, HARASSMENT, ABUSE, FAKE_ACCOUNT, OTHER }`, `VideoRoomReportStatus { PENDING, REVIEWED, DISMISSED, ACTIONED }`.

**`VideoRoomWarning` → `video_room_warnings`**
```
id          String @id @default(uuid()) @db.Uuid
roomId      String @db.Uuid
userId      String @db.Uuid
moderatorId String @db.Uuid
reason      String
metadata    Json?
createdBy/updatedBy/createdAt/updatedAt (audit cols)
@@index([roomId, userId]) @@index([userId])
```
Warning **count** = indexed `count({where:{roomId,userId}})`; **history** = paginated list; **metadata** = the `Json` column. Records only — never escalates.

### 5.2 Additive changes to shared enums

- `VideoRoomModerationActionType` already includes `MUTE_TEMPORARY, MUTE_PERMANENT, UNMUTE, BLOCK, UNBLOCK, KICK, WARN, ROLE_*, ANNOUNCEMENT_*`. Add: `FORCE_DISCONNECT, REPORT_REVIEWED, ROOM_MUTED, ROOM_UNMUTED, AUTO_MUTED, AUTO_KICKED, AUTO_FLAGGED`. (Additive enum values only — no column changes to existing tables.) `muteAll`/room-unmute log `ROOM_MUTED`/`ROOM_UNMUTED` (targetUserId null); auto actions log `AUTO_*`.

### 5.3 Redis keys (all `video-room:` namespaced, `{roomId}` hash-tagged where multi-key)

```
video-room:{roomId}:mutes                      SET  active-mute mirror (fast enforcement)
video-room:{roomId}:blocks                     SET  active-block mirror (fast join-gate)
video-room:moderation:{roomId}                 lock per-room command mutex (LockService)
video-room:moderation:monitor                  lock fleet-wide expiry-sweep singleton
video-room:mod:spam:{roomId}:{userId}          windowed counter (INCR + EXPIRE)
video-room:mod:flood:{roomId}:{userId}         windowed counter
video-room:mod:dup:{roomId}:{userId}           last-hash / dedup set (window TTL)
video-room:mod:joinleave:{roomId}:{userId}     windowed join/leave counter
video-room:mod:reports:{roomId}:{userId}       windowed report counter (excessive-reports)
video-room:mod:cooldown:{roomId}:{userId}      auto-action cooldown flag (TTL)
```
The mutes/blocks mirror sets are populated on create/lift and read by the enforcement points; DB remains authoritative (mirror is the hot-path cache, rebuilt lazily on miss).

---

## 6. The engine

### 6.1 Command semantics (normative)

All commands run under `LockService.withLock('video-room:moderation:{roomId}', …)`. Prereq for every target action: **not self**, `assertPermission`, `assertOutranks`, **owner-protection** (owner never moderatable except platform admin → `OwnerProtectionException`).

- **kick(actor, roomId, targetUserId, reason?)** — perm `KICK_USERS`. Deactivate member (`repo.deactivateMember`), **hard disconnect** (`session.endUserRoomSessions` + `sockets.disconnectUser`), `appendAction(KICK)`, publish `UserKickedEvent`, enqueue notify. No rejoin bar.
- **kickMany(actor, roomId, targetUserIds[], reason?)** — validates each; per-target prereqs; partial-success result `{kicked[], skipped[]}`; one action row per target.
- **blacklist(actor, roomId, targetUserId, reason?)** — perm `BLOCK_USERS`. `repo.findActiveBlock` dup-guard (→ `BlacklistException` 409); `repo.createBlock`; add to blocks mirror; if member active → kick pipeline; `appendAction(BLOCK)`; publish `UserBlacklistedEvent`; enqueue notify. Rejoin barred by existing join-gate.
- **unblacklist(actor, roomId, targetUserId)** — perm `BLOCK_USERS`. `findActiveBlock` (→ 404 if none); `repo.liftBlock`; remove mirror; `appendAction(UNBLOCK)`; publish `UserUnblacklistedEvent`.
- **mute(actor, roomId, dto: MuteVideoRoomUserDto + channels)** — perm `MUTE_USERS`. For `chat`: `findActiveMute` dup-guard (→ `MuteException` 409), `repo.createMute(type, expiresAt)`, add mutes mirror. For `mic`: delegate to `media.forceMute(actor, roomId, {targetUserId, muted:true})`. `appendAction(MUTE_*)`; publish `UserMutedEvent{channels}`; enqueue notify.
- **unmute(actor, roomId, targetUserId, channels)** — perm `MUTE_USERS`. `chat`: `repo.liftMute` + mirror remove. `mic`: `media.forceMute(...muted:false)`. `appendAction(UNMUTE)`; publish `UserUnmutedEvent`.
- **muteAll(actor, roomId, {channels})** — perm `ROOM_MUTE`. `chat` → chat-policy set mode `READ_ONLY` (reuse). `mic` → sweep non-elevated seated speakers via `media.forceMute`. `appendAction`; publish `RoomModerationUpdatedEvent`.
- **warn(actor, roomId, targetUserId, reason, metadata?)** — perm `MUTE_USERS` (lowest moderation perm; no dedicated WARN perm exists, matching the RBAC matrix). `warningRepo.create`; `appendAction(WARN)`; publish `UserWarnedEvent` (target-only socket); enqueue notify. No escalation.
- **forceDisconnect(actor, roomId, targetUserId, reason?)** — perm `KICK_USERS`. `session.endUserRoomSessions` + `sockets.disconnectUser`; `appendAction(FORCE_DISCONNECT)`; publish `UserForceDisconnectedEvent`. No durable mute/block, no membership deactivation (transient eject).

### 6.2 Reports

- **report(reporter, roomId, dto)** — controller `@NotGuest`; service: not-self, room-exists, no duplicate open report for `(room,reporter,target[,message])`. `reportRepo.create(status=PENDING)`; publish `UserReportedEvent{recipientIds}` (elevated roles + owner, minus reporter); enqueue `report-processing`. Emitted to each recipient only (never broadcast).
- **reviewReport(actor, roomId, reportId, dto)** — perm `MANAGE_PARTICIPANTS` (or elevated). `getReport` (404 / 409-if-not-PENDING); `reportRepo.review(status, resolutionAction)`; `appendAction(REPORT_REVIEWED)`.

### 6.3 Automated moderation (normative)

`Detector` interface:
```ts
interface ModerationDetector {
  readonly kind: 'spam' | 'flood' | 'duplicate' | 'rapid_join_leave' | 'excessive_reports';
  evaluate(signal: ModerationSignal, cfg: ModerationConfig): Promise<DetectionResult | null>;
}
type DetectionResult = { action: 'auto_mute' | 'auto_kick' | 'auto_flag'; reason: string; meta?: Json };
```
- **Signals** arrive on EVENT_BUS via `video-room-auto-moderation.listener.ts`:
  - chat `MESSAGE_SENT` → spam, flood, duplicate detectors (using windowed Redis counters; **spam reconciles with the existing `SPAM_DETECTED`** signal rather than re-scanning).
  - member `joined` / `left`/`reclaimed` → rapid-join-leave detector.
  - `UserReportedEvent` → excessive-reports detector (counts reports *against* a target in window).
- **Engine flow:** per signal, run matching detectors; first non-null result → check `cooldown` key → apply via command-service `autoMute` / `autoKick` / `autoFlag` (system actor, idempotent) → set cooldown TTL → increment metric.
- **`autoFlag`** opens a system `VideoRoomReport` (`reporterId = SYSTEM_MODERATOR_ID`, `reason = SPAM|ABUSE`) so human moderators see it; no punitive action.
- **Thresholds** entirely from `videoRoom.moderation` config (see §10). A detector whose threshold is unset/disabled is a no-op (feature-flag friendly).

### 6.4 Expiry monitor

`video-room-moderation-expiry.monitor.ts` — `setInterval(cfg.expiryMonitorIntervalMs)` guarded by Redis lock `video-room:moderation:monitor` (single sweeper). Calls `repo.expireMutes()` (already present) → for each expired mute: lift + mirror remove + `appendAction(UNMUTE, {reason:'expired'})` + publish `UserUnmutedEvent`. Registered in `video-rooms.module.ts`. (Blocks are permanent-until-lifted — never expire.)

---

## 7. API surface

### REST — base `video-room/:roomId`, JWT-guarded (global), fully Swagger-documented

| Method | Route | Perm (service-enforced) | DTO |
|---|---|---|---|
| POST | `/moderation/kick` | KICK_USERS | `KickVideoRoomUsersDto {userIds[], reason?}` |
| POST | `/moderation/blacklist` | BLOCK_USERS | `BlockVideoRoomUserDto` (reuse) |
| DELETE | `/moderation/blacklist/:userId` | BLOCK_USERS | — |
| POST | `/moderation/mute` | MUTE_USERS | `MuteVideoRoomUserDto` (reuse) + `channels?` |
| POST | `/moderation/unmute` | MUTE_USERS | `UnmuteVideoRoomUserDto {userId, channels?}` |
| POST | `/moderation/mute-all` | ROOM_MUTE | `MuteAllDto {channels?}` |
| POST | `/moderation/warn` | MUTE_USERS | `WarnVideoRoomUserDto {userId, reason, metadata?}` |
| POST | `/moderation/force-disconnect` | KICK_USERS | `ForceDisconnectDto {userId, reason?}` |
| POST | `/report` | `@NotGuest` (report-only) | `ReportVideoRoomUserDto {targetUserId, reason, description?, messageId?}` |
| POST | `/reports/:reportId/review` | MANAGE_PARTICIPANTS | `ReviewReportDto {status, resolutionAction?}` |
| GET | `/moderation/history` | elevated | `ListModerationDto` (pagination + `targetUserId?`) |
| GET | `/reports` | elevated | `ListModerationDto` |
| GET | `/muted-users` | elevated | pagination |
| GET | `/blacklisted-users` | elevated | pagination |
| GET | `/moderation/warnings` | elevated | `ListModerationDto` (+`userId?`) |

DTOs reuse `MuteVideoRoomUserDto`/`BlockVideoRoomUserDto` unchanged; new DTOs added in `dto/moderation.dto.ts`. Text bounds from constants (`VIDEO_ROOM_MODERATION_REASON_MAX`, new `..._DESCRIPTION_MAX`, `..._WARNING_METADATA` limits). Guests denied via `@NotGuest`; audience/viewer may only hit `/report`.

### Socket — `/video-room` namespace (broadcast-only; EVENT_BUS → listener)

`userKicked`, `userMuted`, `userUnmuted`, `userWarned` (target-only), `userReported` (recipients-only), `userBlacklisted`, `userUnblacklisted`, `userForceDisconnected`, `moderationUpdated`, `roomModerationUpdated`.

### EVENT_BUS domain events (`video-room-moderation.events.ts`, dot-namespaced)

`UserKickedEvent`, `UserBlacklistedEvent`, `UserUnblacklistedEvent`, `UserMutedEvent`, `UserUnmutedEvent`, `UserWarnedEvent`, `UserForceDisconnectedEvent`, `UserReportedEvent`, `ReportReviewedEvent`, `RoomModerationUpdatedEvent`, `ModerationActionCompletedEvent`. All extend `DomainEvent<Payload>`; published through a `VideoRoomEventService`-style path.

---

## 8. RBAC, exceptions, audit

- **RBAC:** reuse `VideoRoomPermissionService`. Owner = full; Admin = kick/mute/warn/blacklist/room-mute; Moderator = per matrix; Host/Participant = none; Audience/Viewer = report only. Nothing hardcoded — `VIDEO_ROOM_PERMISSION_MATRIX` is the source of truth. `assertOutranks` + owner-protection guard every target action.
- **Exceptions** (`video-room-moderation.exceptions.ts`, thin `BusinessException` wrappers matching the PK/treasure exception-file pattern): `ModerationException`, `KickException`, `MuteException`, `BlacklistException`, `WarningException`, `ReportException`, `OwnerProtectionException`. New `ERROR_CODES` entries added to `src/common/exceptions/error-codes.ts`.
- **Audit / compliance:** every action → `appendAction({roomId, moderatorId, targetUserId, action, reason, metadata})` into the append-only `VideoRoomModerationAction` (immutable spine). `metadata` carries `{requestId, ip, userAgent}` from `@RequestMeta()` threaded through the controller. Auto actions use `moderatorId = SYSTEM_MODERATOR_ID` and `metadata.system = true`.

---

## 9. Observability

`VideoRoomModerationMetrics` (registered on `MetricsService.registry`):
- Counters: `video_rooms_moderation_actions_total{action}`, `..._kicks_total`, `..._mutes_total{channel}`, `..._warnings_total`, `..._reports_total{reason}`, `..._blacklist_total`, `..._auto_actions_total{detector,action}`, `..._spam_total`, `..._flood_total`.
- Histogram: `video_rooms_moderation_response_seconds{action}` (moderation response time).
- Gauge (optional): active mutes / active blocks per sweep.

---

## 10. Configuration

Extend `videoRoom` namespace with a `moderation` object (env-backed, `env.validation.ts` defaults; nothing hardcoded):
```
moderation: {
  spamThreshold, spamWindowSec,
  floodThreshold, floodWindowSec,
  duplicateWindowSec,
  rapidJoinLeaveThreshold, rapidJoinLeaveWindowSec,
  excessiveReportsThreshold, excessiveReportsWindowSec,
  warningThreshold,                 // informational only (never auto-escalates)
  autoMuteMinutes,
  autoActionCooldownSec,
  expiryMonitorIntervalMs,
  reasonMax, descriptionMax,
}
```
New env vars `VIDEO_ROOM_MOD_*` with sane defaults (mirroring the audio-room chat auto-mod defaults: mute-threshold 3, kick-threshold 6, mute-minutes 15, window 3600, dedup 30).

---

## 11. Performance & scale targets

- Enforcement reads (join-gate block, chat mute) hit the Redis mirror set — O(1), no DB on hot path.
- Command mutations serialized per-room via `LockService` (correctness) but independent across rooms (horizontal).
- Auto-mod counters are Redis `INCR`+`EXPIRE` (atomic, windowed) — supports high message rates.
- Async fan-out (notify, report aggregation) offloaded to the 3 dedicated queues; workers idempotent + DLQ-backed via `BaseQueueWorker`.
- Expiry sweep is a single fleet-wide locked sweeper — no thundering herd.

---

## 12. Backward compatibility — mandatory release gate

- Purely additive: new services/controller-routes (filling existing 501 stubs), new tables, additive enum values, new Redis keys, new queues, new metrics, new config with defaults.
- No signature changes to existing services; enforcement points (join/chat/seat/gift block-checks) already call `findActiveBlock`/`findActiveMute` and keep working unchanged.
- Migration is **file-only** (added `.prisma` + generated migration folder authored by hand — no `prisma migrate` run, no DB reset, no git).
- **Release gate:** full `tsc` clean, `eslint` clean, `jest` green (no regressions vs the current baseline), and the app boots (DI resolves) with the new module wiring.

---

## 13. Testing strategy (strict TDD)

- **Unit:** each of the 4 services; each of the 5 detectors; expiry monitor; socket listener (event→emit mapping); auto-mod listener (signal routing + cooldown).
- **Repository:** `VideoRoomReportRepository`, `VideoRoomWarningRepository` (CRUD, pagination, count); reused moderation repo write-paths exercised.
- **Permission/owner-protection:** each command asserts perm + outranks + owner-protection; audience/viewer report-only.
- **Action tests:** kick/kickMany (partial success), blacklist/unblacklist (dup guard, join-gate bar), mute/unmute per channel (chat row + mic delegation), warn (count/history), force-disconnect, report/review.
- **Concurrency:** duplicate mute/blacklist under lock; auto-mod cooldown prevents double action.
- **Integration:** end-to-end moderation flow spec (mirrors audio `moderation.service.spec.ts` breadth), incl. hard-disconnect and Redis-mirror population.
- `tsc` + `eslint` + `jest` after **every** task; stop for review after each; never commit.

---

## 14. Deliverables

New (all under `src/modules/video-rooms/`): 4 services + `detectors/` (interface + 5), 2 repositories, moderation controller (fills 501 stubs), events file, 2 listeners (socket bridge + auto-mod), exceptions file, expiry monitor, moderation constants, metrics provider, 3 queue processors; DTO additions; 2 new Prisma tables + enum additions (file-only migration); `videoRoom.moderation` config + env vars + `ERROR_CODES` additions; module wiring in `video-rooms.module.ts`; full spec coverage per §13. Nothing committed.
```
