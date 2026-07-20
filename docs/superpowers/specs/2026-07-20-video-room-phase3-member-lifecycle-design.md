# Video Room — Phase 3: Member Management, Presence & Session Lifecycle (VR-3)

Status: **Approved** (design decisions locked 2026-07-20)
Builds on: VR-0 foundation + VR-1 database domain + VR-2 lifecycle
Owner module: `src/modules/video-rooms`

---

## 1. Scope

Implement the complete **participant lifecycle** for Video Rooms on top of VR-0/1/2:
join, leave, unexpected disconnect, reconnect (with grace window), heartbeat
monitoring, session management (creation/validation/renewal/expiration/recovery),
duplicate-session prevention, real-time presence, room synchronization, room
counters, audit, monitoring, and event publishing. Production-grade, built to
support millions of concurrent participants.

**Explicitly NOT in scope** (deferred, per brief): seat assignment, viewer mode,
camera/mic controls, video publishing/playback, beauty filters, chat, emoji, gifts,
treasure boxes, wallet, PK battles, moderation *actions* (join reads the existing
block-list only — read-only, no write path), rankings, recording, notifications,
analytics *processing*, ownership transfer.

## 2. Locked design decisions (brainstorming, 2026-07-20)

1. **Grace-window reconnect (chosen).** An unexpected socket drop marks the session
   `RECONNECTING`/`DISCONNECTED` and **keeps the member in the room** (counters
   preserved) for `reconnectTimeoutSeconds` (120s). The existing
   `VideoRoomSessionMonitor` auto-reclaims to `LEFT` (decrement, publish `UserLeft`)
   only if no heartbeat/reconnect returns in the grace window. Explicit REST `/leave`
   = immediate `LEFT`. This is the one place VR-3 goes beyond Audio Rooms (which drops
   Redis presence immediately and has no grace window) — and the video-rooms
   `VideoRoomSessionMonitor` already computes `cutoff = now − reconnectTimeoutSeconds`,
   so the reclaim path is pre-wired.
2. **Per-device, evict-older duplicate policy (chosen).** Sessions are keyed by
   `(userId, deviceId)`. A new session for the **same device** force-disconnects the
   older socket (`UserDisconnected reason=duplicate_session`). **Different devices
   coexist** (multi-device allowed; no cap in VR-3). Activates the dormant
   `RegisterSessionResult.duplicateOf` hook.
3. **Full presence state machine (chosen).** Seven states
   (`CONNECTING|ONLINE|IDLE|RECONNECTING|DISCONNECTED|LEFT|OFFLINE`), computed by a
   pure `derivePresenceState(session, now, config)` function (single source of truth,
   exhaustively unit-tested), driven by heartbeat freshness + a client-reported
   `inBackground` flag. Live presence is Redis-authoritative; `VideoRoomPresence` is
   the durable mirror for recovery/analytics.
4. **House conventions win (chosen).** join/leave/reconnect/heartbeat are **REST
   commands**; the socket layer stays **transport + EVENT_BUS→`VideoRoomSocketListener`
   relay-out** (reuse the shared `VideoRoomGateway`/`BaseGateway` `room:join`/`ping`).
   **No domain `@SubscribeMessage` gateway. No per-module exception classes** — errors
   are `BusinessException(ERROR_CODES.*, msg, HttpStatus.*)`. Consistent with VR-0/1/2
   and every other module.

## 3. What already exists (reuse; do not recreate)

- **Durable tables:** `VideoRoomMember` (memberStatus, joinSource, platform, country,
  region, `deviceId`, `lastActiveAt`, `isActive`; unique `(roomId,userId)`),
  `VideoRoomPresence` (durable Redis mirror; `socketId?`, `lastSeenAt`; unique
  `(roomId,userId)`), `VideoRoomStatistics` (`currentViewers`, `peakViewers`,
  `totalJoins`, `totalSessions`, `lastActivityAt`), `video_room_logs`
  (`VideoRoomLogAction` incl. `JOINED`/`LEFT`), `video_room_events` (generic
  append-only event store: `eventType`, `payload`, `correlationId`).
  **VR-3 adds NO tables and NO Prisma enum values** (audit uses `video_room_events` +
  the existing `JOINED`/`LEFT` log actions).
- **Config (all pre-provisioned in VR-0, `videoRoom` namespace):**
  `heartbeatIntervalSeconds` 25, `reconnectTimeoutSeconds` 120,
  `maxReconnectAttempts` 5, `idleTimeoutSeconds` 300, `cleanupIntervalSeconds` 30,
  `sessionTtlSeconds` 90, `stateTtlSeconds` 300, `defaultMaxViewers`/`maxViewersCap`.
  **VR-3 adds NO env vars.**
- **Managers (implemented in VR-0, wired live here):**
  `VideoRoomStateService` (versioned snapshot: `getSnapshot`/`applyUpdate`/`restore`/
  `clear`), `VideoRoomSessionService` (`register`/`heartbeat`/`getSession`/
  `listRoomSessions`/`end`/`expireStale`), `VideoRoomPresenceService`
  (viewers/hosts/participants sets).
- **Scheduler:** `VideoRoomSessionMonitor` (30s `setInterval`, lock-guarded, grace
  reclaim) — enhanced here to publish events + fix counters on reclaim.
- **Relay:** `VideoRoomSocketListener` (EVENT_BUS→`emitToNamespaceRoom('/video-room')`)
  — already forwards `USER_JOINED`/`USER_LEFT`; extended with the new events.
- **Infra:** `PresenceService`, `SocketManager` (`emitToNamespaceRoom`,
  `emitToUserEverywhere`, `disconnectUserEverywhere`), `LockService.withLock`,
  `CacheService` (`increment` = TTL-on-first-write counter), `@Inject(REDIS_CLIENT)`,
  `EVENT_BUS`/`DomainEvent`, `BusinessException`/`ERROR_CODES`, `VideoRoomsMetrics`,
  `auditCreate/Update`, `ParseUuidPipe`, `@CurrentUser`/`@NotGuest`. Infra
  `PresenceChangedEvent(presence.changed, {userId, online})` used for the
  disconnect fast-path.

## 4. Session record (Redis) — extend, do not replace

`RegisterSessionInput` / `VideoRoomSessionRecord` (in
`interfaces/room-session-manager.interface.ts`) gain:

```
VideoRoomSessionRecord {
  roomId, userId, socketId, role,          // existing
  deviceId,        // dedup key component (userId+deviceId), from JoinRoomDto/heartbeat
  platform,        // audit
  ip,              // audit
  sid,             // auth session id, from token claims (AuthenticatedUser.sid)
  presenceState,   // VideoRoomPresenceState (last computed/observed)
  inBackground,    // client-reported activity flag (drives IDLE)
  connectedAt, lastSeenAt, reconnectCount   // lastSeenAt/reconnectCount new
}
```

Storage (existing key builders, all hash-tagged / Cluster-safe):
- `video-room:session:{socketId}` — the record, TTL = `sessionTtlSeconds` (90s).
- `video-room:{roomId}:sessions` — SET of socketIds in the room.
- **NEW reverse index `video-room:user:{userId}:sessions`** — SET of the user's
  socketIds (across rooms). Makes duplicate-detection and disconnect-fast-path
  O(sessions-per-user) instead of the current `findDuplicate` scan over the whole
  room set (an O(room-size) SMEMBERS on every join — a real scale bug at 5000 viewers).
- `VideoRoomPresence` (Postgres) — durable mirror; `lastSeenAt` written **lazily**
  (§7), not per beat.

## 5. Presence state machine (Decision 3)

New code enum `VideoRoomPresenceState` in `enums/index.ts` (runtime only, not
Postgres): `CONNECTING | ONLINE | IDLE | RECONNECTING | DISCONNECTED | LEFT | OFFLINE`.

Pure function `derivePresenceState(session, now, cfg)` — single source of truth,
side-effect-free, exhaustively unit-tested. Thresholds isolated at the top of the
function for easy tuning:

| State | Rule (age = `now − lastSeenAt`) |
|---|---|
| `OFFLINE` | no session record |
| `CONNECTING` | session exists, `reconnectCount==0` and no confirmed heartbeat yet (age < first-beat window) |
| `ONLINE` | age ≤ `heartbeatIntervalSeconds × MISS_FACTOR` and `!inBackground` |
| `IDLE` | heartbeating but `inBackground==true`, or age > `idleTimeoutSeconds` while still within grace |
| `RECONNECTING` | `heartbeat miss-threshold < age ≤ reconnectTimeoutSeconds` (grace), or a `/reconnect` is in flight |
| `DISCONNECTED` | infra `PresenceChangedEvent(online:false)` observed (socket confirmed dead), still within grace |
| `LEFT` | explicit `/leave`, or `age > reconnectTimeoutSeconds` (monitor reclaim) |

`DISCONNECTED` vs `RECONNECTING` differ only in *what we know* (socket confirmed dead
vs heartbeats merely late); both are within-grace and both reclaim to `LEFT` at the
same cutoff. `MISS_FACTOR` (default ~2 missed beats) and the first-beat window are
the tunable knobs.

Presence transitions publish `PresenceUpdatedEvent` **only on change** (coalesced),
never per heartbeat.

## 6. Join flow — `POST /video-rooms/:id/join`

`VideoRoomMemberService.join(actor, roomId, dto, ctx)` — new orchestrator service;
composes the existing managers; no Prisma in the service. Wrapped in
`locks.withLock(videoRoomJoinLockKey(roomId))` (NEW key builder
`video-room:join:{roomId}`), mirroring Audio's `join`:

1. `getLiveRoomOrThrow(roomId)` → `VIDEO_ROOM_NOT_FOUND` (missing) / `VIDEO_ROOM_ENDED`
   (status ≠ LIVE). (Reuse `VideoRoomQueryService`/repo detail read.)
2. `assertNotBlocked(roomId, actor.id)` — read-only via
   `VideoRoomModerationRepository.findActiveBlock` (Redis fast-path optional) →
   `VIDEO_ROOM_BLOCKED`. **Read only — not implementing moderation.**
3. Password gate: only when `room.isLocked && room.passwordHash && !alreadyMember &&
   !ownerOrPlatformAdmin`; verify via `VideoRoomPasswordService` →
   `VIDEO_ROOM_PASSWORD_INVALID`.
4. Capacity: `presence.viewerCount(roomId) >= room.maxViewers` (skip if already a
   live member) → `VIDEO_ROOM_CAPACITY_EXCEEDED`.
5. Duplicate-session (§8): evict any live session for the same `(userId, deviceId)`.
6. Writes (order mirrors Audio):
   - `presence.addViewer(roomId, userId)` (Redis)
   - role = `OWNER` if `room.ownerId==userId` else `VIEWER` (no seat/host assignment
     in VR-3; schema default is `VIEWER`)
   - `repo.upsertActiveMember(roomId, userId, role, deviceId, platform, actorId)` (DB;
     reactivate returning row — never duplicate)
   - `session.register({roomId, userId, socketId, role, deviceId, platform, ip, sid})`
     (Redis record + reverse index + durable presence mirror; returns `duplicateOf`)
   - `state.applyUpdate(roomId, s => ({viewerCount: presence count, onlineCount++...}))`
     (bump counters + version, locked)
   - `repo.bumpStatsOnJoin(roomId)` (`totalJoins++`, `currentViewers`, `peakViewers`,
     `totalSessions++`, `lastActivityAt`)
   - `repo.appendLog(JOINED)` + `events.record('member.joined', ctx)` (rich audit →
     `video_room_events`)
   - publish `UserJoinedEvent` + `SessionCreatedEvent`; `metrics.incJoin()`,
     `metrics.setSessions(...)`.
7. Return the **full room-sync payload** (§9).

`socketId`/`deviceId`/`ip`: `socketId` and `deviceId` come from the request
(`JoinRoomDto` carries `socketId`, `deviceId?`, `platform?`; matches how the client
already holds its socket id from the `/video-room` namespace handshake); `ip` from
`@Ip()`/request; `sid` from `AuthenticatedUser.sid`. If `deviceId` is absent,
dedup degrades to `(userId, socketId)` (cannot evict by device).

## 7. Heartbeat & reclaim — built for millions

- `POST /video-rooms/:id/heartbeat` (body `HeartbeatDto { socketId, inBackground?,
  networkQualityLevel? }`) → `session.heartbeat(socketId, {inBackground})`.
  **Hot path = Redis `EXPIRE` only** (slide the 90s TTL) + update `inBackground` on the
  record. The durable `VideoRoomPresence.lastSeenAt` is written **lazily** — only when
  the mirror is stale beyond a flush threshold (e.g. ½ `sessionTtl`) — so 1M users
  beating every 25s do **not** each hammer Postgres every beat. Redis is authoritative
  for live counts; the mirror exists for recovery, so bounded lag is acceptable.
  **Heartbeat publishes no event** (metric only) — only presence *transitions* publish.
  Missing record → return `false` (client learns it was evicted/expired →
  `VIDEO_ROOM_SESSION_EXPIRED` on the REST surface); `metrics.incHeartbeatFailure()`.
- `VideoRoomSessionMonitor` (existing 30s lock-guarded sweep) enhanced: on each
  reclaimed stale session (age > grace) it now also decrements counters
  (`state.applyUpdate`), deactivates the member if no other live session remains,
  records `session.expired`, publishes `UserLeftEvent(reason:timeout)` +
  `SessionExpiredEvent`, and emits `HeartbeatMissedEvent` (bus-only) the first time a
  session crosses the miss-threshold.

## 8. Duplicate session — per-device, evict-older (Decision 2)

On `session.register`, look up the reverse index `video-room:user:{userId}:sessions`
for a live record with the same `deviceId` on a **different** socketId:
- End the old record (`end(oldSocketId)`: delete record, `SREM` room + user sets,
  remove durable presence).
- `sockets.emitToUserEverywhere(userId, SESSION_EVICTED, {evictedSocketId})` — the
  client holding that socket self-disconnects; cross-instance safe.
- publish `UserDisconnectedEvent(reason: duplicate_session)`;
  `metrics.incDuplicateSession()`.
- Backstop: the evicted socket's next heartbeat returns `false` (record gone).
Different `deviceId`s are left untouched (multi-device). Owner/self re-join from the
same device is an idempotent re-register (reactivate, `reconnectCount` unchanged).

## 9. Reconnect & room synchronization

- `POST /video-rooms/:id/reconnect` (`ReconnectDto { socketId, previousSocketId?,
  deviceId?, lastVersion? }`) → `VideoRoomMemberService.reconnect(...)`: validate the
  member is still ACTIVE and within the grace window (else `VIDEO_ROOM_RECONNECT_FAILED`
  if the member was already reclaimed, or transparently re-join if room still LIVE and
  capacity allows), re-`register` the (possibly new) socket, `reconnectCount++`,
  transition presence `RECONNECTING→ONLINE`, record `member.reconnected`, publish
  `UserReconnectedEvent`; `metrics.incReconnect(success)`. Returns the full sync payload.
- `GET /video-rooms/:id/sync` (also returned by join/reconnect) →
  `RoomSyncView { room metadata, settings, members[], presence[], statistics,
  announcements[], version }`, where `version = VideoRoomStateSnapshot.version`
  (monotonic). Client passes `lastVersion`; VR-3 returns **full** state + version
  (delta-sync deferred). Publishes `RoomSynchronizedEvent`.
- **Disconnect fast-path listener** (`VideoRoomPresenceListener`, `OnModuleInit`):
  subscribes to infra `PresenceChangedEvent(online:false)`; via the reverse index,
  flips that user's live sessions to `DISCONNECTED` and publishes
  `UserDisconnectedEvent(reason: connection_lost)`. Best-effort promptness for the
  single-device case; the monitor remains the guarantee for the rest.

## 10. Leave — `POST /video-rooms/:id/leave`

`VideoRoomMemberService.leave(actor, roomId, {socketId?})`. No lock (mirrors Audio):
`repo.findRoomRow` (`VIDEO_ROOM_NOT_FOUND`; does not require LIVE) →
`presence.removeViewer` → `session.end(socketId)` (if socket given; else end all the
user's sessions in the room via the reverse index) → `repo.deactivateMember`
(`isActive=false`, `memberStatus=LEFT`, `leftAt`) → `repo.removePresence` →
`state.applyUpdate` (decrement) → `repo.bumpStatsOnLeave` → `appendLog(LEFT)` +
`events.record('member.left')` → publish `UserLeftEvent(reason: normal)`;
`metrics.incLeave()`, `metrics.observeSessionDuration(...)`.

## 11. Endpoints (base `video-rooms`)

| Method | Route | Guard | Service |
|---|---|---|---|
| POST | `/video-rooms/:id/join` | `@NotGuest`, uuid | `member.join` |
| POST | `/video-rooms/:id/leave` | `@NotGuest`, uuid | `member.leave` |
| POST | `/video-rooms/:id/reconnect` | `@NotGuest`, uuid | `member.reconnect` |
| POST | `/video-rooms/:id/heartbeat` | `@NotGuest`, uuid | `session.heartbeat` |
| GET | `/video-rooms/:id/members` | auth, uuid | `member.listMembers` (paginated) |
| GET | `/video-rooms/:id/presence` | auth, uuid | `member.listPresence` |
| GET | `/video-rooms/:id/session` | auth, uuid | `member.getMySession` |
| GET | `/video-rooms/:id/sync` | auth, uuid | `member.sync` |

New `VideoRoomMembersController` (keeps the VR-2 `VideoRoomsController` focused on
lifecycle). All `@HttpCode(200)` on POSTs (Audio convention). Fully Swagger-documented
(auth, validation, examples, responses, error codes).

## 12. Events (EVENT_BUS)

Add to `events/video-room.events.ts` + `VideoRoomEventService` + `VIDEO_ROOM_EVENTS`:
`UserDisconnectedEvent`, `UserReconnectedEvent`, `PresenceUpdatedEvent`,
`HeartbeatMissedEvent`, `SessionCreatedEvent`, `SessionExpiredEvent`,
`RoomSynchronizedEvent` (`UserJoinedEvent`/`UserLeftEvent` already exist).

Fan-out policy (scale-critical):
- **Bus + socket relay** (client cares): `UserJoined/Left/Disconnected/Reconnected`,
  `PresenceUpdated` (coalesced), `RoomSynchronized` → mapped in `VideoRoomSocketListener`
  to client-facing `VIDEO_ROOM_SOCKET_EVENTS` (`USER_JOINED`, `USER_LEFT`,
  `USER_DISCONNECTED`, `USER_RECONNECTED`, `PRESENCE_UPDATED`, `ROOM_SYNC` (=`state_sync`),
  plus `SESSION_EVICTED` emitted point-to-point via `emitToUserEverywhere`).
- **Bus-only** (analytics/monitoring, no per-client socket spam): `HeartbeatMissed`,
  `SessionCreated`, `SessionExpired`.
- **Metric-only** (no event): heartbeat received.

## 13. Counters & metrics

Redis-first, surfaced in the state snapshot (extend `VideoRoomStateSnapshot` +
`VideoRoomStateMutation` with `onlineCount`, `reconnectingCount`, `idleCount`;
`viewerCount` already present):
`currentMembers`, `currentOnlineMembers`, `currentActiveConnections`,
`currentReconnectingUsers`, `currentIdleUsers`.

`VideoRoomsMetrics` — reuse `setSessions`/`setViewers`/`incHeartbeatFailure`/
`incReconnect`; **add** `incJoin` (`video_rooms_joins_total`), `incLeave`
(`video_rooms_leaves_total`), `incDuplicateSession`
(`video_rooms_duplicate_sessions_total`), `observeSessionDuration`
(`video_rooms_session_duration_seconds` Histogram), and a reconnect-failure counter.

## 14. Audit

- Rich per-event context → **`video_room_events`** via `VideoRoomEventsRepository`
  (`eventType`, `payload`, `correlationId`): `member.joined|left|disconnected|
  reconnected`, `heartbeat.missed`, `session.duplicate|expired`, `room.synchronized` —
  payload carries `userId, roomId, socketId, sid, deviceId, ip, platform, timestamp`.
- Human room-activity log → **`video_room_logs`** (`JOINED`/`LEFT`, existing enum
  values; no migration).

## 15. Exceptions (house pattern — new `ERROR_CODES`)

Add to `src/common/exceptions/error-codes.ts`: `VIDEO_ROOM_ENDED` (409),
`VIDEO_ROOM_PASSWORD_INVALID` (400), `VIDEO_ROOM_BLOCKED` (403),
`VIDEO_ROOM_NOT_MEMBER` (403), `VIDEO_ROOM_DUPLICATE_SESSION` (409),
`VIDEO_ROOM_RECONNECT_FAILED` (409). Reuse existing `VIDEO_ROOM_NOT_FOUND`,
`VIDEO_ROOM_CAPACITY_EXCEEDED`, `VIDEO_ROOM_SESSION_EXPIRED`. Throw
`BusinessException(...)`; global `AllExceptionsFilter` renders the envelope. Maps the
brief's requested exception set (`RoomJoinException`→codes, `DuplicateSessionException`
→`VIDEO_ROOM_DUPLICATE_SESSION`, `HeartbeatTimeoutException`→`VIDEO_ROOM_SESSION_EXPIRED`,
`ReconnectFailedException`→`VIDEO_ROOM_RECONNECT_FAILED`, `RoomCapacityException`→
`VIDEO_ROOM_CAPACITY_EXCEEDED`, `RoomClosedException`→`VIDEO_ROOM_ENDED`,
`InvalidRoomPasswordException`→`VIDEO_ROOM_PASSWORD_INVALID`). No exception classes.

## 16. DTOs & views

DTOs (class-validator + Swagger): `JoinRoomDto { password?, socketId, deviceId?,
platform? }`, `LeaveRoomDto { socketId? }`, `ReconnectDto { socketId,
previousSocketId?, deviceId?, lastVersion? }`, `HeartbeatDto { socketId, inBackground?,
networkQualityLevel? }`. Views + mappers (client-safe, drop audit/internal cols):
`MemberView`, `PresenceView` (incl. `presenceState`), `SessionView`, `RoomSyncView`.

## 17. Repository additions

- `VideoRoomsRepository` (+ member/stats primitives): `getMember`,
  `upsertActiveMember`, `deactivateMember`, `setMemberRole`, `listActiveMembers`
  (paginated), `countActiveMembers`, `bumpStatsOnJoin`, `bumpStatsOnLeave` (mirror
  Audio's `AudioRoomsRepository` member section). `upsertPresence`/`removePresence`/
  `touchPresence`/`findStalePresence` already exist.
- `VideoRoomModerationRepository` (+ read): `findActiveBlock(roomId, userId)`.
- `VideoRoomEventsRepository`: reuse its append for the rich audit rows.
No Prisma outside repositories.

## 18. Testing (TDD, co-located `*.spec.ts`)

- `video-room-presence-state.spec.ts` — `derivePresenceState`, exhaustive over the 7
  states + boundary ages.
- `video-room-member.service.spec.ts` — join validation matrix (not-found/ended/
  blocked/password/capacity/duplicate), owner-role, leave, reconnect (in/out of grace),
  duplicate-evict, counter + event + log + audit assertions.
- `video-room-session.service.spec.ts` (extend) — reverse index, lazy `lastSeenAt`,
  evict, `heartbeat` false path, presence-state stamping.
- `video-room-session.monitor.spec.ts` (NEW) — reclaim decrements counters,
  deactivates member, publishes `UserLeft`/`SessionExpired`.
- `video-room-presence.listener.spec.ts` (NEW) — `PresenceChanged(offline)` →
  `DISCONNECTED` + `UserDisconnected`.
- `video-room-socket.listener.spec.ts` (extend) — new relays.
- `video-room-members.controller.spec.ts` (NEW) — routing, guards, DTO validation,
  status codes, error mapping.
- `video-rooms.repository.spec.ts` (extend) — member methods, stats bumps.
- Keep the existing 806+ suite green (purely additive).

## 19. Implementation order

1. Error codes + `VideoRoomPresenceState` enum + constants (join lock key, new socket
   event names) + session-record/interface extension.
2. `derivePresenceState` + tests.
3. Repository member/stats methods + moderation block read + tests.
4. Events (+ `VideoRoomEventService` methods) + socket-listener relays.
5. `VideoRoomSessionService` extensions (reverse index, evict, lazy mirror, presence
   stamping) + tests.
6. `VideoRoomMemberService` (join/leave/reconnect/sync/list) + tests.
7. `VideoRoomSessionMonitor` enhancement + `VideoRoomPresenceListener` + tests.
8. `VideoRoomMembersController` + DTOs + views/mappers + tests.
9. Metrics extension; module wiring; README; Swagger.
10. Verify: `tsc` + lint + boundaries + full suite green.

## 20. Acceptance criteria

- `pnpm build` (strict) 0 errors; `pnpm lint` 0 warnings; `pnpm boundaries` clean
  (video-rooms depends only on `common`/`infra`/its own tree).
- Join/leave/reconnect/heartbeat/members/presence/session/sync work end-to-end; each
  Swagger-documented. Grace-window reconnect preserves membership; monitor reclaims
  after 120s. Per-device duplicate eviction works; multi-device coexists. Presence
  state machine correct at boundaries. Counters Redis-first + snapshot-consistent;
  events published per the fan-out policy; audit rows written; RBAC enforced.
- All new specs pass; existing 806+ suite stays green. **No new tables, no migration,
  no new env vars, no stubs.**
