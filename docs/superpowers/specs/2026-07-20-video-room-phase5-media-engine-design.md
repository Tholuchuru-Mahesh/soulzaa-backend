# Video Room — Phase 5: Enterprise Media Engine (VR-5)

- **Date:** 2026-07-20
- **Status:** Approved (design)
- **Module:** `src/modules/video-rooms` (new slice inside the existing module — no new module, no new tables)
- **Depends on:** VR-0 (infra + media seam), VR-1 (session schema/repository), VR-2 (lifecycle + permission + Redis versioned state), VR-3 (member/presence/session), VR-4 (multi-seat engine)
- **Media provider:** ZEGOCLOUD, via the pre-built provider-agnostic seam (`IMediaProvider` → `ZegoMediaProvider` → shared `ZegoTokenService`). No SDK re-initialization.

## 1. Objective

Wire the already-scaffolded-but-unconsumed media seam into a complete, production-grade media (RTC)
engine for Video Rooms: media-session lifecycle, stream publishing/subscription, camera & microphone
controls, audio-output routing, configurable + adaptive video quality, beauty filters, a validated
stream state machine, network recovery, live Redis synchronization, socket events, event-bus publishing,
immutable audit logging, and monitoring — built to the Phase 0–4 quality bar (SOLID, repository +
service layers, event-driven, CQRS-ready, horizontally scalable).

**Explicitly out of scope** (per brief's DO-NOT list): viewer mode, room chat, emoji, virtual gifts,
treasure boxes, wallet, PK battles, rankings, notifications, moderation actions, analytics processing,
recording, live-streaming features. Also excluded by house convention: new Prisma tables, migrations,
bespoke exception classes, inbound socket gateways.

## 2. Locked design decisions (brainstorming, 2026-07-20)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Live media-state authority | **Redis-authoritative versioned media-stage + DB write-through** — a `VideoRoomMediaStateService` pure primitive (getSnapshot/rebuild/commit/clear) + `VideoRoomMediaService.mutateStage` locked pipeline, an exact mirror of the VR-4 seat stage. Monotonic `version` for out-of-order client reconciliation; write-through to `video_room_sessions`; recovery snapshot to `video_room_snapshots`. |
| 2 | Exception strategy | **House convention** — `BusinessException(code, msg, httpStatus)` + new `VIDEO_ROOM_MEDIA_*` `ERROR_CODES`. The brief's named exceptions are *mapped* to codes; no bespoke classes (identical to VR-2 / VR-4). |
| 3 | Command/realtime split | **REST commands + outbound broadcasts** — every media command is a REST endpoint that mutates through a service; realtime is `EVENT_BUS → media-socket.listener → video_room.* broadcast`. No inbound `@SubscribeMessage` (mirrors audio voice + all VR phases). |
| 4 | Migration policy | **Zero schema change** — project the whole engine over existing tables (`video_room_sessions`, `video_rooms.zegoRoomId`/`streamingStatus`, `video_room_events` history, `video_room_snapshots` recovery) + Redis. |
| 5 | Business-logic fidelity | **Implement everything** (no learning-mode TODO forks) — including the adaptive quality selector, the `STREAM_TRANSITIONS` table, beauty validation/clamp, and the admin `forceMute` hook (brief's "future-compatible" mute-by-owner/admin). |

## 3. Reuse map (what already exists — do NOT recreate)

- **Media seam (VR-0):** `MEDIA_PROVIDER` token + `IMediaProvider` (`interfaces/media-provider.interface.ts`);
  `ZegoMediaProvider` (`media/zego-media.provider.ts`) delegating to the shared `ZegoTokenService`
  (`src/infra/zego/zego-token.service.ts` — the one token04 impl, also used by audio-rooms + calls);
  `MediaTokenService` (`media/media-token.service.ts`: `isConfigured`, `mintMediaRoomId`,
  `issueForRoom({userId, mediaRoomId?, canPublish})`, `refresh(params)`); value objects
  `MediaSession` (issued credentials) and `MediaConnection` (observed runtime state).
- **Durable persistence (VR-1):** `VideoRoomMediaSessionRepository` over `VideoRoomSession`
  (`start` upsert/reactivate with `reconnectCount++`, `find`, `listActive`, `setRole`, `recordQuality`,
  `end(roomId,userId,durationSeconds: bigint)`). The row already carries `selfMutedAudio/Video`,
  `cameraFacing`, `role`, `zegoRoomId`, `network`/`platform`/`deviceId`, and a rolling A/V quality summary.
- **Live-state primitives (VR-0/2/4):** `VideoRoomStateService` (self-locking versioned) and
  `VideoRoomSeatStateService` (pure non-locking primitive) + `VideoRoomSeatService.mutateStage` (public
  locked pipeline reused by sibling slices) — the exact templates for the media stage.
- **Seat occupancy (VR-4):** `VideoRoomSeatService.getStage` → publish/camera/mic gated on active seat
  occupancy. Seat LEFT/CLOSED lifecycle events drive media teardown (via a lifecycle listener).
- **RBAC (VR-2):** `VideoRoomPermissionService` + `VIDEO_ROOM_PERMISSION_MATRIX` — `MANAGE_PARTICIPANTS`
  gates `forceMute`; self-service verbs require active membership only.
- **Membership/presence (VR-3):** `VideoRoomSessionService` / `VideoRoomPresenceService` — join-media
  requires an active room session.
- **Socket bridge (VR-0/3/4):** `VideoRoomSocketListener` pattern, `SocketManager.emitToNamespaceRoom`,
  `emitToUserEverywhere`, `VIDEO_ROOM_NAMESPACE`, `VIDEO_ROOM_SOCKET_EVENTS`. Existing `STREAM_READY`/
  `STREAM_CLOSED` client events + `emitStreamStarted/Stopped` helpers are the first things VR-5 consumes.
- **Event bus (VR-0):** `EVENT_BUS` / `IEventBus`, `DomainEvent<T>` base; `VideoRoomEventService` typed façade.
- **Audit (VR-1):** `VideoRoomEventService.appendEvent` → append-only `video_room_events`.
- **Recovery store (VR-1):** `video_room_snapshots` (`VideoRoomSnapshot`, `version`, `state Json`, `reason`).
- **Infra:** `LockService.withLock`, `CacheService` (JSON + `EX` seconds TTL), `VideoRoomsMetrics`,
  `VideoRoomSessionMonitor` fleet-locked-sweep pattern, `ERROR_CODES`, `BusinessException`.
- **Enums (VR-0):** `ConnectionType` (PUBLISHER/SUBSCRIBER), `ConnectionStatus`, `MediaProviderKind`.
- **Room columns:** `VideoRoom.zegoRoomId` (`@unique`, nullable → lazily minted on first media use) and
  `VideoRoom.streamingStatus` (`VideoRoomStreamingStatus` IDLE/PUBLISHING/PAUSED).

## 4. Component architecture (new units, single-purpose — mirrors VR-4)

```
VideoRoomMediaStateService     Redis-authoritative versioned media-stage primitive
                               (getSnapshot / rebuild / commit / clear) — mirrors VideoRoomSeatStateService
VideoRoomMediaService          orchestrator (analog of audio VoiceService); owns the public
                               mutateStage(roomId, fn) locked pipeline. Verbs: joinMedia / leaveMedia /
                               refreshToken · startPublish / stopPublish / pausePublish / resumePublish ·
                               subscribe / unsubscribe · cameraOn / cameraOff / switchCamera ·
                               micOn / micOff / setSelfMute / forceMute · setAudioOutput · setQuality ·
                               setBeauty · heartbeat / reportQuality · getMediaState
VideoRoomMediaRecoveryService  reconnect · republish · resubscribe · restoreFromSnapshot · recovery tokens
VideoRoomMediaController       REST surface (§8), thin actor/id/dto/ip marshalling + delegation
media/media-stage.ts           MediaStageSnapshot / MediaParticipant / MediaStageView interfaces (VOs)
media/media-quality.ts         VideoQualityProfile enum + bitrate/resolution table + selectQualityProfile(sample)
media/beauty-settings.ts       BeautySettings VO + validateBeauty / clampBeauty
constants/video-room-stream-lifecycle.ts   MediaStreamState enum + STREAM_TRANSITIONS + assertStreamTransition
events/video-room-media.events.ts          VIDEO_ROOM_MEDIA_EVENTS bus names + DomainEvent classes
listeners/video-room-media-socket.listener.ts     bus media-events → video_room.* client broadcasts
listeners/video-room-media-metrics.listener.ts    bus media-events → VideoRoomsMetrics
listeners/video-room-media-lifecycle.listener.ts  room CLOSED/DELETED → clearStage; USER_LEFT → leaveMedia;
                                                  seat LEFT → stopPublish (re-privilege on seat change)
scheduler/video-room-media.monitor.ts             fleet-locked sweep: stale media heartbeat → RECOVERING;
                                                  grace elapsed → ENDED + leaveMedia; reap recovery tokens

Extend: VideoRoomsMetrics (media gauges/counters/histograms) · VIDEO_ROOM_SOCKET_EVENTS (media names) ·
        VideoRoomEventService (media emit helpers) · ERROR_CODES (VIDEO_ROOM_MEDIA_* block) ·
        config/video-room.config.ts + configuration.ts + env.validation.ts + .env.example (media fields) ·
        constants/video-room.constants.ts (media Redis key builders) · dto/media.dto.ts (new) ·
        VideoRoomsRepository (add setZegoRoomId; reuse updateRoom/setStatus for streamingStatus)
Reuse:  MediaTokenService · VideoRoomMediaSessionRepository · ZegoMediaProvider · LockService · CacheService ·
        VideoRoomEventService · VideoRoomPermissionService · VideoRoomSeatService · VideoRoomSessionService
```

No new module. ~18–20 new files + ~7 extended, each with a colocated `.spec.ts`.

## 5. Media-stage snapshot + stream state machine

### 5.1 Snapshot shape (`media/media-stage.ts`)

```ts
interface MediaStageSnapshot {
  roomId: string;
  version: number;                 // monotonic; optimistic-concurrency / client reconciliation
  updatedAt: string;               // ISO
  mediaRoomId: string;             // the room's ZEGO handle (== VideoRoom.zegoRoomId)
  provider: MediaProviderKind;
  participants: MediaParticipant[];
}
interface MediaParticipant {
  userId: string;
  seatIndex?: number;              // present when the participant occupies a seat (publisher)
  role: ConnectionType;            // PUBLISHER (seated) | SUBSCRIBER (audience)
  connection: ConnectionStatus;    // CONNECTING | CONNECTED | RECONNECTING | DISCONNECTED
  streamId?: string;               // active publish stream id (deterministic per room+user+kind)
  streamKind: MediaStreamKind;     // CAMERA (implemented) | SCREEN (future-ready, flagged)
  streamState: MediaStreamState;   // the 8-state FSM below
  camera: { on: boolean; facing: 'FRONT' | 'REAR' };
  mic: { on: boolean; selfMuted: boolean; adminMuted: boolean };
  audioOutput: AudioOutput;        // SPEAKER | EARPIECE | BLUETOOTH | WIRED
  quality: VideoQualityProfile;    // LOW | MEDIUM | HIGH | HD | FULL_HD | ADAPTIVE
  beauty: BeautySettings;
  subscriptions: string[];         // userIds this participant is subscribed to
  joinedAt: string;
  lastHeartbeatAt: string;
}
```
`MediaStageView` = client-facing projection (drops server-only fields if any) returned by `getMediaState`
and carried in join/publish responses. `MediaStageMutation = Partial<Omit<MediaStageSnapshot,
'roomId'|'version'|'updatedAt'>>`.

### 5.2 Stream FSM (`constants/video-room-stream-lifecycle.ts`)

New **code-only** enum `MediaStreamState` (not a Prisma enum — ephemeral, Redis + socket only), covering
the brief's 8 states: `CREATED · CONNECTING · LIVE · PAUSED · STOPPED · FAILED · RECOVERING · ENDED`.
Single `STREAM_TRANSITIONS` source of truth; `assertStreamTransition(from, to)` throws
`VIDEO_ROOM_STREAM_INVALID_STATE` (409) on an illegal edge. Legal edges:

```
CREATED    → CONNECTING (startPublish)
CONNECTING → LIVE (publish confirmed) | FAILED (connect error)
LIVE       → PAUSED (pause) | STOPPED (stop) | FAILED (drop) | RECOVERING (network loss)
PAUSED     → LIVE (resume) | STOPPED (stop)
FAILED     → RECOVERING (recovery attempt) | ENDED (give up)
RECOVERING → LIVE (recovered / republished) | FAILED (recovery failed) | ENDED (grace elapsed)
STOPPED    → CREATED (re-publish) | ENDED (leave)
ENDED      → (terminal)
```
Room-level `VideoRoom.streamingStatus` (IDLE/PUBLISHING/PAUSED) is a **durable projection** of the stage
(set PUBLISHING on first LIVE publisher, PAUSED when all paused, IDLE when none) via `updateRoom`. Per-
participant `MediaStreamState` is Redis-only.

## 6. State topology (Redis-authoritative + DB write-through)

`VideoRoomMediaService.mutateStage(roomId, fn)`, under a per-room media lock:
```
withLock( videoRoomMediaLockKey(roomId) ):
  1. base = mediaState.getSnapshot(roomId) ?? mediaState.rebuild(roomId)   // rebuild from listActive sessions if cold
  2. validate: stream transition (STREAM_TRANSITIONS) + membership/seat + permission (RBAC)
  3. next = fn(base)                                                        // pure in-memory mutation
  4. mediaState.commit(roomId, base, patch)  → version++, cache.set(EX ttl) // Redis = source of truth
  5. mediaSessionRepo write-through (setRole / recordQuality / self-mute cols / end)  // durable projection
  6. VideoRoomEventService.appendEvent("media.<action>", {actor, target, seatIndex, streamId, ip, requestId})
  7. bus.publish(new MediaXxxEvent({roomId, version, ...}))  → socket + metrics listeners
```
**Consistency trade-off** (accepted, identical to `VideoRoomStateService`/`VideoRoomSeatStateService`):
Redis is authoritative; DB is a write-through projection. A crash between steps 4 and 5 loses the last
uncommitted mutation on a Redis wipe; `rebuild` reconstructs the snapshot from active sessions (version
reset to 1). All writes are inside the lock, so no concurrent divergence. `VideoRoomSnapshot` captures
periodic + pre-shutdown snapshots for cold-restore.

**New Redis keys** (`constants/video-room.constants.ts`, `{roomId}` hash-tagged → Cluster-safe single-key ops):

| Key builder | Value | Purpose |
|---|---|---|
| `videoRoomMediaStateKey(roomId)` = `video-room:{roomId}:media` | JSON | Authoritative versioned media snapshot |
| `videoRoomMediaLockKey(roomId)` = `video-room:media:{roomId}` | lock | Serializes all media mutations for a room |
| `videoRoomMediaHeartbeatKey(roomId, userId)` = `video-room:{roomId}:media:hb:{userId}` | `'1'` + TTL | Per-publisher liveness; absence ⇒ stale ⇒ monitor recovery |
| `videoRoomMediaRecoveryKey(roomId, userId)` = `video-room:{roomId}:media:recovery:{userId}` | token + TTL | Recovery grant during the reconnect grace window |
| `VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY` = `video-room:media:monitor` | lock | Fleet-wide single-sweeper lock |

## 7. Operations → services

**Media session (`VideoRoomMediaService`):**
- `joinMedia(actor, roomId, dto)`: assert room LIVE + active membership; ensure `mediaRoomId` (read
  `room.zegoRoomId`; if null, under `videoRoomMediaLockKey` re-check then `MediaTokenService.mintMediaRoomId`
  → `repo.setZegoRoomId`); derive `canPublish` from seat occupancy (`VideoRoomSeatService.getStage`);
  `mediaSessionRepo.start(...)`; `mutateStage` → add participant (`streamState=CREATED`,
  `connection=CONNECTING`); issue `MediaSession` via `MediaTokenService.issueForRoom`; auto-subscribe to
  current publishers (policy); audit `media.joined`; publish `MediaSessionCreatedEvent`; return
  `{ mediaSession, mediaStage }`.
- `leaveMedia(actor, roomId)`: idempotent; if publishing → `stopPublish` first; `mutateStage` → remove
  participant; `mediaSessionRepo.end(duration)`; clear heartbeat/recovery keys; audit; publish
  `MediaSessionClosedEvent`.
- `refreshToken(actor, roomId)`: validate active participant + non-expired session; re-issue via
  `MediaTokenService.refresh`; return fresh `MediaSession`.
- Session validation / timeout: enforced in every verb (participant must exist + be CONNECTED/RECOVERING);
  timeout handled by the monitor (§10).

**Stream publishing:**
- `startPublish(actor, roomId, dto)`: **seat-occupancy required** (else `VIDEO_ROOM_MEDIA_SEAT_REQUIRED`
  403); **one active stream per participant** — if already CONNECTING/LIVE/PAUSED →
  `VIDEO_ROOM_DUPLICATE_STREAM` (409); `assertStreamTransition(CREATED|STOPPED → CONNECTING)`; mint
  deterministic `streamId`; `mutateStage`; server confirms `CONNECTING → LIVE`; set room
  `streamingStatus=PUBLISHING` if first live publisher; audit `media.publish`; publish
  `StreamPublishedEvent` → `video_room.stream_published` (+ existing `stream_ready`).
- `stopPublish`: `LIVE|PAUSED → STOPPED`; reconcile room `streamingStatus`; `StreamStoppedEvent` →
  `video_room.stream_stopped` (+ `stream_closed`).
- `pausePublish` / `resumePublish`: `LIVE ↔ PAUSED`.
- Dual-stream / screen: `streamKind` field distinguishes CAMERA vs SCREEN; only CAMERA implemented, SCREEN
  is validated-but-rejected with a "future" code so the shape is ready.

**Stream subscription:**
- `subscribe(actor, roomId, { targetUserId, priority? })`: target must be publishing (LIVE/PAUSED); enforce
  `maxSubscriptionsPerUser` (else `VIDEO_ROOM_SUBSCRIPTION_LIMIT` 409); add to `subscriptions`; publish
  `SubscribedEvent`. Auto-subscribe (on join) and manual/priority subscribe share this path (priority only
  orders the auto set). `unsubscribe` removes. Resubscribe on recovery replays the stored `subscriptions`.

**Camera:** `cameraOn`/`cameraOff` (publisher + seat gated) → `mutateStage` `camera.on`; write-through
`session.selfMutedVideo`; `Camera{Enabled,Disabled}Event` → `video_room.camera_{on,off}`.
`switchCamera({facing})` → `camera.facing` + `session.cameraFacing`. Camera-permission claim validated
from the DTO; camera failure → `streamState FAILED → RECOVERING`.

**Microphone:** `micOn`/`micOff`/`setSelfMute` → `mic.selfMuted` + write-through `session.selfMutedAudio`;
blocked self-unmute when `adminMuted`. `forceMute({targetUserId, muted})` gated by `MANAGE_PARTICIPANTS`
(actor must outrank target) → sets `mic.adminMuted`; `Microphone{Enabled,Disabled}Event` →
`video_room.mic_{on,off}`.

**Audio output:** `setAudioOutput({output})` — client-detected route (SPEAKER/EARPIECE/BLUETOOTH/WIRED);
server records + broadcasts `AudioOutputChangedEvent`. Bluetooth/headset **detection is client-side**; the
server is the synchronization + broadcast authority.

**Video quality (`media/media-quality.ts`):** `VideoQualityProfile` = LOW/MEDIUM/HIGH/HD/FULL_HD/ADAPTIVE
with a `PROFILE_BITRATE` table (kbps + resolution + fps), clamped to config `maxBitrateKbps`. `setQuality`
sets the profile. When ADAPTIVE, `heartbeat` feeds `selectQualityProfile(sample)` (maps RTT / packet-loss /
bitrate → effective profile); a change publishes `QualityChangedEvent` (bitrate-change metric).

**Beauty (`media/beauty-settings.ts`):** `BeautySettings { enabled, level, smoothSkin, brightness, sharpen,
faceEnhance }`; `clampBeauty` bounds every field (0–100 / documented ranges). `setBeauty` → `mutateStage`
beauty (Redis stage, ephemeral live preference — no column needed); `BeautyChangedEvent` →
`video_room.beauty_changed`.

## 8. REST API surface (`@Controller('video-rooms')`, global `JwtAuthGuard`; `@NotGuest` on writes; `@Ip` for audit; POST → `@HttpCode(200)`)

```
POST   video-rooms/:id/media/join            { deviceId?, platform?, network?, canPublishHint? }
POST   video-rooms/:id/media/leave
POST   video-rooms/:id/media/refresh
POST   video-rooms/:id/media/publish         { streamKind? }                 @NotGuest
POST   video-rooms/:id/media/stop            @NotGuest
POST   video-rooms/:id/media/pause           @NotGuest
POST   video-rooms/:id/media/resume          @NotGuest
POST   video-rooms/:id/media/subscribe       { targetUserId, priority? }
POST   video-rooms/:id/media/unsubscribe     { targetUserId }
POST   video-rooms/:id/media/camera/on       @NotGuest
POST   video-rooms/:id/media/camera/off      @NotGuest
POST   video-rooms/:id/media/camera/switch   { facing }                      @NotGuest
POST   video-rooms/:id/media/mic/on          @NotGuest
POST   video-rooms/:id/media/mic/off         @NotGuest
POST   video-rooms/:id/media/mic/force       { targetUserId, muted }         (MANAGE_PARTICIPANTS)
POST   video-rooms/:id/media/audio-output    { output }
POST   video-rooms/:id/media/quality         { profile }                     @NotGuest
POST   video-rooms/:id/media/beauty          { enabled, level, smoothSkin, brightness, sharpen, faceEnhance }  @NotGuest
POST   video-rooms/:id/media/heartbeat       { rttMs?, packetLossPct?, frameRate?, bitrateKbps?, qualityLevel? }
POST   video-rooms/:id/media/recover         { lastVersion? }
GET    video-rooms/:id/media/state
```
The brief's exact 10 (`join, leave, publish, stop, camera/on, camera/off, mic/on, mic/off, beauty, state`)
are the core subset; the additional endpoints are their natural siblings (refresh, pause/resume, sub/unsub,
camera-switch, mic-force, audio-output, quality, heartbeat, recover). Every route fully Swagger-documented
(auth, permission, validation, examples, status codes) per the existing controllers.

## 9. DTOs & exceptions

- **DTOs (`dto/media.dto.ts`, new):** `JoinMediaDto`, `PublishStreamDto` (`streamKind?`), `SubscribeStreamDto`
  (`targetUserId`, `priority?`), `UnsubscribeStreamDto`, `CameraSwitchDto` (`facing`), `ForceMuteDto`
  (`targetUserId`, `muted`), `AudioOutputDto` (`output`), `SetQualityDto` (`profile`), `BeautySettingsDto`,
  `MediaHeartbeatDto`, `RecoverMediaDto`. Response VOs: `MediaSessionResponseDto` (issued creds +
  `MediaStageView`), `MediaStateResponseDto` (`MediaStageView`). Reusable composed validators (mirror
  `validators/video-room.validators.ts`) for repeated fields (facing, output, profile, beauty ranges).
- **Exceptions — new `ERROR_CODES` under a `// ---- Video Room media (VR-5) ----` block** (mapping the
  brief's named exceptions):
  | Brief exception | ERROR_CODE (HTTP) |
  |---|---|
  | MediaSessionException | `VIDEO_ROOM_MEDIA_SESSION_INVALID` (409) |
  | StreamPublishException | `VIDEO_ROOM_STREAM_PUBLISH_FAILED` (409) |
  | StreamSubscribeException | `VIDEO_ROOM_STREAM_SUBSCRIBE_FAILED` (409) |
  | CameraException | `VIDEO_ROOM_CAMERA_ERROR` (409) |
  | MicrophoneException | `VIDEO_ROOM_MICROPHONE_ERROR` (409) |
  | MediaPermissionException | `VIDEO_ROOM_MEDIA_SEAT_REQUIRED` (403) / reuse `VIDEO_ROOM_FORBIDDEN` |
  | MediaTokenException | reuse `VIDEO_ROOM_MEDIA_NOT_CONFIGURED` (503) / `VIDEO_ROOM_SESSION_EXPIRED` (401) |
  | StreamRecoveryException | `VIDEO_ROOM_MEDIA_RECOVERY_FAILED` (409) |
  | DuplicateStreamException | `VIDEO_ROOM_DUPLICATE_STREAM` (409) |
  | (stream FSM guard) | `VIDEO_ROOM_STREAM_INVALID_STATE` (409) |
  | (subscription cap) | `VIDEO_ROOM_SUBSCRIPTION_LIMIT` (409) |
  Reuse existing: `VIDEO_ROOM_MEDIA_NOT_CONFIGURED`, `VIDEO_ROOM_CONFIG_INVALID`, `VIDEO_ROOM_INVALID_STATE`,
  `VIDEO_ROOM_NOT_MEMBER`, `VIDEO_ROOM_SESSION_EXPIRED`, `VIDEO_ROOM_FORBIDDEN`.

## 10. Events, socket, audit, metrics, scheduler

- **EVENT_BUS (`events/video-room-media.events.ts`):** `MediaSessionCreatedEvent`, `MediaSessionClosedEvent`,
  `StreamPublishedEvent` + `StreamStoppedEvent` (reuse existing helpers), `StreamPausedEvent`,
  `StreamResumedEvent`, `CameraEnabledEvent`, `CameraDisabledEvent`, `MicrophoneEnabledEvent`,
  `MicrophoneDisabledEvent`, `SubscribedEvent`, `UnsubscribedEvent`, `BeautyChangedEvent`,
  `QualityChangedEvent`, `AudioOutputChangedEvent`, `StreamStateChangedEvent`, `StreamRecoveredEvent`,
  `MediaRecoveredEvent`, `MediaFailedEvent`, `MediaStateSyncEvent`. Each extends `DomainEvent<T>`, payload
  carries `{roomId, version, ...}`.
- **Socket (`video-room-media-socket.listener.ts` + new `VIDEO_ROOM_SOCKET_EVENTS`):** `media_joined`,
  `media_left`, `camera_on`, `camera_off`, `mic_on`, `mic_off`, `stream_published`, `stream_stopped`,
  `stream_paused`, `stream_resumed`, `subscribed`, `unsubscribed`, `beauty_changed`, `quality_changed`,
  `audio_output_changed`, `stream_state_changed`, `media_recovered`, `stream_failed`, `stream_recovered`,
  `media_state_sync` (reusing existing `stream_ready`/`stream_closed`). Heartbeat + quality-sample events
  stay **bus-only** (feed metrics, not relayed). Services never touch sockets.
- **Audit:** every mutation appends `video_room_events` via `VideoRoomEventService` with
  `{roomId, userId, seatIndex, streamId, deviceId, socketId, action, requestId, ip, timestamp}` — satisfies
  the brief's audit-field list with no new table.
- **Metrics (extend `VideoRoomsMetrics`, `// ---- VR-5 media ----`):** gauges
  `video_rooms_media_active_streams`, `..._publishing_users`, `..._subscribed_users`; counters
  `video_rooms_media_sessions_total`, `..._tokens_issued_total`, `..._publish_total`,
  `..._publish_failures_total`, `..._media_failures_total`, `..._recovery_success_total`,
  `..._reconnect_total`, `..._bitrate_changes_total`, `..._camera_toggles_total`, `..._mic_toggles_total`,
  `..._beauty_changes_total`; histograms `video_rooms_media_join_seconds`, `..._publish_seconds`,
  `..._subscribe_seconds`, `..._media_session_duration_seconds`; a labeled
  `video_rooms_media_quality_profile` gauge for the video-quality distribution. Reconnect-rate + media-
  latency derive from these. Driven by `video-room-media-metrics.listener.ts` (mirrors the seat-metrics listener).
- **Scheduler (`scheduler/video-room-media.monitor.ts`, or extend `VideoRoomSessionMonitor`):** fleet-locked
  (`VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY`) `setInterval` sweep at `mediaMonitorIntervalSeconds` with `.unref()`
  + re-entrancy guard: publishers with a stale `videoRoomMediaHeartbeatKey` → `LIVE → RECOVERING`; grace
  (`mediaReconnectGraceSeconds`) elapsed → `RECOVERING → ENDED` + `leaveMedia`; reap expired recovery tokens.
  Emits `StreamStateChangedEvent` / `MediaFailedEvent` so clients stay synced.

## 11. Network recovery (`VideoRoomMediaRecoveryService`)

- Temporary network loss (observed by monitor or reported): `mutateStage` `LIVE → RECOVERING`; write a
  `videoRoomMediaRecoveryKey` token (TTL = grace); publish `StreamStateChangedEvent`.
- `recover(actor, roomId, dto)`: validate recovery token / grace window (else `VIDEO_ROOM_MEDIA_RECOVERY_FAILED`);
  `mediaSessionRepo` reconnect (`reconnectCount++`); re-issue `MediaSession`; `mutateStage`
  `RECOVERING → LIVE`; **republish** (restore `streamId`/`streamState`) + **resubscribe** (replay stored
  `subscriptions`); if Redis cold, `restoreFromSnapshot(roomId)` rebuilds the stage from the latest
  `VideoRoomSnapshot` before applying; publish `MediaRecoveredEvent` + `StreamRecoveredEvent` →
  `video_room.media_recovered` / `stream_recovered`.
- `streamFailed` (unrecoverable): `→ FAILED → ENDED`; publish `MediaFailedEvent` → `video_room.stream_failed`.

## 12. Validations (enforced in services, reusing existing gates)

Room exists · room active (LIVE) · user joined (active session) · seat occupied (publish/camera/mic) ·
media token / provider configured (`MediaTokenService.isConfigured` → 503) · camera/mic permission
(DTO claim + seat) · duplicate stream (one publishing stream/participant) · publishing limit ·
subscription limit (`maxSubscriptionsPerUser`) · stream-transition legality · actor outranks target (forceMute).

## 13. Config additions

`config/video-room.config.ts` (+ `configuration.ts` `videoRoomConfig` namespace + `env.validation.ts` +
`.env.example`), all coerced once behind the typed accessor:

| Field / env | Default | Purpose |
|---|---|---|
| `mediaHeartbeatTtlSeconds` / `VIDEO_ROOM_MEDIA_HEARTBEAT_TTL_SECONDS` | 30 | Publisher liveness marker life |
| `mediaMonitorIntervalSeconds` / `VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS` | 10 | Media sweep cadence |
| `mediaReconnectGraceSeconds` / `VIDEO_ROOM_MEDIA_RECONNECT_GRACE_SECONDS` | 60 | RECOVERING→ENDED grace |
| `mediaRecoveryTokenTtlSeconds` / `VIDEO_ROOM_MEDIA_RECOVERY_TOKEN_TTL_SECONDS` | 60 | Recovery grant TTL |
| `maxSubscriptionsPerUser` / `VIDEO_ROOM_MAX_SUBSCRIPTIONS_PER_USER` | 20 | Subscription cap |
| `qualitySampleEvery` / `VIDEO_ROOM_MEDIA_QUALITY_SAMPLE_EVERY` | 6 | Persist a quality sample every Nth heartbeat |
| `defaultBeautyLevel` / `VIDEO_ROOM_DEFAULT_BEAUTY_LEVEL` | 0 | Beauty default |

The 6-profile `PROFILE_BITRATE` table (LOW/MEDIUM/HIGH/HD/FULL_HD/ADAPTIVE → kbps/resolution/fps) is a
constant in `media/media-quality.ts`, clamped by the existing `maxBitrateKbps`. The existing coarse
`VIDEO_ROOM_DEFAULT_QUALITY` (SD/HD/FHD) maps to a default profile.

## 14. Testing plan (TDD, colocated `*.spec.ts`)

- `video-room-stream-lifecycle.spec.ts` — `STREAM_TRANSITIONS` table + `assertStreamTransition`.
- `media-quality.spec.ts` — profile/bitrate table + `selectQualityProfile` adaptive mapping + clamp.
- `beauty-settings.spec.ts` — `clampBeauty` bounds + validation.
- `video-room-media-state.service.spec.ts` — `commit` version bump, `rebuild` from active sessions, `clear`.
- `video-room-media.service.spec.ts` — `mutateStage` lock; join/leave (idempotent); publish dedup +
  pause/resume; subscribe/unsubscribe + cap; camera/mic write-through + adminMuted block; forceMute
  outranking; setQuality/adaptive; setBeauty; token refresh; room `streamingStatus` projection.
- `video-room-media-recovery.service.spec.ts` — reconnect/republish/resubscribe, restore-from-snapshot,
  grace expiry, recovery-token validation.
- `video-room-media-socket.listener.spec.ts` — bus→client event mapping (incl. bus-only suppression).
- `video-room-media-metrics.listener.spec.ts` — counters/gauges/histograms driven by bus events.
- `video-room-media.monitor.spec.ts` — stale-heartbeat → RECOVERING → ENDED sweep, fleet-lock guard.
- `video-room-media.controller.spec.ts` — routing, guards, DTO validation, permission propagation, codes.
- `media.dto.spec.ts` — validation bounds. Plus `VideoRoomMediaSessionRepository` write-through coverage.

**Bar:** comprehensive coverage; existing suite stays green (purely additive); `pnpm build` (strict) 0
errors; `pnpm lint` 0 warnings; `pnpm boundaries` clean (video-rooms depends only on common/infra/its tree).

## 15. Implementation order

1. Enums + `MediaStreamState`/`MediaStreamKind`/`AudioOutput`/`VideoQualityProfile`; `STREAM_TRANSITIONS`
   helper; `media/media-quality.ts` + `media/beauty-settings.ts` + `media/media-stage.ts` VOs; ERROR_CODES;
   Redis key builders; config (env + namespace + typed accessor + `.env.example`).
2. `VideoRoomsRepository.setZegoRoomId` (+ `streamingStatus` projection helper) + tests.
3. `VideoRoomMediaStateService` primitive + tests.
4. `events/video-room-media.events.ts` + `VideoRoomEventService` media emit helpers + socket listener +
   metrics listener + `VideoRoomsMetrics` extension.
5. `VideoRoomMediaService` (session/publish/subscribe/camera/mic/output/quality/beauty/heartbeat) + tests.
6. `VideoRoomMediaRecoveryService` + tests.
7. `scheduler/video-room-media.monitor.ts` + tests; `video-room-media-lifecycle.listener.ts` + tests.
8. `dto/media.dto.ts` + `VideoRoomMediaController` (full Swagger) + tests.
9. Module wiring (`// VR-5 media engine` providers/controllers block) + README + `.env.example`.
10. Verify: `tsc` + lint + boundaries + full suite green; zero regressions.

## 16. Non-goals / explicit exclusions

The brief's DO-NOT list (viewer mode, chat, emoji, gifts, treasure boxes, wallet, PK battles, rankings,
notifications, moderation actions, analytics processing, recording, live-streaming features). Also: no new
Prisma tables, no migration, no bespoke exception classes, no inbound socket gateway, no re-initialization
of the ZEGOCLOUD SDK (delegate to the shared `ZegoTokenService`). SCREEN stream kind is shape-ready but not
implemented this phase.
