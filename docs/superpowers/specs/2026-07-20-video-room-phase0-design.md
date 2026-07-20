# Video Room — Phase 0: Enterprise Foundation (Design)

**Date:** 2026-07-20
**Module:** `video-rooms`
**Status:** Approved design — ready for implementation plan
**Scope:** Foundation only. No room business workflow (creation, join/leave, seats, streaming, gifts, PK, moderation, recording).

---

## 1. Purpose & guiding principle

Build the production-ready backend foundation the Video Room module's future phases will all sit on, by **filling the pre-scaffolded `src/modules/video-rooms/` skeleton** using the exact conventions already established by the `audio-rooms` module — and **reusing every existing `@Global` infrastructure component** rather than recreating any of it.

The single rule that resolves every scope question:

> **Phase 0 ships real, unit-tested foundation _primitives_ + the durable schema. Every room _business rule_ (capacity, join, seat, host, stream) stays behind an HTTP 501.**
>
> The test for "build now vs defer": does it encode a room rule? If yes → deferred. If it is a generic capability (versioned state, session lifecycle, presence counting, media-token issuance, audit logging) → built now.

Nothing in this phase is a placeholder or a TODO. The 501 responses are the _intended, documented Phase-0 contract_ for the not-yet-implemented endpoints, not stubs.

### 1.1 Decisions locked (brainstorming, 2026-07-20)

| # | Decision | Choice |
|---|----------|--------|
| ① | DB schema scope for Phase 0 | **Foundational tables + migration** (VideoRoom + Settings + Statistics + Presence + Log; reuse `room_categories`/`room_languages`; business tables deferred) |
| ② | ZEGOCLOUD layer | **Thin `IMediaProvider` port wrapping the existing `ZegoTokenService`** (no token04 duplication; audio-rooms/calls untouched) |
| ③ | Error modeling | **House pattern** — `BusinessException` + `VIDEO_ROOM_*` entries in shared `ERROR_CODES` (no per-module exception classes) |
| ④ | BullMQ queues | **Lean, purposeful set** — `video-rooms` + `video-rooms-cleanup` only; reuse central analytics/notification queues |

---

## 2. Context: what already exists (reuse, do not recreate)

Evidence gathered from the existing codebase. All of the following are `@Global` and injectable without importing their module.

| Concern | Existing component | How video-rooms reuses it |
|---------|--------------------|---------------------------|
| Socket namespace + gateway | `VideoRoomGateway` + `SOCKET_NAMESPACES.VIDEO_ROOM = '/video-room'` **already declared** in `src/infra/socket/socket.gateway.ts` and registered in `SOCKET_GATEWAYS` | Reuse as-is. No new gateway. |
| Socket broadcast + auth + presence + reconnect | `SocketManager` (`emitToNamespaceRoom`, `emitToUser*`), `BaseGateway` (JWT handshake, `room:join`/`room:leave`/`ping`, presence), Redis adapter with `connectionStateRecovery: 120s` | Inject `SocketManager` in a relay listener; join/leave/heartbeat/reconnect are free. |
| RTC tokens | `ZegoTokenService` (`buildRoomToken(userId, zegoRoomId, canPublish)`, `isConfigured()`), token04 vendored | Delegate to it behind `ZegoMediaProvider`. |
| Redis | `CacheService`, `PresenceService`, `LockService`, `@Inject(REDIS_CLIENT)` | Compose into state/session/presence services. |
| Queue | Global `QueueModule` (connection, backoff, DLQ, metrics, Bull Board); `BaseQueueWorker` | `BullModule.registerQueue({name})` + `@Processor` + `BaseQueueWorker`. |
| Metrics | Prometheus `MetricsService.registry` at `GET /metrics`; `MonitoringMetrics` template | Small `VideoRoomsMetrics` provider (families exposed directly; sampler deferred). |
| Auth / RBAC | Global `JwtAuthGuard`, `RolesGuard`, `PermissionsGuard`; `@CurrentUser`, `@Public`, `@NotGuest`, `@Roles`, `@RequirePermissions` | Decorators on controllers; guards are global. |
| Errors | `BusinessException` + `ERROR_CODES` + global `AllExceptionsFilter` | Add `VIDEO_ROOM_*` codes; throw `BusinessException`. |
| Response envelope | Global `ResponseInterceptor` | Return raw objects; auto-wrapped. |
| Config | `ConfigModule.forRoot({ load: configurations, validate: validateEnv })`; `registerAs` namespaces + Zod `envSchema` | Add `videoRoomConfig = registerAs('videoRoom', …)` + `VIDEO_ROOM_*` Zod block. |
| Events | `EVENT_BUS` (`IEventBus`, `DomainEvent<T>` base) | Publish `DomainEvent` subclasses. |
| Audit / persistence helpers | `PrismaService`, `auditCreate/Update/SoftDelete`, `ParseUuidPipe`, `buildPaginated`, `PaginationQueryDto` | Repository + controllers. |
| Shared constants | `MAX_VIDEO_SEATS = 9`, `RoomStatus`/`RoomVisibility` (generic) | Reuse `MAX_VIDEO_SEATS`; define own DB enums for ownership (see §4.2). |

The `video-rooms` module is already registered in `DOMAIN_MODULES` (`src/modules/index.ts`) — no change there.

### 2.1 House real-time pattern (must mirror)

Soulzaa does **not** use per-module `@SubscribeMessage` gateways for domain logic. The pattern is **REST-command-in / EVENT_BUS → per-module socket-listener relay-out**:

1. A service performs its domain work then `await bus.publish(new SomeEvent({...}))`.
2. A `*-socket.listener.ts` (`OnModuleInit`) subscribes to those bus events and relays each to the namespace via `SocketManager.emitToNamespaceRoom(namespace, roomId, socketEventName, payload)`.
3. Two distinct vocabularies: internal bus names (`video_room.created`) vs client-facing socket names (`video_room.state_sync`).

---

## 3. Module layout

```
src/modules/video-rooms/
  constants/
    video-room.constants.ts   # VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS, redis key builders,
                              # validation bounds, default/TTL constants
    index.ts
  config/
    video-room.config.ts      # VideoRoomConfig interface + loadVideoRoomConfig(config) typed+coerced accessor
  enums/
    index.ts                  # StreamStatus, ViewerStatus, ParticipantStatus, ConnectionStatus,
                              # SessionStatus, ConnectionType, MediaProviderKind (TS-only runtime enums)
  interfaces/
    video-rooms.service.interface.ts   # VIDEO_ROOMS_SERVICE token + IVideoRoomsService (real minimal contract)
    media-provider.interface.ts        # MEDIA_PROVIDER token + IMediaProvider
    room-state-manager.interface.ts    # IRoomStateManager
    room-session-manager.interface.ts  # IRoomSessionManager
    room-presence-manager.interface.ts # IRoomPresenceManager
    index.ts
  dto/
    create-video-room.dto.ts
    update-video-room.dto.ts
    list-video-rooms.dto.ts
    index.ts
  validators/
    video-room.validators.ts  # composed class-validator decorators over constants bounds
  entities/
    video-room.view.ts        # API view shapes
    index.ts
  mappers/
    video-room.mapper.ts       # VideoRoom (+settings/stats) -> view
  media/
    zego-media.provider.ts     # ZegoMediaProvider implements IMediaProvider (wraps ZegoTokenService)
    media-token.service.ts     # MediaTokenService facade (mints mediaRoomId, derives canPublish)
    media-session.ts           # MediaSession value type
    media-connection.ts        # MediaConnection value type
    mock-media.provider.ts     # MockMediaProvider for tests
  repositories/
    video-rooms.repository.ts
    index.ts
  services/
    video-rooms.service.ts       # implements IVideoRoomsService (foundation surface)
    video-room-state.service.ts  # implements IRoomStateManager
    video-room-session.service.ts# implements IRoomSessionManager
    video-room-presence.service.ts# implements IRoomPresenceManager
    video-room-event.service.ts  # thin publisher: wraps bus.publish(new XxxEvent(...))
    index.ts
  scheduler/
    video-room-session.monitor.ts # lock-guarded expiry sweep (OnModuleInit/OnModuleDestroy)
  listeners/
    video-room-socket.listener.ts # EVENT_BUS -> SocketManager relay
    index.ts
  events/
    video-room.events.ts       # VIDEO_ROOM_EVENTS map + DomainEvent subclasses
    index.ts
  controllers/
    video-rooms.controller.ts  # 5 endpoints -> 501, fully Swagger-documented
    index.ts
  video-rooms.metrics.ts        # VideoRoomsMetrics (prom-client gauges/counters)
  video-rooms.module.ts
  README.md
```
(No `processors/` and no metrics sampler in VR-0 — see §9/§11: queue *producers* are
registered, workers land with their phases; metric families are exposed directly.)

**Deliberately NOT created** (would duplicate infra, violating the reuse mandate): a module `gateways/`, `guards/`, `interceptors/`, `decorators/`, and an `exceptions/` class hierarchy. These all reuse `src/common` + `src/infra`.

Test files (`*.spec.ts`) are co-located per house convention (see §14).

---

## 4. Database foundation (Decision ①)

New file: `prisma/schema/video_rooms.prisma` (currently an empty stub). One database, one migration history; boundaries expressed by file ownership.

### 4.1 Reuse (no new tables)

- **`room_categories`** and **`room_languages`** — already generically named shared reference data; video-rooms references `categoryId`/`language` by value exactly as audio-rooms does (no cross-table FK, by convention).
- **`MAX_VIDEO_SEATS = 9`** from `src/common/constants/room.constants.ts` — reused for the seat-count cap default (seats themselves are a later phase).

### 4.2 New tables owned by video-rooms (system of record)

Mirrors the audio_rooms AR-0 lifecycle set. All ids `uuid`, all with audit columns + soft-delete where the audio analog has them.

- **`VideoRoom`** → `video_rooms`
  - Core: `id`, `ownerId (@db.Uuid)`, `name`, `description?`, `imageKey?`, `categoryId?`, `language?`, `visibility (VideoRoomVisibility @default(PUBLIC))`, `isLocked (@default(false))`, `passwordHash?`, `isDiscoverable (@default(true))`, `maxParticipants (Int)`, `maxViewers (Int)`, `status (VideoRoomStatus @default(OFFLINE))`, `endedAt?`, `zegoRoomId? @unique` (nullable; lazily minted on first media use, like audio-rooms' AR-2 migration approach).
  - Audit: `createdBy?`, `updatedBy?`, `createdAt`, `updatedAt`, `deletedAt?`.
  - Indexes: `@@index([status])`, `@@index([categoryId])`, `@@index([visibility, isDiscoverable, status])`.
  - Note: unlike `AudioRoom`, `ownerId` is **not** `@unique` here — the concurrency rule (how many live video rooms one owner may host) is a business rule decided in the lifecycle phase, not baked into the schema.
- **`VideoRoomSettings`** → `video_room_settings` (1:1, PK `roomId`): `allowChat`, `allowGifts`, `joinApprovalRequired`, `isRoomMuted`, `metadata Json?`, timestamps. Flags for later phases are defaulted now so the settings surface is stable; seat/host-slot layout fields are added by the seat phase (seats are out of scope here — §4.4).
- **`VideoRoomMember`** → `video_room_members`: durable membership record of record (`role`, `isActive`, `joinedAt`, `leftAt`), unique on `(roomId, userId)` so a returning user's row is reactivated, not duplicated. Matches the PRD entity "Video Room Members" + the audio_rooms `RoomMember` precedent. Table only in VR-0; the join flow that writes it is deferred (§4.4/§4.5).
- **`VideoRoomStatistics`** → `video_room_statistics` (1:1, PK `roomId`): `peakViewers`, `peakParticipants`, `totalJoins (BigInt)`, `currentViewers`, `currentParticipants`, `totalDurationSeconds (BigInt)`, `lastActivityAt`, timestamps.
- **`VideoRoomPresence`** → `video_room_presence`: durable mirror of the Redis viewer/participant set for cross-instance recovery + analytics. `id`, `roomId`, `userId`, `socketId?`, `role` (participant vs viewer), `joinedAt`, `lastSeenAt`. `@@unique([roomId, userId])`, `@@index([roomId])`.
- **`VideoRoomLog`** → `video_room_logs`: append-only audit (write-once). `id`, `roomId`, `actorId?`, `action (VideoRoomLogAction)`, `metadata Json?`, `createdAt`. `@@index([roomId])`, `@@index([action])`.

### 4.3 Enums (owned by video-rooms, for file-ownership cleanliness)

- **`VideoRoomStatus`** { OFFLINE, LIVE, ENDED } — own copy (not reusing `RoomStatus`) so video may add `PAUSED`/`RECORDING` later without touching the audio file.
- **`VideoRoomVisibility`** { PUBLIC, PRIVATE }.
- **`VideoRoomMemberRole`** { OWNER, HOST, PARTICIPANT, VIEWER } — the durable membership vocabulary (elevated grants + the authoritative seat model arrive with the seat phase).
- **`VideoRoomLogAction`** { CREATED, UPDATED, DELETED, ENDED, JOINED, LEFT, LOCKED, UNLOCKED, OWNERSHIP_TRANSFERRED, IMAGE_UPDATED } (+ room-lifecycle actions).

### 4.4 Deferred to later phases (business tables — NOT in Phase 0)

Video seats, viewer rows, stream sessions, media (voice/video) sessions, PK battles, host slots. Live seat/host/viewer state is Redis-authoritative; Phase 0 ships the _services_ that manage that state, not these durable tables.

### 4.5 Repository scope (Phase 0)

`VideoRoomsRepository` injects `PrismaService`, `CacheService`, `@Inject(REDIS_CLIENT) redis`. It implements only the **read / recovery / audit / presence-mirror** primitives the foundation services call — each unit-tested against a test DB:

- `findById(id)` (with settings + statistics), `findByOwnerId(ownerId)`, `list(query)` (paginated, discoverable filter via `buildPaginated`)
- `updateStatus(id, status, actorId)` (lifecycle primitive for recovery/cleanup)
- `appendLog(entry)` (audit primitive)
- `upsertPresence` / `removePresence` / `touchPresence` (durable mirror)

Room **create / mutate / soft-delete** persistence is deferred to the lifecycle phase (its callers — validated create with settings/statistics transaction — do not exist yet). Test fixtures insert rows via Prisma directly.

---

## 5. Configuration (`VIDEO_ROOM_*`)

Add a `videoRoomConfig = registerAs('videoRoom', () => ({...}))` namespace to `src/config/configuration.ts`, append to the exported `configurations` array; declare + validate the env block in `src/config/env.validation.ts` (Zod `z.coerce.number().int().positive().default(...)`); document in `.env.example`.

| Env var | Default | Meaning |
|---------|---------|---------|
| `VIDEO_ROOM_DEFAULT_MAX_PARTICIPANTS` | 12 | default seat-holder cap |
| `VIDEO_ROOM_MAX_PARTICIPANTS_CAP` | 20 | hard cap |
| `VIDEO_ROOM_DEFAULT_MAX_VIEWERS` | 500 | default audience cap |
| `VIDEO_ROOM_MAX_VIEWERS_CAP` | 5000 | hard cap |
| `VIDEO_ROOM_HEARTBEAT_INTERVAL_SECONDS` | 25 | client heartbeat cadence |
| `VIDEO_ROOM_RECONNECT_TIMEOUT_SECONDS` | 120 | reconnect grace (aligns with adapter recovery) |
| `VIDEO_ROOM_MAX_RECONNECT_ATTEMPTS` | 5 | |
| `VIDEO_ROOM_IDLE_TIMEOUT_SECONDS` | 300 | idle host/room timeout |
| `VIDEO_ROOM_CLEANUP_INTERVAL_SECONDS` | 30 | session/presence sweep cadence |
| `VIDEO_ROOM_SESSION_TTL_SECONDS` | 90 | session heartbeat TTL |
| `VIDEO_ROOM_STATE_TTL_SECONDS` | 300 | state-snapshot cache TTL |
| `VIDEO_ROOM_CACHE_TTL_SECONDS` | 60 | room read-cache TTL |
| `VIDEO_ROOM_DEFAULT_QUALITY` | `HD` | default stream quality |
| `VIDEO_ROOM_MAX_BITRATE_KBPS` | 2500 | ceiling advertised to clients |

Consumption: `loadVideoRoomConfig(config)` re-coerces `config.get('videoRoom')` values to `Number` (namespaced values surface as raw strings at runtime — the documented audio-rooms gotcha) and returns a typed `VideoRoomConfig`.

Fixed conventions (namespace string, socket event names, Redis key builders, validation bounds) live in `constants/video-room.constants.ts`, not config.

---

## 6. Media provider abstraction (Decision ②)

```
IMediaProvider (token MEDIA_PROVIDER)
  kind: MediaProviderKind
  issueToken(params: IssueTokenParams): MediaToken
  refreshToken(params: IssueTokenParams): MediaToken
  validateRequest(params: IssueTokenParams): void   // throws BusinessException if unusable
```

- **`ZegoMediaProvider implements IMediaProvider`** — injects the existing `ZegoTokenService`; `issueToken` delegates to `buildRoomToken(userId, mediaRoomId, canPublish)`; `refreshToken` re-issues (the calls-module `renewToken` pattern); `validateRequest` guards `zego.isConfigured()` → throws `BusinessException(VIDEO_ROOM_MEDIA_NOT_CONFIGURED, HttpStatus.SERVICE_UNAVAILABLE)`. **No token04 reimplementation. audio-rooms/calls untouched.**
- **`MediaTokenService`** — video-rooms façade injected with `@Inject(MEDIA_PROVIDER)`. Mints/accepts a `mediaRoomId` (a `randomUUID()` separate from the app room id, matching audio/calls), derives `canPublish` from the caller's participant role, returns a `MediaSession` (`{ mediaRoomId, provider, role, appId, token, expiresInSeconds }`).
- **`MediaSession` / `MediaConnection`** — lightweight, plain-serialisable value types (no SDK types leak into services).
- **`MockMediaProvider`** — deterministic test double bound to `MEDIA_PROVIDER` in specs.
- **Provider swap = bind a different class to `MEDIA_PROVIDER`.** Business services depend only on `MediaTokenService` / `IMediaProvider`.

No endpoint issues a token in Phase 0 (that is the join/stream phase); the layer is built + unit-tested and ready.

---

## 7. State / Session / Presence services (the spec's "managers")

All compose infra primitives — no lock/presence reinvention. Backed by `IRoomStateManager` / `IRoomSessionManager` / `IRoomPresenceManager` interfaces.

- **`VideoRoomStateService` (IRoomStateManager)** — authoritative live room-state snapshot in Redis (`videoRoomStateKey(roomId)` → `video-room:{roomId}:state`). Methods: `getSnapshot(roomId)`, `applyUpdate(roomId, mutator)` executed inside `LockService.withLock(videoRoomStateLockKey(roomId), fn)` with an optimistic monotonically-increasing `version` (conflict = version mismatch → retry/throw `VIDEO_ROOM_INVALID_STATE`), `snapshot(roomId)` / `restore(roomId)` (rebuild cache from durable tables — recovery). Every update is versioned.
- **`VideoRoomSessionService` (IRoomSessionManager)** — per-connection session registry: `video-room:{roomId}:sessions` (set), `video-room:session:{socketId}` (hash + heartbeat TTL). Methods: `register(session)`, `heartbeat(socketId)`, `findDuplicate(roomId, userId)` (duplicate-connection detection), `expireStale(roomId)` (TTL sweep), `endSession(socketId)`, `withReconnectWindow(...)`. Durable mirror via `VideoRoomPresence`.
- **`VideoRoomPresenceService` (IRoomPresenceManager)** — viewer/host counts via infra `PresenceService` + `video-room:{roomId}:viewers` / `:hosts` sets: `viewerCount`, `hostCount`, `isViewer`, `isHost`, `addViewer`/`removeViewer` (Redis-only, no business gating).

These are **real, unit-tested primitives**; they are **not wired into a live join/leave flow** in Phase 0 (no controller/business service drives them yet). That wiring is a later phase. Building them now satisfies "foundation all future phases use" without implementing a room workflow.

---

## 8. Socket integration (reconciled with the house pattern)

No new gateway. Mapping of the spec's requested socket events:

| Spec event | Realization in Phase 0 |
|------------|------------------------|
| `connection` / `disconnect` | `BaseGateway` connection lifecycle (auth handshake + presence) — free |
| `joinRoom` / `leaveRoom` | `BaseGateway`'s existing `room:join` / `room:leave` handlers — free |
| `heartbeat` | `BaseGateway` `ping` — free |
| `reconnect` | adapter `connectionStateRecovery` (120s) — free |
| `roomStateSync` | outbound → `VIDEO_ROOM_SOCKET_EVENTS.STATE_SYNC` relayed by listener |
| `streamReady` / `streamClosed` | outbound → `...STREAM_READY` / `...STREAM_CLOSED` |
| `viewerConnected` / `viewerDisconnected` | outbound → `...VIEWER_CONNECTED` / `...VIEWER_DISCONNECTED` |

`constants/video-room.constants.ts` exports `VIDEO_ROOM_NAMESPACE = SOCKET_NAMESPACES.VIDEO_ROOM` and `VIDEO_ROOM_SOCKET_EVENTS` (client-facing dot-named). `VideoRoomSocketListener` (`OnModuleInit`) subscribes to the bus events (§9) and relays each via `sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload)`. In Phase 0 the listener is wired and unit-tested (mock `SocketManager`), though no business service publishes yet.

---

## 9. Events (EVENT_BUS)

`events/video-room.events.ts` — `VIDEO_ROOM_EVENTS = { CREATED: 'video_room.created', ... } as const` + one class per event extending `DomainEvent<TPayload>` with `readonly name`:

`RoomCreatedEvent`, `RoomClosedEvent`, `UserJoinedEvent`, `UserLeftEvent`, `ViewerJoinedEvent`, `ViewerLeftEvent`, `HostConnectedEvent`, `HostDisconnectedEvent`, `StreamStartedEvent`, `StreamStoppedEvent`.

Payloads are plain, id-carrying records. In Phase 0 these are **published only** by no business flow yet; their sole consumer is the transport relay listener (house pattern). No business/queue consumers (per "do not create consumers yet"). `VideoRoomEventService` is a thin injectable wrapper (`emitRoomCreated(...)` → `bus.publish(new RoomCreatedEvent(...))`) so future services publish through one typed surface.

---

## 10. Queues (Decision ④)

`video-rooms.module.ts` `imports: [BullModule.registerQueue({ name: 'video-rooms' }, { name: 'video-rooms-cleanup' })]` — the queue *producers* are registered now; **workers land with their phases** (the spec's "Register queues only. Workers will be implemented later."). No no-op processor classes in VR-0 (they would be dead infra). Connection, backoff, DLQ, metrics, and Bull Board are inherited from the global `QueueModule`. Analytics and notifications reuse the existing central queues rather than duplicate.

---

## 11. Monitoring

`VideoRoomsMetrics` injects `MetricsService`, registers on `metrics.registry`:
- Gauges: `video_rooms_live_total`, `video_rooms_viewers_total`, `video_rooms_hosts_total`, `video_rooms_sessions_total`.
- Counters: `video_rooms_heartbeat_failures_total`, `video_rooms_reconnects_total`.

The metric families are registered on the shared registry at construction, so they surface at `GET /metrics` immediately (reporting 0 until data flows); the `set*`/`inc*` helpers are called by later-phase code as rooms go live, viewers connect, and sessions reconnect. No standalone sampler monitor in VR-0 — there is no fleet-wide room/viewer index to sample yet, so a sampler would read nothing (dead infra); it lands with the phase that introduces a live-rooms index. Redis/socket latency is already emitted by infra `MonitoringMetrics` — reused, not duplicated. All surface at `GET /metrics` with zero controller changes.

---

## 12. Exceptions (Decision ③)

Add to `src/common/exceptions/error-codes.ts` a `// ---- Video Room domain ----` block:

`VIDEO_ROOM_NOT_FOUND`, `VIDEO_ROOM_ALREADY_EXISTS`, `VIDEO_ROOM_UNAVAILABLE`, `VIDEO_ROOM_CAPACITY_EXCEEDED`, `VIDEO_ROOM_HOST_UNAVAILABLE`, `VIDEO_ROOM_INVALID_STATE`, `VIDEO_ROOM_SESSION_EXPIRED`, `VIDEO_ROOM_MEDIA_NOT_CONFIGURED`, `VIDEO_ROOM_CONFIG_INVALID`.

Throw `new BusinessException(ERROR_CODES.VIDEO_ROOM_*, 'human message', HttpStatus.*)`. Global `AllExceptionsFilter` renders the envelope. No per-module exception classes (matches every other module). These map the spec's requested exception set (`RoomNotFoundException` → `VIDEO_ROOM_NOT_FOUND`, etc.).

---

## 13. REST API skeleton

`@ApiTags('video-rooms') @ApiBearerAuth() @Controller('video-rooms')`:

| Method | Route | Guard | Phase-0 body |
|--------|-------|-------|--------------|
| POST | `/video-rooms` | `@NotGuest()` | `throw new NotImplementedException()` |
| GET | `/video-rooms` | (auth) | `throw new NotImplementedException()` |
| GET | `/video-rooms/:id` | (auth), `ParseUuidPipe` | `throw new NotImplementedException()` |
| PATCH | `/video-rooms/:id` | `@NotGuest()`, `ParseUuidPipe` | `throw new NotImplementedException()` |
| DELETE | `/video-rooms/:id` | `@NotGuest()`, `ParseUuidPipe` | `throw new NotImplementedException()` |

Each method is fully documented (`@ApiOperation`, `@ApiResponse` incl. 501, request/response DTOs typed) so Swagger is complete. JWT is global; writes add `@NotGuest()`. DTOs use class-validator + the composed `validators/`. The 501 is the intended Phase-0 contract, not a stub.

---

## 14. Testing & documentation

- Co-located Jest `*.spec.ts` (TDD, house convention): `video-rooms.repository.spec.ts`, `video-room-state.service.spec.ts`, `video-room-session.service.spec.ts`, `video-room-presence.service.spec.ts`, `media-token.service.spec.ts` / `zego-media.provider.spec.ts` (using `MockMediaProvider`), `video-room-socket.listener.spec.ts`.
- `MockMediaProvider` as the reusable test double for the media seam.
- `src/modules/video-rooms/README.md` (architecture notes + folder map) + JSDoc on public classes + this committed spec.

---

## 15. Public contract (`IVideoRoomsService`)

Replace the placeholder with a minimal but **real** cross-module surface (no `__contract?: never`):

```ts
export interface IVideoRoomsService {
  /** True if the room exists, is not soft-deleted, and status === LIVE. */
  isRoomLive(roomId: string): Promise<boolean>;
}
```

Implemented against repository/state (read-cache first). Exported by token only (`{ provide: VIDEO_ROOMS_SERVICE, useExisting: VideoRoomsService }`, `exports: [VIDEO_ROOMS_SERVICE]`), so other modules (analytics/rankings/gifts) can query liveness without importing the module. The surface grows in later phases.

---

## 16. Module wiring

```ts
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'video-rooms' }, { name: 'video-rooms-cleanup' })],
  controllers: [VideoRoomsController],
  providers: [
    VideoRoomsRepository,
    VideoRoomsService, VideoRoomStateService, VideoRoomSessionService,
    VideoRoomPresenceService, VideoRoomEventService,
    MediaTokenService, ZegoMediaProvider,
    VideoRoomSessionMonitor, VideoRoomsMetrics,
    VideoRoomSocketListener,
    { provide: MEDIA_PROVIDER, useExisting: ZegoMediaProvider },
    { provide: VIDEO_ROOMS_SERVICE, useExisting: VideoRoomsService },
  ],
  exports: [VIDEO_ROOMS_SERVICE],
})
export class VideoRoomsModule {}
```

`@Global` + token-only export mirrors `AudioRoomsModule`. Infra deps resolve globally without imports.

---

## 17. Acceptance criteria (verification, not assertion)

1. `pnpm prisma:migrate` applies the new migration cleanly; `pnpm prisma:generate` regenerates the client.
2. `pnpm build` (TypeScript strict) — 0 errors.
3. `pnpm lint` — 0 warnings.
4. `pnpm boundaries` (dependency-cruiser) — clean; proves no illegal cross-module dependency (video-rooms depends only on `common`/`infra`/its own tree, never another domain module's internals).
5. `pnpm test` — the new `video-rooms` specs pass.
6. App boots; `GET /metrics` exposes the `video_rooms_*` families; Swagger shows the 5 documented endpoints; each returns **501** with the error envelope.
7. No TODOs, no placeholder bodies other than the intended 501 contract.

---

## 18. Explicitly out of scope (deferred to later phases)

Room creation, join/leave, viewer mode, seat/host management, camera/mic/publishing, streaming, beauty filters, chat, gifts, treasure boxes, wallet, PK battles, moderation, notifications, rankings, analytics jobs, recording, live streaming, and any business workflow. Business tables (seats/viewers/streams/sessions/PK) and the room create/mutate persistence path.
