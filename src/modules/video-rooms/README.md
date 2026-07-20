# Video Rooms — VR-0 Foundation + VR-1 Database Domain + VR-2 Lifecycle

The Video Room backend. VR-0 delivered the reusable primitives + durable
foundation; VR-1 landed the complete database domain; **VR-2 implements the full
room lifecycle** (create / get / search / discover / update / lock / activate /
close / reopen / soft-delete / restore / verify-status). Still **out of scope**
(later phases): join/leave, viewer mode, participants, seats, streaming, chat,
gifts, PK, moderation, notifications.

Design specs:
[VR-0](../../../docs/superpowers/specs/2026-07-20-video-room-phase0-design.md) ·
[VR-1](../../../docs/superpowers/specs/2026-07-20-video-room-phase1-database-design.md) ·
[VR-2](../../../docs/superpowers/specs/2026-07-20-video-room-phase2-lifecycle-design.md).

## VR-2 lifecycle at a glance

- **No schema change.** The brief's 7-state lifecycle + 7 visibility types are
  *projected* onto the minimal VR-1 columns (`status` × `isLocked` × `deletedAt` ×
  `streamingStatus`; access policy stored in `metadata`) by the pure
  `constants/video-room-lifecycle.ts` helper — no migration.
- **CQRS-ready split.** `VideoRoomLifecycleService` (commands) ·
  `VideoRoomQueryService` (reads) · `VideoRoomPermissionService` (the RBAC gate
  over `VIDEO_ROOM_PERMISSION_MATRIX`) · `VideoRoomPasswordService` (bcryptjs).
  `VideoRoomsService` stays thin (only the exported `isRoomLive` contract).
- **Status machine** (`isValidStatusTransition`): `OFFLINE→LIVE` (activate),
  `OFFLINE|LIVE→ENDED` (close), `ENDED→OFFLINE` (reopen); illegal transitions throw
  `VIDEO_ROOM_INVALID_STATE`. Lock + soft-delete are orthogonal (any state).
- **Rooms per owner** capped by `VIDEO_ROOM_MAX_ROOMS_PER_OWNER` (default 1) →
  `VIDEO_ROOM_ALREADY_EXISTS` (409) on create.
- **Discovery** ranks on durable signals: newest / popular (statistics) / featured
  (verified) / nearby (country) / vip (access policy) + a global trending zset
  (`video-room:trending`, seeded on create/activate). Friends/following deferred
  (no social/join wiring yet).
- Every command syncs the Redis read-cache + trending set, appends a
  `video_room_logs` audit row, and publishes an EVENT_BUS event
  (`RoomCreated/Updated/Locked/Deleted/Restored/Closed`) relayed to `/video-room`.

### Endpoints (base `video-rooms`, all JWT-guarded; writes `@NotGuest`)

`POST /` · `GET /` · `GET /search` · `GET /trending` · `GET /popular` ·
`GET /featured` · `GET /mine` · `GET /:id` · `GET /:id/status` · `PATCH /:id` ·
`DELETE /:id` · `POST /:id/{activate,close,reopen,lock,unlock,restore}`.

## What this module reuses (does not recreate)

Every cross-cutting concern comes from existing `@Global` infrastructure — the
module only registers its own BullMQ queues:

| Concern | Reused from |
| --- | --- |
| Socket namespace + gateway | `infra/socket` — `VideoRoomGateway` / `/video-room` already exist; we emit via `SocketManager` |
| RTC tokens | `infra/zego` `ZegoTokenService` (wrapped by `ZegoMediaProvider`) |
| Redis (cache, locks, sets) | `infra/redis` `CacheService` / `LockService` / `REDIS_CLIENT` |
| Metrics | `infra/observability` `MetricsService` registry (`GET /metrics`) |
| Queues | `infra/queue` global `QueueModule` (connection/backoff/DLQ inherited) |
| Auth / RBAC / envelope / errors | `common` guards, interceptors, `BusinessException` + `ERROR_CODES` |
| Reference data | shared `room_categories` / `room_languages` tables (by value) |

## Layout

```
constants/   namespace, socket-events, Redis keys, bounds, queues, VR-1 domain defaults,
             the VideoRoomPermission code matrix, and theme/background seed data
config/      typed VideoRoomConfig accessor over the `videoRoom` config namespace
enums/       runtime (non-DB) enums: connection/session/stream/participant/viewer state
interfaces/  IVideoRoomsService (public contract) + IMediaProvider + state/session/presence ports
dto/         create/update/list/search + settings/role/seat/moderation/announcement bodies
validators/  composed field decorators over the constants bounds
entities/    client-safe views (room + stage + content) consumed by mappers/
mappers/     row → client-safe view projections (drop audit/internal columns)
media/       IMediaProvider seam: ZegoMediaProvider (adapter), MediaTokenService (façade),
             MediaSession/MediaConnection value types, MockMediaProvider (tests)
repositories/ pure Prisma persistence: rooms + VR-1 roles / seats / moderation /
             media-session / events+snapshots+announcements / reference
services/    VR-2 Lifecycle (commands) / Query (reads) / Permission (RBAC gate) /
             Password (bcryptjs); VideoRoomsService (contract); State / Session /
             Presence managers; Event publisher; VideoRoomReferenceSeederService
scheduler/   VideoRoomSessionMonitor — lock-guarded stale-session sweep
listeners/   VideoRoomSocketListener — EVENT_BUS → /video-room relay
events/      VIDEO_ROOM_EVENTS + DomainEvent classes
controllers/ VideoRoomsController — 17 fully-documented lifecycle routes (VR-2)
```

## Database (owned tables)

**VR-0 (6):** `video_rooms`, `video_room_settings`, `video_room_members`,
`video_room_statistics`, `video_room_presence`, `video_room_logs`.

**VR-1 (+13):** `video_room_roles` (elevated grants), `video_room_seats`,
`video_room_seat_requests`, `video_room_invitations` (the multi-seat stage),
`video_room_mutes`, `video_room_blocks`, `video_room_moderation_actions`
(moderation — **no ban table**, by design), `video_room_sessions` (durable media
session), `video_room_events` + `video_room_snapshots` (event stream + recovery),
`video_room_announcements`, and the seeded `video_room_themes` /
`video_room_backgrounds` reference. VR-1 also extends the VR-0 tables (settings
flags, room facets/tags, member context, lifetime statistics) and the
`VideoRoomMemberRole` / `VideoRoomLogAction` enums.

Two additive, offline-generated migrations, **left unapplied** — apply with your
normal Prisma workflow:
`migrations/20260720120000_video_rooms_phase0_foundation` and
`migrations/20260720130000_video_rooms_phase1_domain`. Live occupancy/state is
authoritative in Redis; these tables are the durable record for recovery +
analytics.

### What VR-1 reuses instead of duplicating (reuse-maximal)

| Concept | Reused from |
| --- | --- |
| Categories / languages | shared `room_categories` / `room_languages` (by value, no FK) |
| Analytics / rollups | shared `analytics` module (`RoomActivity`, `RoomDailyStat`, `CreatorDailyStat`, `RevenueReport`) keyed by generic `roomId` |
| Permissions | code matrix (`constants/video-room-permissions.ts`) + `video_room_roles` grants — **not** a DB permission table |
| Participant / Viewer | `video_room_members.role` + seat occupancy + `video_room_presence` + analytics `RoomVisitor` |
| Connection / Device | `video_room_sessions` columns + Redis runtime enums (`enums/index.ts`) |
| Tags | `video_rooms.tags` `String[]` (GIN-indexed) — no join table |

Conventions held from VR-0: `deletedAt`-only soft delete (no `version`/`deletedBy`
sprawl — `VideoRoomSnapshot.version` is a state sequence, not a lock), no
cross-domain foreign keys, and append-only histories carry only their event
columns.

## Realtime contract

Inbound (`joinRoom` / `leaveRoom` / `heartbeat` / `reconnect`) is served by the
shared `BaseGateway` (`room:join` / `room:leave` / `ping`) + the adapter's 120s
`connectionStateRecovery`. Outbound `video_room.*` events are emitted by
`VideoRoomSocketListener` in response to EVENT_BUS domain events. See
`constants/video-room.constants.ts` (`VIDEO_ROOM_SOCKET_EVENTS`) and
`events/video-room.events.ts` (`VIDEO_ROOM_EVENTS`) — the two vocabularies are
intentionally distinct and bridged by the listener.

## Public contract

Other modules depend only on `VIDEO_ROOMS_SERVICE` (token) → `IVideoRoomsService`
or on the EVENT_BUS. VR-0 exposes `isRoomLive(roomId)`; the surface grows per
phase. VR-2's lifecycle/query/permission services are module-internal (the
controller wires them directly) — they are **not** exported across the module
boundary.

## VR-3 — Member, presence & session lifecycle

Participant lifecycle wired live on the VR-0 managers. **Commands are REST**
(`VideoRoomMembersController` → `VideoRoomMemberService`); realtime fan-out stays
EVENT_BUS → `VideoRoomSocketListener` (no domain socket gateway). No new tables,
migration, or env vars — it reuses `video_room_members` (durable membership),
`video_room_presence` (durable mirror), `video_room_events` (rich audit), and the
pre-provisioned `VIDEO_ROOM_*` config.

REST surface (all under `video-rooms`, JWT-guarded; writes `@NotGuest`, 200):

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/:id/join` | validate → write member/session/presence → return room-state sync |
| POST | `/:id/leave` | graceful exit (end session, deactivate member, decrement) |
| POST | `/:id/reconnect` | grace-window reconnect (membership preserved) |
| POST | `/:id/heartbeat` | slide session TTL + report activity (`{ alive }`) |
| GET | `/:id/members` | active-member roster (paginated) |
| GET | `/:id/presence` | per-member live presence (derived) |
| GET | `/:id/session` | the caller's own live session |
| GET | `/:id/sync` | version-based room-state sync |

Presence is a 7-state machine
(`CONNECTING/ONLINE/IDLE/RECONNECTING/DISCONNECTED/LEFT/OFFLINE`) computed by the
pure `derivePresenceState` — heartbeat freshness + the client `inBackground` flag.
Live state is Redis-authoritative; `video_room_presence.lastSeenAt` is written
**lazily** (≈ every 2 heartbeat intervals) so heartbeat traffic never hammers
Postgres. Reclaim of dropped sessions after the 120s grace window is the
`VideoRoomSessionMonitor` (30s, lock-guarded) → `VideoRoomMemberService.reclaim`;
the `VideoRoomPresenceListener` is a low-latency disconnect fast-path off the infra
`presence.changed` event. Duplicate sessions are evicted per `(userId, deviceId)`;
different devices coexist.

New Redis keys: `video-room:user:{userId}:sessions` (reverse index) and
`video-room:join:{roomId}` (join lock). Counter fan-out policy: `UserJoined/Left/
Disconnected/Reconnected`, `PresenceUpdated`, `RoomSynchronized` relay to clients;
`HeartbeatMissed`, `SessionCreated/Expired` are bus-only (analytics/monitoring);
heartbeat-received is metric-only. `idleCount` in the state snapshot is best-effort
(live per-member IDLE is exact via `GET /presence`); `viewerCount` is authoritative.

## VR-5 — Media Engine

The RTC layer: media-session join/leave, dual-stream publishing, subscriptions +
caps, device controls (camera/mic/audio-output), configurable + adaptive video
quality, beauty filters, and network-drop recovery. Built the same way as VR-4:
a Redis-authoritative versioned stage (mirrors `VideoRoomSeatStateService` /
`VideoRoomStateService`), no new migration, and **ZEGO reached only through the
shared `MediaTokenService`** — the module mints/reuses the room's ZEGO handle
and issues/refreshes RTC tokens through the same façade VR-0 already wired
(`ZegoTokenService` → `ZegoMediaProvider` → `MediaTokenService`); no SDK
re-initialization, no second ZEGO client, no parallel token path.

### REST surface (base `video-rooms/:id/media`, all JWT-guarded; state-changing routes `@NotGuest`, 200)

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/join` | join the media session → media session + ZEGO token + stage |
| POST | `/leave` | end the media session (idempotent) |
| POST | `/refresh` | re-issue the RTC token for an active session |
| POST | `/publish` | start publishing (seat occupancy required; camera only this phase) |
| POST | `/stop` | stop publishing |
| POST | `/pause` / `/resume` | pause/resume the live stream |
| POST | `/subscribe` / `/unsubscribe` | subscribe/unsubscribe to a publisher (capped by `maxSubscriptionsPerUser`) |
| POST | `/camera/on` / `/camera/off` / `/camera/switch` | camera controls (front/rear) |
| POST | `/mic/on` / `/mic/off` | self mute/unmute |
| POST | `/mic/force` | moderator force-mute/unmute (`MANAGE_PARTICIPANTS` + outrank) |
| POST | `/audio-output` | set the audio route (speaker/earpiece/bluetooth/wired) |
| POST | `/quality` | set the video quality profile (`LOW/MEDIUM/HIGH/HD/FULL_HD/ADAPTIVE`) |
| POST | `/beauty` | update beauty-filter settings (clamped) |
| POST | `/heartbeat` | media heartbeat + quality sample (drives adaptive quality) |
| POST | `/recover` | recover a session/stream after a network drop |
| GET | `/state` | current media stage snapshot |

### Socket events (`/video-room` namespace, EVENT_BUS-driven — no domain gateway)

`video_room.media_joined` / `media_left` · `stream_published` / `stream_stopped` ·
`stream_paused` / `stream_resumed` · `stream_state_changed` · `stream_failed` ·
`stream_recovered` · `media_recovered` · `subscribed` / `unsubscribed` ·
`camera_on` / `camera_off` · `mic_on` / `mic_off` · `beauty_changed` ·
`quality_changed` · `audio_output_changed` · `media_state_sync`. Every payload
carries the stage's monotonic `version` for out-of-order reconciliation. Bus-only
(not relayed to sockets): heartbeat/quality-sample events (monitoring only).

### Redis keys

| Key | Purpose |
| --- | --- |
| `video-room:{roomId}:media` | the live `MediaStageSnapshot` (versioned, TTL-refreshed) |
| `video-room:media:{roomId}` | the `mutateStage` mutation lock (all writes serialize here) |
| `video-room:{roomId}:media:recovery:{userId}` | reconnect grace-window marker, armed on RECOVERING/FAILED |
| `video-room:{roomId}:media:hb:{userId}` | reserved fast-path heartbeat marker (not yet written — liveness uses the durable `video_room_sessions.lastHeartbeatAt` sweep instead, see below) |
| `video-room:media:monitor` | lock guarding `VideoRoomMediaMonitor`'s sweep tick |

### The 8-state stream FSM

`CREATED → CONNECTING → LIVE ⇄ PAUSED`, `LIVE/PAUSED → STOPPED`,
`LIVE/CONNECTING/RECOVERING → FAILED`, `LIVE → RECOVERING → LIVE|FAILED|ENDED`,
and any non-terminal state → `ENDED`. Every transition routes through
`assertStreamTransition` (`constants/video-room-stream-lifecycle.ts`), the
single source of truth mirroring the seat/room lifecycle tables; illegal
transitions throw `VIDEO_ROOM_STREAM_INVALID_STATE` (409).

### Recovery + persistence

`VideoRoomMediaMonitor` (lock-guarded, `VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS`)
sweeps `video_room_sessions` for stale heartbeats via `findStale`: within the
reconnect grace window a publisher moves to `RECOVERING`; past grace it's
force-expired via `VideoRoomMediaRecoveryService.expireRecovery`. On room
close/delete, `VideoRoomMediaLifecycleListener` persists the live stage as a
`PRE_SHUTDOWN` snapshot (`video_room_events`/`video_room_snapshots`) before
dropping the Redis snapshot — `restoreFromSnapshot` rehydrates it on the next
cold read. On `USER_LEFT`, the listener ends that user's media session.

### Config

7 env-backed knobs under the `videoRoom` namespace (see `.env.example` /
`config/video-room.config.ts`): `VIDEO_ROOM_MEDIA_HEARTBEAT_TTL_SECONDS`,
`VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS`,
`VIDEO_ROOM_MEDIA_RECONNECT_GRACE_SECONDS`,
`VIDEO_ROOM_MEDIA_RECOVERY_TOKEN_TTL_SECONDS`,
`VIDEO_ROOM_MAX_SUBSCRIPTIONS_PER_USER`, `VIDEO_ROOM_MEDIA_QUALITY_SAMPLE_EVERY`,
`VIDEO_ROOM_DEFAULT_BEAUTY_LEVEL`.

### Known simplifications (explicit, not silent)

- `SubscribeStreamDto.priority` is captured/audited but does not yet reorder the
  subscription set (auto-subscribe already slices to the cap) — ordering by
  priority is a later refinement.
- `videoRoomMediaHeartbeatKey` is reserved for a future fast-path; liveness
  detection today uses the durable `video_room_sessions.lastHeartbeatAt` +
  `findStale` sweep, mirroring the audio `VoiceHeartbeatMonitor`.
