# Video Room Phase 5 — Enterprise Media Engine (ZEGOCLOUD) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the pre-built (but unconsumed) media seam into a complete production media engine for Video Rooms — media-session lifecycle, stream publish/subscribe, camera/mic controls, audio-output, adaptive video quality, beauty filters, a validated stream state machine, and network recovery — on the existing schema with Redis-authoritative live state.

**Architecture:** New slice inside `src/modules/video-rooms` — no new module, no new tables, no migration. Live media state is a versioned, lock-serialized Redis snapshot (source of truth); every mutation write-throughs to `video_room_sessions`, appends an immutable `video_room_events` audit row, and publishes a domain event on `EVENT_BUS` that a socket listener bridges to `video_room.*` broadcasts. Mirrors the existing `VideoRoomSeatStateService` / `VideoRoomSeatSocketListener` patterns. ZEGO tokens come from the shared `ZegoTokenService` via the existing `MediaTokenService` — the SDK is never re-initialized.

**Tech Stack:** NestJS, TypeScript, Prisma (Postgres), ioredis (`CacheService`/`LockService`), custom `EVENT_BUS` (`IEventBus`), Socket.IO (`SocketManager`), prom-client (`VideoRoomsMetrics`), Jest.

## Global Constraints

- **Conventions-first:** express the engine on existing tables + video-room primitives. No new Prisma tables, no migration, no bespoke exception classes, no inbound socket gateway, no ZEGO SDK re-init.
- **Redis-authoritative + DB write-through:** the versioned Redis media snapshot is the source of truth for reads + socket sync; Postgres `video_room_sessions` is the durable projection/recovery source; `video_room_snapshots` is the cold-restore source.
- **All media mutations run under `withLock(videoRoomMediaLockKey(roomId))`** via `VideoRoomMediaService.mutateStage` — load/rebuild snapshot → validate (stream transition + membership/seat + RBAC) → commit Redis snapshot (version++) → write-through DB → append audit → publish event, all inside the lock.
- **Services never touch sockets.** Fan-out is `EVENT_BUS` → `VideoRoomMediaSocketListener` → `SocketManager.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload)`.
- **RBAC only** via `VideoRoomPermissionService` + `VIDEO_ROOM_PERMISSION_MATRIX`; platform ADMIN/SUPER_ADMIN bypass. No hardcoded role checks. `forceMute` requires `MANAGE_PARTICIPANTS` + actor outranks target.
- **Publish/camera/mic require active seat occupancy** (`VideoRoomSeatService.getStage`). Only seat occupants publish media. One active publishing stream per participant.
- **Errors:** `throw new BusinessException(ERROR_CODES.X, message, HttpStatus.Y)`.
- **ZEGO token seam:** `MediaTokenService.issueForRoom({userId, mediaRoomId, canPublish})` / `.mintMediaRoomId()` / `.refresh(params)` / `.isConfigured()`. Never call `ZegoTokenService` or `generate-token04` directly.
- **Every file gets a colocated `.spec.ts`.** Verification bar: `npx tsc --noEmit` clean, ESLint clean, `boundaries` clean, full suite green, zero regressions.
- **Numbers off `ConfigService` may be strings at runtime** — read every media tunable through the coerced `loadVideoRoomConfig(config)` accessor, never `process.env` or raw `config.get` in services.

## Canonical interfaces (defined in Tasks 1–7; referenced everywhere)

```ts
// Task 1 — enums/index.ts (append) + constants/video-room-stream-lifecycle.ts
export enum MediaStreamState {
  CREATED='CREATED', CONNECTING='CONNECTING', LIVE='LIVE', PAUSED='PAUSED',
  STOPPED='STOPPED', FAILED='FAILED', RECOVERING='RECOVERING', ENDED='ENDED',
}
export enum MediaStreamKind { CAMERA='CAMERA', SCREEN='SCREEN' }
export enum AudioOutput { SPEAKER='SPEAKER', EARPIECE='EARPIECE', BLUETOOTH='BLUETOOTH', WIRED='WIRED' }
export enum VideoQualityProfile { LOW='LOW', MEDIUM='MEDIUM', HIGH='HIGH', HD='HD', FULL_HD='FULL_HD', ADAPTIVE='ADAPTIVE' }
export enum CameraFacing { FRONT='FRONT', REAR='REAR' }
canStreamTransition(from: MediaStreamState, to: MediaStreamState): boolean
assertStreamTransition(from: MediaStreamState, to: MediaStreamState): void  // throws VIDEO_ROOM_STREAM_INVALID_STATE (409)

// Task 2 — media/media-quality.ts
export interface QualitySpec { bitrateKbps: number; width: number; height: number; fps: number }
export const PROFILE_BITRATE: Record<Exclude<VideoQualityProfile, 'ADAPTIVE'>, QualitySpec>
export interface NetworkSample { rttMs?: number; packetLossPct?: number; bitrateKbps?: number }
selectQualityProfile(sample: NetworkSample): VideoQualityProfile   // maps a sample → a concrete (non-ADAPTIVE) profile
resolveBitrate(profile: VideoQualityProfile, maxBitrateKbps: number): number

// Task 3 — media/beauty-settings.ts
export interface BeautySettings { enabled: boolean; level: number; smoothSkin: number; brightness: number; sharpen: number; faceEnhance: number }
export const DEFAULT_BEAUTY: BeautySettings
clampBeauty(input: Partial<BeautySettings> | undefined, base?: BeautySettings): BeautySettings   // bounds every field 0..100

// Task 4 — media/media-stage.ts
export interface MediaParticipant {
  userId: string; seatIndex: number | null; role: ConnectionType; connection: ConnectionStatus;
  streamId: string | null; streamKind: MediaStreamKind; streamState: MediaStreamState;
  camera: { on: boolean; facing: CameraFacing };
  mic: { on: boolean; selfMuted: boolean; adminMuted: boolean };
  audioOutput: AudioOutput; quality: VideoQualityProfile; beauty: BeautySettings;
  subscriptions: string[]; joinedAt: string; lastHeartbeatAt: string;
}
export interface MediaStageSnapshot {
  roomId: string; version: number; updatedAt: string;   // ISO
  mediaRoomId: string; provider: MediaProviderKind; participants: MediaParticipant[];
}
export type MediaStageMutation = Partial<Pick<MediaStageSnapshot, 'participants' | 'mediaRoomId'>>;
export interface MediaStageView { roomId: string; version: number; updatedAt: string; mediaRoomId: string; provider: MediaProviderKind; participants: MediaParticipant[] }
toMediaStageView(s: MediaStageSnapshot): MediaStageView
newParticipant(input: { userId: string; seatIndex: number | null; role: ConnectionType; nowIso: string; defaultBeauty: BeautySettings }): MediaParticipant
upsertParticipant(list: MediaParticipant[], userId: string, patch: (p: MediaParticipant) => MediaParticipant): MediaParticipant[]

// Task 7 — VideoRoomMediaStateService (pure Redis primitive; NON-locking, caller holds media lock)
getSnapshot(roomId: string): Promise<MediaStageSnapshot | null>
rebuild(roomId: string): Promise<MediaStageSnapshot>          // from room.zegoRoomId + listActive sessions, version=1
commit(roomId: string, base: MediaStageSnapshot, patch: MediaStageMutation): Promise<MediaStageSnapshot>  // version++, cache.set
clear(roomId: string): Promise<void>

// Task 12 — VideoRoomMediaService
mutateStage(roomId: string, fn: (base: MediaStageSnapshot) => Promise<MediaStageSnapshot>): Promise<MediaStageView>  // locked pipeline
```

---

### Task 1: Media enums + stream state machine

**Files:**
- Modify: `src/modules/video-rooms/enums/index.ts` (append the 5 new enums)
- Create: `src/modules/video-rooms/constants/video-room-stream-lifecycle.ts`
- Test: `src/modules/video-rooms/constants/video-room-stream-lifecycle.spec.ts`

**Interfaces:**
- Produces: `MediaStreamState`, `MediaStreamKind`, `AudioOutput`, `VideoQualityProfile`, `CameraFacing` enums; `canStreamTransition(from,to)`, `assertStreamTransition(from,to)`.
- Consumes: `ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE` (added in Task 5 — for the spec, stub the code string; Task 5 makes it real). To avoid ordering coupling, `assertStreamTransition` imports `ERROR_CODES` and `BusinessException` from `src/common/exceptions`; the code constant is added in Task 5 and this file references it by name.

- [ ] **Step 1: Write the failing test**

```ts
// video-room-stream-lifecycle.spec.ts
import { MediaStreamState } from '../enums';
import { canStreamTransition, assertStreamTransition, STREAM_TRANSITIONS } from './video-room-stream-lifecycle';

describe('stream lifecycle', () => {
  it('allows legal edges', () => {
    expect(canStreamTransition(MediaStreamState.CREATED, MediaStreamState.CONNECTING)).toBe(true);
    expect(canStreamTransition(MediaStreamState.CONNECTING, MediaStreamState.LIVE)).toBe(true);
    expect(canStreamTransition(MediaStreamState.LIVE, MediaStreamState.RECOVERING)).toBe(true);
    expect(canStreamTransition(MediaStreamState.RECOVERING, MediaStreamState.LIVE)).toBe(true);
    expect(canStreamTransition(MediaStreamState.PAUSED, MediaStreamState.LIVE)).toBe(true);
    expect(canStreamTransition(MediaStreamState.STOPPED, MediaStreamState.CREATED)).toBe(true);
  });
  it('rejects illegal edges', () => {
    expect(canStreamTransition(MediaStreamState.CREATED, MediaStreamState.LIVE)).toBe(false);
    expect(canStreamTransition(MediaStreamState.ENDED, MediaStreamState.LIVE)).toBe(false);
    expect(canStreamTransition(MediaStreamState.STOPPED, MediaStreamState.PAUSED)).toBe(false);
  });
  it('assertStreamTransition throws on an illegal edge', () => {
    expect(() => assertStreamTransition(MediaStreamState.ENDED, MediaStreamState.LIVE)).toThrow();
  });
  it('every state is a key in the transition table', () => {
    for (const s of Object.values(MediaStreamState)) expect(STREAM_TRANSITIONS[s]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`Cannot find module './video-room-stream-lifecycle'`).

Run: `npx jest src/modules/video-rooms/constants/video-room-stream-lifecycle.spec.ts`

- [ ] **Step 3: Implement**

Append to `enums/index.ts`:

```ts
/** The media stream FSM (VR-5). Ephemeral — Redis + socket only, never Postgres. */
export enum MediaStreamState {
  CREATED = 'CREATED',
  CONNECTING = 'CONNECTING',
  LIVE = 'LIVE',
  PAUSED = 'PAUSED',
  STOPPED = 'STOPPED',
  FAILED = 'FAILED',
  RECOVERING = 'RECOVERING',
  ENDED = 'ENDED',
}
/** What a publish stream carries. SCREEN is shape-ready (VR-5 implements CAMERA only). */
export enum MediaStreamKind { CAMERA = 'CAMERA', SCREEN = 'SCREEN' }
/** Client-detected audio output route (synchronized + broadcast server-side). */
export enum AudioOutput { SPEAKER = 'SPEAKER', EARPIECE = 'EARPIECE', BLUETOOTH = 'BLUETOOTH', WIRED = 'WIRED' }
/** Configurable video quality tiers; ADAPTIVE defers to the network-driven selector. */
export enum VideoQualityProfile { LOW = 'LOW', MEDIUM = 'MEDIUM', HIGH = 'HIGH', HD = 'HD', FULL_HD = 'FULL_HD', ADAPTIVE = 'ADAPTIVE' }
/** Which camera a publisher is using. */
export enum CameraFacing { FRONT = 'FRONT', REAR = 'REAR' }
```

Create `constants/video-room-stream-lifecycle.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { MediaStreamState } from '../enums';

/**
 * The single source of truth for legal media-stream transitions (VR-5). Mirrors
 * the seat/lifecycle transition tables. Every mutation that changes a
 * participant's streamState routes through assertStreamTransition first.
 */
export const STREAM_TRANSITIONS: Record<MediaStreamState, readonly MediaStreamState[]> = {
  [MediaStreamState.CREATED]: [MediaStreamState.CONNECTING, MediaStreamState.ENDED],
  [MediaStreamState.CONNECTING]: [MediaStreamState.LIVE, MediaStreamState.FAILED, MediaStreamState.ENDED],
  [MediaStreamState.LIVE]: [
    MediaStreamState.PAUSED, MediaStreamState.STOPPED, MediaStreamState.FAILED, MediaStreamState.RECOVERING,
  ],
  [MediaStreamState.PAUSED]: [MediaStreamState.LIVE, MediaStreamState.STOPPED, MediaStreamState.ENDED],
  [MediaStreamState.STOPPED]: [MediaStreamState.CREATED, MediaStreamState.ENDED],
  [MediaStreamState.FAILED]: [MediaStreamState.RECOVERING, MediaStreamState.ENDED],
  [MediaStreamState.RECOVERING]: [MediaStreamState.LIVE, MediaStreamState.FAILED, MediaStreamState.ENDED],
  [MediaStreamState.ENDED]: [],
};

/** True when `from → to` is a legal stream transition (self-edge always allowed — idempotent). */
export function canStreamTransition(from: MediaStreamState, to: MediaStreamState): boolean {
  if (from === to) return true;
  return STREAM_TRANSITIONS[from].includes(to);
}

/** Assert a legal stream transition; else 409. */
export function assertStreamTransition(from: MediaStreamState, to: MediaStreamState): void {
  if (!canStreamTransition(from, to)) {
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE,
      `Illegal stream transition ${from} → ${to}.`,
      HttpStatus.CONFLICT,
    );
  }
}
```

> Note: this file imports `ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE`, added in Task 5. If executing strictly in order, add just that one code to `error-codes.ts` now (or run Task 5's error-code step first). The spec's `assertStreamTransition` test only needs the code to exist as a string.

- [ ] **Step 4: Run — verify PASS.** Run: `npx jest src/modules/video-rooms/constants/video-room-stream-lifecycle.spec.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video-rooms): VR-5 media enums + stream state machine"`

---

### Task 2: Video quality profiles + adaptive selector (`media/media-quality.ts`)

**Files:**
- Create: `src/modules/video-rooms/media/media-quality.ts`
- Test: `src/modules/video-rooms/media/media-quality.spec.ts`

**Interfaces:**
- Consumes: `VideoQualityProfile` (Task 1).
- Produces: `QualitySpec`, `PROFILE_BITRATE`, `NetworkSample`, `selectQualityProfile(sample)`, `resolveBitrate(profile, maxBitrateKbps)`.

- [ ] **Step 1: Write the failing test**

```ts
// media-quality.spec.ts
import { VideoQualityProfile } from '../enums';
import { PROFILE_BITRATE, selectQualityProfile, resolveBitrate } from './media-quality';

describe('media-quality', () => {
  it('has a spec for every concrete profile (not ADAPTIVE)', () => {
    for (const p of Object.values(VideoQualityProfile)) {
      if (p === VideoQualityProfile.ADAPTIVE) continue;
      expect(PROFILE_BITRATE[p].bitrateKbps).toBeGreaterThan(0);
    }
  });
  it('selects a high profile on a clean network', () => {
    expect(selectQualityProfile({ rttMs: 20, packetLossPct: 0 })).toBe(VideoQualityProfile.FULL_HD);
  });
  it('degrades under loss/latency', () => {
    expect(selectQualityProfile({ rttMs: 400, packetLossPct: 12 })).toBe(VideoQualityProfile.LOW);
    expect(selectQualityProfile({ rttMs: 150, packetLossPct: 3 })).toBe(VideoQualityProfile.HIGH);
  });
  it('never returns ADAPTIVE from the selector', () => {
    expect(selectQualityProfile({})).not.toBe(VideoQualityProfile.ADAPTIVE);
  });
  it('resolveBitrate clamps to the configured max', () => {
    expect(resolveBitrate(VideoQualityProfile.FULL_HD, 2500)).toBe(2500);
    expect(resolveBitrate(VideoQualityProfile.LOW, 2500)).toBe(PROFILE_BITRATE.LOW.bitrateKbps);
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/media/media-quality.spec.ts`

- [ ] **Step 3: Implement**

```ts
// media/media-quality.ts
import { VideoQualityProfile } from '../enums';

export interface QualitySpec { bitrateKbps: number; width: number; height: number; fps: number }
export interface NetworkSample { rttMs?: number; packetLossPct?: number; bitrateKbps?: number }

type ConcreteProfile = Exclude<VideoQualityProfile, VideoQualityProfile.ADAPTIVE>;

/** Bitrate/resolution/fps per concrete profile. Bitrates are ceilings, clamped by config maxBitrateKbps. */
export const PROFILE_BITRATE: Record<ConcreteProfile, QualitySpec> = {
  [VideoQualityProfile.LOW]: { bitrateKbps: 300, width: 320, height: 240, fps: 15 },
  [VideoQualityProfile.MEDIUM]: { bitrateKbps: 600, width: 640, height: 360, fps: 20 },
  [VideoQualityProfile.HIGH]: { bitrateKbps: 1000, width: 848, height: 480, fps: 24 },
  [VideoQualityProfile.HD]: { bitrateKbps: 1800, width: 1280, height: 720, fps: 30 },
  [VideoQualityProfile.FULL_HD]: { bitrateKbps: 3000, width: 1920, height: 1080, fps: 30 },
};

/**
 * Adaptive quality selector (VR-5). Maps a live network sample to a concrete
 * profile. Higher RTT / packet loss ⇒ a lower tier. Missing fields are treated
 * as pristine (favor quality) — the caller only invokes this when ADAPTIVE is on.
 */
export function selectQualityProfile(sample: NetworkSample): ConcreteProfile {
  const rtt = sample.rttMs ?? 0;
  const loss = sample.packetLossPct ?? 0;
  if (loss >= 10 || rtt >= 350) return VideoQualityProfile.LOW;
  if (loss >= 5 || rtt >= 250) return VideoQualityProfile.MEDIUM;
  if (loss >= 2 || rtt >= 120) return VideoQualityProfile.HIGH;
  if (loss >= 0.5 || rtt >= 60) return VideoQualityProfile.HD;
  return VideoQualityProfile.FULL_HD;
}

/** The effective bitrate for a profile, clamped to the room's configured ceiling. */
export function resolveBitrate(profile: VideoQualityProfile, maxBitrateKbps: number): number {
  const concrete = profile === VideoQualityProfile.ADAPTIVE ? VideoQualityProfile.HD : profile;
  return Math.min(PROFILE_BITRATE[concrete as ConcreteProfile].bitrateKbps, maxBitrateKbps);
}
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/media/media-quality.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 video quality profiles + adaptive selector"`

---

### Task 3: Beauty settings value object (`media/beauty-settings.ts`)

**Files:**
- Create: `src/modules/video-rooms/media/beauty-settings.ts`
- Test: `src/modules/video-rooms/media/beauty-settings.spec.ts`

**Interfaces:**
- Produces: `BeautySettings`, `DEFAULT_BEAUTY`, `clampBeauty(input, base?)`.

- [ ] **Step 1: Write the failing test**

```ts
// beauty-settings.spec.ts
import { DEFAULT_BEAUTY, clampBeauty } from './beauty-settings';

describe('beauty-settings', () => {
  it('DEFAULT_BEAUTY is disabled with zeroed levels', () => {
    expect(DEFAULT_BEAUTY.enabled).toBe(false);
    expect(DEFAULT_BEAUTY.level).toBe(0);
  });
  it('clamps every numeric field to 0..100', () => {
    const r = clampBeauty({ enabled: true, level: 150, smoothSkin: -5, brightness: 42, sharpen: 999, faceEnhance: 0 });
    expect(r.enabled).toBe(true);
    expect(r.level).toBe(100);
    expect(r.smoothSkin).toBe(0);
    expect(r.brightness).toBe(42);
    expect(r.sharpen).toBe(100);
  });
  it('merges onto a base for partial updates', () => {
    const base = clampBeauty({ enabled: true, level: 30, smoothSkin: 30, brightness: 30, sharpen: 30, faceEnhance: 30 });
    const r = clampBeauty({ level: 60 }, base);
    expect(r.level).toBe(60);
    expect(r.smoothSkin).toBe(30); // preserved from base
  });
  it('undefined input returns the base (or default) unchanged', () => {
    expect(clampBeauty(undefined)).toEqual(DEFAULT_BEAUTY);
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/media/beauty-settings.spec.ts`

- [ ] **Step 3: Implement**

```ts
// media/beauty-settings.ts

/** Per-user beauty-filter settings. Ephemeral (live preference) — Redis stage only, no DB column. */
export interface BeautySettings {
  enabled: boolean;
  level: number;        // overall intensity 0..100
  smoothSkin: number;   // 0..100
  brightness: number;   // 0..100
  sharpen: number;      // 0..100
  faceEnhance: number;  // 0..100
}

export const DEFAULT_BEAUTY: BeautySettings = {
  enabled: false, level: 0, smoothSkin: 0, brightness: 0, sharpen: 0, faceEnhance: 0,
};

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Validate + clamp a (partial) beauty update onto a base. Every numeric field is
 * bounded to 0..100; unspecified fields keep the base value. Returns a fresh object.
 */
export function clampBeauty(input: Partial<BeautySettings> | undefined, base: BeautySettings = DEFAULT_BEAUTY): BeautySettings {
  if (!input) return { ...base };
  return {
    enabled: input.enabled ?? base.enabled,
    level: input.level === undefined ? base.level : clamp(input.level),
    smoothSkin: input.smoothSkin === undefined ? base.smoothSkin : clamp(input.smoothSkin),
    brightness: input.brightness === undefined ? base.brightness : clamp(input.brightness),
    sharpen: input.sharpen === undefined ? base.sharpen : clamp(input.sharpen),
    faceEnhance: input.faceEnhance === undefined ? base.faceEnhance : clamp(input.faceEnhance),
  };
}
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/media/beauty-settings.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 beauty settings value object + clamp"`

---

### Task 4: Media-stage value objects + helpers (`media/media-stage.ts`)

**Files:**
- Create: `src/modules/video-rooms/media/media-stage.ts`
- Test: `src/modules/video-rooms/media/media-stage.spec.ts`

**Interfaces:**
- Consumes: `ConnectionType`, `ConnectionStatus`, `MediaProviderKind`, `MediaStreamState`, `MediaStreamKind`, `AudioOutput`, `VideoQualityProfile`, `CameraFacing` (Task 1 / VR-0 enums); `BeautySettings`, `DEFAULT_BEAUTY` (Task 3).
- Produces: `MediaParticipant`, `MediaStageSnapshot`, `MediaStageMutation`, `MediaStageView`, `toMediaStageView(s)`, `newParticipant(input)`, `upsertParticipant(list, userId, patch)`.

- [ ] **Step 1: Write the failing test**

```ts
// media-stage.spec.ts
import { ConnectionType, ConnectionStatus, MediaStreamState, MediaStreamKind } from '../enums';
import { newParticipant, upsertParticipant, toMediaStageView } from './media-stage';
import { DEFAULT_BEAUTY } from './beauty-settings';

const now = '2026-07-20T00:00:00.000Z';

describe('media-stage', () => {
  it('newParticipant seeds sensible defaults', () => {
    const p = newParticipant({ userId: 'u1', seatIndex: 2, role: ConnectionType.PUBLISHER, nowIso: now, defaultBeauty: DEFAULT_BEAUTY });
    expect(p.streamState).toBe(MediaStreamState.CREATED);
    expect(p.connection).toBe(ConnectionStatus.CONNECTING);
    expect(p.streamKind).toBe(MediaStreamKind.CAMERA);
    expect(p.camera.on).toBe(false);
    expect(p.mic.selfMuted).toBe(false);
    expect(p.subscriptions).toEqual([]);
  });
  it('upsertParticipant patches an existing entry immutably', () => {
    const p = newParticipant({ userId: 'u1', seatIndex: 0, role: ConnectionType.PUBLISHER, nowIso: now, defaultBeauty: DEFAULT_BEAUTY });
    const list = [p];
    const next = upsertParticipant(list, 'u1', (x) => ({ ...x, camera: { ...x.camera, on: true } }));
    expect(next[0].camera.on).toBe(true);
    expect(list[0].camera.on).toBe(false); // original untouched
  });
  it('upsertParticipant is a no-op for an unknown user', () => {
    const list = [newParticipant({ userId: 'u1', seatIndex: 0, role: ConnectionType.PUBLISHER, nowIso: now, defaultBeauty: DEFAULT_BEAUTY })];
    expect(upsertParticipant(list, 'ghost', (x) => x)).toBe(list);
  });
  it('toMediaStageView passes through the snapshot fields', () => {
    const v = toMediaStageView({ roomId: 'r', version: 3, updatedAt: now, mediaRoomId: 'm', provider: 'ZEGO' as never, participants: [] });
    expect(v.version).toBe(3);
    expect(v.mediaRoomId).toBe('m');
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/media/media-stage.spec.ts`

- [ ] **Step 3: Implement**

```ts
// media/media-stage.ts
import {
  AudioOutput, CameraFacing, ConnectionStatus, ConnectionType,
  MediaProviderKind, MediaStreamKind, MediaStreamState, VideoQualityProfile,
} from '../enums';
import type { BeautySettings } from './beauty-settings';

export interface MediaParticipant {
  userId: string;
  seatIndex: number | null;
  role: ConnectionType;
  connection: ConnectionStatus;
  streamId: string | null;
  streamKind: MediaStreamKind;
  streamState: MediaStreamState;
  camera: { on: boolean; facing: CameraFacing };
  mic: { on: boolean; selfMuted: boolean; adminMuted: boolean };
  audioOutput: AudioOutput;
  quality: VideoQualityProfile;
  beauty: BeautySettings;
  subscriptions: string[];
  joinedAt: string;
  lastHeartbeatAt: string;
}

export interface MediaStageSnapshot {
  roomId: string;
  version: number;
  updatedAt: string;
  mediaRoomId: string;
  provider: MediaProviderKind;
  participants: MediaParticipant[];
}

export type MediaStageMutation = Partial<Pick<MediaStageSnapshot, 'participants' | 'mediaRoomId'>>;
export type MediaStageView = MediaStageSnapshot;

export function toMediaStageView(s: MediaStageSnapshot): MediaStageView {
  return { ...s, participants: s.participants.map((p) => ({ ...p })) };
}

/** A fresh participant on join — audience default (SUBSCRIBER) unless seated. */
export function newParticipant(input: {
  userId: string; seatIndex: number | null; role: ConnectionType; nowIso: string; defaultBeauty: BeautySettings;
}): MediaParticipant {
  return {
    userId: input.userId,
    seatIndex: input.seatIndex,
    role: input.role,
    connection: ConnectionStatus.CONNECTING,
    streamId: null,
    streamKind: MediaStreamKind.CAMERA,
    streamState: MediaStreamState.CREATED,
    camera: { on: false, facing: CameraFacing.FRONT },
    mic: { on: false, selfMuted: false, adminMuted: false },
    audioOutput: AudioOutput.SPEAKER,
    quality: VideoQualityProfile.ADAPTIVE,
    beauty: { ...input.defaultBeauty },
    subscriptions: [],
    joinedAt: input.nowIso,
    lastHeartbeatAt: input.nowIso,
  };
}

/** Immutably patch the participant with `userId`; returns the same array reference if absent. */
export function upsertParticipant(
  list: MediaParticipant[], userId: string, patch: (p: MediaParticipant) => MediaParticipant,
): MediaParticipant[] {
  const idx = list.findIndex((p) => p.userId === userId);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = patch(next[idx]);
  return next;
}
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/media/media-stage.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media-stage value objects + helpers"`

---

### Task 5: Plumbing — error codes, Redis keys, socket event names, config

**Files:**
- Modify: `src/common/exceptions/error-codes.ts` (add a `// ---- Video Room media (VR-5) ----` block)
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (media Redis key builders + media socket event names + `VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY`)
- Modify: `src/modules/video-rooms/config/video-room.config.ts` (add media fields to `VideoRoomConfig`, `RawVideoRoomConfig`, `loadVideoRoomConfig`)
- Modify: `src/config/configuration.ts:272` (`videoRoomConfig` namespace — add media env reads)
- Modify: `src/config/env.validation.ts` (add `VIDEO_ROOM_MEDIA_*` zod fields)
- Modify: `.env.example` (document the new vars)
- Test: `src/modules/video-rooms/constants/video-room-media.constants.spec.ts`

**Interfaces:**
- Produces: `ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE`, `VIDEO_ROOM_DUPLICATE_STREAM`, `VIDEO_ROOM_MEDIA_SESSION_INVALID`, `VIDEO_ROOM_STREAM_PUBLISH_FAILED`, `VIDEO_ROOM_STREAM_SUBSCRIBE_FAILED`, `VIDEO_ROOM_CAMERA_ERROR`, `VIDEO_ROOM_MICROPHONE_ERROR`, `VIDEO_ROOM_MEDIA_SEAT_REQUIRED`, `VIDEO_ROOM_MEDIA_RECOVERY_FAILED`, `VIDEO_ROOM_SUBSCRIPTION_LIMIT`; key builders `videoRoomMediaStateKey`, `videoRoomMediaLockKey`, `videoRoomMediaHeartbeatKey`, `videoRoomMediaRecoveryKey`; `VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY`; new `VIDEO_ROOM_SOCKET_EVENTS.*` media names; `VideoRoomConfig` media fields (`mediaHeartbeatTtlSeconds`, `mediaMonitorIntervalSeconds`, `mediaReconnectGraceSeconds`, `mediaRecoveryTokenTtlSeconds`, `maxSubscriptionsPerUser`, `qualitySampleEvery`, `defaultBeautyLevel`).

- [ ] **Step 1: Write the failing test**

```ts
// video-room-media.constants.spec.ts
import {
  videoRoomMediaStateKey, videoRoomMediaLockKey, videoRoomMediaHeartbeatKey,
  videoRoomMediaRecoveryKey, VIDEO_ROOM_SOCKET_EVENTS, VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY,
} from './video-room.constants';

describe('VR-5 media constants', () => {
  it('hash-tags the room id for cluster safety', () => {
    expect(videoRoomMediaStateKey('r1')).toBe('video-room:{r1}:media');
    expect(videoRoomMediaLockKey('r1')).toBe('video-room:media:{r1}');
    expect(videoRoomMediaHeartbeatKey('r1', 'u1')).toBe('video-room:{r1}:media:hb:u1');
    expect(videoRoomMediaRecoveryKey('r1', 'u1')).toBe('video-room:{r1}:media:recovery:u1');
    expect(VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY).toBe('video-room:media:monitor');
  });
  it('exposes media client socket events', () => {
    expect(VIDEO_ROOM_SOCKET_EVENTS.MEDIA_JOINED).toBe('video_room.media_joined');
    expect(VIDEO_ROOM_SOCKET_EVENTS.CAMERA_ON).toBe('video_room.camera_on');
    expect(VIDEO_ROOM_SOCKET_EVENTS.STREAM_PUBLISHED).toBe('video_room.stream_published');
    expect(VIDEO_ROOM_SOCKET_EVENTS.MEDIA_STATE_SYNC).toBe('video_room.media_state_sync');
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/constants/video-room-media.constants.spec.ts`

- [ ] **Step 3: Implement**

In `error-codes.ts`, after the VR-3 block (around line 154), add:

```ts
  // ---- Video Room media (VR-5) ----
  VIDEO_ROOM_STREAM_INVALID_STATE: 'VIDEO_ROOM_STREAM_INVALID_STATE',
  VIDEO_ROOM_DUPLICATE_STREAM: 'VIDEO_ROOM_DUPLICATE_STREAM',
  VIDEO_ROOM_MEDIA_SESSION_INVALID: 'VIDEO_ROOM_MEDIA_SESSION_INVALID',
  VIDEO_ROOM_STREAM_PUBLISH_FAILED: 'VIDEO_ROOM_STREAM_PUBLISH_FAILED',
  VIDEO_ROOM_STREAM_SUBSCRIBE_FAILED: 'VIDEO_ROOM_STREAM_SUBSCRIBE_FAILED',
  VIDEO_ROOM_CAMERA_ERROR: 'VIDEO_ROOM_CAMERA_ERROR',
  VIDEO_ROOM_MICROPHONE_ERROR: 'VIDEO_ROOM_MICROPHONE_ERROR',
  VIDEO_ROOM_MEDIA_SEAT_REQUIRED: 'VIDEO_ROOM_MEDIA_SEAT_REQUIRED',
  VIDEO_ROOM_MEDIA_RECOVERY_FAILED: 'VIDEO_ROOM_MEDIA_RECOVERY_FAILED',
  VIDEO_ROOM_SUBSCRIPTION_LIMIT: 'VIDEO_ROOM_SUBSCRIPTION_LIMIT',
```

In `video-room.constants.ts`, add media socket events to the `VIDEO_ROOM_SOCKET_EVENTS` object (after the VR-4 block):

```ts
  // ---- VR-5 media engine (client-facing) ----
  MEDIA_JOINED: 'video_room.media_joined',
  MEDIA_LEFT: 'video_room.media_left',
  CAMERA_ON: 'video_room.camera_on',
  CAMERA_OFF: 'video_room.camera_off',
  MIC_ON: 'video_room.mic_on',
  MIC_OFF: 'video_room.mic_off',
  STREAM_PUBLISHED: 'video_room.stream_published',
  STREAM_STOPPED: 'video_room.stream_stopped',
  STREAM_PAUSED: 'video_room.stream_paused',
  STREAM_RESUMED: 'video_room.stream_resumed',
  MEDIA_SUBSCRIBED: 'video_room.subscribed',
  MEDIA_UNSUBSCRIBED: 'video_room.unsubscribed',
  BEAUTY_CHANGED: 'video_room.beauty_changed',
  QUALITY_CHANGED: 'video_room.quality_changed',
  AUDIO_OUTPUT_CHANGED: 'video_room.audio_output_changed',
  STREAM_STATE_CHANGED: 'video_room.stream_state_changed',
  MEDIA_RECOVERED: 'video_room.media_recovered',
  STREAM_FAILED: 'video_room.stream_failed',
  STREAM_RECOVERED: 'video_room.stream_recovered',
  MEDIA_STATE_SYNC: 'video_room.media_state_sync',
```

And the media Redis key builders + monitor lock (after the VR-4 key block):

```ts
// ---- VR-5 media engine (single-key ops → Cluster-safe; hash-tag the room id) ----

/** Authoritative versioned media snapshot (JSON) — VideoRoomMediaStateService. */
export function videoRoomMediaStateKey(roomId: string): string {
  return `video-room:{${roomId}}:media`;
}
/** Per-room lock serialising all media mutations (join/publish/camera/mic/…). */
export function videoRoomMediaLockKey(roomId: string): string {
  return `video-room:media:{${roomId}}`;
}
/** Per-publisher media liveness marker (TTL); absence ⇒ stale ⇒ monitor recovery. */
export function videoRoomMediaHeartbeatKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:media:hb:${userId}`;
}
/** Recovery grant (token + TTL) during the reconnect grace window. */
export function videoRoomMediaRecoveryKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:media:recovery:${userId}`;
}
/** Fleet-wide lock so exactly one instance runs the media-expiry sweep. */
export const VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY = 'video-room:media:monitor';
```

In `config/video-room.config.ts` add these fields to **all three** of `VideoRoomConfig`, `RawVideoRoomConfig`, and the returned object in `loadVideoRoomConfig` (numeric fields `Number(raw.x)`):

```ts
// VideoRoomConfig (typed):
  mediaHeartbeatTtlSeconds: number;
  mediaMonitorIntervalSeconds: number;
  mediaReconnectGraceSeconds: number;
  mediaRecoveryTokenTtlSeconds: number;
  maxSubscriptionsPerUser: number;
  qualitySampleEvery: number;
  defaultBeautyLevel: number;
// loadVideoRoomConfig() return:
  mediaHeartbeatTtlSeconds: Number(raw.mediaHeartbeatTtlSeconds),
  mediaMonitorIntervalSeconds: Number(raw.mediaMonitorIntervalSeconds),
  mediaReconnectGraceSeconds: Number(raw.mediaReconnectGraceSeconds),
  mediaRecoveryTokenTtlSeconds: Number(raw.mediaRecoveryTokenTtlSeconds),
  maxSubscriptionsPerUser: Number(raw.maxSubscriptionsPerUser),
  qualitySampleEvery: Number(raw.qualitySampleEvery),
  defaultBeautyLevel: Number(raw.defaultBeautyLevel),
```

In `configuration.ts` `videoRoomConfig = registerAs('videoRoom', () => ({ ... }))` add:

```ts
    mediaHeartbeatTtlSeconds: env().VIDEO_ROOM_MEDIA_HEARTBEAT_TTL_SECONDS,
    mediaMonitorIntervalSeconds: env().VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS,
    mediaReconnectGraceSeconds: env().VIDEO_ROOM_MEDIA_RECONNECT_GRACE_SECONDS,
    mediaRecoveryTokenTtlSeconds: env().VIDEO_ROOM_MEDIA_RECOVERY_TOKEN_TTL_SECONDS,
    maxSubscriptionsPerUser: env().VIDEO_ROOM_MAX_SUBSCRIPTIONS_PER_USER,
    qualitySampleEvery: env().VIDEO_ROOM_MEDIA_QUALITY_SAMPLE_EVERY,
    defaultBeautyLevel: env().VIDEO_ROOM_DEFAULT_BEAUTY_LEVEL,
```

In `env.validation.ts` after the VR block (~line 231) add:

```ts
  VIDEO_ROOM_MEDIA_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  VIDEO_ROOM_MEDIA_RECONNECT_GRACE_SECONDS: z.coerce.number().int().positive().default(60),
  VIDEO_ROOM_MEDIA_RECOVERY_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  VIDEO_ROOM_MAX_SUBSCRIPTIONS_PER_USER: z.coerce.number().int().positive().default(20),
  VIDEO_ROOM_MEDIA_QUALITY_SAMPLE_EVERY: z.coerce.number().int().positive().default(6),
  VIDEO_ROOM_DEFAULT_BEAUTY_LEVEL: z.coerce.number().int().min(0).max(100).default(0),
```

In `.env.example` add the 7 vars with their defaults under a `# Video Room media (VR-5)` comment.

- [ ] **Step 4: Run — PASS** (also `npx tsc --noEmit` to confirm config typing). Run: `npx jest src/modules/video-rooms/constants/video-room-media.constants.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media error codes, redis keys, socket events, config"`

---

### Task 6: Repository — `setZegoRoomId` + `setStreamingStatus`

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-rooms.repository.ts` (append two methods after `updateStatus`)
- Test: `src/modules/video-rooms/repositories/video-rooms.repository.spec.ts` (extend existing)

**Interfaces:**
- Produces: `VideoRoomsRepository.setZegoRoomId(id: string, zegoRoomId: string, actorId: string): Promise<VideoRoom>`; `VideoRoomsRepository.setStreamingStatus(id: string, streamingStatus: VideoRoomStreamingStatus, actorId: string): Promise<VideoRoom>`.
- Consumes: `PrismaService`, `auditUpdate` (already imported in the file).

- [ ] **Step 1: Write the failing test** (extend the existing spec; the file already mocks `PrismaService` with a `videoRoom.update` jest fn):

```ts
it('setZegoRoomId writes the handle + audit', async () => {
  prisma.videoRoom.update.mockResolvedValue({ id: 'r1' } as never);
  await repo.setZegoRoomId('r1', 'zego-123', 'actor');
  expect(prisma.videoRoom.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ zegoRoomId: 'zego-123' }) }),
  );
});
it('setStreamingStatus writes the projection', async () => {
  prisma.videoRoom.update.mockResolvedValue({ id: 'r1' } as never);
  await repo.setStreamingStatus('r1', 'PUBLISHING' as never, 'actor');
  expect(prisma.videoRoom.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ streamingStatus: 'PUBLISHING' }) }),
  );
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/repositories/video-rooms.repository.spec.ts`

- [ ] **Step 3: Implement** (append after `updateStatus`, mirroring it; import `VideoRoomStreamingStatus` from `@prisma/client`):

```ts
  /** Lazily assign the room's ZEGO room handle on first media use (distinct from app id). */
  async setZegoRoomId(id: string, zegoRoomId: string, actorId: string): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: { zegoRoomId, ...auditUpdate(actorId) },
    });
  }

  /** Project the room-level streaming status (IDLE/PUBLISHING/PAUSED) from the media stage. */
  async setStreamingStatus(
    id: string, streamingStatus: VideoRoomStreamingStatus, actorId: string,
  ): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: { streamingStatus, ...auditUpdate(actorId) },
    });
  }
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/repositories/video-rooms.repository.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 room zego-handle + streaming-status setters"`

---

### Task 7: `VideoRoomMediaStateService` (Redis snapshot primitive)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-media-state.service.ts`
- Test: `src/modules/video-rooms/services/video-room-media-state.service.spec.ts`

**Interfaces:**
- Consumes: `CacheService`, `VideoRoomMediaSessionRepository`, `VideoRoomsRepository`, `@Inject(MEDIA_PROVIDER) IMediaProvider`, `ConfigService`; `videoRoomMediaStateKey`, `loadVideoRoomConfig`; `MediaStageSnapshot`/`MediaStageMutation`/`newParticipant` (Task 4); `ConnectionType`, `ConnectionStatus`, `CameraFacing`, `VideoQualityProfile`, `AudioOutput`, `MediaStreamState`, `MediaStreamKind`; `DEFAULT_BEAUTY`.
- Produces (non-locking; caller holds the media lock): `getSnapshot(roomId)`, `rebuild(roomId)`, `commit(roomId, base, patch)`, `clear(roomId)`.

- [ ] **Step 1: Write the failing test** (mock `CacheService`, the two repos, provider, `ConfigService`):

```ts
// video-room-media-state.service.spec.ts
import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { MediaProviderKind, ConnectionType } from '../enums';

const cfg = { get: () => ({ stateTtlSeconds: 300, defaultBeautyLevel: 0 }) };
const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
const sessions = { listActive: jest.fn() };
const rooms = { findById: jest.fn() };
const provider = { kind: MediaProviderKind.ZEGO };

const make = () => new VideoRoomMediaStateService(cache as never, sessions as never, rooms as never, provider as never, cfg as never);

describe('VideoRoomMediaStateService', () => {
  beforeEach(() => jest.clearAllMocks());
  it('getSnapshot returns the cached snapshot', async () => {
    cache.get.mockResolvedValue({ roomId: 'r', version: 2, participants: [] });
    expect((await make().getSnapshot('r'))!.version).toBe(2);
  });
  it('rebuild seeds participants from active sessions, version=1', async () => {
    rooms.findById.mockResolvedValue({ id: 'r', zegoRoomId: 'zego-1' });
    sessions.listActive.mockResolvedValue([{ userId: 'u1', role: 'PUBLISHER', selfMutedAudio: false, selfMutedVideo: true, cameraFacing: 'FRONT' }]);
    const snap = await make().rebuild('r');
    expect(snap.version).toBe(1);
    expect(snap.mediaRoomId).toBe('zego-1');
    expect(snap.provider).toBe(MediaProviderKind.ZEGO);
    expect(snap.participants[0].userId).toBe('u1');
    expect(snap.participants[0].role).toBe(ConnectionType.PUBLISHER);
    expect(cache.set).toHaveBeenCalled();
  });
  it('commit bumps the version and writes through', async () => {
    const base = { roomId: 'r', version: 5, updatedAt: '', mediaRoomId: 'z', provider: MediaProviderKind.ZEGO, participants: [] };
    const next = await make().commit('r', base as never, { participants: [] });
    expect(next.version).toBe(6);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r}:media', expect.objectContaining({ version: 6 }), 300);
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/services/video-room-media-state.service.spec.ts`

- [ ] **Step 3: Implement** (mirror `VideoRoomSeatStateService`):

```ts
// services/video-room-media-state.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  AudioOutput, CameraFacing, ConnectionStatus, ConnectionType,
  MediaStreamKind, MediaStreamState, VideoQualityProfile,
} from '../enums';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { MEDIA_PROVIDER, type IMediaProvider } from '../interfaces/media-provider.interface';
import { DEFAULT_BEAUTY } from '../media/beauty-settings';
import type { MediaParticipant, MediaStageMutation, MediaStageSnapshot } from '../media/media-stage';
import { videoRoomMediaStateKey } from '../constants/video-room.constants';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/**
 * Redis-authoritative versioned media snapshot — the pure primitive behind the
 * media stage (mirrors VideoRoomSeatStateService). NON-locking: the caller
 * (VideoRoomMediaService.mutateStage) holds videoRoomMediaLockKey. `rebuild`
 * reconstructs a cold snapshot from durable active sessions + the room handle.
 */
@Injectable()
export class VideoRoomMediaStateService {
  private readonly ttl: number;

  constructor(
    private readonly cache: CacheService,
    private readonly sessions: VideoRoomMediaSessionRepository,
    private readonly rooms: VideoRoomsRepository,
    @Inject(MEDIA_PROVIDER) private readonly provider: IMediaProvider,
    config: ConfigService,
  ) {
    this.ttl = loadVideoRoomConfig(config).stateTtlSeconds;
  }

  async getSnapshot(roomId: string): Promise<MediaStageSnapshot | null> {
    return this.cache.get<MediaStageSnapshot>(videoRoomMediaStateKey(roomId));
  }

  /** Rebuild a cold snapshot from active sessions + the room's zego handle. version = 1. */
  async rebuild(roomId: string): Promise<MediaStageSnapshot> {
    const [room, active] = await Promise.all([
      this.rooms.findById(roomId),
      this.sessions.listActive(roomId),
    ]);
    const nowIso = new Date().toISOString();
    const participants: MediaParticipant[] = active.map((s) => ({
      userId: s.userId,
      seatIndex: null,
      role: s.role === 'PUBLISHER' ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER,
      connection: ConnectionStatus.CONNECTED,
      streamId: null,
      streamKind: MediaStreamKind.CAMERA,
      streamState: MediaStreamState.CREATED,
      camera: { on: !s.selfMutedVideo, facing: (s.cameraFacing as CameraFacing) ?? CameraFacing.FRONT },
      mic: { on: !s.selfMutedAudio, selfMuted: s.selfMutedAudio, adminMuted: false },
      audioOutput: AudioOutput.SPEAKER,
      quality: VideoQualityProfile.ADAPTIVE,
      beauty: { ...DEFAULT_BEAUTY },
      subscriptions: [],
      joinedAt: nowIso,
      lastHeartbeatAt: nowIso,
    }));
    const snapshot: MediaStageSnapshot = {
      roomId,
      version: 1,
      updatedAt: nowIso,
      mediaRoomId: room?.zegoRoomId ?? '',
      provider: this.provider.kind,
      participants,
    };
    await this.cache.set(videoRoomMediaStateKey(roomId), snapshot, this.ttl);
    return snapshot;
  }

  /** Apply a patch, bump version, write to Redis (source of truth). Caller holds the lock. */
  async commit(roomId: string, base: MediaStageSnapshot, patch: MediaStageMutation): Promise<MediaStageSnapshot> {
    const next: MediaStageSnapshot = {
      ...base, ...patch, roomId, version: base.version + 1, updatedAt: new Date().toISOString(),
    };
    await this.cache.set(videoRoomMediaStateKey(roomId), next, this.ttl);
    return next;
  }

  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomMediaStateKey(roomId));
  }
}
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/services/video-room-media-state.service.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 redis-authoritative media state service"`

---

### Task 8: Media domain events (`events/video-room-media.events.ts`)

**Files:**
- Create: `src/modules/video-rooms/events/video-room-media.events.ts`
- Test: `src/modules/video-rooms/events/video-room-media.events.spec.ts`

**Interfaces:**
- Consumes: `DomainEvent` (`src/common/events`), `ConnectionType`, `MediaStreamState`, `VideoQualityProfile`, `AudioOutput`.
- Produces: `VIDEO_ROOM_MEDIA_EVENTS` (bus names) + event classes `MediaSessionCreatedEvent`, `MediaSessionClosedEvent`, `StreamPublishedEvent`, `StreamStoppedEvent`, `StreamPausedEvent`, `StreamResumedEvent`, `CameraEnabledEvent`, `CameraDisabledEvent`, `MicEnabledEvent`, `MicDisabledEvent`, `SubscribedEvent`, `UnsubscribedEvent`, `BeautyChangedEvent`, `QualityChangedEvent`, `AudioOutputChangedEvent`, `StreamStateChangedEvent`, `StreamRecoveredEvent`, `MediaRecoveredEvent`, `MediaFailedEvent`, `MediaStateSyncEvent`. Every payload includes `{ roomId: string; version: number; userId: string }`; extras noted below.

> **Naming note:** VR-5 `StreamPublishedEvent`/`StreamStoppedEvent` are NEW classes distinct from the existing `StreamStartedEvent`/`StreamStoppedEvent` in `video-room.events.ts`. To avoid a name collision on `StreamStoppedEvent`, VR-5 names them `MediaStreamPublishedEvent` / `MediaStreamStoppedEvent`. Update the Interfaces list + all later references accordingly.

- [ ] **Step 1: Write the failing test**

```ts
// video-room-media.events.spec.ts
import { VIDEO_ROOM_MEDIA_EVENTS, MediaSessionCreatedEvent, MediaStreamPublishedEvent, CameraEnabledEvent } from './video-room-media.events';

describe('VR-5 media events', () => {
  it('event carries its bus name + payload', () => {
    const e = new MediaSessionCreatedEvent({ roomId: 'r', version: 1, userId: 'u', seatIndex: null, role: 'SUBSCRIBER' as never });
    expect(e.name).toBe(VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED);
    expect(e.payload.userId).toBe('u');
  });
  it('publish + camera events expose distinct names', () => {
    expect(new MediaStreamPublishedEvent({ roomId: 'r', version: 1, userId: 'u', streamId: 's', streamState: 'LIVE' as never }).name)
      .toBe(VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED);
    expect(new CameraEnabledEvent({ roomId: 'r', version: 1, userId: 'u' }).name)
      .toBe(VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED);
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/events/video-room-media.events.spec.ts`

- [ ] **Step 3: Implement** (mirror `video-room-seat.events.ts`):

```ts
// events/video-room-media.events.ts
import { DomainEvent } from 'src/common/events';
import type { AudioOutput, ConnectionType, MediaStreamState, VideoQualityProfile } from '../enums';

export const VIDEO_ROOM_MEDIA_EVENTS = {
  SESSION_CREATED: 'video_room.media_session_created',
  SESSION_CLOSED: 'video_room.media_session_closed',
  STREAM_PUBLISHED: 'video_room.media_stream_published',
  STREAM_STOPPED: 'video_room.media_stream_stopped',
  STREAM_PAUSED: 'video_room.media_stream_paused',
  STREAM_RESUMED: 'video_room.media_stream_resumed',
  CAMERA_ENABLED: 'video_room.media_camera_enabled',
  CAMERA_DISABLED: 'video_room.media_camera_disabled',
  MIC_ENABLED: 'video_room.media_mic_enabled',
  MIC_DISABLED: 'video_room.media_mic_disabled',
  SUBSCRIBED: 'video_room.media_subscribed',
  UNSUBSCRIBED: 'video_room.media_unsubscribed',
  BEAUTY_CHANGED: 'video_room.media_beauty_changed',
  QUALITY_CHANGED: 'video_room.media_quality_changed',
  AUDIO_OUTPUT_CHANGED: 'video_room.media_audio_output_changed',
  STREAM_STATE_CHANGED: 'video_room.media_stream_state_changed',
  STREAM_RECOVERED: 'video_room.media_stream_recovered',
  MEDIA_RECOVERED: 'video_room.media_recovered',
  MEDIA_FAILED: 'video_room.media_failed',
  STATE_SYNC: 'video_room.media_state_sync',
} as const;

export type VideoRoomMediaEvent = (typeof VIDEO_ROOM_MEDIA_EVENTS)[keyof typeof VIDEO_ROOM_MEDIA_EVENTS];

interface Base { roomId: string; version: number; userId: string }

export class MediaSessionCreatedEvent extends DomainEvent<Base & { seatIndex: number | null; role: ConnectionType }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED;
}
export class MediaSessionClosedEvent extends DomainEvent<Base & { durationSeconds: number }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.SESSION_CLOSED;
}
export class MediaStreamPublishedEvent extends DomainEvent<Base & { streamId: string; streamState: MediaStreamState }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED;
}
export class MediaStreamStoppedEvent extends DomainEvent<Base & { streamId: string | null }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_STOPPED;
}
export class StreamPausedEvent extends DomainEvent<Base> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_PAUSED; }
export class StreamResumedEvent extends DomainEvent<Base> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_RESUMED; }
export class CameraEnabledEvent extends DomainEvent<Base> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED; }
export class CameraDisabledEvent extends DomainEvent<Base> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.CAMERA_DISABLED; }
export class MicEnabledEvent extends DomainEvent<Base> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.MIC_ENABLED; }
export class MicDisabledEvent extends DomainEvent<Base & { byAdmin: boolean }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.MIC_DISABLED; }
export class SubscribedEvent extends DomainEvent<Base & { targetUserId: string }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.SUBSCRIBED; }
export class UnsubscribedEvent extends DomainEvent<Base & { targetUserId: string }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.UNSUBSCRIBED; }
export class BeautyChangedEvent extends DomainEvent<Base & { enabled: boolean; level: number }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.BEAUTY_CHANGED; }
export class QualityChangedEvent extends DomainEvent<Base & { profile: VideoQualityProfile; bitrateKbps: number }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.QUALITY_CHANGED; }
export class AudioOutputChangedEvent extends DomainEvent<Base & { output: AudioOutput }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.AUDIO_OUTPUT_CHANGED; }
export class StreamStateChangedEvent extends DomainEvent<Base & { streamState: MediaStreamState }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_STATE_CHANGED; }
export class StreamRecoveredEvent extends DomainEvent<Base & { streamId: string | null }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_RECOVERED; }
export class MediaRecoveredEvent extends DomainEvent<Base> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.MEDIA_RECOVERED; }
export class MediaFailedEvent extends DomainEvent<Base & { reason: string }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.MEDIA_FAILED; }
export class MediaStateSyncEvent extends DomainEvent<Base & { version: number }> { readonly name = VIDEO_ROOM_MEDIA_EVENTS.STATE_SYNC; }
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/events/video-room-media.events.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media domain events"`

---

### Task 9: `VideoRoomMediaSocketListener` (bus → socket bridge)

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-media-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-media-socket.listener.spec.ts`

**Interfaces:**
- Consumes: `@Inject(EVENT_BUS) IEventBus`, `SocketManager`, `VIDEO_ROOM_NAMESPACE`, `VIDEO_ROOM_SOCKET_EVENTS`, `VIDEO_ROOM_MEDIA_EVENTS` + event classes (Task 8).
- Produces: `VideoRoomMediaSocketListener` (`implements OnModuleInit`).

- [ ] **Step 1: Write the failing test** (mock bus that records handlers; mock SocketManager):

```ts
// video-room-media-socket.listener.spec.ts
import { VideoRoomMediaSocketListener } from './video-room-media-socket.listener';
import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';
import { VIDEO_ROOM_SOCKET_EVENTS, VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';

describe('VideoRoomMediaSocketListener', () => {
  it('bridges camera_enabled → video_room.camera_on', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = { subscribe: (name: string, h: (e: unknown) => void) => { handlers[name] = h; return () => {}; } };
    const sockets = { emitToNamespaceRoom: jest.fn() };
    new VideoRoomMediaSocketListener(bus as never, sockets as never).onModuleInit();
    handlers[VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED]({ payload: { roomId: 'r', userId: 'u', version: 1 } });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE, 'r', VIDEO_ROOM_SOCKET_EVENTS.CAMERA_ON, { roomId: 'r', userId: 'u', version: 1 });
  });
  it('maps media_failed → stream_failed', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = { subscribe: (name: string, h: (e: unknown) => void) => { handlers[name] = h; return () => {}; } };
    const sockets = { emitToNamespaceRoom: jest.fn() };
    new VideoRoomMediaSocketListener(bus as never, sockets as never).onModuleInit();
    handlers[VIDEO_ROOM_MEDIA_EVENTS.MEDIA_FAILED]({ payload: { roomId: 'r', userId: 'u', version: 2, reason: 'x' } });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE, 'r', VIDEO_ROOM_SOCKET_EVENTS.STREAM_FAILED, expect.any(Object));
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/listeners/video-room-media-socket.listener.spec.ts`

- [ ] **Step 3: Implement** (mirror `VideoRoomSeatSocketListener`):

```ts
// listeners/video-room-media-socket.listener.ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';

/**
 * Bridges media domain events (EVENT_BUS) to client-facing video_room.* socket
 * broadcasts. Services never touch sockets. Heartbeat/quality-sample events are
 * intentionally NOT subscribed here (monitoring-only, handled by the metrics listener).
 */
@Injectable()
export class VideoRoomMediaSocketListener implements OnModuleInit {
  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus, private readonly sockets: SocketManager) {}

  onModuleInit(): void {
    const M = VIDEO_ROOM_MEDIA_EVENTS;
    const S = VIDEO_ROOM_SOCKET_EVENTS;
    const map: Array<[string, string]> = [
      [M.SESSION_CREATED, S.MEDIA_JOINED], [M.SESSION_CLOSED, S.MEDIA_LEFT],
      [M.STREAM_PUBLISHED, S.STREAM_PUBLISHED], [M.STREAM_STOPPED, S.STREAM_STOPPED],
      [M.STREAM_PAUSED, S.STREAM_PAUSED], [M.STREAM_RESUMED, S.STREAM_RESUMED],
      [M.CAMERA_ENABLED, S.CAMERA_ON], [M.CAMERA_DISABLED, S.CAMERA_OFF],
      [M.MIC_ENABLED, S.MIC_ON], [M.MIC_DISABLED, S.MIC_OFF],
      [M.SUBSCRIBED, S.MEDIA_SUBSCRIBED], [M.UNSUBSCRIBED, S.MEDIA_UNSUBSCRIBED],
      [M.BEAUTY_CHANGED, S.BEAUTY_CHANGED], [M.QUALITY_CHANGED, S.QUALITY_CHANGED],
      [M.AUDIO_OUTPUT_CHANGED, S.AUDIO_OUTPUT_CHANGED], [M.STREAM_STATE_CHANGED, S.STREAM_STATE_CHANGED],
      [M.STREAM_RECOVERED, S.STREAM_RECOVERED], [M.MEDIA_RECOVERED, S.MEDIA_RECOVERED],
      [M.MEDIA_FAILED, S.STREAM_FAILED], [M.STATE_SYNC, S.MEDIA_STATE_SYNC],
    ];
    for (const [busName, clientEvent] of map) {
      this.bus.subscribe<{ payload: { roomId: string } }>(busName, (e) =>
        this.emit(e.payload.roomId, clientEvent, e.payload));
    }
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/listeners/video-room-media-socket.listener.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media socket bridge listener"`

---

### Task 10: Metrics extension + `VideoRoomMediaMetricsListener`

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (add media metrics + helper methods)
- Create: `src/modules/video-rooms/listeners/video-room-media-metrics.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-media-metrics.listener.spec.ts`

**Interfaces:**
- Produces on `VideoRoomsMetrics`: `incMediaSession()`, `incTokenIssued()`, `setActiveStreams(n)`/`incActiveStream()`/`decActiveStream()`, `setPublishingUsers(n)`, `setSubscribedUsers(n)`, `incPublish()`, `incPublishFailure()`, `incMediaFailure()`, `incRecoverySuccess()`, `incReconnect()`, `incBitrateChange()`, `incCameraToggle()`, `incMicToggle()`, `incBeautyChange()`, `observeMediaJoin(sec)`, `observePublish(sec)`, `observeSubscribe(sec)`, `observeMediaSessionDuration(sec)`, `setQualityProfile(profile, n)`.
- `VideoRoomMediaMetricsListener` (`implements OnModuleInit`) subscribing media bus events → the helpers above.

- [ ] **Step 1: Write the failing test**

```ts
// video-room-media-metrics.listener.spec.ts
import { VideoRoomMediaMetricsListener } from './video-room-media-metrics.listener';
import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';

describe('VideoRoomMediaMetricsListener', () => {
  it('counts publishes + active streams on STREAM_PUBLISHED', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = { subscribe: (n: string, h: (e: unknown) => void) => { handlers[n] = h; return () => {}; } };
    const metrics = { incPublish: jest.fn(), incActiveStream: jest.fn(), incMediaSession: jest.fn(), decActiveStream: jest.fn(), incMediaFailure: jest.fn(), incRecoverySuccess: jest.fn(), incBeautyChange: jest.fn(), incBitrateChange: jest.fn(), incCameraToggle: jest.fn(), incMicToggle: jest.fn() };
    new VideoRoomMediaMetricsListener(bus as never, metrics as never).onModuleInit();
    handlers[VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED]({ payload: {} });
    expect(metrics.incPublish).toHaveBeenCalled();
    expect(metrics.incActiveStream).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/listeners/video-room-media-metrics.listener.spec.ts`

- [ ] **Step 3: Implement**

In `video-rooms.metrics.ts` ctor add (mirroring existing `registers`/`new Counter` pattern), under a `// ---- VR-5 media ----` comment:

```ts
    this.mediaActiveStreams = new Gauge({ name: 'video_rooms_media_active_streams', help: 'Currently live media streams', registers });
    this.mediaPublishingUsers = new Gauge({ name: 'video_rooms_media_publishing_users', help: 'Users currently publishing', registers });
    this.mediaSubscribedUsers = new Gauge({ name: 'video_rooms_media_subscribed_users', help: 'Users currently subscribing', registers });
    this.mediaSessionsC = new Counter({ name: 'video_rooms_media_sessions_total', help: 'Media sessions started', registers });
    this.mediaTokensC = new Counter({ name: 'video_rooms_media_tokens_issued_total', help: 'Media tokens issued', registers });
    this.mediaPublishC = new Counter({ name: 'video_rooms_media_publish_total', help: 'Stream publishes', registers });
    this.mediaPublishFailC = new Counter({ name: 'video_rooms_media_publish_failures_total', help: 'Stream publish failures', registers });
    this.mediaFailC = new Counter({ name: 'video_rooms_media_failures_total', help: 'Media failures', registers });
    this.mediaRecoveryC = new Counter({ name: 'video_rooms_media_recovery_success_total', help: 'Successful media recoveries', registers });
    this.mediaReconnectC = new Counter({ name: 'video_rooms_media_reconnect_total', help: 'Media reconnects', registers });
    this.mediaBitrateC = new Counter({ name: 'video_rooms_media_bitrate_changes_total', help: 'Adaptive bitrate changes', registers });
    this.mediaCameraC = new Counter({ name: 'video_rooms_media_camera_toggles_total', help: 'Camera on/off toggles', registers });
    this.mediaMicC = new Counter({ name: 'video_rooms_media_mic_toggles_total', help: 'Mic on/off toggles', registers });
    this.mediaBeautyC = new Counter({ name: 'video_rooms_media_beauty_changes_total', help: 'Beauty changes', registers });
    this.mediaJoinH = new Histogram({ name: 'video_rooms_media_join_seconds', help: 'Media join latency', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers });
    this.mediaPublishH = new Histogram({ name: 'video_rooms_media_publish_seconds', help: 'Publish latency', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers });
    this.mediaSubscribeH = new Histogram({ name: 'video_rooms_media_subscribe_seconds', help: 'Subscribe latency', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers });
    this.mediaSessionDurH = new Histogram({ name: 'video_rooms_media_session_duration_seconds', help: 'Media session duration', buckets: [5, 30, 60, 300, 900, 1800, 3600, 7200], registers });
    this.mediaQualityG = new Gauge({ name: 'video_rooms_media_quality_profile', help: 'Active streams by quality profile', labelNames: ['profile'], registers });
```

Declare each as a `private readonly` field (`Gauge`/`Counter`/`Histogram`) and add helper methods:

```ts
  incMediaSession(): void { this.mediaSessionsC.inc(); }
  incTokenIssued(): void { this.mediaTokensC.inc(); }
  incActiveStream(): void { this.mediaActiveStreams.inc(); }
  decActiveStream(): void { this.mediaActiveStreams.dec(); }
  setPublishingUsers(n: number): void { this.mediaPublishingUsers.set(n); }
  setSubscribedUsers(n: number): void { this.mediaSubscribedUsers.set(n); }
  incPublish(): void { this.mediaPublishC.inc(); }
  incPublishFailure(): void { this.mediaPublishFailC.inc(); }
  incMediaFailure(): void { this.mediaFailC.inc(); }
  incRecoverySuccess(): void { this.mediaRecoveryC.inc(); }
  incReconnect(): void { this.mediaReconnectC.inc(); }
  incBitrateChange(): void { this.mediaBitrateC.inc(); }
  incCameraToggle(): void { this.mediaCameraC.inc(); }
  incMicToggle(): void { this.mediaMicC.inc(); }
  incBeautyChange(): void { this.mediaBeautyC.inc(); }
  observeMediaJoin(sec: number): void { this.mediaJoinH.observe(sec); }
  observePublish(sec: number): void { this.mediaPublishH.observe(sec); }
  observeSubscribe(sec: number): void { this.mediaSubscribeH.observe(sec); }
  observeMediaSessionDuration(sec: number): void { this.mediaSessionDurH.observe(sec); }
  setQualityProfile(profile: string, n: number): void { this.mediaQualityG.set({ profile }, n); }
```

Create `listeners/video-room-media-metrics.listener.ts`:

```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/** Drives VideoRoomsMetrics off media bus events (monitoring-only; no sockets). */
@Injectable()
export class VideoRoomMediaMetricsListener implements OnModuleInit {
  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus, private readonly metrics: VideoRoomsMetrics) {}

  onModuleInit(): void {
    const M = VIDEO_ROOM_MEDIA_EVENTS;
    this.bus.subscribe(M.SESSION_CREATED, () => this.metrics.incMediaSession());
    this.bus.subscribe(M.STREAM_PUBLISHED, () => { this.metrics.incPublish(); this.metrics.incActiveStream(); });
    this.bus.subscribe(M.STREAM_STOPPED, () => this.metrics.decActiveStream());
    this.bus.subscribe(M.MEDIA_FAILED, () => this.metrics.incMediaFailure());
    this.bus.subscribe(M.MEDIA_RECOVERED, () => this.metrics.incRecoverySuccess());
    this.bus.subscribe(M.CAMERA_ENABLED, () => this.metrics.incCameraToggle());
    this.bus.subscribe(M.CAMERA_DISABLED, () => this.metrics.incCameraToggle());
    this.bus.subscribe(M.MIC_ENABLED, () => this.metrics.incMicToggle());
    this.bus.subscribe(M.MIC_DISABLED, () => this.metrics.incMicToggle());
    this.bus.subscribe(M.BEAUTY_CHANGED, () => this.metrics.incBeautyChange());
    this.bus.subscribe(M.QUALITY_CHANGED, () => this.metrics.incBitrateChange());
  }
}
```

- [ ] **Step 4: Run — PASS** (+ `npx tsc --noEmit`). Run: `npx jest src/modules/video-rooms/listeners/video-room-media-metrics.listener.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media metrics + metrics listener"`

---

### Task 11: Media DTOs (`dto/media.dto.ts`)

**Files:**
- Create: `src/modules/video-rooms/dto/media.dto.ts`
- Modify: `src/modules/video-rooms/dto/index.ts` (re-export)
- Test: `src/modules/video-rooms/dto/media.dto.spec.ts`

**Interfaces:**
- Produces: `JoinMediaDto`, `PublishStreamDto`, `SubscribeStreamDto`, `UnsubscribeStreamDto`, `CameraSwitchDto`, `ForceMuteDto`, `AudioOutputDto`, `SetQualityDto`, `BeautySettingsDto`, `MediaHeartbeatDto`, `RecoverMediaDto`.
- Consumes: `class-validator`, `@nestjs/swagger`; enums `MediaStreamKind`, `CameraFacing`, `AudioOutput`, `VideoQualityProfile`.

- [ ] **Step 1: Write the failing test**

```ts
// media.dto.spec.ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SubscribeStreamDto, BeautySettingsDto, CameraSwitchDto } from './media.dto';

describe('media DTOs', () => {
  it('SubscribeStreamDto requires a UUID target', () => {
    expect(validateSync(plainToInstance(SubscribeStreamDto, { targetUserId: 'not-a-uuid' })).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(SubscribeStreamDto, { targetUserId: '11111111-1111-1111-1111-111111111111' }))).toHaveLength(0);
  });
  it('BeautySettingsDto bounds levels 0..100', () => {
    expect(validateSync(plainToInstance(BeautySettingsDto, { enabled: true, level: 250 })).length).toBeGreaterThan(0);
  });
  it('CameraSwitchDto requires a valid facing', () => {
    expect(validateSync(plainToInstance(CameraSwitchDto, { facing: 'SIDE' })).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(CameraSwitchDto, { facing: 'FRONT' }))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/dto/media.dto.spec.ts`

- [ ] **Step 3: Implement** (each field with `@ApiProperty`/`@ApiPropertyOptional` + validators; enums via `@IsEnum`):

```ts
// dto/media.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min,
} from 'class-validator';
import { AudioOutput, CameraFacing, MediaStreamKind, VideoQualityProfile } from '../enums';

export class JoinMediaDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() deviceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() platform?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() network?: string;
}

export class PublishStreamDto {
  @ApiPropertyOptional({ enum: MediaStreamKind, default: MediaStreamKind.CAMERA })
  @IsOptional() @IsEnum(MediaStreamKind) streamKind?: MediaStreamKind;
}

export class SubscribeStreamDto {
  @ApiProperty() @IsUUID() targetUserId!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) priority?: number;
}

export class UnsubscribeStreamDto {
  @ApiProperty() @IsUUID() targetUserId!: string;
}

export class CameraSwitchDto {
  @ApiProperty({ enum: CameraFacing }) @IsEnum(CameraFacing) facing!: CameraFacing;
}

export class ForceMuteDto {
  @ApiProperty() @IsUUID() targetUserId!: string;
  @ApiProperty() @IsBoolean() muted!: boolean;
}

export class AudioOutputDto {
  @ApiProperty({ enum: AudioOutput }) @IsEnum(AudioOutput) output!: AudioOutput;
}

export class SetQualityDto {
  @ApiProperty({ enum: VideoQualityProfile }) @IsEnum(VideoQualityProfile) profile!: VideoQualityProfile;
}

export class BeautySettingsDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) level?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) smoothSkin?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) brightness?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) sharpen?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) faceEnhance?: number;
}

export class MediaHeartbeatDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() rttMs?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() packetLossPct?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() frameRate?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() bitrateKbps?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(5) qualityLevel?: number;
}

export class RecoverMediaDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) lastVersion?: number;
}
```

Add to `dto/index.ts`: `export * from './media.dto';`

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/dto/media.dto.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media DTOs"`

---

### Task 12: `VideoRoomMediaService` — session lifecycle (join / leave / refresh + `mutateStage`)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-media.service.ts`
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts`

**Interfaces:**
- Consumes: `LockService`, `VideoRoomMediaStateService` (Task 7), `VideoRoomMediaSessionRepository`, `VideoRoomsRepository`, `VideoRoomPermissionService`, `VideoRoomSeatStateService` (VR-4, for occupancy), `MediaTokenService`, `VideoRoomEventsRepository`, `@Inject(EVENT_BUS) IEventBus`, `ConfigService`; value objects + events from earlier tasks; `RoomActor`.
- Produces (used by later tasks + the controller): `mutateStage(roomId, fn)`, `joinMedia(actor, roomId, dto, ip?)`, `leaveMedia(actor, roomId, ip?)`, `refreshToken(actor, roomId)`, `getMediaState(actor, roomId)`; plus protected helpers `loadLiveRoom(roomId)`, `assertMember(room, userId)`, `resolveSeatIndex(roomId, userId)`, `ensureMediaRoomId(room, actorId)`, `defaultBeauty()`, `cfg`. Return type `MediaJoinResult = { mediaSession: MediaSession; stage: MediaStageView }`.

- [ ] **Step 1: Write the failing tests**

```ts
// video-room-media.service.spec.ts (representative cases; expand per behavior)
import { VideoRoomMediaService } from './video-room-media.service';
import { ConnectionType, MediaProviderKind } from '../enums';

const room = { id: 'r', ownerId: 'owner', status: 'LIVE', zegoRoomId: 'zego-1' };
function build(over: Partial<Record<string, unknown>> = {}) {
  const locks = { withLock: (_k: string, fn: () => Promise<unknown>) => fn() };
  const mediaState = {
    getSnapshot: jest.fn().mockResolvedValue({ roomId: 'r', version: 1, updatedAt: '', mediaRoomId: 'zego-1', provider: MediaProviderKind.ZEGO, participants: [] }),
    rebuild: jest.fn(),
    commit: jest.fn().mockImplementation((_r, base, patch) => ({ ...base, ...patch, version: base.version + 1 })),
    clear: jest.fn(),
  };
  const mediaSessions = { start: jest.fn(), end: jest.fn(), find: jest.fn() };
  const rooms = { findById: jest.fn().mockResolvedValue(room), setZegoRoomId: jest.fn() };
  const permissions = { resolveEffectiveRole: jest.fn().mockResolvedValue('VIEWER') };
  const seatState = { getSnapshot: jest.fn().mockResolvedValue({ seats: [{ seatIndex: 2, occupantUserId: 'u1' }] }), rebuild: jest.fn() };
  const tokens = { isConfigured: () => true, mintMediaRoomId: () => 'minted', issueForRoom: jest.fn().mockReturnValue({ token: 't', appId: 1, mediaRoomId: 'zego-1', userId: 'u1', role: ConnectionType.PUBLISHER, expiresInSeconds: 3600, provider: MediaProviderKind.ZEGO }), refresh: jest.fn() };
  const events = { appendEvent: jest.fn() };
  const bus = { publish: jest.fn() };
  const cfg = { get: () => ({ stateTtlSeconds: 300, maxSubscriptionsPerUser: 20, defaultBeautyLevel: 0, mediaHeartbeatTtlSeconds: 30, qualitySampleEvery: 6, maxBitrateKbps: 2500 }) };
  const svc = new VideoRoomMediaService(locks as never, mediaState as never, mediaSessions as never, rooms as never, permissions as never, seatState as never, tokens as never, events as never, bus as never, cfg as never);
  return { svc, mediaState, mediaSessions, rooms, permissions, tokens, events, bus };
}

describe('VideoRoomMediaService — session', () => {
  it('joinMedia as a seat occupant derives PUBLISHER + issues a publish token', async () => {
    const { svc, mediaSessions, tokens, bus } = build();
    const res = await svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never);
    expect(mediaSessions.start).toHaveBeenCalledWith(expect.objectContaining({ role: 'PUBLISHER' }));
    expect(tokens.issueForRoom).toHaveBeenCalledWith(expect.objectContaining({ canPublish: true }));
    expect(res.stage.participants.some((p) => p.userId === 'u1')).toBe(true);
    expect(bus.publish).toHaveBeenCalled();
  });
  it('joinMedia rejects a non-member', async () => {
    const { svc, permissions } = build();
    permissions.resolveEffectiveRole.mockResolvedValue(null);
    await expect(svc.joinMedia({ id: 'ghost', roles: [] } as never, 'r', {} as never)).rejects.toThrow();
  });
  it('joinMedia 503s when the provider is unconfigured and no handle exists', async () => {
    const { svc, rooms, tokens } = build();
    rooms.findById.mockResolvedValue({ ...room, zegoRoomId: null });
    (tokens as { isConfigured: () => boolean }).isConfigured = () => false;
    await expect(svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never)).rejects.toThrow();
  });
  it('leaveMedia is idempotent and ends the durable session', async () => {
    const { svc, mediaSessions } = build();
    mediaSessions.find = jest.fn().mockResolvedValue({ joinedAt: new Date() });
    await svc.leaveMedia({ id: 'u1', roles: [] } as never, 'r');
    expect(mediaSessions.end).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts`

- [ ] **Step 3: Implement** (the base service; publishing/subscription/device verbs are added in Tasks 13–15 on the same class):

```ts
// services/video-room-media.service.ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VideoRoomStatus, type VideoRoom } from '@prisma/client';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ConnectionStatus, ConnectionType } from '../enums';
import { loadVideoRoomConfig, type VideoRoomConfig } from '../config/video-room.config';
import { videoRoomMediaLockKey } from '../constants/video-room.constants';
import { DEFAULT_BEAUTY, type BeautySettings } from '../media/beauty-settings';
import {
  newParticipant, toMediaStageView, upsertParticipant,
  type MediaStageSnapshot, type MediaStageView,
} from '../media/media-stage';
import type { MediaSession } from '../media/media-session';
import { MediaTokenService } from '../media/media-token.service';
import { MediaSessionCreatedEvent, MediaSessionClosedEvent } from '../events/video-room-media.events';
import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

export interface MediaJoinResult { mediaSession: MediaSession; stage: MediaStageView }

/**
 * VR-5 media engine orchestrator (analog of audio VoiceService). Owns the
 * mutateStage locked pipeline and the media-session lifecycle. Publishing,
 * subscription, and device (camera/mic/output/quality/beauty) verbs extend this
 * same class in Tasks 13–15; recovery lives in VideoRoomMediaRecoveryService.
 */
@Injectable()
export class VideoRoomMediaService {
  protected readonly cfg: VideoRoomConfig;

  constructor(
    protected readonly locks: LockService,
    protected readonly mediaState: VideoRoomMediaStateService,
    protected readonly mediaSessions: VideoRoomMediaSessionRepository,
    protected readonly rooms: VideoRoomsRepository,
    protected readonly permissions: VideoRoomPermissionService,
    protected readonly seatState: VideoRoomSeatStateService,
    protected readonly tokens: MediaTokenService,
    protected readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) protected readonly bus: IEventBus,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  /** The locked mutation pipeline: load/rebuild → fn (must commit) → view. */
  async mutateStage(
    roomId: string, fn: (base: MediaStageSnapshot) => Promise<MediaStageSnapshot>,
  ): Promise<MediaStageView> {
    const next = await this.locks.withLock(videoRoomMediaLockKey(roomId), async () => {
      const base = (await this.mediaState.getSnapshot(roomId)) ?? (await this.mediaState.rebuild(roomId));
      return fn(base);
    });
    return toMediaStageView(next);
  }

  async getMediaState(_actor: RoomActor, roomId: string): Promise<MediaStageView> {
    const snap = (await this.mediaState.getSnapshot(roomId)) ?? (await this.mediaState.rebuild(roomId));
    return toMediaStageView(snap);
  }

  async joinMedia(
    actor: RoomActor, roomId: string,
    dto: { deviceId?: string; platform?: string; network?: string }, ip?: string,
  ): Promise<MediaJoinResult> {
    const room = await this.loadLiveRoom(roomId);
    await this.assertMember(room, actor.id);
    const mediaRoomId = await this.ensureMediaRoomId(room, actor.id);
    const seatIndex = await this.resolveSeatIndex(roomId, actor.id);
    const canPublish = seatIndex !== null;
    const role = canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER;

    await this.mediaSessions.start({
      roomId, userId: actor.id, zegoRoomId: mediaRoomId, role,
      deviceId: dto.deviceId ?? null, platform: dto.platform ?? null, network: dto.network ?? null,
    });

    const stage = await this.mutateStage(roomId, async (base) => {
      const nowIso = new Date().toISOString();
      const already = base.participants.some((p) => p.userId === actor.id);
      let participants = already
        ? upsertParticipant(base.participants, actor.id, (p) => ({
            ...p, seatIndex, role, connection: ConnectionStatus.CONNECTED,
          }))
        : [...base.participants, {
            ...newParticipant({ userId: actor.id, seatIndex, role, nowIso, defaultBeauty: this.defaultBeauty() }),
            connection: ConnectionStatus.CONNECTED,
          }];
      const publishers = participants
        .filter((p) => p.userId !== actor.id && p.streamId !== null)
        .map((p) => p.userId)
        .slice(0, this.cfg.maxSubscriptionsPerUser);
      participants = upsertParticipant(participants, actor.id, (p) => ({ ...p, subscriptions: publishers }));
      return this.mediaState.commit(roomId, base, { participants, mediaRoomId });
    });

    await this.events.appendEvent({
      roomId, actorId: actor.id, eventType: 'media.joined',
      payload: { userId: actor.id, seatIndex, role, ip: ip ?? null },
    });
    await this.bus.publish(new MediaSessionCreatedEvent({ roomId, version: stage.version, userId: actor.id, seatIndex, role }));

    const mediaSession = this.tokens.issueForRoom({ userId: actor.id, mediaRoomId, canPublish });
    return { mediaSession, stage };
  }

  async leaveMedia(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    const existing = await this.mediaSessions.find(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      if (!base.participants.some((p) => p.userId === actor.id)) return base; // idempotent
      const participants = base.participants.filter((p) => p.userId !== actor.id);
      return this.mediaState.commit(roomId, base, { participants });
    });
    if (existing) {
      const durationSeconds = BigInt(Math.max(0, Math.floor((Date.now() - new Date(existing.joinedAt).getTime()) / 1000)));
      await this.mediaSessions.end(roomId, actor.id, durationSeconds);
      await this.events.appendEvent({
        roomId, actorId: actor.id, eventType: 'media.left',
        payload: { userId: actor.id, durationSeconds: Number(durationSeconds), ip: ip ?? null },
      });
      await this.bus.publish(new MediaSessionClosedEvent({ roomId, version: stage.version, userId: actor.id, durationSeconds: Number(durationSeconds) }));
    }
    return stage;
  }

  async refreshToken(actor: RoomActor, roomId: string): Promise<MediaSession> {
    const room = await this.loadLiveRoom(roomId);
    const session = await this.mediaSessions.find(roomId, actor.id);
    if (!session || session.status !== 'ACTIVE') {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID, 'No active media session to refresh.', HttpStatus.CONFLICT);
    }
    const canPublish = session.role === 'PUBLISHER';
    return this.tokens.refresh({ userId: actor.id, mediaRoomId: room.zegoRoomId ?? '', role: canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER });
  }

  // ---- protected helpers (reused by Tasks 13–15 + recovery) ----

  protected async loadLiveRoom(roomId: string): Promise<VideoRoom> {
    const room = await this.rooms.findById(roomId);
    if (!room || room.deletedAt) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_NOT_FOUND, 'Room not found.', HttpStatus.NOT_FOUND);
    }
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_INVALID_STATE, 'Room is not live.', HttpStatus.CONFLICT);
    }
    return room;
  }

  protected async assertMember(room: VideoRoom, userId: string): Promise<void> {
    const role = await this.permissions.resolveEffectiveRole({ id: room.id, ownerId: room.ownerId }, userId);
    if (role === null) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_NOT_MEMBER, 'You are not a member of this room.', HttpStatus.FORBIDDEN);
    }
  }

  /** The seat index a user occupies, or null (audience). Reads the VR-4 seat snapshot. */
  protected async resolveSeatIndex(roomId: string, userId: string): Promise<number | null> {
    const seatSnap = (await this.seatState.getSnapshot(roomId)) ?? (await this.seatState.rebuild(roomId));
    const seat = seatSnap.seats.find((s) => s.occupantUserId === userId);
    return seat ? seat.seatIndex : null;
  }

  /** Read (or lazily mint) the room's ZEGO handle. Sequential — never nested inside mutateStage's lock. */
  protected async ensureMediaRoomId(room: VideoRoom, actorId: string): Promise<string> {
    if (room.zegoRoomId) return room.zegoRoomId;
    if (!this.tokens.isConfigured()) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_NOT_CONFIGURED, 'The media provider is not configured.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.locks.withLock(videoRoomMediaLockKey(room.id), async () => {
      const fresh = await this.rooms.findById(room.id);
      if (fresh?.zegoRoomId) return fresh.zegoRoomId;
      const mediaRoomId = this.tokens.mintMediaRoomId();
      await this.rooms.setZegoRoomId(room.id, mediaRoomId, actorId);
      return mediaRoomId;
    });
  }

  protected defaultBeauty(): BeautySettings {
    const level = this.cfg.defaultBeautyLevel;
    return { ...DEFAULT_BEAUTY, enabled: level > 0, level };
  }
}
```

> `resolveSeatIndex` depends on the VR-4 `SeatStageSnapshot` exposing `seats[].seatIndex` + `occupantUserId` — confirmed in `interfaces/seat-stage.interface.ts`. `VideoRoomSeatStateService.rebuild` is non-locking, so calling it here does not nest the seat lock.

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media service — session lifecycle + mutateStage"`

---

### Task 13: `VideoRoomMediaService` — publishing (publish / stop / pause / resume)

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-media.service.ts` (add publishing verbs to the class)
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `assertStreamTransition`, `MediaStreamState`, `MediaStreamKind` (Task 1); `MediaStreamPublishedEvent`, `MediaStreamStoppedEvent`, `StreamPausedEvent`, `StreamResumedEvent`, `StreamStateChangedEvent` (Task 8); `VideoRoomStreamingStatus` (`@prisma/client`).
- Produces: `startPublish(actor, roomId, dto, ip?)`, `stopPublish(actor, roomId, ip?)`, `pausePublish(actor, roomId)`, `resumePublish(actor, roomId)` — all return `MediaStageView`. Private helper `reconcileRoomStreaming(roomId, participants)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('VideoRoomMediaService — publishing', () => {
  it('startPublish requires seat occupancy', async () => {
    const { svc, seatState } = build();
    seatState.getSnapshot.mockResolvedValue({ seats: [] }); // no occupancy
    await expect(svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never)).rejects.toThrow();
  });
  it('startPublish moves CREATED→LIVE and sets a streamId', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({ roomId: 'r', version: 1, updatedAt: '', mediaRoomId: 'z', provider: 'ZEGO', participants: [{ userId: 'u1', seatIndex: 2, streamId: null, streamState: 'CREATED', subscriptions: [], role: 'PUBLISHER', camera: { on: false, facing: 'FRONT' }, mic: { on: false, selfMuted: false, adminMuted: false } }] });
    const stage = await svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never);
    const p = stage.participants.find((x) => x.userId === 'u1')!;
    expect(p.streamState).toBe('LIVE');
    expect(p.streamId).toBeTruthy();
  });
  it('startPublish rejects a duplicate active stream', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({ roomId: 'r', version: 1, updatedAt: '', mediaRoomId: 'z', provider: 'ZEGO', participants: [{ userId: 'u1', seatIndex: 2, streamId: 'live', streamState: 'LIVE', subscriptions: [], role: 'PUBLISHER', camera: { on: true, facing: 'FRONT' }, mic: { on: true, selfMuted: false, adminMuted: false } }] });
    await expect(svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts -t publishing`

- [ ] **Step 3: Implement** (append these methods to `VideoRoomMediaService`; add the imports named above):

```ts
  async startPublish(
    actor: RoomActor, roomId: string, dto: { streamKind?: MediaStreamKind }, ip?: string,
  ): Promise<MediaStageView> {
    await this.loadLiveRoom(roomId);
    const seatIndex = await this.resolveSeatIndex(roomId, actor.id);
    if (seatIndex === null) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_SEAT_REQUIRED, 'Occupy a seat to publish.', HttpStatus.FORBIDDEN);
    }
    if ((dto.streamKind ?? MediaStreamKind.CAMERA) === MediaStreamKind.SCREEN) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_STREAM_PUBLISH_FAILED, 'Screen streams are not yet supported.', HttpStatus.NOT_IMPLEMENTED);
    }
    const streamId = `${roomId}_${actor.id}_camera`;
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID, 'Join media before publishing.', HttpStatus.CONFLICT);
      if (me.streamId !== null && (me.streamState === MediaStreamState.LIVE || me.streamState === MediaStreamState.CONNECTING || me.streamState === MediaStreamState.PAUSED)) {
        throw new BusinessException(ERROR_CODES.VIDEO_ROOM_DUPLICATE_STREAM, 'Already publishing.', HttpStatus.CONFLICT);
      }
      assertStreamTransition(me.streamState, MediaStreamState.CONNECTING);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p, seatIndex, role: ConnectionType.PUBLISHER, streamId, streamState: MediaStreamState.LIVE,
        camera: { ...p.camera, on: true }, mic: { ...p.mic, on: true },
      }));
      const next = await this.mediaState.commit(roomId, base, { participants });
      await this.reconcileRoomStreaming(roomId, next.participants, actor.id);
      return next;
    });
    await this.mediaSessions.setRole(roomId, actor.id, 'PUBLISHER' as never);
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.publish', payload: { userId: actor.id, seatIndex, streamId, ip: ip ?? null } });
    await this.bus.publish(new MediaStreamPublishedEvent({ roomId, version: stage.version, userId: actor.id, streamId, streamState: MediaStreamState.LIVE }));
    return stage;
  }

  async stopPublish(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me || me.streamId === null) return base; // idempotent
      assertStreamTransition(me.streamState, MediaStreamState.STOPPED);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p, streamState: MediaStreamState.STOPPED, streamId: null,
        camera: { ...p.camera, on: false }, mic: { ...p.mic, on: false },
      }));
      const next = await this.mediaState.commit(roomId, base, { participants });
      await this.reconcileRoomStreaming(roomId, next.participants, actor.id);
      return next;
    });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.stop', payload: { userId: actor.id, ip: ip ?? null } });
    await this.bus.publish(new MediaStreamStoppedEvent({ roomId, version: stage.version, userId: actor.id, streamId: null }));
    return stage;
  }

  async pausePublish(actor: RoomActor, roomId: string): Promise<MediaStageView> {
    const stage = await this.transitionStream(roomId, actor.id, MediaStreamState.PAUSED);
    await this.bus.publish(new StreamPausedEvent({ roomId, version: stage.version, userId: actor.id }));
    return stage;
  }

  async resumePublish(actor: RoomActor, roomId: string): Promise<MediaStageView> {
    const stage = await this.transitionStream(roomId, actor.id, MediaStreamState.LIVE);
    await this.bus.publish(new StreamResumedEvent({ roomId, version: stage.version, userId: actor.id }));
    return stage;
  }

  /** Validate + apply a single stream-state transition for a participant. */
  protected async transitionStream(roomId: string, userId: string, to: MediaStreamState): Promise<MediaStageView> {
    return this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me) throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID, 'No media session.', HttpStatus.CONFLICT);
      assertStreamTransition(me.streamState, to);
      const participants = upsertParticipant(base.participants, userId, (p) => ({ ...p, streamState: to }));
      return this.mediaState.commit(roomId, base, { participants });
    });
  }

  /** Project the room-level streamingStatus from the live participants. */
  protected async reconcileRoomStreaming(
    roomId: string, participants: MediaStageView['participants'], actorId: string,
  ): Promise<void> {
    const anyLive = participants.some((p) => p.streamState === MediaStreamState.LIVE);
    const anyPaused = participants.some((p) => p.streamState === MediaStreamState.PAUSED);
    const status: VideoRoomStreamingStatus = anyLive ? 'PUBLISHING' : anyPaused ? 'PAUSED' : 'IDLE';
    await this.rooms.setStreamingStatus(roomId, status, actorId);
  }
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media service — publish/stop/pause/resume"`

---

### Task 14: `VideoRoomMediaService` — subscription (subscribe / unsubscribe)

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-media.service.ts`
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `SubscribedEvent`, `UnsubscribedEvent` (Task 8); `this.cfg.maxSubscriptionsPerUser`.
- Produces: `subscribe(actor, roomId, dto, ip?)`, `unsubscribe(actor, roomId, dto, ip?)` — return `MediaStageView`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('VideoRoomMediaService — subscription', () => {
  const publisherStage = { roomId: 'r', version: 1, updatedAt: '', mediaRoomId: 'z', provider: 'ZEGO', participants: [
    { userId: 'u1', seatIndex: null, streamId: null, streamState: 'CREATED', subscriptions: [], role: 'SUBSCRIBER', camera: { on: false, facing: 'FRONT' }, mic: { on: false, selfMuted: false, adminMuted: false } },
    { userId: 'pub', seatIndex: 0, streamId: 'live', streamState: 'LIVE', subscriptions: [], role: 'PUBLISHER', camera: { on: true, facing: 'FRONT' }, mic: { on: true, selfMuted: false, adminMuted: false } },
  ] };
  it('subscribe adds a publishing target', async () => {
    const { svc, mediaState, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(publisherStage);
    const stage = await svc.subscribe({ id: 'u1', roles: [] } as never, 'r', { targetUserId: 'pub' } as never);
    expect(stage.participants.find((p) => p.userId === 'u1')!.subscriptions).toContain('pub');
    expect(bus.publish).toHaveBeenCalled();
  });
  it('subscribe rejects a non-publishing target', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({ ...publisherStage, participants: [publisherStage.participants[0], { ...publisherStage.participants[1], streamId: null, streamState: 'CREATED' }] });
    await expect(svc.subscribe({ id: 'u1', roles: [] } as never, 'r', { targetUserId: 'pub' } as never)).rejects.toThrow();
  });
  it('subscribe enforces the per-user cap', async () => {
    const { svc, mediaState } = build();
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    mediaState.getSnapshot.mockResolvedValue({ ...publisherStage, participants: [{ ...publisherStage.participants[0], subscriptions: many }, publisherStage.participants[1]] });
    await expect(svc.subscribe({ id: 'u1', roles: [] } as never, 'r', { targetUserId: 'pub' } as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts -t subscription`

- [ ] **Step 3: Implement** (append to `VideoRoomMediaService`; add imports `SubscribedEvent`, `UnsubscribedEvent`):

```ts
  async subscribe(
    actor: RoomActor, roomId: string, dto: { targetUserId: string; priority?: number }, ip?: string,
  ): Promise<MediaStageView> {
    await this.loadLiveRoom(roomId);
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID, 'Join media before subscribing.', HttpStatus.CONFLICT);
      if (me.subscriptions.includes(dto.targetUserId)) return base; // idempotent
      const target = base.participants.find((p) => p.userId === dto.targetUserId);
      if (!target || target.streamId === null) {
        throw new BusinessException(ERROR_CODES.VIDEO_ROOM_STREAM_SUBSCRIBE_FAILED, 'Target is not publishing.', HttpStatus.CONFLICT);
      }
      if (me.subscriptions.length >= this.cfg.maxSubscriptionsPerUser) {
        throw new BusinessException(ERROR_CODES.VIDEO_ROOM_SUBSCRIPTION_LIMIT, 'Subscription limit reached.', HttpStatus.CONFLICT);
      }
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p, subscriptions: [...p.subscriptions, dto.targetUserId],
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.subscribe', payload: { userId: actor.id, targetUserId: dto.targetUserId, ip: ip ?? null } });
    await this.bus.publish(new SubscribedEvent({ roomId, version: stage.version, userId: actor.id, targetUserId: dto.targetUserId }));
    return stage;
  }

  async unsubscribe(
    actor: RoomActor, roomId: string, dto: { targetUserId: string }, ip?: string,
  ): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me || !me.subscriptions.includes(dto.targetUserId)) return base; // idempotent
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p, subscriptions: p.subscriptions.filter((id) => id !== dto.targetUserId),
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.unsubscribe', payload: { userId: actor.id, targetUserId: dto.targetUserId, ip: ip ?? null } });
    await this.bus.publish(new UnsubscribedEvent({ roomId, version: stage.version, userId: actor.id, targetUserId: dto.targetUserId }));
    return stage;
  }
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media service — subscribe/unsubscribe"`

---

### Task 15: `VideoRoomMediaService` — device controls (camera / mic / force-mute / audio-output / quality / beauty / heartbeat)

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-media.service.ts`
- Modify: `src/modules/video-rooms/repositories/video-room-media-session.repository.ts` (add `setSelfMedia`)
- Test: `src/modules/video-rooms/services/video-room-media.service.spec.ts` (extend); `video-room-media-session.repository.spec.ts` (extend)

**Interfaces:**
- Consumes: `clampBeauty`, `BeautySettings` (Task 3); `selectQualityProfile`, `resolveBitrate` (Task 2); `CameraEnabledEvent`, `CameraDisabledEvent`, `MicEnabledEvent`, `MicDisabledEvent`, `AudioOutputChangedEvent`, `QualityChangedEvent`, `BeautyChangedEvent` (Task 8); `VideoRoomPermission.MANAGE_PARTICIPANTS`; `AudioOutput`, `CameraFacing`, `VideoQualityProfile`, `MediaStreamState`.
- Produces: `cameraOn/cameraOff(actor, roomId, ip?)`, `switchCamera(actor, roomId, dto, ip?)`, `micOn/micOff(actor, roomId, ip?)`, `setSelfMute(actor, roomId, muted, ip?)`, `forceMute(actor, roomId, dto, ip?)`, `setAudioOutput(actor, roomId, dto)`, `setQuality(actor, roomId, dto)`, `setBeauty(actor, roomId, dto)`, `heartbeat(actor, roomId, dto)`; on the repo: `setSelfMedia(roomId, userId, data)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('VideoRoomMediaService — device controls', () => {
  const seated = { roomId: 'r', version: 1, updatedAt: '', mediaRoomId: 'z', provider: 'ZEGO', participants: [
    { userId: 'u1', seatIndex: 2, streamId: 'live', streamState: 'LIVE', subscriptions: [], role: 'PUBLISHER', quality: 'ADAPTIVE', audioOutput: 'SPEAKER', beauty: { enabled: false, level: 0, smoothSkin: 0, brightness: 0, sharpen: 0, faceEnhance: 0 }, camera: { on: true, facing: 'FRONT' }, mic: { on: true, selfMuted: false, adminMuted: false } },
  ] };
  it('cameraOff mutes video + writes through', async () => {
    const { svc, mediaState, mediaSessions, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    mediaSessions.setSelfMedia = jest.fn();
    const stage = await svc.cameraOff({ id: 'u1', roles: [] } as never, 'r');
    expect(stage.participants[0].camera.on).toBe(false);
    expect(mediaSessions.setSelfMedia).toHaveBeenCalledWith('r', 'u1', expect.objectContaining({ selfMutedVideo: true }));
    expect(bus.publish).toHaveBeenCalled();
  });
  it('setSelfMute blocked when admin-muted', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({ ...seated, participants: [{ ...seated.participants[0], mic: { on: false, selfMuted: true, adminMuted: true } }] });
    await expect(svc.setSelfMute({ id: 'u1', roles: [] } as never, 'r', false)).rejects.toThrow();
  });
  it('forceMute requires MANAGE_PARTICIPANTS + outrank', async () => {
    const { svc, permissions, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    permissions.assertPermission = jest.fn();
    permissions.assertOutranks = jest.fn();
    await svc.forceMute({ id: 'admin', roles: [] } as never, 'r', { targetUserId: 'u1', muted: true });
    expect(permissions.assertPermission).toHaveBeenCalled();
    expect(permissions.assertOutranks).toHaveBeenCalledWith(expect.any(Object), 'admin', 'u1');
  });
  it('setBeauty clamps + broadcasts', async () => {
    const { svc, mediaState, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    const stage = await svc.setBeauty({ id: 'u1', roles: [] } as never, 'r', { enabled: true, level: 250 });
    expect(stage.participants[0].beauty.level).toBe(100);
    expect(bus.publish).toHaveBeenCalled();
  });
});
```

Repo test:

```ts
it('setSelfMedia updates self-mute + facing', async () => {
  prisma.videoRoomSession.update.mockResolvedValue({} as never);
  await repo.setSelfMedia('r', 'u1', { selfMutedVideo: true, cameraFacing: 'REAR' });
  expect(prisma.videoRoomSession.update).toHaveBeenCalledWith(expect.objectContaining({
    where: { roomId_userId: { roomId: 'r', userId: 'u1' } },
    data: expect.objectContaining({ selfMutedVideo: true, cameraFacing: 'REAR' }),
  }));
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts -t "device controls"`

- [ ] **Step 3: Implement**

Add to `VideoRoomMediaSessionRepository`:

```ts
  /** Durable projection of a user's self-media controls (Redis stage is authoritative). */
  async setSelfMedia(
    roomId: string, userId: string,
    data: { selfMutedAudio?: boolean; selfMutedVideo?: boolean; cameraFacing?: string },
  ): Promise<VideoRoomSession> {
    return this.prisma.videoRoomSession.update({
      where: { roomId_userId: { roomId, userId } },
      data: { ...data, ...auditUpdate(userId) },
    });
  }
```

Add to `VideoRoomMediaService` (imports: the media events above, `clampBeauty`, `selectQualityProfile`, `resolveBitrate`, `AudioOutput`, `CameraFacing`, `VideoQualityProfile`, `VideoRoomPermission`):

```ts
  async cameraOn(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    return this.setCamera(actor, roomId, true, ip);
  }
  async cameraOff(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    return this.setCamera(actor, roomId, false, ip);
  }
  private async setCamera(actor: RoomActor, roomId: string, on: boolean, ip?: string): Promise<MediaStageView> {
    await this.assertSeated(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) throw new BusinessException(ERROR_CODES.VIDEO_ROOM_CAMERA_ERROR, 'Join media first.', HttpStatus.CONFLICT);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({ ...p, camera: { ...p.camera, on } }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, actor.id, { selfMutedVideo: !on });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: on ? 'media.camera_on' : 'media.camera_off', payload: { userId: actor.id, ip: ip ?? null } });
    await this.bus.publish(on
      ? new CameraEnabledEvent({ roomId, version: stage.version, userId: actor.id })
      : new CameraDisabledEvent({ roomId, version: stage.version, userId: actor.id }));
    return stage;
  }

  async switchCamera(actor: RoomActor, roomId: string, dto: { facing: CameraFacing }, ip?: string): Promise<MediaStageView> {
    await this.assertSeated(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({ ...p, camera: { ...p.camera, facing: dto.facing } }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, actor.id, { cameraFacing: dto.facing });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.camera_switch', payload: { userId: actor.id, facing: dto.facing, ip: ip ?? null } });
    await this.bus.publish(new CameraEnabledEvent({ roomId, version: stage.version, userId: actor.id }));
    return stage;
  }

  async micOn(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> { return this.setSelfMute(actor, roomId, false, ip); }
  async micOff(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> { return this.setSelfMute(actor, roomId, true, ip); }

  async setSelfMute(actor: RoomActor, roomId: string, muted: boolean, ip?: string): Promise<MediaStageView> {
    await this.assertSeated(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MICROPHONE_ERROR, 'Join media first.', HttpStatus.CONFLICT);
      if (!muted && me.mic.adminMuted) {
        throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MICROPHONE_ERROR, 'You have been muted by a moderator.', HttpStatus.FORBIDDEN);
      }
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({ ...p, mic: { ...p.mic, on: !muted, selfMuted: muted } }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, actor.id, { selfMutedAudio: muted });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: muted ? 'media.mic_off' : 'media.mic_on', payload: { userId: actor.id, ip: ip ?? null } });
    await this.bus.publish(muted
      ? new MicDisabledEvent({ roomId, version: stage.version, userId: actor.id, byAdmin: false })
      : new MicEnabledEvent({ roomId, version: stage.version, userId: actor.id }));
    return stage;
  }

  async forceMute(actor: RoomActor, roomId: string, dto: { targetUserId: string; muted: boolean }, ip?: string): Promise<MediaStageView> {
    const room = await this.loadLiveRoom(roomId);
    const ref = { id: room.id, ownerId: room.ownerId };
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.MANAGE_PARTICIPANTS);
    await this.permissions.assertOutranks(ref, actor.id, dto.targetUserId);
    const stage = await this.mutateStage(roomId, async (base) => {
      const target = base.participants.find((p) => p.userId === dto.targetUserId);
      if (!target) throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MICROPHONE_ERROR, 'Target has no media session.', HttpStatus.NOT_FOUND);
      const participants = upsertParticipant(base.participants, dto.targetUserId, (p) => ({ ...p, mic: { ...p.mic, adminMuted: dto.muted, on: dto.muted ? false : p.mic.on } }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, dto.targetUserId, { selfMutedAudio: dto.muted });
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.force_mute', payload: { actorId: actor.id, targetUserId: dto.targetUserId, muted: dto.muted, ip: ip ?? null } });
    await this.bus.publish(dto.muted
      ? new MicDisabledEvent({ roomId, version: stage.version, userId: dto.targetUserId, byAdmin: true })
      : new MicEnabledEvent({ roomId, version: stage.version, userId: dto.targetUserId }));
    return stage;
  }

  async setAudioOutput(actor: RoomActor, roomId: string, dto: { output: AudioOutput }): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({ ...p, audioOutput: dto.output }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.bus.publish(new AudioOutputChangedEvent({ roomId, version: stage.version, userId: actor.id, output: dto.output }));
    return stage;
  }

  async setQuality(actor: RoomActor, roomId: string, dto: { profile: VideoQualityProfile }): Promise<MediaStageView> {
    const bitrateKbps = resolveBitrate(dto.profile, this.cfg.maxBitrateKbps);
    const stage = await this.mutateStage(roomId, async (base) => {
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({ ...p, quality: dto.profile }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.bus.publish(new QualityChangedEvent({ roomId, version: stage.version, userId: actor.id, profile: dto.profile, bitrateKbps }));
    return stage;
  }

  async setBeauty(actor: RoomActor, roomId: string, dto: Partial<BeautySettings>): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      const beauty = clampBeauty(dto, me?.beauty);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({ ...p, beauty }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    const applied = stage.participants.find((p) => p.userId === actor.id)!.beauty;
    await this.bus.publish(new BeautyChangedEvent({ roomId, version: stage.version, userId: actor.id, enabled: applied.enabled, level: applied.level }));
    return stage;
  }

  async heartbeat(actor: RoomActor, roomId: string, dto: { rttMs?: number; packetLossPct?: number; bitrateKbps?: number; frameRate?: number; qualityLevel?: number }): Promise<void> {
    const session = await this.mediaSessions.find(roomId, actor.id);
    if (!session) return;
    await this.mediaSessions.recordQuality(roomId, actor.id, {
      lastHeartbeatAt: new Date(),
      qualitySampleCount: { increment: 1 },
      ...(dto.qualityLevel != null ? { lastQualityLevel: dto.qualityLevel } : {}),
      ...(dto.rttMs != null ? { avgRttMs: Math.round(dto.rttMs) } : {}),
      ...(dto.frameRate != null ? { avgFrameRate: Math.round(dto.frameRate) } : {}),
      ...(dto.bitrateKbps != null ? { avgBitrateKbps: Math.round(dto.bitrateKbps) } : {}),
    });
    const snap = await this.mediaState.getSnapshot(roomId);
    const me = snap?.participants.find((p) => p.userId === actor.id);
    if (me?.quality === VideoQualityProfile.ADAPTIVE && (session.qualitySampleCount % this.cfg.qualitySampleEvery) === 0) {
      const profile = selectQualityProfile({ rttMs: dto.rttMs, packetLossPct: dto.packetLossPct, bitrateKbps: dto.bitrateKbps });
      const bitrateKbps = resolveBitrate(profile, this.cfg.maxBitrateKbps);
      await this.bus.publish(new QualityChangedEvent({ roomId, version: snap!.version, userId: actor.id, profile, bitrateKbps }));
    }
  }

  /** Publish/camera/mic require an active seat. */
  protected async assertSeated(roomId: string, userId: string): Promise<void> {
    if ((await this.resolveSeatIndex(roomId, userId)) === null) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_SEAT_REQUIRED, 'Occupy a seat to use media.', HttpStatus.FORBIDDEN);
    }
  }
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/services/video-room-media.service.spec.ts && npx jest src/modules/video-rooms/repositories/video-room-media-session.repository.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media service — camera/mic/output/quality/beauty/heartbeat"`

---

### Task 16: `VideoRoomMediaRecoveryService` (reconnect / republish / resubscribe / restore)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-media-recovery.service.ts`
- Test: `src/modules/video-rooms/services/video-room-media-recovery.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomMediaService` (public `mutateStage`, `leaveMedia`), `VideoRoomMediaStateService` (`commit`, `getSnapshot`), `VideoRoomMediaSessionRepository`, `VideoRoomsRepository`, `MediaTokenService`, `VideoRoomEventsRepository` (`findLatestSnapshot`, `saveSnapshot`), `CacheService`, `@Inject(EVENT_BUS) IEventBus`, `ConfigService`; `videoRoomMediaRecoveryKey`; `upsertParticipant`, `newParticipant`, `DEFAULT_BEAUTY`; `MediaStreamState`, `ConnectionStatus`, `ConnectionType`; `MediaRecoveredEvent`, `StreamRecoveredEvent`, `StreamStateChangedEvent`, `MediaFailedEvent`.
- Produces: `recover(actor, roomId, dto)` → `MediaJoinResult`; `markRecovering(roomId, userId)`; `expireRecovery(roomId, userId)`; `reportStreamFailure(roomId, userId, reason)`; `restoreFromSnapshot(roomId)` → `MediaStageView | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// video-room-media-recovery.service.spec.ts
import { VideoRoomMediaRecoveryService } from './video-room-media-recovery.service';
import { MediaProviderKind } from '../enums';

function build() {
  const stageWith = (streamState: string) => ({ roomId: 'r', version: 1, updatedAt: '', mediaRoomId: 'z', provider: MediaProviderKind.ZEGO, participants: [{ userId: 'u1', seatIndex: 0, streamId: 'live', streamState, subscriptions: [], role: 'PUBLISHER', connection: 'RECONNECTING', camera: { on: true, facing: 'FRONT' }, mic: { on: true, selfMuted: false, adminMuted: false } }] });
  const media = { mutateStage: jest.fn().mockImplementation((_r, fn) => fn(stageWith('RECOVERING'))), leaveMedia: jest.fn() };
  const mediaState = { commit: jest.fn().mockImplementation((_r, base, patch) => ({ ...base, ...patch, version: base.version + 1 })), getSnapshot: jest.fn() };
  const mediaSessions = { find: jest.fn().mockResolvedValue({ role: 'PUBLISHER', status: 'ACTIVE' }), start: jest.fn() };
  const rooms = { findById: jest.fn().mockResolvedValue({ id: 'r', ownerId: 'o', status: 'LIVE', zegoRoomId: 'z', deletedAt: null }) };
  const tokens = { issueForRoom: jest.fn().mockReturnValue({ token: 't' }) };
  const events = { findLatestSnapshot: jest.fn().mockResolvedValue(null), saveSnapshot: jest.fn(), appendEvent: jest.fn() };
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const bus = { publish: jest.fn() };
  const cfg = { get: () => ({ stateTtlSeconds: 300, mediaRecoveryTokenTtlSeconds: 60, defaultBeautyLevel: 0 }) };
  const svc = new VideoRoomMediaRecoveryService(media as never, mediaState as never, mediaSessions as never, rooms as never, tokens as never, events as never, cache as never, bus as never, cfg as never);
  return { svc, media, mediaSessions, cache, bus };
}

describe('VideoRoomMediaRecoveryService', () => {
  it('recover reactivates the session, flips RECOVERING→LIVE, reissues token, clears the token key', async () => {
    const { svc, media, mediaSessions, cache, bus } = build();
    const res = await svc.recover({ id: 'u1', roles: [] } as never, 'r', {} as never);
    expect(mediaSessions.start).toHaveBeenCalled();
    expect(media.mutateStage).toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledWith('video-room:{r}:media:recovery:u1');
    expect(res.mediaSession).toBeDefined();
    expect(bus.publish).toHaveBeenCalled();
  });
  it('recover fails without a durable session', async () => {
    const { svc, mediaSessions } = build();
    mediaSessions.find.mockResolvedValue(null);
    await expect(svc.recover({ id: 'u1', roles: [] } as never, 'r', {} as never)).rejects.toThrow();
  });
  it('expireRecovery ends media + publishes MediaFailed', async () => {
    const { svc, media, bus } = build();
    await svc.expireRecovery('r', 'u1');
    expect(media.leaveMedia).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r');
    expect(bus.publish).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/services/video-room-media-recovery.service.spec.ts`

- [ ] **Step 3: Implement**

```ts
// services/video-room-media-recovery.service.ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VideoRoomSnapshotReason } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ConnectionStatus, ConnectionType, MediaStreamState } from '../enums';
import { loadVideoRoomConfig, type VideoRoomConfig } from '../config/video-room.config';
import { videoRoomMediaRecoveryKey } from '../constants/video-room.constants';
import { DEFAULT_BEAUTY } from '../media/beauty-settings';
import { newParticipant, toMediaStageView, upsertParticipant, type MediaParticipant, type MediaStageSnapshot, type MediaStageView } from '../media/media-stage';
import type { MediaSession } from '../media/media-session';
import { MediaTokenService } from '../media/media-token.service';
import {
  MediaFailedEvent, MediaRecoveredEvent, StreamRecoveredEvent, StreamStateChangedEvent,
} from '../events/video-room-media.events';
import { VideoRoomMediaService, type MediaJoinResult } from './video-room-media.service';
import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/** Network recovery for media sessions/streams (VR-5). Owns recovery tokens + the RECOVERING lifecycle. */
@Injectable()
export class VideoRoomMediaRecoveryService {
  private readonly cfg: VideoRoomConfig;

  constructor(
    private readonly media: VideoRoomMediaService,
    private readonly mediaState: VideoRoomMediaStateService,
    private readonly mediaSessions: VideoRoomMediaSessionRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly tokens: MediaTokenService,
    private readonly events: VideoRoomEventsRepository,
    private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  async recover(actor: RoomActor, roomId: string, _dto: { lastVersion?: number }): Promise<MediaJoinResult> {
    const room = await this.rooms.findById(roomId);
    if (!room || room.deletedAt || room.status !== 'LIVE') {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_RECOVERY_FAILED, 'Room is not recoverable.', HttpStatus.CONFLICT);
    }
    const session = await this.mediaSessions.find(roomId, actor.id);
    if (!session) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_MEDIA_RECOVERY_FAILED, 'No media session to recover.', HttpStatus.CONFLICT);
    }
    const canPublish = session.role === 'PUBLISHER';
    const role = canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER;
    const mediaRoomId = room.zegoRoomId ?? '';
    await this.mediaSessions.start({ roomId, userId: actor.id, zegoRoomId: mediaRoomId, role });

    const stage = await this.media.mutateStage(roomId, async (base) => {
      let participants = base.participants;
      if (!participants.some((p) => p.userId === actor.id)) {
        participants = [...participants, await this.restoreParticipant(roomId, actor.id, role)];
      }
      participants = upsertParticipant(participants, actor.id, (p) => ({
        ...p,
        connection: ConnectionStatus.CONNECTED,
        streamState: p.streamState === MediaStreamState.RECOVERING || p.streamState === MediaStreamState.FAILED ? MediaStreamState.LIVE : p.streamState,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });

    await this.cache.del(videoRoomMediaRecoveryKey(roomId, actor.id));
    await this.events.appendEvent({ roomId, actorId: actor.id, eventType: 'media.recovered', payload: { userId: actor.id } });
    const me = stage.participants.find((p) => p.userId === actor.id)!;
    await this.bus.publish(new MediaRecoveredEvent({ roomId, version: stage.version, userId: actor.id }));
    await this.bus.publish(new StreamRecoveredEvent({ roomId, version: stage.version, userId: actor.id, streamId: me.streamId }));
    const mediaSession: MediaSession = this.tokens.issueForRoom({ userId: actor.id, mediaRoomId, canPublish });
    return { mediaSession, stage };
  }

  /** Monitor-driven: a live publisher's heartbeat went stale — enter RECOVERING + arm the grace token. */
  async markRecovering(roomId: string, userId: string): Promise<void> {
    const stage = await this.media.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me || me.streamState !== MediaStreamState.LIVE) return base; // idempotent
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p, streamState: MediaStreamState.RECOVERING, connection: ConnectionStatus.RECONNECTING,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.cache.set(videoRoomMediaRecoveryKey(roomId, userId), { at: new Date().toISOString() }, this.cfg.mediaRecoveryTokenTtlSeconds);
    await this.bus.publish(new StreamStateChangedEvent({ roomId, version: stage.version, userId, streamState: MediaStreamState.RECOVERING }));
  }

  /** Grace elapsed — end the media session and publish a failure. */
  async expireRecovery(roomId: string, userId: string): Promise<void> {
    const stage = await this.media.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me) return base;
      const participants = upsertParticipant(base.participants, userId, (p) => ({ ...p, streamState: MediaStreamState.ENDED }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.bus.publish(new MediaFailedEvent({ roomId, version: stage.version, userId, reason: 'recovery_timeout' }));
    await this.media.leaveMedia({ id: userId, roles: [] } as RoomActor, roomId);
    await this.cache.del(videoRoomMediaRecoveryKey(roomId, userId));
  }

  /** Client-reported unrecoverable stream error — mark FAILED + arm the grace token. */
  async reportStreamFailure(roomId: string, userId: string, reason: string): Promise<void> {
    const stage = await this.media.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me) return base;
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p, streamState: MediaStreamState.FAILED, connection: ConnectionStatus.RECONNECTING,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.cache.set(videoRoomMediaRecoveryKey(roomId, userId), { at: new Date().toISOString() }, this.cfg.mediaRecoveryTokenTtlSeconds);
    await this.bus.publish(new MediaFailedEvent({ roomId, version: stage.version, userId, reason }));
  }

  /** Rehydrate a whole stage from the latest durable snapshot (cold Redis after a reopen). */
  async restoreFromSnapshot(roomId: string): Promise<MediaStageView | null> {
    const snap = await this.events.findLatestSnapshot(roomId);
    if (!snap) return null;
    const state = snap.state as unknown as MediaStageSnapshot;
    const restored = await this.mediaState.commit(roomId, state, {});
    return toMediaStageView(restored);
  }

  private async restoreParticipant(roomId: string, userId: string, role: ConnectionType): Promise<MediaParticipant> {
    const snap = await this.events.findLatestSnapshot(roomId);
    const prior = snap
      ? (snap.state as unknown as MediaStageSnapshot).participants?.find((p) => p.userId === userId)
      : undefined;
    return prior ?? newParticipant({ userId, seatIndex: null, role, nowIso: new Date().toISOString(), defaultBeauty: DEFAULT_BEAUTY });
  }
}
```

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/services/video-room-media-recovery.service.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media recovery service"`

---

### Task 17: Media monitor (stale-heartbeat sweep) + room/seat lifecycle listener

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-room-media-session.repository.ts` (add `findStale`)
- Create: `src/modules/video-rooms/scheduler/video-room-media.monitor.ts`
- Create: `src/modules/video-rooms/listeners/video-room-media-lifecycle.listener.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-media.monitor.spec.ts`; `src/modules/video-rooms/listeners/video-room-media-lifecycle.listener.spec.ts`; repo spec (extend)

**Interfaces:**
- Produces on repo: `findStale(cutoff: Date, limit: number): Promise<VideoRoomSession[]>` (ACTIVE sessions with `lastHeartbeatAt < cutoff`).
- Produces: `VideoRoomMediaMonitor` (`OnModuleInit, OnModuleDestroy`) — fleet-locked sweep calling `recovery.markRecovering` / `recovery.expireRecovery`; `VideoRoomMediaLifecycleListener` (`OnModuleInit`) — reacts to room CLOSED/DELETED (snapshot + clear) and USER_LEFT (leaveMedia).
- Consumes: `LockService`, `VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY`, `loadVideoRoomConfig`, `VideoRoomMediaRecoveryService`, `VideoRoomMediaSessionRepository`; the room event bus names used by `video-room-seat-lifecycle.listener.ts` (`VIDEO_ROOM_EVENTS.USER_LEFT`, `.CLOSED`, `.DELETED` from `events/video-room.events.ts`).

- [ ] **Step 1: Write the failing test** (monitor):

```ts
// video-room-media.monitor.spec.ts
import { VideoRoomMediaMonitor } from './video-room-media.monitor';

describe('VideoRoomMediaMonitor', () => {
  it('marks recovering for a freshly-stale session, expires past grace', async () => {
    const now = Date.now();
    const cfg = { get: () => ({ mediaHeartbeatTtlSeconds: 30, mediaReconnectGraceSeconds: 60, mediaMonitorIntervalSeconds: 10 }) };
    const release = jest.fn();
    const locks = { acquire: jest.fn().mockResolvedValue(release) };
    const recovery = { markRecovering: jest.fn(), expireRecovery: jest.fn() };
    const sessions = { findStale: jest.fn().mockResolvedValue([
      { roomId: 'r', userId: 'fresh', lastHeartbeatAt: new Date(now - 35_000) },   // stale, within grace
      { roomId: 'r', userId: 'gone', lastHeartbeatAt: new Date(now - 120_000) },   // past grace
    ]) };
    const mon = new VideoRoomMediaMonitor(locks as never, recovery as never, sessions as never, cfg as never);
    await mon.sweep();
    expect(recovery.markRecovering).toHaveBeenCalledWith('r', 'fresh');
    expect(recovery.expireRecovery).toHaveBeenCalledWith('r', 'gone');
    expect(release).toHaveBeenCalled();
  });
});
```

Lifecycle listener test:

```ts
// video-room-media-lifecycle.listener.spec.ts
import { VideoRoomMediaLifecycleListener } from './video-room-media-lifecycle.listener';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';

describe('VideoRoomMediaLifecycleListener', () => {
  it('clears the media stage on room close', async () => {
    const handlers: Record<string, (e: unknown) => Promise<void>> = {};
    const bus = { subscribe: (n: string, h: (e: unknown) => Promise<void>) => { handlers[n] = h; return () => {}; } };
    const media = { leaveMedia: jest.fn() };
    const mediaState = { clear: jest.fn(), getSnapshot: jest.fn().mockResolvedValue({ version: 3, participants: [] }) };
    const events = { saveSnapshot: jest.fn() };
    new VideoRoomMediaLifecycleListener(bus as never, media as never, mediaState as never, events as never).onModuleInit();
    await handlers[VIDEO_ROOM_EVENTS.CLOSED]({ payload: { roomId: 'r' } });
    expect(events.saveSnapshot).toHaveBeenCalled();
    expect(mediaState.clear).toHaveBeenCalledWith('r');
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/scheduler/video-room-media.monitor.spec.ts src/modules/video-rooms/listeners/video-room-media-lifecycle.listener.spec.ts`

- [ ] **Step 3: Implement**

Add to `VideoRoomMediaSessionRepository` (`import { VideoRoomSessionStatus }` already present):

```ts
  /** ACTIVE sessions whose last heartbeat predates `cutoff` (monitor sweep). */
  async findStale(cutoff: Date, limit: number): Promise<VideoRoomSession[]> {
    return this.prisma.videoRoomSession.findMany({
      where: { status: VideoRoomSessionStatus.ACTIVE, lastHeartbeatAt: { lt: cutoff } },
      orderBy: { lastHeartbeatAt: 'asc' },
      take: limit,
    });
  }
```

Create `scheduler/video-room-media.monitor.ts` (mirror `VideoRoomSessionMonitor`):

```ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig, type VideoRoomConfig } from '../config/video-room.config';
import { VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY } from '../constants/video-room.constants';
import { VideoRoomMediaRecoveryService } from '../services/video-room-media-recovery.service';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';

/** Fleet-locked sweep: stale media heartbeats → RECOVERING; past grace → ENDED. */
@Injectable()
export class VideoRoomMediaMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomMediaMonitor.name);
  private readonly cfg: VideoRoomConfig;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly locks: LockService,
    private readonly recovery: VideoRoomMediaRecoveryService,
    private readonly mediaSessions: VideoRoomMediaSessionRepository,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.mediaMonitorIntervalSeconds * 1000);
    this.timer.unref?.();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const release = await this.locks.acquire(VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY, this.cfg.mediaMonitorIntervalSeconds * 1000);
    try {
      if (release) await this.sweep();
    } catch (err) {
      this.logger.warn(`media sweep failed: ${String(err)}`);
    } finally {
      if (release) await release();
      this.running = false;
    }
  }

  /** One sweep pass (exposed for tests). */
  async sweep(): Promise<void> {
    const now = Date.now();
    const graceMs = (this.cfg.mediaHeartbeatTtlSeconds + this.cfg.mediaReconnectGraceSeconds) * 1000;
    const cutoff = new Date(now - this.cfg.mediaHeartbeatTtlSeconds * 1000);
    const stale = await this.mediaSessions.findStale(cutoff, 200);
    for (const s of stale) {
      const last = new Date(s.lastHeartbeatAt).getTime();
      if (now - last > graceMs) await this.recovery.expireRecovery(s.roomId, s.userId);
      else await this.recovery.markRecovering(s.roomId, s.userId);
    }
  }
}
```

Create `listeners/video-room-media-lifecycle.listener.ts`:

```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VideoRoomSnapshotReason } from '@prisma/client';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomMediaService } from '../services/video-room-media.service';
import { VideoRoomMediaStateService } from '../services/video-room-media-state.service';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/**
 * Keeps the media slice consistent with room/member lifecycle (one-directional —
 * no dependency back into lifecycle). On room CLOSED/DELETED: snapshot then clear
 * the media stage. On USER_LEFT: end that user's media session.
 */
@Injectable()
export class VideoRoomMediaLifecycleListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly media: VideoRoomMediaService,
    private readonly mediaState: VideoRoomMediaStateService,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    const teardown = async (e: { payload: { roomId: string } }) => this.teardownRoom(e.payload.roomId);
    this.bus.subscribe(VIDEO_ROOM_EVENTS.CLOSED, teardown);
    this.bus.subscribe(VIDEO_ROOM_EVENTS.DELETED, teardown);
    this.bus.subscribe<{ payload: { roomId: string; userId: string } }>(VIDEO_ROOM_EVENTS.USER_LEFT, (e) =>
      this.media.leaveMedia({ id: e.payload.userId, roles: [] } as RoomActor, e.payload.roomId));
  }

  private async teardownRoom(roomId: string): Promise<void> {
    const snap = await this.mediaState.getSnapshot(roomId);
    if (snap) {
      await this.events.saveSnapshot({ roomId, version: snap.version, reason: VideoRoomSnapshotReason.PRE_SHUTDOWN, state: snap as never });
    }
    await this.mediaState.clear(roomId);
  }
}
```

> Confirm the exact exported constant names in `events/video-room.events.ts` match `VIDEO_ROOM_EVENTS.CLOSED/DELETED/USER_LEFT` (the seat-lifecycle listener subscribes the same names — copy its imports). If a payload lacks `userId` on `USER_LEFT`, adjust the handler to the actual field.

- [ ] **Step 4: Run — PASS.** Run: `npx jest src/modules/video-rooms/scheduler/video-room-media.monitor.spec.ts src/modules/video-rooms/listeners/video-room-media-lifecycle.listener.spec.ts src/modules/video-rooms/repositories/video-room-media-session.repository.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media monitor + lifecycle listener"`

---

### Task 18: `VideoRoomMediaController` (REST + Swagger)

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-media.controller.ts`
- Modify: `src/modules/video-rooms/controllers/index.ts` (re-export)
- Test: `src/modules/video-rooms/controllers/video-rooms-media.controller.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomMediaService`, `VideoRoomMediaRecoveryService`; `@CurrentUser() AuthenticatedUser`, `@NotGuest()`, `ParseUuidPipe`, `@Ip()`; the media DTOs (Task 11); `RoomActor`.
- Produces: routes under `video-rooms/:id/media/*` (§8 of the spec), each delegating to a service.

- [ ] **Step 1: Write the failing test** (mirror `video-rooms-seats.controller.spec.ts` — mock both services, assert delegation):

```ts
// video-rooms-media.controller.spec.ts
import { VideoRoomsMediaController } from './video-rooms-media.controller';

const user = { id: 'u1', roles: [] };
function build() {
  const media = { joinMedia: jest.fn().mockResolvedValue({ mediaSession: {}, stage: {} }), leaveMedia: jest.fn(), startPublish: jest.fn(), stopPublish: jest.fn(), cameraOn: jest.fn(), micOff: jest.fn(), setBeauty: jest.fn(), getMediaState: jest.fn(), forceMute: jest.fn() };
  const recovery = { recover: jest.fn() };
  return { c: new VideoRoomsMediaController(media as never, recovery as never), media, recovery };
}
describe('VideoRoomsMediaController', () => {
  it('join delegates with the actor + ip', async () => {
    const { c, media } = build();
    await c.join('11111111-1111-1111-1111-111111111111', user as never, {} as never, '1.2.3.4');
    expect(media.joinMedia).toHaveBeenCalledWith({ id: 'u1', roles: [] }, '11111111-1111-1111-1111-111111111111', {}, '1.2.3.4');
  });
  it('cameraOn delegates', async () => {
    const { c, media } = build();
    await c.cameraOn('11111111-1111-1111-1111-111111111111', user as never, '1.2.3.4');
    expect(media.cameraOn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Run: `npx jest src/modules/video-rooms/controllers/video-rooms-media.controller.spec.ts`

- [ ] **Step 3: Implement** (mirror `VideoRoomsSeatsController` — global `JwtAuthGuard`, `@NotGuest()` on state changers, `@HttpCode(200)` on POST commands, one `@ApiOperation` + `@ApiResponse`s per route; `private actor(user)` helper). Abbreviated body — every route follows the same shape:

```ts
// controllers/video-rooms-media.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  AudioOutputDto, BeautySettingsDto, CameraSwitchDto, ForceMuteDto, JoinMediaDto,
  MediaHeartbeatDto, PublishStreamDto, RecoverMediaDto, SetQualityDto, SubscribeStreamDto, UnsubscribeStreamDto,
} from '../dto';
import { VideoRoomMediaService } from '../services/video-room-media.service';
import { VideoRoomMediaRecoveryService } from '../services/video-room-media-recovery.service';

@ApiTags('video-room-media')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsMediaController {
  constructor(
    private readonly media: VideoRoomMediaService,
    private readonly recovery: VideoRoomMediaRecoveryService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/media/join')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join the room media session and receive a ZEGO token.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Media session + stage.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Not a room member.' })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: 'Media provider not configured.' })
  join(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: JoinMediaDto, @Ip() ip: string) {
    return this.media.joinMedia(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/leave') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave the room media session.' })
  leave(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.media.leaveMedia(this.actor(user), id, ip);
  }

  @Post(':id/media/refresh') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh (re-issue) the media token.' })
  refresh(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.refreshToken(this.actor(user), id);
  }

  @Post(':id/media/publish') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start publishing (seat occupancy required).' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Already publishing / illegal transition.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'No seat occupied.' })
  publish(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: PublishStreamDto, @Ip() ip: string) {
    return this.media.startPublish(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/stop') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop publishing.' })
  stop(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.media.stopPublish(this.actor(user), id, ip);
  }

  @Post(':id/media/pause') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause the publishing stream.' })
  pause(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.pausePublish(this.actor(user), id);
  }

  @Post(':id/media/resume') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume the paused stream.' })
  resume(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.resumePublish(this.actor(user), id);
  }

  @Post(':id/media/subscribe') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Subscribe to a publisher.' })
  subscribe(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: SubscribeStreamDto, @Ip() ip: string) {
    return this.media.subscribe(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/unsubscribe') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unsubscribe from a publisher.' })
  unsubscribe(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: UnsubscribeStreamDto, @Ip() ip: string) {
    return this.media.unsubscribe(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/camera/on') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn the camera on.' })
  cameraOn(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.media.cameraOn(this.actor(user), id, ip);
  }

  @Post(':id/media/camera/off') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn the camera off.' })
  cameraOff(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.media.cameraOff(this.actor(user), id, ip);
  }

  @Post(':id/media/camera/switch') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Switch front/rear camera.' })
  switchCamera(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CameraSwitchDto, @Ip() ip: string) {
    return this.media.switchCamera(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/mic/on') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute the microphone.' })
  micOn(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.media.micOn(this.actor(user), id, ip);
  }

  @Post(':id/media/mic/off') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute the microphone.' })
  micOff(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.media.micOff(this.actor(user), id, ip);
  }

  @Post(':id/media/mic/force') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force-mute/unmute a participant (moderator).' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Requires MANAGE_PARTICIPANTS + outrank.' })
  forceMute(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: ForceMuteDto, @Ip() ip: string) {
    return this.media.forceMute(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/audio-output') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the audio output route.' })
  audioOutput(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: AudioOutputDto) {
    return this.media.setAudioOutput(this.actor(user), id, dto);
  }

  @Post(':id/media/quality') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the video quality profile.' })
  quality(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: SetQualityDto) {
    return this.media.setQuality(this.actor(user), id, dto);
  }

  @Post(':id/media/beauty') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update beauty-filter settings.' })
  beauty(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: BeautySettingsDto) {
    return this.media.setBeauty(this.actor(user), id, dto);
  }

  @Post(':id/media/heartbeat') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Media heartbeat + quality sample.' })
  heartbeat(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: MediaHeartbeatDto) {
    return this.media.heartbeat(this.actor(user), id, dto);
  }

  @Post(':id/media/recover') @NotGuest() @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recover a media session after a network drop.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nothing to recover.' })
  recover(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: RecoverMediaDto) {
    return this.recovery.recover(this.actor(user), id, dto);
  }

  @Get(':id/media/state')
  @ApiOperation({ summary: 'Get the current media stage.' })
  state(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.getMediaState(this.actor(user), id);
  }
}
```

Add to `controllers/index.ts`: `export * from './video-rooms-media.controller';`

> Confirm the exact import paths for `AuthenticatedUser`, `ParseUuidPipe`, `NotGuest`, `CurrentUser` from a sibling controller (`video-rooms-seats.controller.ts`) and copy them verbatim.

- [ ] **Step 4: Run — PASS** (+ `npx tsc --noEmit`). Run: `npx jest src/modules/video-rooms/controllers/video-rooms-media.controller.spec.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 media controller + swagger"`

---

### Task 19: Module wiring, README, `.env.example`, verification

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (register VR-5 providers + controller)
- Modify: `src/modules/video-rooms/README.md` (document the media engine)
- Modify: `.env.example` (already touched in Task 5 — confirm complete)
- Test: run the full suite + static gates

**Interfaces:**
- Consumes: every VR-5 provider created above.
- Produces: a fully wired, DI-resolvable media engine.

- [ ] **Step 1: Write the failing test** — a module compile test (mirror the existing module smoke test if present; otherwise rely on `Test.createTestingModule`):

```ts
// video-rooms.module.spec.ts (create if absent)
import { Test } from '@nestjs/testing';
import { VideoRoomsModule } from './video-rooms.module';
import { VideoRoomMediaService } from './services/video-room-media.service';

it('resolves the media service from the module graph', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [VideoRoomsModule] })
    // .overrideProvider(...) infra deps as the existing module tests do
    .compile();
  expect(moduleRef.get(VideoRoomMediaService)).toBeInstanceOf(VideoRoomMediaService);
});
```

> If the repo has no module-level test harness (infra providers make it heavy), skip this test and rely on `npx tsc --noEmit` + the app booting; note that in the commit.

- [ ] **Step 2: Run — FAIL** (provider not registered).

- [ ] **Step 3: Implement** — in `video-rooms.module.ts`, add under a new `// VR-5 media engine` comment in `providers`:

```ts
    // VR-5 media engine
    VideoRoomMediaStateService,
    VideoRoomMediaService,
    VideoRoomMediaRecoveryService,
    VideoRoomMediaSocketListener,
    VideoRoomMediaMetricsListener,
    VideoRoomMediaLifecycleListener,
    VideoRoomMediaMonitor,
```

and add `VideoRoomsMediaController` to the `controllers: [...]` array. Import each from its path. (`MediaTokenService`, `ZegoMediaProvider`, `MEDIA_PROVIDER` binding, and `VideoRoomMediaSessionRepository` are already registered — do not duplicate.)

Update `README.md` with a `## VR-5 Media Engine` section: the REST surface, socket events, Redis keys, the stream FSM, and the "ZEGO via shared MediaTokenService — no SDK re-init" note.

- [ ] **Step 4: Verify the whole phase** — run every gate and confirm green:

```bash
npx tsc --noEmit
npx eslint src/modules/video-rooms --max-warnings 0
npm run boundaries        # or: npx eslint --rulesdir ... / the repo's boundaries script
npx jest src/modules/video-rooms
```
Expected: 0 TS errors, 0 lint warnings, boundaries clean (video-rooms imports only from `common`/`infra`/its own tree — the media provider seam keeps ZEGO behind `MediaTokenService`), all new specs pass, and the pre-existing suite stays green (purely additive).

- [ ] **Step 5: Commit** — `git commit -am "feat(video-rooms): VR-5 wire media engine into module + README + verification"`

---

## Self-Review (completed by plan author)

**Spec coverage:** Media session lifecycle (T12) · publishing incl. dual-stream shape/dedup (T13) · subscription + caps (T14) · camera (T15) · microphone + admin force-mute (T15) · audio output (T15) · configurable + adaptive quality (T2, T15) · beauty (T3, T15) · 8-state stream FSM (T1) · network recovery/reconnect/republish/resubscribe/restore (T16) · Redis media sync (T5, T7) · socket events (T5, T9) · event bus (T8) · audit via `video_room_events` (T12–T16) · metrics (T10) · monitor (T17) · validations (seat/member/duplicate/limits — T12–T15) · REST + Swagger (T18) · DTOs (T11) · repository persistence (T6, T15, T17) · config (T5) · module wiring (T19). Every spec §7–§14 requirement maps to a task.

**Placeholder scan:** none — every code step contains real code; no "TBD/TODO/handle edge cases."

**Type consistency:** `MediaStageSnapshot`/`MediaParticipant`/`MediaStageView` are defined once (T4) and used verbatim in T7/T12–T17; `mutateStage(roomId, fn)` signature is identical in T12 and its callers (T13–T16); the renamed `MediaStreamPublishedEvent`/`MediaStreamStoppedEvent` (to avoid colliding with the existing `StreamStartedEvent`/`StreamStoppedEvent`) are used consistently in T8/T9/T13; `setSelfMedia`/`findStale`/`setZegoRoomId`/`setStreamingStatus` repo methods are defined and consumed in the same/adjacent tasks. `VideoQualityProfile.ADAPTIVE` is excluded from `PROFILE_BITRATE` and handled by `resolveBitrate`'s fallback.

**Known execution-order couplings (flagged in-task):** Task 1's `assertStreamTransition` references `ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE` which Task 5 adds — add that one code first if executing strictly in order. Confirm the exact `VIDEO_ROOM_EVENTS` bus-name constants (T17) and controller decorator import paths (T18) against sibling files before writing.

**Known simplifications (explicit, not silent):**
1. **Latency histograms.** T10 declares `video_rooms_media_{join,publish,subscribe}_seconds` + `observeMediaJoin/observePublish/observeSubscribe/observeMediaSessionDuration` helpers, but the T10 metrics listener only wires counters/gauges (event-driven). To populate the histograms, stamp `const t0 = Date.now()` at the top of `joinMedia`/`startPublish`/`subscribe`/`leaveMedia` (T12–T14) and, since the service must not depend on `VideoRoomsMetrics`, carry the elapsed ms on the corresponding event payload (`Base & { latencyMs?: number }`) so the metrics listener observes it. This is a ~1-line-per-verb add folded into T12–T14 during execution — call it out in each commit. (The counters/gauges the brief's monitoring list needs are fully wired; only the average-time histograms need this hook.)
2. **`SubscribeStreamDto.priority`** is captured and audited but does not reorder the subscription set this phase (auto-subscribe already slices to the cap). Ordering by priority is a later refinement.
3. **`videoRoomMediaHeartbeatKey`** is defined (T5) and reserved for a future fast-path; liveness detection actually uses the durable `video_room_sessions.lastHeartbeatAt` + `findStale` (T17), mirroring the audio `VoiceHeartbeatMonitor`. No Redis heartbeat marker is written this phase.

