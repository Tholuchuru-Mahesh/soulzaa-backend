# Video Room Phase 3 — Member, Presence & Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the dormant VR-0 presence/session/state seams into a live participant lifecycle — join, leave, unexpected disconnect, grace-window reconnect, heartbeat, per-device duplicate eviction, a 7-state presence machine, version-based room sync, counters, audit, metrics, and events — reusing the existing tables, config, and infra with zero new tables/migrations/env vars.

**Architecture:** REST commands (`VideoRoomMembersController` → new `VideoRoomMemberService`) orchestrate the existing `VideoRoomStateService`/`VideoRoomSessionService`/`VideoRoomPresenceService`; broadcast is EVENT_BUS → `VideoRoomSocketListener` relay (no domain `@SubscribeMessage` gateway). Live state is Redis-authoritative (`VideoRoomPresence` is a lazily-written durable mirror); the `VideoRoomSessionMonitor` reclaims stale sessions after a 120s grace window.

**Tech Stack:** NestJS, TypeScript (strict), Prisma/Postgres, ioredis (`REDIS_CLIENT`/`CacheService`/`LockService`/`PresenceService`), Socket.IO (`SocketManager`), `EVENT_BUS` (in-process), prom-client (`VideoRoomsMetrics`), Jest.

## Global Constraints

- **No new Prisma tables, no migration, no new Prisma enum values.** Reuse `VideoRoomMember`, `VideoRoomPresence`, `VideoRoomStatistics`, `video_room_logs` (`JOINED`/`LEFT`), `video_room_events`.
- **No new env vars.** All knobs exist in the `videoRoom` config namespace; read via `loadVideoRoomConfig(config)`.
- **House conventions:** errors are `new BusinessException(ERROR_CODES.*, msg, HttpStatus.*)` — no per-module exception classes. No domain socket gateway. No Prisma outside repositories. Redis keys hash-tagged (`{...}`) for Cluster safety.
- **Auth:** global `JwtAuthGuard`; writes add `@NotGuest()`; `@CurrentUser()` → `AuthenticatedUser { id, roles, sid? }`. Actor helper `actor(user): RoomActor` already used in VR-2.
- **Verification gates (run after each task):** `pnpm build` (0 errors), `pnpm lint` (0 warnings), targeted `pnpm test <spec>`; final task runs `pnpm test` (existing 806+ green) + `pnpm boundaries`.
- **Commits:** the working tree carries uncommitted VR-0/1/2 work on `main`; do **not** commit unless the user asks. Each task's final step is a green-test checkpoint, not a git commit.

---

### Task 1: Foundations — error codes, presence enum, constants, session-record interface

Scaffolding every later task consumes. No behavior yet, so its "test" is `tsc`.

**Files:**
- Modify: `src/common/exceptions/error-codes.ts` (add VR-3 codes)
- Modify: `src/modules/video-rooms/enums/index.ts` (add `VideoRoomPresenceState`)
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (join lock key + socket events)
- Modify: `src/modules/video-rooms/interfaces/room-session-manager.interface.ts` (extend record types)
- Modify: `src/modules/video-rooms/interfaces/room-state-manager.interface.ts` (extend snapshot counters)

**Interfaces produced (later tasks rely on these exact names/types):**
```ts
// enums/index.ts
export enum VideoRoomPresenceState {
  CONNECTING = 'CONNECTING', ONLINE = 'ONLINE', IDLE = 'IDLE',
  RECONNECTING = 'RECONNECTING', DISCONNECTED = 'DISCONNECTED',
  LEFT = 'LEFT', OFFLINE = 'OFFLINE',
}

// interfaces/room-session-manager.interface.ts — extend existing
export interface RegisterSessionInput {
  roomId: string; userId: string; socketId: string; role: ConnectionType;
  deviceId?: string; platform?: string; ip?: string; sid?: string;
}
export interface VideoRoomSessionRecord {
  roomId: string; userId: string; socketId: string; role: ConnectionType;
  deviceId?: string; platform?: string; ip?: string; sid?: string;
  presenceState: VideoRoomPresenceState; inBackground: boolean;
  connectedAt: string; lastSeenAt: string; reconnectCount: number;
}
export interface RegisterSessionResult { session: VideoRoomSessionRecord; duplicateOf: string | null; }
export interface HeartbeatInput { inBackground?: boolean; }
// IRoomSessionManager gains:
//   heartbeat(socketId: string, input?: HeartbeatInput): Promise<boolean>;
//   listUserSessions(userId: string): Promise<string[]>;
//   endUserRoomSessions(roomId: string, userId: string): Promise<VideoRoomSessionRecord[]>;
//   markPresence(socketId: string, state: VideoRoomPresenceState): Promise<VideoRoomSessionRecord | null>;

// interfaces/room-state-manager.interface.ts — extend snapshot + mutation
export interface VideoRoomStateSnapshot {
  roomId: string; version: number; status: VideoRoomStatus;
  participantCount: number; viewerCount: number; hostCount: number;
  onlineCount: number; reconnectingCount: number; idleCount: number;   // NEW
  isLocked: boolean; updatedAt: string;
}
// VideoRoomStateMutation stays Partial<Omit<...,'roomId'|'version'|'updatedAt'>> — auto-includes new counts

// error-codes.ts — new keys (values = SCREAMING_SNAKE strings matching the key)
// VIDEO_ROOM_ENDED, VIDEO_ROOM_PASSWORD_INVALID, VIDEO_ROOM_BLOCKED,
// VIDEO_ROOM_NOT_MEMBER, VIDEO_ROOM_DUPLICATE_SESSION, VIDEO_ROOM_RECONNECT_FAILED

// constants/video-room.constants.ts
export const videoRoomUserSessionsKey = (userId: string) => `video-room:user:{${userId}}:sessions`;
export const videoRoomJoinLockKey = (roomId: string) => `video-room:join:{${roomId}}`;
// VIDEO_ROOM_SOCKET_EVENTS gains: USER_DISCONNECTED:'video_room.user_disconnected',
//   USER_RECONNECTED:'video_room.user_reconnected', PRESENCE_UPDATED:'video_room.presence_updated',
//   SESSION_EVICTED:'video_room.session_evicted'  (ROOM_SYNC reuses existing STATE_SYNC:'video_room.state_sync')
```

- [ ] **Step 1:** Add the six `ERROR_CODES` entries in the `// ---- Video Room domain ----` block (each `KEY: 'KEY'`), with the HttpStatus noted in a trailing comment. Add `VideoRoomPresenceState` to `enums/index.ts`. Add the two key builders + four socket-event names to constants. Extend `RegisterSessionInput`/`VideoRoomSessionRecord`/`RegisterSessionResult`/`IRoomSessionManager` and `VideoRoomStateSnapshot` per the block above. Import `VideoRoomPresenceState` where referenced.
- [ ] **Step 2:** Update the existing implementations so the project still compiles: in `video-room-session.service.ts` widen `heartbeat` signature (accept optional `input`) and populate the new record fields in `register` (default `presenceState: CONNECTING`, `inBackground: false`, `lastSeenAt = connectedAt`, `reconnectCount: 0`); in `video-room-state.service.ts` `restore()` default the three new counts to `0`. Keep existing tests green (they will still pass — additive fields).
- [ ] **Step 3: Verify** — Run `pnpm build`. Expected: 0 errors. Run `pnpm test video-room-session.service video-room-state.service`. Expected: existing specs PASS.

---

### Task 2: `derivePresenceState` pure function

**Files:**
- Create: `src/modules/video-rooms/services/video-room-presence-state.ts`
- Test: `src/modules/video-rooms/services/video-room-presence-state.spec.ts`

**Interfaces produced:**
```ts
export interface PresenceStateThresholds {
  heartbeatIntervalSeconds: number; reconnectTimeoutSeconds: number; idleTimeoutSeconds: number;
}
// Tunable knobs, isolated at top of file:
export const PRESENCE_MISS_FACTOR = 2;        // missed beats before RECONNECTING
export const PRESENCE_FIRST_BEAT_FACTOR = 1;  // grace for the very first beat (CONNECTING window)
export function derivePresenceState(
  session: Pick<VideoRoomSessionRecord,'presenceState'|'inBackground'|'lastSeenAt'|'reconnectCount'> | null,
  nowMs: number,
  cfg: PresenceStateThresholds,
): VideoRoomPresenceState;
```

Rules (age = `nowMs − Date.parse(lastSeenAt)`, in seconds):
- `session == null` → `OFFLINE`.
- `presenceState === LEFT` → `LEFT` (terminal; sticky).
- `presenceState === DISCONNECTED` and `age ≤ reconnectTimeoutSeconds` → `DISCONNECTED`; if `age > reconnectTimeoutSeconds` → `LEFT`.
- `reconnectCount === 0 && age ≤ heartbeatIntervalSeconds × PRESENCE_FIRST_BEAT_FACTOR && presenceState === CONNECTING` → `CONNECTING`.
- `age > reconnectTimeoutSeconds` → `LEFT`.
- `age > heartbeatIntervalSeconds × PRESENCE_MISS_FACTOR` → `RECONNECTING`.
- `inBackground || age > idleTimeoutSeconds` → `IDLE`.
- else → `ONLINE`.

- [ ] **Step 1: Write the failing test** (`cfg = { heartbeatIntervalSeconds: 25, reconnectTimeoutSeconds: 120, idleTimeoutSeconds: 300 }`, `now = 1_000_000_000_000`):
```ts
import { derivePresenceState } from './video-room-presence-state';
import { VideoRoomPresenceState } from '../enums';
const cfg = { heartbeatIntervalSeconds: 25, reconnectTimeoutSeconds: 120, idleTimeoutSeconds: 300 };
const NOW = 1_000_000_000_000;
const at = (secAgo: number, over: Partial<any> = {}) => ({
  presenceState: VideoRoomPresenceState.ONLINE, inBackground: false,
  lastSeenAt: new Date(NOW - secAgo * 1000).toISOString(), reconnectCount: 1, ...over,
});
it('OFFLINE when no session', () => expect(derivePresenceState(null, NOW, cfg)).toBe(VideoRoomPresenceState.OFFLINE));
it('ONLINE when fresh + foreground', () => expect(derivePresenceState(at(5), NOW, cfg)).toBe(VideoRoomPresenceState.ONLINE));
it('IDLE when backgrounded', () => expect(derivePresenceState(at(5, { inBackground: true }), NOW, cfg)).toBe(VideoRoomPresenceState.IDLE));
it('IDLE when idle past idleTimeout but within grace? no — RECONNECTING dominates past miss', () => expect(derivePresenceState(at(310), NOW, cfg)).toBe(VideoRoomPresenceState.RECONNECTING));
it('RECONNECTING when > 2 missed beats within grace', () => expect(derivePresenceState(at(60), NOW, cfg)).toBe(VideoRoomPresenceState.RECONNECTING));
it('LEFT when past grace', () => expect(derivePresenceState(at(130), NOW, cfg)).toBe(VideoRoomPresenceState.LEFT));
it('LEFT is sticky', () => expect(derivePresenceState(at(1, { presenceState: VideoRoomPresenceState.LEFT }), NOW, cfg)).toBe(VideoRoomPresenceState.LEFT));
it('CONNECTING for first beat window', () => expect(derivePresenceState(at(10, { presenceState: VideoRoomPresenceState.CONNECTING, reconnectCount: 0 }), NOW, cfg)).toBe(VideoRoomPresenceState.CONNECTING));
it('DISCONNECTED sticky within grace', () => expect(derivePresenceState(at(30, { presenceState: VideoRoomPresenceState.DISCONNECTED }), NOW, cfg)).toBe(VideoRoomPresenceState.DISCONNECTED));
it('DISCONNECTED past grace → LEFT', () => expect(derivePresenceState(at(130, { presenceState: VideoRoomPresenceState.DISCONNECTED }), NOW, cfg)).toBe(VideoRoomPresenceState.LEFT));
```
- [ ] **Step 2: Run** `pnpm test video-room-presence-state` → FAIL (module not found).
- [ ] **Step 3: Implement** per the rule ordering above (order matters — LEFT/DISCONNECTED stickiness and the grace cutoff must be checked before the IDLE/ONLINE bands).
- [ ] **Step 4: Run** `pnpm test video-room-presence-state` → PASS (all cases).

---

### Task 3: Repository member + stats primitives; moderation block read

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-rooms.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-rooms.repository.spec.ts` (extend)
- Modify: `src/modules/video-rooms/repositories/video-room-moderation.repository.ts` (+ read)
- Test: `src/modules/video-rooms/repositories/video-room-moderation.repository.spec.ts` (extend)

**Interfaces produced (mirror `AudioRoomsRepository` member section):**
```ts
// VideoRoomsRepository
getMember(roomId: string, userId: string): Promise<VideoRoomMember | null>;
upsertActiveMember(p: { roomId: string; userId: string; role: VideoRoomMemberRole;
  deviceId?: string; platform?: string; actorId: string }): Promise<VideoRoomMember>;
deactivateMember(roomId: string, userId: string, actorId: string): Promise<void>; // isActive=false, memberStatus=LEFT, leftAt=now
setMemberRole(roomId: string, userId: string, role: VideoRoomMemberRole, actorId: string): Promise<void>;
listActiveMembers(roomId: string, take: number, skip: number): Promise<VideoRoomMember[]>; // order joinedAt asc
countActiveMembers(roomId: string): Promise<number>;
bumpStatsOnJoin(roomId: string, liveCount: number): Promise<void>; // totalJoins++, totalSessions++, currentViewers=liveCount, peakViewers=max, lastActivityAt
bumpStatsOnLeave(roomId: string, liveCount: number): Promise<void>; // currentViewers=liveCount, lastActivityAt
// VideoRoomModerationRepository
findActiveBlock(roomId: string, userId: string): Promise<{ id: string } | null>; // status ACTIVE
```

- [ ] **Step 1: Write failing tests** — extend the repo spec. Follow the existing spec's Prisma-mock/test-DB pattern (read the top of `video-rooms.repository.spec.ts` first and match it). Cover: `upsertActiveMember` creates then reactivates the same `(roomId,userId)` row (no duplicate; `isActive=true`, `leftAt=null`, `memberStatus=ACTIVE`); `deactivateMember` sets `isActive=false`/`memberStatus=LEFT`/`leftAt`; `listActiveMembers` returns only active ordered by `joinedAt`; `bumpStatsOnJoin` increments `totalJoins`+`totalSessions` and raises `peakViewers` via a `max` write; `findActiveBlock` returns the row when a block with `status=ACTIVE` exists, else null.
- [ ] **Step 2: Run** the two repo specs → FAIL (methods undefined).
- [ ] **Step 3: Implement** the methods using `PrismaService`, `auditCreate`/`auditUpdate`. For `upsertActiveMember` use `prisma.videoRoomMember.upsert` on the `roomId_userId` composite unique (create branch stamps `auditCreate(actorId)` + `joinedAt`; update branch sets `isActive:true, leftAt:null, memberStatus:ACTIVE, role, deviceId, platform, lastActiveAt:new Date()` + `auditUpdate`). `peakViewers` raise = a second `updateMany` where `peakViewers < liveCount`. `findActiveBlock` = `findFirst` on `video_room_blocks` where `{ roomId, userId, status: 'ACTIVE' }` (confirm the exact model/enum names in `video_rooms_moderation.prisma`).
- [ ] **Step 4: Run** the two repo specs → PASS.

---

### Task 4: Events + `VideoRoomEventService` methods + socket-listener relays

**Files:**
- Modify: `src/modules/video-rooms/events/video-room.events.ts`
- Modify: `src/modules/video-rooms/services/video-room-event.service.ts`
- Modify: `src/modules/video-rooms/listeners/video-room-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-socket.listener.spec.ts` (extend)

**Interfaces produced:**
```ts
// VIDEO_ROOM_EVENTS gains keys: USER_DISCONNECTED:'video_room.user_disconnected',
//   USER_RECONNECTED:'video_room.user_reconnected', PRESENCE_UPDATED:'video_room.presence_updated',
//   HEARTBEAT_MISSED:'video_room.heartbeat_missed', SESSION_CREATED:'video_room.session_created',
//   SESSION_EXPIRED:'video_room.session_expired', ROOM_SYNCHRONIZED:'video_room.room_synchronized'
// Event classes extend DomainEvent<T>; payloads carry { roomId, userId?, ...counts/reason }:
//   UserDisconnectedEvent({ roomId, userId, socketId, reason: 'duplicate_session'|'connection_lost'|'timeout' })
//   UserReconnectedEvent({ roomId, userId, socketId })
//   PresenceUpdatedEvent({ roomId, userId, state, onlineCount, reconnectingCount, idleCount })
//   HeartbeatMissedEvent({ roomId, userId, socketId })
//   SessionCreatedEvent({ roomId, userId, socketId })
//   SessionExpiredEvent({ roomId, userId, socketId, durationSeconds })
//   RoomSynchronizedEvent({ roomId, version })
// VideoRoomEventService gains one thin emit* per event (await bus.publish(new XEvent(payload))).
```

Relay policy in `VideoRoomSocketListener.onModuleInit`: subscribe and relay to the namespace room via `sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, clientEvent, payload)`:
- `USER_DISCONNECTED → VIDEO_ROOM_SOCKET_EVENTS.USER_DISCONNECTED`
- `USER_RECONNECTED → ...USER_RECONNECTED`
- `PRESENCE_UPDATED → ...PRESENCE_UPDATED`
- `ROOM_SYNCHRONIZED → ...STATE_SYNC`
- **Do NOT relay** `HEARTBEAT_MISSED`, `SESSION_CREATED`, `SESSION_EXPIRED` (bus-only). `SESSION_EVICTED` is emitted point-to-point by the session service via `emitToUserEverywhere`, not here.

- [ ] **Step 1: Write failing test** — extend the listener spec (match its existing mock-`SocketManager` pattern): assert publishing `UserDisconnectedEvent`/`UserReconnectedEvent`/`PresenceUpdatedEvent`/`RoomSynchronizedEvent` calls `emitToNamespaceRoom` with the correct client event name + payload, and that `HeartbeatMissedEvent`/`SessionExpiredEvent`/`SessionCreatedEvent` do **not** trigger any emit.
- [ ] **Step 2: Run** `pnpm test video-room-socket.listener` → FAIL.
- [ ] **Step 3: Implement** the event classes + `VIDEO_ROOM_EVENTS` keys + `VideoRoomEventService.emit*` + the four new subscriptions in the listener.
- [ ] **Step 4: Run** `pnpm test video-room-socket.listener` → PASS.

---

### Task 5: `VideoRoomSessionService` extensions

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-session.service.ts`
- Test: `src/modules/video-rooms/services/video-room-session.service.spec.ts` (extend)

**Interfaces produced (implements the extended `IRoomSessionManager` from Task 1):**
- `register(input)` — additionally `SADD` `videoRoomUserSessionsKey(userId)` with socketId; detect duplicate via the **user** reverse index (not the room set) filtering by `deviceId` on a different socketId → set `duplicateOf`; write full record fields.
- `heartbeat(socketId, input?)` — slide Redis TTL, set `inBackground` from input, recompute `presenceState` via `derivePresenceState`, persist record; **lazy** `repo.touchPresence` only when the mirror is stale > `sessionTtl/2`; return `false` if record missing.
- `listUserSessions(userId)` — `SMEMBERS` of the reverse index.
- `endUserRoomSessions(roomId, userId)` — end every socket of the user that is in `roomId` (via reverse index ∩ room set); returns the ended records.
- `markPresence(socketId, state)` — set `presenceState` on the record (used by the disconnect listener → `DISCONNECTED`).
- `end(socketId)` — additionally `SREM` the reverse index; compute `durationSeconds = now − connectedAt` on the returned record (add to record or return alongside).
- Evict helper used by `register`: `evictDuplicate(userId, deviceId, keepSocketId)` → `end(oldSocketId)` + `sockets.emitToUserEverywhere(userId, SESSION_EVICTED, { evictedSocketId })` + `events.emitUserDisconnected({reason:'duplicate_session'})` + `metrics.incDuplicateSession()`. (Inject `SocketManager`, `VideoRoomEventService`, `VideoRoomsMetrics` — add to constructor + module providers already registered.)

- [ ] **Step 1: Write failing tests** (extend spec; mock `REDIS_CLIENT`, `CacheService`, repo, `SocketManager`, events, metrics): (a) `register` adds to both room set and user reverse index; (b) `register` for same `(userId,deviceId)` different socket returns `duplicateOf=oldSocket`, calls `emitToUserEverywhere` with `SESSION_EVICTED`, ends old record; (c) `register` for different `deviceId` does not evict; (d) `heartbeat` slides TTL + sets `inBackground` + recomputes state, and skips `touchPresence` when mirror fresh, calls it when stale; (e) `heartbeat` missing record → `false`; (f) `endUserRoomSessions` ends only sockets in that room.
- [ ] **Step 2: Run** `pnpm test video-room-session.service` → FAIL.
- [ ] **Step 3: Implement**; keep all existing session-service tests green.
- [ ] **Step 4: Run** `pnpm test video-room-session.service` → PASS.

---

### Task 6: `VideoRoomMemberService` — join

**Files:**
- Create: `src/modules/video-rooms/services/video-room-member.service.ts`
- Test: `src/modules/video-rooms/services/video-room-member.service.spec.ts`

**Interfaces produced:**
```ts
export interface JoinContext { socketId: string; deviceId?: string; platform?: string; ip?: string; sid?: string; }
export interface RoomSyncPayload {
  room: VideoRoomDetailView; settings: unknown; members: MemberView[];
  presence: PresenceView[]; statistics: unknown; announcements: unknown[]; version: number;
}
class VideoRoomMemberService {
  join(actor: RoomActor, roomId: string, dto: JoinRoomDto, ctx: JoinContext): Promise<RoomSyncPayload>;
}
```
Behavior = design §6 (validation order: not-found/ended → blocked → password → capacity → duplicate → writes → return sync). Inject: `VideoRoomsRepository`, `VideoRoomModerationRepository`, `VideoRoomPasswordService`, `VideoRoomStateService`, `VideoRoomSessionService`, `VideoRoomPresenceService`, `VideoRoomEventService`, `VideoRoomEventsRepository`, `VideoRoomsMetrics`, `LockService`, `ConfigService`, `VideoRoomQueryService` (for the sync view). Wrap writes in `locks.withLock(videoRoomJoinLockKey(roomId), fn)`.

- [ ] **Step 1: Write failing tests** (mock all deps): throws `VIDEO_ROOM_NOT_FOUND` (missing), `VIDEO_ROOM_ENDED` (status≠LIVE), `VIDEO_ROOM_BLOCKED` (block present), `VIDEO_ROOM_PASSWORD_INVALID` (locked + wrong pw, non-owner, not already member), `VIDEO_ROOM_CAPACITY_EXCEEDED` (viewerCount≥maxViewers, not already member); happy path calls `addViewer`+`upsertActiveMember(role=OWNER for owner else VIEWER)`+`session.register`+`state.applyUpdate`+`bumpStatsOnJoin`+`appendLog(JOINED)`+`events.emitUserJoined`+`emitSessionCreated`+`metrics.incJoin`, and returns a `RoomSyncPayload` with a numeric `version`; owner with correct/absent password bypasses the password gate.
- [ ] **Step 2: Run** `pnpm test video-room-member.service` → FAIL.
- [ ] **Step 3: Implement** `join` only (leave/reconnect/sync land in Task 7).
- [ ] **Step 4: Run** `pnpm test video-room-member.service` → PASS.

---

### Task 7: `VideoRoomMemberService` — leave, reconnect, sync, list

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-member.service.ts`
- Test: `src/modules/video-rooms/services/video-room-member.service.spec.ts` (extend)

**Interfaces produced:**
```ts
leave(actor: RoomActor, roomId: string, dto: LeaveRoomDto, ctx?: { ip?: string }): Promise<void>;
reconnect(actor: RoomActor, roomId: string, dto: ReconnectDto, ctx: JoinContext): Promise<RoomSyncPayload>;
sync(actor: RoomActor, roomId: string, lastVersion?: number): Promise<RoomSyncPayload>;
listMembers(roomId: string, take: number, skip: number): Promise<{ items: MemberView[]; total: number }>;
listPresence(roomId: string): Promise<PresenceView[]>;
getMySession(userId: string, roomId: string): Promise<SessionView | null>;
```
Behavior = design §9/§10: `leave` (no lock) removeViewer → end session(s) → deactivateMember → removePresence → state decrement → bumpStatsOnLeave → appendLog(LEFT) → emitUserLeft(reason:normal) + metrics.incLeave/observeSessionDuration. `reconnect` validates member still ACTIVE within grace (else `VIDEO_ROOM_RECONNECT_FAILED`), re-register socket, `reconnectCount++`, state `RECONNECTING→ONLINE`, emitUserReconnected + metrics.incReconnect, returns sync. `sync` builds `RoomSyncPayload` from state snapshot + repo reads + emitRoomSynchronized.

- [ ] **Step 1: Write failing tests**: `leave` happy path calls the full chain + `emitUserLeft`; `leave` on unknown room throws `VIDEO_ROOM_NOT_FOUND`; `reconnect` for an active member returns sync + `emitUserReconnected` + `reconnectCount` incremented; `reconnect` for a reclaimed/inactive member throws `VIDEO_ROOM_RECONNECT_FAILED`; `sync` returns payload with the snapshot `version` and emits `RoomSynchronizedEvent`; `listMembers` returns mapped views + total.
- [ ] **Step 2: Run** `pnpm test video-room-member.service` → FAIL (new methods).
- [ ] **Step 3: Implement** the five methods.
- [ ] **Step 4: Run** `pnpm test video-room-member.service` → PASS (Task 6 + 7 cases).

---

### Task 8: Monitor enhancement + disconnect fast-path listener

**Files:**
- Modify: `src/modules/video-rooms/scheduler/video-room-session.monitor.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-session.monitor.spec.ts` (Create)
- Create: `src/modules/video-rooms/listeners/video-room-presence.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-presence.listener.spec.ts` (Create)
- Modify: `src/modules/video-rooms/listeners/index.ts` (export new listener)

**Interfaces consumed:** `VideoRoomSessionService.expireStale` (existing), `endUserRoomSessions`, `markPresence`; `VideoRoomStateService.applyUpdate`; `VideoRoomsRepository.deactivateMember`; `VideoRoomEventService.emitUserLeft/emitSessionExpired/emitHeartbeatMissed/emitUserDisconnected`; infra `PresenceChangedEvent` (`INFRA_PRESENCE_EVENTS.CHANGED`, payload `{ userId, online }`).

- [ ] **Step 1: Write failing tests** — Monitor: on a reclaimed stale session the sweep decrements counts via `state.applyUpdate`, calls `deactivateMember` when the user has no other live session, and publishes `UserLeftEvent(reason:timeout)` + `SessionExpiredEvent`. Listener: `PresenceChangedEvent({online:false})` → for each of that user's live sessions calls `markPresence(socketId, DISCONNECTED)` + `emitUserDisconnected(reason:'connection_lost')`; `{online:true}` is a no-op.
- [ ] **Step 2: Run** both specs → FAIL.
- [ ] **Step 3: Implement** — extend the monitor's per-session reclaim callback; create `VideoRoomPresenceListener` (`OnModuleInit`, `bus.subscribe(INFRA_PRESENCE_EVENTS.CHANGED, ...)`, uses `session.listUserSessions`).
- [ ] **Step 4: Run** both specs → PASS.

---

### Task 9: DTOs, views/mappers, `VideoRoomMembersController`

**Files:**
- Create: `dto/join-video-room.dto.ts`, `dto/leave-video-room.dto.ts`, `dto/reconnect-video-room.dto.ts`, `dto/video-room-heartbeat.dto.ts` (+ barrel `dto/index.ts`)
- Create: `entities/video-room-member.view.ts`, `entities/video-room-presence.view.ts`, `entities/video-room-session.view.ts` (+ barrel)
- Create: `mappers/video-room-member.mapper.ts` (+ barrel)
- Create: `controllers/video-rooms-members.controller.ts` (+ `controllers/index.ts` export)
- Test: `controllers/video-rooms-members.controller.spec.ts`

**Interfaces produced:** DTOs + `MemberView`/`PresenceView`/`SessionView` per design §16 (class-validator + `@ApiProperty`; `JoinRoomDto { password?, socketId, deviceId?, platform? }`, etc.). Controller routes per design §11, all `@NotGuest()` on POSTs, `@HttpCode(200)`, `ParseUuidPipe` on `:id`, `@CurrentUser()`+`actor(user)`, `@Ip()` for ctx, delegate to `VideoRoomMemberService`. Full Swagger (`@ApiOperation`/`@ApiResponse` incl. error codes).

- [ ] **Step 1: Write failing controller test** (mock `VideoRoomMemberService`): each route delegates to the right service method with mapped args; `POST /join` returns the sync payload with 200; guards/pipe metadata present; invalid DTO rejected.
- [ ] **Step 2: Run** `pnpm test video-rooms-members.controller` → FAIL.
- [ ] **Step 3: Implement** DTOs, views, mapper, controller.
- [ ] **Step 4: Run** `pnpm test video-rooms-members.controller` → PASS.

---

### Task 10: Metrics, module wiring, README, full verification

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (+ its spec if present)
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/video-rooms/README.md`

**Interfaces produced:** `VideoRoomsMetrics` gains `incJoin()`, `incLeave()`, `incDuplicateSession()`, `incReconnectFailure()`, `observeSessionDuration(seconds)` (Histogram `video_rooms_session_duration_seconds`) — registered on `metrics.registry` in the constructor.

- [ ] **Step 1:** Add the metric families + helper methods (match the existing `VideoRoomsMetrics` construction pattern). If a metrics spec exists, add assertions that the new families register + helpers exist.
- [ ] **Step 2:** Register `VideoRoomMemberService`, `VideoRoomPresenceListener`, and the new `VideoRoomMembersController` in `video-rooms.module.ts` (controllers array + providers). Confirm `VideoRoomEventsRepository`, managers, metrics already present.
- [ ] **Step 3:** Update README (new endpoints, member lifecycle, presence states, Redis keys incl. the user reverse index).
- [ ] **Step 4: Full verification** — Run `pnpm build` (0 errors), `pnpm lint` (0 warnings), `pnpm boundaries` (clean), `pnpm test` (all new specs pass; existing 806+ green). Fix any regression before done.

---

## Self-Review

**Spec coverage:** join (T6), leave/reconnect/sync (T7), disconnect+grace (T7 leave/reconnect + T8 monitor/listener), heartbeat (T5+T9), duplicate-session (T5), presence machine (T2+T5), room sync (T7), counters (T1 snapshot + T6/7/8 mutations), Redis mgmt (T1 keys + T5), socket events (T4 relay + T9 controller), REST endpoints (T9), event bus (T4), audit (T6/7 via `video_room_events`+logs), monitoring (T10 metrics), validations (T6), exceptions (T1 codes), DTOs (T9), repository layer (T3), testing (each task), Swagger (T9). Out-of-scope items confirmed absent. ✓
**Placeholder scan:** no TBD/TODO; behavior either shown or cross-referenced to the committed design §-numbers with exact signatures inline. ✓
**Type consistency:** `VideoRoomSessionRecord`/`RegisterSessionResult`/`VideoRoomStateSnapshot`/`RoomSyncPayload`/event payloads defined once (T1/T4/T6) and referenced by identical names downstream; `heartbeat(socketId, input?)`, `duplicateOf`, `videoRoomUserSessionsKey`, `derivePresenceState` names stable across tasks. ✓
