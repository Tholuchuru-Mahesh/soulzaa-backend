# VR-11 Enterprise Treasure Box Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a configurable, sequential Treasure Box ladder for Video Rooms where gift value raises a progress counter, threshold crossings unlock boxes, and platform-minted reward pools are drawn and paid to eligible participants — automatically, atomically, and recoverably.

**Architecture:** Progress is a **counter, not an escrow** — gift coins are never consumed, so VR-10's creator-earnings path is untouched and `onSend` does no wallet work. A conditional `UPDATE … WHERE status = 'ACTIVE'` is the concurrency primitive that makes exactly one transaction the unlock owner. Combo gifts **chain** (each unlock enqueues the next) rather than fan out, guaranteeing ordered payouts and animations. All new code lives under `src/modules/video-rooms/`, reusing `RewardDistributor`, `QueueJobRegistry`, `LockService`, `CacheService` and the presence sets.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Redis (ioredis), BullMQ, Socket.IO, Jest, prom-client.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-22-video-room-phase11-treasure-engine-design.md` is normative. Where this plan and the spec disagree, the spec wins.
- **BC gate (mandatory):** No file under `src/modules/treasure-boxes/` or `src/modules/audio-rooms/` may be modified. `prisma/schema/treasure_boxes.prisma` **is** edited (additive enum values + columns) — that is not a `src/` file and is permitted.
- **Exactly one existing `src/` file is modified:** `src/modules/video-rooms/services/video-room-gift-context.handler.ts` (Task 14). Plus additive-only edits to shared registries: `error-codes.ts`, `configuration.ts`, `env.validation.ts`, `video-room-permissions.ts`, `video-rooms.metrics.ts`, `video-rooms.module.ts`, and `video-rooms/*/index.ts` barrels.
- **The video engine MUST NEVER write** `RoomContributionCounter` or `UserContributionCounter` (spec D10). Asserted by test in Task 25.
- **No hardcoded economics.** Thresholds, pool rates, winner counts and eligibility bounds come from `VideoRoomTreasureLevel` or config. Default ladder: **15,000 / 60,000 / 200,000 / 350,000**. Default pool: **1000 bps (10%)**. Default winners: **3**.
- **Postgres is authoritative for progress.** Redis is a read-through mirror only.
- **Money is `BigInt`** in Prisma and repository signatures; converted to `number` only at DTO/event boundaries.
- **Test style:** construct services directly with `as never` mocks (no Nest `TestingModule`); inject a clock as the last constructor param where time matters. Run with `npx jest <path>`.
- **Commit style:** `feat(vr-11): …`, `test(vr-11): …`, `chore(vr-11): …`. Never `git push`.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema/video_rooms_treasure.prisma` | 4 new models (video-owned) |
| `prisma/schema/treasure_boxes.prisma` *(mod)* | additive enum values + `TreasureReward` columns |
| `prisma/migrations/20260722000000_vr11_treasure_engine/migration.sql` | authored, **not applied** |
| `constants/video-room-treasure.constants.ts` | Redis keys, lock keys, socket events, queue job, stages |
| `config/video-room-treasure.config.ts` | typed `videoRoomTreasure` namespace |
| `exceptions/video-room-treasure.exceptions.ts` | 7 `BusinessException` subclasses |
| `events/video-room-treasure.events.ts` | 10 domain events + shared correlation envelope |
| `repositories/video-room-treasure.repository.ts` | levels, sessions, boxes, contributions |
| `repositories/video-room-treasure-reward.repository.ts` | pools, winners, reward rows |
| `services/video-room-treasure-level.seeder.ts` | default ladder seed |
| `services/video-room-treasure-pool.service.ts` | pool strategies |
| `services/video-room-treasure-eligibility.service.ts` | oversample → filter |
| `services/video-room-treasure-winner.service.ts` | strategy registry + 5 strategies |
| `services/video-room-treasure.service.ts` | lifecycle state machine (RBAC-gated) |
| `services/video-room-treasure-progress.service.ts` | cascade + claim + throttled emit |
| `services/video-room-treasure-unlock.service.ts` | 9-step pipeline, queue-driven |
| `services/video-room-treasure-recovery.service.ts` | DLQ replay + orphan reconciliation |
| `services/video-room-treasure-query.service.ts` | status / history / winners / statistics |
| `dto/video-room-treasure.dto.ts` | 6 DTOs, Swagger-annotated |
| `controllers/video-rooms-treasure.controller.ts` | 10 endpoints |
| `listeners/video-room-treasure-socket.listener.ts` | 7 socket events + throttle |
| `listeners/video-room-treasure-metrics.listener.ts` | 8 metrics |
| `listeners/video-room-treasure-audit.listener.ts` | `VideoRoomEvent` rows |

---

## Task 1: Release-gate baseline

**Files:**
- Create: `docs/superpowers/plans/vr11-baseline.txt`

**Interfaces:**
- Consumes: nothing.
- Produces: the recorded baseline numbers Task 25 asserts against.

- [ ] **Step 1: Capture the full-suite baseline**

Run: `npx jest --silent 2>&1 | tail -20`
Expected: a summary line like `Tests: N passed, N total`. Record N.

- [ ] **Step 2: Capture the BC suites specifically**

Run: `npx jest src/modules/treasure-boxes --silent 2>&1 | tail -10`
Expected: all pass. Record the count.

- [ ] **Step 3: Record the protected-file hashes**

```bash
git ls-files src/modules/treasure-boxes src/modules/audio-rooms \
  | xargs shasum > docs/superpowers/plans/vr11-baseline.txt
npx jest --silent 2>&1 | tail -5 >> docs/superpowers/plans/vr11-baseline.txt
```

- [ ] **Step 4: Verify tsc and lint are clean before we start**

Run: `npx tsc --noEmit && npx eslint "src/**/*.ts" --max-warnings 0`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/vr11-baseline.txt
git commit -m "chore(vr-11): record BC release-gate baseline"
```

---

## Task 2: Prisma schema and migration

**Files:**
- Create: `prisma/schema/video_rooms_treasure.prisma`
- Modify: `prisma/schema/treasure_boxes.prisma` (enum values + `TreasureReward` columns only)
- Create: `prisma/migrations/20260722000000_vr11_treasure_engine/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma client types `VideoRoomTreasureLevel`, `VideoRoomTreasureSession`, `TreasureRewardPool`, `TreasureWinner`, `TreasureRewardStatus`; enum members `TreasureSessionStatus.{DRAFT,PAUSED,CLOSED,ARCHIVED}` and `TreasureBoxStatus.UNLOCKING`. Every later task depends on these.

- [ ] **Step 1: Create the video-owned models**

Create `prisma/schema/video_rooms_treasure.prisma`:

```prisma
// ============================================================
// VR-11 Treasure Box Engine (Video Rooms). Video-owned tables.
// TreasureSession / TreasureBox / TreasureContribution / TreasureReward
// are SHARED with audio rooms and are safe to share because every audio
// query is scoped by roomId/sessionId/boxId. TreasureBoxConfig is NOT
// shared — it is globally keyed by `level @unique` and read unfiltered by
// the audio engine, so video gets its own level table.
// ============================================================

/// The video-room treasure ladder. Global (one ladder for all video rooms),
/// mirroring how audio configures its own. Frozen into a session at create.
model VideoRoomTreasureLevel {
  id                String   @id @default(uuid()) @db.Uuid
  level             Int      @unique
  threshold         BigInt
  enabled           Boolean  @default(true)
  poolStrategy      String   @default("PERCENTAGE")
  poolPercentBps    Int      @default(1000)
  poolFixedAmount   BigInt?
  winnerAlgorithm   String   @default("RANDOM")
  winnerCount       Int      @default(3)
  minStaySeconds    Int      @default(120)
  minActivityEvents Int      @default(0)

  createdBy String?  @db.Uuid
  updatedBy String?  @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("video_room_treasure_levels")
}

/// 1:1 extension of TreasureSession for video-only state. `levelSnapshot`
/// freezes the whole ladder at create time so an admin editing
/// VideoRoomTreasureLevel cannot change a running session's rules.
model VideoRoomTreasureSession {
  id            String   @id @default(uuid()) @db.Uuid
  sessionId     String   @unique @db.Uuid
  roomId        String   @db.Uuid
  levelSnapshot Json
  createdBy     String   @db.Uuid
  createdAt     DateTime @default(now())

  @@index([roomId])
  @@map("video_room_treasure_sessions")
}

/// The minted pool for one unlocked box. `boxId @unique` makes a replayed
/// unlock job fail closed at the database rather than mint twice.
model TreasureRewardPool {
  id               String   @id @default(uuid()) @db.Uuid
  boxId            String   @unique @db.Uuid
  sessionId        String   @db.Uuid
  roomId           String   @db.Uuid
  level            Int
  strategy         String
  sourceAmount     BigInt
  poolAmount       BigInt
  allocatedAmount  BigInt   @default(0)
  winnerCount      Int
  algorithm        String
  algorithmVersion Int      @default(1)
  selectionSeed    String
  computedAt       DateTime @default(now())

  @@index([roomId])
  @@index([sessionId])
  @@map("treasure_reward_pools")
}

/// One winner of one box. The unique constraint is the primary
/// duplicate-reward defence and lives on a video-owned table.
model TreasureWinner {
  id             String   @id @default(uuid()) @db.Uuid
  boxId          String   @db.Uuid
  sessionId      String   @db.Uuid
  roomId         String   @db.Uuid
  userId         String   @db.Uuid
  algorithm      String
  shareBps       Int
  amount         BigInt
  eligibleCount  Int
  candidateCount Int
  selectedAt     DateTime @default(now())

  @@unique([boxId, userId])
  @@index([roomId])
  @@index([userId])
  @@map("treasure_winners")
}
```

- [ ] **Step 2: Extend the shared enums and `TreasureReward`**

In `prisma/schema/treasure_boxes.prisma`, replace the two enum blocks and add columns to `TreasureReward`. **Change nothing else in this file.**

```prisma
enum TreasureSessionStatus {
  ACTIVE
  COMPLETED
  CANCELLED
  // ---- VR-11 (video rooms only; audio never writes these) ----
  DRAFT
  PAUSED
  CLOSED
  ARCHIVED
}

enum TreasureBoxStatus {
  PENDING
  ACTIVE
  OPENED
  // ---- VR-11: the unlock claim ticket. Audio never writes it. ----
  UNLOCKING
}

/// VR-11: distribution lifecycle for retry/recovery. Defaults to DISTRIBUTED
/// so every pre-existing and audio-written row stays semantically correct —
/// a TreasureReward row has only ever been written after a successful payout.
/// The video pipeline explicitly writes PENDING first, then flips it.
enum TreasureRewardStatus {
  PENDING
  DISTRIBUTED
  FAILED
}
```

Then inside `model TreasureReward`, after `backpackItemId`:

```prisma
  status        TreasureRewardStatus @default(DISTRIBUTED)
  attempts      Int                  @default(0)
  lastError     String?
  failureStage  String?
  distributedAt DateTime?
```

- [ ] **Step 3: Author the migration (do NOT apply it)**

Create `prisma/migrations/20260722000000_vr11_treasure_engine/migration.sql`:

```sql
-- VR-11 Treasure Box Engine. Fully additive: every column is new or defaulted,
-- so this applies to a running instance with no backfill and no downtime.

ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
ALTER TYPE "TreasureBoxStatus"     ADD VALUE IF NOT EXISTS 'UNLOCKING';

CREATE TYPE "TreasureRewardStatus" AS ENUM ('PENDING', 'DISTRIBUTED', 'FAILED');

ALTER TABLE "treasure_rewards"
  ADD COLUMN "status"        "TreasureRewardStatus" NOT NULL DEFAULT 'DISTRIBUTED',
  ADD COLUMN "attempts"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError"     TEXT,
  ADD COLUMN "failureStage"  TEXT,
  ADD COLUMN "distributedAt" TIMESTAMP(3);

CREATE TABLE "video_room_treasure_levels" (
  "id" UUID NOT NULL,
  "level" INTEGER NOT NULL,
  "threshold" BIGINT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "poolStrategy" TEXT NOT NULL DEFAULT 'PERCENTAGE',
  "poolPercentBps" INTEGER NOT NULL DEFAULT 1000,
  "poolFixedAmount" BIGINT,
  "winnerAlgorithm" TEXT NOT NULL DEFAULT 'RANDOM',
  "winnerCount" INTEGER NOT NULL DEFAULT 3,
  "minStaySeconds" INTEGER NOT NULL DEFAULT 120,
  "minActivityEvents" INTEGER NOT NULL DEFAULT 0,
  "createdBy" UUID, "updatedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "video_room_treasure_levels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_treasure_levels_level_key"
  ON "video_room_treasure_levels"("level");

CREATE TABLE "video_room_treasure_sessions" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "levelSnapshot" JSONB NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_treasure_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_treasure_sessions_sessionId_key"
  ON "video_room_treasure_sessions"("sessionId");
CREATE INDEX "video_room_treasure_sessions_roomId_idx"
  ON "video_room_treasure_sessions"("roomId");

CREATE TABLE "treasure_reward_pools" (
  "id" UUID NOT NULL,
  "boxId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "level" INTEGER NOT NULL,
  "strategy" TEXT NOT NULL,
  "sourceAmount" BIGINT NOT NULL,
  "poolAmount" BIGINT NOT NULL,
  "allocatedAmount" BIGINT NOT NULL DEFAULT 0,
  "winnerCount" INTEGER NOT NULL,
  "algorithm" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL DEFAULT 1,
  "selectionSeed" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasure_reward_pools_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "treasure_reward_pools_boxId_key" ON "treasure_reward_pools"("boxId");
CREATE INDEX "treasure_reward_pools_roomId_idx" ON "treasure_reward_pools"("roomId");
CREATE INDEX "treasure_reward_pools_sessionId_idx" ON "treasure_reward_pools"("sessionId");

CREATE TABLE "treasure_winners" (
  "id" UUID NOT NULL,
  "boxId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "algorithm" TEXT NOT NULL,
  "shareBps" INTEGER NOT NULL,
  "amount" BIGINT NOT NULL,
  "eligibleCount" INTEGER NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasure_winners_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "treasure_winners_boxId_userId_key" ON "treasure_winners"("boxId", "userId");
CREATE INDEX "treasure_winners_roomId_idx" ON "treasure_winners"("roomId");
CREATE INDEX "treasure_winners_userId_idx" ON "treasure_winners"("userId");
```

- [ ] **Step 4: Generate the client and verify types**

Run: `npx prisma generate && npx tsc --noEmit`
Expected: generate succeeds; `tsc` clean. If `tsc` reports errors in `treasure-boxes/`, **stop** — the enum change was not additive and the BC gate is broken.

- [ ] **Step 5: Verify the audio suite still passes against the new client**

Run: `npx jest src/modules/treasure-boxes --silent 2>&1 | tail -5`
Expected: same pass count as the Task 1 baseline.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema/video_rooms_treasure.prisma prisma/schema/treasure_boxes.prisma prisma/migrations
git commit -m "feat(vr-11): add treasure engine schema and migration"
```

---

## Task 3: Constants

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-treasure.constants.ts`
- Test: `src/modules/video-rooms/constants/video-room-treasure.constants.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `VIDEO_ROOM_TREASURE_SOCKET_EVENTS` (7 keys), `VIDEO_ROOM_TREASURE_QUEUE_JOB: string`
  - `treasureUnlockLockKey(roomId): string`, `treasureLifecycleLockKey(roomId): string`
  - `treasureProgressKey(roomId)`, `treasureLevelKey(roomId)`, `treasureActivityKey(roomId, sessionId)`, `treasureEmitKey(roomId)`, `treasureStatsKey(roomId, sessionId)`
  - `TreasureUnlockStage` (const object + type), `TREASURE_CONTEXT_TYPE`
  - `TreasurePoolStrategy`, `TreasureWinnerAlgorithm` (const objects + types)

- [ ] **Step 1: Write the failing test**

Create `video-room-treasure.constants.spec.ts`:

```ts
import {
  TREASURE_CONTEXT_TYPE,
  TreasurePoolStrategy,
  TreasureUnlockStage,
  TreasureWinnerAlgorithm,
  treasureActivityKey,
  treasureEmitKey,
  treasureLevelKey,
  treasureProgressKey,
  treasureUnlockLockKey,
  VIDEO_ROOM_TREASURE_SOCKET_EVENTS,
} from './video-room-treasure.constants';

describe('video-room treasure constants', () => {
  it('exposes the seven socket events the spec names', () => {
    expect(Object.values(VIDEO_ROOM_TREASURE_SOCKET_EVENTS)).toEqual([
      'treasureProgressUpdated',
      'treasureUnlocked',
      'treasureWinnerSelected',
      'treasureRewardDistributed',
      'treasureLevelChanged',
      'treasureAnimation',
      'treasureRecovered',
    ]);
  });

  it('hash-tags per-room lock keys so Redis Cluster keeps them in one slot', () => {
    expect(treasureUnlockLockKey('r1')).toBe('video-room:treasure:unlock:{r1}');
  });

  it('namespaces every Redis key under video-room:treasure', () => {
    expect(treasureProgressKey('r1')).toBe('video-room:treasure:progress:r1');
    expect(treasureLevelKey('r1')).toBe('video-room:treasure:level:r1');
    expect(treasureActivityKey('r1', 's1')).toBe('video-room:treasure:activity:r1:s1');
    expect(treasureEmitKey('r1')).toBe('video-room:treasure:emit:r1');
  });

  it('names the context type once so no service spells VIDEO_ROOM inline', () => {
    expect(TREASURE_CONTEXT_TYPE).toBe('VIDEO_ROOM');
  });

  it('enumerates every pipeline stage for failure attribution', () => {
    expect(Object.values(TreasureUnlockStage)).toEqual([
      'VALIDATE',
      'POOL',
      'ELIGIBILITY',
      'WINNER_SELECTION',
      'DISTRIBUTION',
      'BROADCAST',
      'CHAIN',
      'RECOVERY',
    ]);
  });

  it('defaults to PERCENTAGE pool and RANDOM winners', () => {
    expect(TreasurePoolStrategy.PERCENTAGE).toBe('PERCENTAGE');
    expect(TreasureWinnerAlgorithm.RANDOM).toBe('RANDOM');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/constants/video-room-treasure.constants.spec.ts`
Expected: FAIL — `Cannot find module './video-room-treasure.constants'`.

- [ ] **Step 3: Write the implementation**

Create `video-room-treasure.constants.ts`:

```ts
/**
 * VR-11 treasure engine constants: the `/video-room` socket vocabulary, the
 * BullMQ job name, every Redis key the engine owns, and the closed vocabularies
 * for pool strategy, winner algorithm and pipeline stage.
 *
 * Per-room LOCK keys are hash-tagged `{roomId}` so Redis Cluster routes them to
 * one slot (the AR-6 `treasureRoomLockKey` convention). Plain data keys are not
 * hash-tagged — they are read individually, never in a multi-key command.
 */

/** The `TreasureSession.contextType` discriminator. Never spelled inline. */
export const TREASURE_CONTEXT_TYPE = 'VIDEO_ROOM';

/** Outbound socket events on the `/video-room` namespace. */
export const VIDEO_ROOM_TREASURE_SOCKET_EVENTS = {
  PROGRESS_UPDATED: 'treasureProgressUpdated',
  UNLOCKED: 'treasureUnlocked',
  WINNER_SELECTED: 'treasureWinnerSelected',
  REWARD_DISTRIBUTED: 'treasureRewardDistributed',
  LEVEL_CHANGED: 'treasureLevelChanged',
  ANIMATION: 'treasureAnimation',
  RECOVERED: 'treasureRecovered',
} as const;

/** BullMQ job name registered on QUEUE_NAMES.GIFT_PROCESSING. */
export const VIDEO_ROOM_TREASURE_QUEUE_JOB = 'video-room.treasure.unlock';

/** Serialises unlock execution per room so payouts and animations stay ordered. */
export function treasureUnlockLockKey(roomId: string): string {
  return `video-room:treasure:unlock:{${roomId}}`;
}

/** Serialises owner lifecycle commands per room. */
export function treasureLifecycleLockKey(roomId: string): string {
  return `video-room:treasure:lifecycle:{${roomId}}`;
}

/** HASH level -> progress. A read-through mirror; Postgres is authoritative. */
export function treasureProgressKey(roomId: string): string {
  return `video-room:treasure:progress:${roomId}`;
}

/** STRING current level. */
export function treasureLevelKey(roomId: string): string {
  return `video-room:treasure:level:${roomId}`;
}

/** HASH userId -> activity event count, for the eligibility filter. */
export function treasureActivityKey(roomId: string, sessionId: string): string {
  return `video-room:treasure:activity:${roomId}:${sessionId}`;
}

/** Throttle stamp for treasureProgressUpdated coalescing. */
export function treasureEmitKey(roomId: string): string {
  return `video-room:treasure:emit:${roomId}`;
}

/** HASH of temporary session statistics. */
export function treasureStatsKey(roomId: string, sessionId: string): string {
  return `video-room:treasure:stats:${roomId}:${sessionId}`;
}

/**
 * Where an unlock failed. Persisted on the reward row, attached to the failure
 * event and emitted as a metric label, so an operator attributes a failure
 * without reading code.
 */
export const TreasureUnlockStage = {
  VALIDATE: 'VALIDATE',
  POOL: 'POOL',
  ELIGIBILITY: 'ELIGIBILITY',
  WINNER_SELECTION: 'WINNER_SELECTION',
  DISTRIBUTION: 'DISTRIBUTION',
  BROADCAST: 'BROADCAST',
  CHAIN: 'CHAIN',
  RECOVERY: 'RECOVERY',
} as const;
export type TreasureUnlockStage =
  (typeof TreasureUnlockStage)[keyof typeof TreasureUnlockStage];

export const TreasurePoolStrategy = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
  ADMIN_OVERRIDE: 'ADMIN_OVERRIDE',
} as const;
export type TreasurePoolStrategy =
  (typeof TreasurePoolStrategy)[keyof typeof TreasurePoolStrategy];

export const TreasureWinnerAlgorithm = {
  RANDOM: 'RANDOM',
  WEIGHTED_RANDOM: 'WEIGHTED_RANDOM',
  ACTIVITY_BASED: 'ACTIVITY_BASED',
  CONTRIBUTION_BASED: 'CONTRIBUTION_BASED',
  VIP_PRIORITY: 'VIP_PRIORITY',
} as const;
export type TreasureWinnerAlgorithm =
  (typeof TreasureWinnerAlgorithm)[keyof typeof TreasureWinnerAlgorithm];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/constants/video-room-treasure.constants.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/constants/video-room-treasure.constants.ts \
        src/modules/video-rooms/constants/video-room-treasure.constants.spec.ts
git commit -m "feat(vr-11): add treasure engine constants"
```

---

## Task 4: Configuration namespace

**Files:**
- Create: `src/modules/video-rooms/config/video-room-treasure.config.ts`
- Test: `src/modules/video-rooms/config/video-room-treasure.config.spec.ts`
- Modify: `src/config/configuration.ts` (append one `registerAs`)
- Modify: `src/config/env.validation.ts` (append the vars)
- Modify: `.env.example` (append the vars)

**Interfaces:**
- Consumes: `toBool` from `./video-room-gift.config`.
- Produces: `interface VideoRoomTreasureConfig` and `loadVideoRoomTreasureConfig(config: ConfigService): VideoRoomTreasureConfig` with fields `enabled, poolBps, winnerCount, oversampleFactor, oversampleMin, minStaySeconds, minActivityEvents, progressEmitPerSecond, orphanTimeoutSeconds, recoveryEnabled, monitorIntervalSeconds`.

- [ ] **Step 1: Write the failing test**

Create `video-room-treasure.config.spec.ts`:

```ts
import { loadVideoRoomTreasureConfig } from './video-room-treasure.config';

const svc = (raw: unknown) => ({ get: () => raw }) as never;

describe('loadVideoRoomTreasureConfig', () => {
  it('coerces env strings to numbers', () => {
    const cfg = loadVideoRoomTreasureConfig(
      svc({ enabled: 'true', poolBps: '1000', winnerCount: '3', oversampleFactor: '3',
            oversampleMin: '50', minStaySeconds: '120', minActivityEvents: '0',
            progressEmitPerSecond: '5', orphanTimeoutSeconds: '120',
            recoveryEnabled: 'false', monitorIntervalSeconds: '30' }),
    );
    expect(cfg.poolBps).toBe(1000);
    expect(cfg.winnerCount).toBe(3);
    expect(cfg.progressEmitPerSecond).toBe(5);
  });

  // The repo-wide z.coerce.boolean() idiom turns the STRING "false" into true,
  // which would silently enable DLQ replay in production. toBool must not.
  it('treats the string "false" as false, not as a truthy non-empty string', () => {
    const cfg = loadVideoRoomTreasureConfig(
      svc({ enabled: 'false', recoveryEnabled: 'false', poolBps: '1000' }),
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.recoveryEnabled).toBe(false);
  });

  it('throws when the namespace is not registered', () => {
    expect(() => loadVideoRoomTreasureConfig(svc(undefined))).toThrow(
      'videoRoomTreasure config namespace is not registered',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/config/video-room-treasure.config.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `video-room-treasure.config.ts`:

```ts
import type { ConfigService } from '@nestjs/config';
import { toBool } from './video-room-gift.config';

/**
 * Typed view of the `videoRoomTreasure` namespace. Namespaced config surfaces as
 * raw process.env strings at runtime, so every value is re-coerced here once —
 * the VR-10 approach. `toBool` is reused rather than re-derived: the repo-wide
 * `z.coerce.boolean()` idiom turns the STRING "false" into `true`, so an operator
 * writing VIDEO_ROOM_TREASURE_RECOVERY_ENABLED=false would silently enable DLQ
 * replay in production.
 */
export interface VideoRoomTreasureConfig {
  /** Master switch. When false, onSend is a no-op and lifecycle POSTs 403. */
  enabled: boolean;
  /** Default pool share in basis points (1000 = 10%). */
  poolBps: number;
  /** Default winners drawn per box. */
  winnerCount: number;
  /** Candidate oversample multiple of winnerCount. */
  oversampleFactor: number;
  /** Floor on the oversample, so small draws still sample widely. */
  oversampleMin: number;
  minStaySeconds: number;
  minActivityEvents: number;
  /** Ceiling on treasureProgressUpdated broadcasts per room per second. */
  progressEmitPerSecond: number;
  /** A box UNLOCKING longer than this with no pool row is re-enqueued. */
  orphanTimeoutSeconds: number;
  recoveryEnabled: boolean;
  monitorIntervalSeconds: number;
}

interface RawVideoRoomTreasureConfig {
  enabled: boolean | string;
  poolBps: number | string;
  winnerCount: number | string;
  oversampleFactor: number | string;
  oversampleMin: number | string;
  minStaySeconds: number | string;
  minActivityEvents: number | string;
  progressEmitPerSecond: number | string;
  orphanTimeoutSeconds: number | string;
  recoveryEnabled: boolean | string;
  monitorIntervalSeconds: number | string;
}

/** Coerce with a fallback, so a blank env var cannot produce NaN. */
function num(value: number | string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadVideoRoomTreasureConfig(config: ConfigService): VideoRoomTreasureConfig {
  const raw = config.get<RawVideoRoomTreasureConfig>('videoRoomTreasure');
  if (!raw) {
    throw new Error('videoRoomTreasure config namespace is not registered');
  }
  return {
    enabled: toBool(raw.enabled, true),
    poolBps: num(raw.poolBps, 1000),
    winnerCount: num(raw.winnerCount, 3),
    oversampleFactor: num(raw.oversampleFactor, 3),
    oversampleMin: num(raw.oversampleMin, 50),
    minStaySeconds: num(raw.minStaySeconds, 120),
    minActivityEvents: num(raw.minActivityEvents, 0),
    progressEmitPerSecond: num(raw.progressEmitPerSecond, 5),
    orphanTimeoutSeconds: num(raw.orphanTimeoutSeconds, 120),
    recoveryEnabled: toBool(raw.recoveryEnabled, false),
    monitorIntervalSeconds: num(raw.monitorIntervalSeconds, 30),
  };
}
```

- [ ] **Step 4: Register the namespace**

Append to `src/config/configuration.ts` (next to the existing `videoRoomGift` factory):

```ts
export const videoRoomTreasureConfig = registerAs('videoRoomTreasure', () => ({
  enabled: process.env.VIDEO_ROOM_TREASURE_ENABLED ?? 'true',
  poolBps: process.env.VIDEO_ROOM_TREASURE_POOL_BPS ?? '1000',
  winnerCount: process.env.VIDEO_ROOM_TREASURE_WINNER_COUNT ?? '3',
  oversampleFactor: process.env.VIDEO_ROOM_TREASURE_OVERSAMPLE_FACTOR ?? '3',
  oversampleMin: process.env.VIDEO_ROOM_TREASURE_OVERSAMPLE_MIN ?? '50',
  minStaySeconds: process.env.VIDEO_ROOM_TREASURE_MIN_STAY_SECONDS ?? '120',
  minActivityEvents: process.env.VIDEO_ROOM_TREASURE_MIN_ACTIVITY_EVENTS ?? '0',
  progressEmitPerSecond: process.env.VIDEO_ROOM_TREASURE_PROGRESS_EMIT_PER_SECOND ?? '5',
  orphanTimeoutSeconds: process.env.VIDEO_ROOM_TREASURE_ORPHAN_TIMEOUT_SECONDS ?? '120',
  recoveryEnabled: process.env.VIDEO_ROOM_TREASURE_RECOVERY_ENABLED ?? 'false',
  monitorIntervalSeconds: process.env.VIDEO_ROOM_TREASURE_MONITOR_INTERVAL_SECONDS ?? '30',
}));
```

Add `videoRoomTreasureConfig` to the array this file exports for `ConfigModule.forRoot({ load: [...] })` — find the existing `videoRoomGiftConfig` entry and add the new one immediately after it.

- [ ] **Step 5: Add the env vars**

Append the eleven `VIDEO_ROOM_TREASURE_*` vars to `.env.example` with the defaults above, and add matching **optional** entries to the schema in `src/config/env.validation.ts` (mirror how the `VIDEO_ROOM_GIFT_*` vars are declared — all optional strings, so a deployment without them still boots).

- [ ] **Step 6: Run tests and typecheck**

Run: `npx jest src/modules/video-rooms/config && npx tsc --noEmit`
Expected: PASS, 3 tests; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/modules/video-rooms/config src/config .env.example
git commit -m "feat(vr-11): add videoRoomTreasure config namespace"
```

---

## Task 5: Error codes and exceptions

**Files:**
- Create: `src/modules/video-rooms/exceptions/video-room-treasure.exceptions.ts`
- Test: `src/modules/video-rooms/exceptions/video-room-treasure.exceptions.spec.ts`
- Modify: `src/common/exceptions/error-codes.ts` (append 11 codes)

**Interfaces:**
- Consumes: `BusinessException`, `ERROR_CODES`.
- Produces: `TreasureBoxException`, `TreasureProgressException`, `TreasureUnlockException`, `RewardPoolException`, `WinnerSelectionException`, `RewardDistributionException`, `DuplicateRewardException`. Each constructor is `(message: string, status?: HttpStatus)` and binds its own `errorCode`.

- [ ] **Step 1: Write the failing test**

```ts
import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from 'src/common/exceptions';
import {
  DuplicateRewardException,
  RewardDistributionException,
  RewardPoolException,
  TreasureBoxException,
  TreasureProgressException,
  TreasureUnlockException,
  WinnerSelectionException,
} from './video-room-treasure.exceptions';

describe('video-room treasure exceptions', () => {
  it.each([
    [TreasureBoxException, ERROR_CODES.VIDEO_ROOM_TREASURE_INVALID],
    [TreasureProgressException, ERROR_CODES.VIDEO_ROOM_TREASURE_PROGRESS_FAILED],
    [TreasureUnlockException, ERROR_CODES.VIDEO_ROOM_TREASURE_UNLOCK_FAILED],
    [RewardPoolException, ERROR_CODES.VIDEO_ROOM_TREASURE_POOL_INVALID],
    [WinnerSelectionException, ERROR_CODES.VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED],
    [RewardDistributionException, ERROR_CODES.VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED],
    [DuplicateRewardException, ERROR_CODES.VIDEO_ROOM_TREASURE_DUPLICATE_REWARD],
  ])('binds its own error code', (Ctor, code) => {
    const err = new (Ctor as new (m: string) => { errorCode: string })('boom');
    expect(err.errorCode).toBe(code);
  });

  it('defaults to 409 CONFLICT — these are state conflicts, not bad input', () => {
    expect(new TreasureUnlockException('x').getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('accepts a status override', () => {
    expect(new TreasureBoxException('x', HttpStatus.FORBIDDEN).getStatus()).toBe(
      HttpStatus.FORBIDDEN,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/exceptions`
Expected: FAIL — module not found.

- [ ] **Step 3: Append the error codes**

In `src/common/exceptions/error-codes.ts`, after the existing `TREASURE_*` block, append:

```ts
  // ---- VR-11 video room treasure ----
  VIDEO_ROOM_TREASURE_INVALID: 'VIDEO_ROOM_TREASURE_INVALID',
  VIDEO_ROOM_TREASURE_PROGRESS_FAILED: 'VIDEO_ROOM_TREASURE_PROGRESS_FAILED',
  VIDEO_ROOM_TREASURE_UNLOCK_FAILED: 'VIDEO_ROOM_TREASURE_UNLOCK_FAILED',
  VIDEO_ROOM_TREASURE_POOL_INVALID: 'VIDEO_ROOM_TREASURE_POOL_INVALID',
  VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED: 'VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED',
  VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED: 'VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED',
  VIDEO_ROOM_TREASURE_DUPLICATE_REWARD: 'VIDEO_ROOM_TREASURE_DUPLICATE_REWARD',
  VIDEO_ROOM_TREASURE_NOT_FOUND: 'VIDEO_ROOM_TREASURE_NOT_FOUND',
  VIDEO_ROOM_TREASURE_ALREADY_ACTIVE: 'VIDEO_ROOM_TREASURE_ALREADY_ACTIVE',
  VIDEO_ROOM_TREASURE_DISABLED: 'VIDEO_ROOM_TREASURE_DISABLED',
  VIDEO_ROOM_TREASURE_NOT_AUTHORIZED: 'VIDEO_ROOM_TREASURE_NOT_AUTHORIZED',
```

- [ ] **Step 4: Write the exceptions**

```ts
import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

/**
 * VR-11 domain exceptions. Each is a thin BusinessException subclass that binds
 * its own error code, so callers get a named type while the global ERROR_CODES
 * registry stays the single source of truth for clients.
 *
 * They default to 409 CONFLICT rather than 400: every one of these fires when the
 * request was well-formed but the treasure state disallows it (wrong session
 * state, box already opened, reward already paid). A 400 would tell the client to
 * fix its payload, which is the wrong instruction.
 */
export class TreasureBoxException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_INVALID, message, status);
  }
}

export class TreasureProgressException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_PROGRESS_FAILED, message, status);
  }
}

export class TreasureUnlockException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_UNLOCK_FAILED, message, status);
  }
}

export class RewardPoolException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_POOL_INVALID, message, status);
  }
}

export class WinnerSelectionException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED, message, status);
  }
}

export class RewardDistributionException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED, message, status);
  }
}

export class DuplicateRewardException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_DUPLICATE_REWARD, message, status);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/exceptions`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/exceptions src/common/exceptions/error-codes.ts
git commit -m "feat(vr-11): add treasure error codes and exceptions"
```

---

## Task 6: Domain events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-treasure.events.ts`
- Test: `src/modules/video-rooms/events/video-room-treasure.events.spec.ts`

**Interfaces:**
- Consumes: `DomainEvent` from `src/common/events`.
- Produces: `VIDEO_ROOM_TREASURE_EVENTS` (name registry) and 10 event classes:
  `TreasureCreatedEvent`, `TreasureStartedEvent`, `TreasureProgressUpdatedEvent`,
  `TreasureUnlockedEvent`, `TreasureRewardGeneratedEvent`, `TreasureWinnerSelectedEvent`,
  `TreasureRewardDistributedEvent`, `TreasureClosedEvent`, `TreasureRecoveredEvent`,
  `TreasureUnlockFailedEvent`. All payloads extend `TreasureEventBase`:
  `{ correlationId, roomId, sessionId, boxId?, level?, batchId? }`.

- [ ] **Step 1: Write the failing test**

```ts
import {
  TreasureProgressUpdatedEvent,
  TreasureUnlockFailedEvent,
  TreasureUnlockedEvent,
  VIDEO_ROOM_TREASURE_EVENTS,
} from './video-room-treasure.events';

describe('video-room treasure events', () => {
  it('dot-namespaces every event name under video_room.treasure', () => {
    for (const name of Object.values(VIDEO_ROOM_TREASURE_EVENTS)) {
      expect(name).toMatch(/^video_room\.treasure\./);
    }
  });

  it('carries the full correlation envelope on every payload', () => {
    const e = new TreasureUnlockedEvent({
      correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 2,
      poolAmount: 6000, winners: [{ userId: 'u1', amount: 2000, shareBps: 3333 }],
      algorithm: 'RANDOM', nextLevel: 3,
    });
    expect(e.name).toBe(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED);
    expect(e.payload.correlationId).toBe('c1');
    expect(e.payload.boxId).toBe('b1');
    expect(e.payload.level).toBe(2);
  });

  it('stamps eventId and occurredAt from the DomainEvent base', () => {
    const e = new TreasureProgressUpdatedEvent({
      correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1,
      progress: 500, threshold: 15000, percent: 3.33,
    });
    expect(e.eventId).toEqual(expect.any(String));
    expect(e.occurredAt).toEqual(expect.any(String));
  });

  it('names the failing stage so failures are attributable without code reading', () => {
    const e = new TreasureUnlockFailedEvent({
      correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1,
      stage: 'DISTRIBUTION', attempt: 2, error: 'wallet timeout',
    });
    expect(e.payload.stage).toBe('DISTRIBUTION');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room-treasure.events.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { DomainEvent } from 'src/common/events';
import type { TreasureUnlockStage } from '../constants/video-room-treasure.constants';

/**
 * VR-11 treasure events. Every payload extends TreasureEventBase so a consumer
 * — socket listener, metrics listener, audit listener — can correlate any event
 * back to its room, session, box and level without a lookup, and so one
 * `correlationId` threads a complete unlock lifecycle through VideoRoomEvent.
 */
export const VIDEO_ROOM_TREASURE_EVENTS = {
  CREATED: 'video_room.treasure.created',
  STARTED: 'video_room.treasure.started',
  PROGRESS_UPDATED: 'video_room.treasure.progress_updated',
  UNLOCKED: 'video_room.treasure.unlocked',
  REWARD_GENERATED: 'video_room.treasure.reward_generated',
  WINNER_SELECTED: 'video_room.treasure.winner_selected',
  REWARD_DISTRIBUTED: 'video_room.treasure.reward_distributed',
  CLOSED: 'video_room.treasure.closed',
  RECOVERED: 'video_room.treasure.recovered',
  UNLOCK_FAILED: 'video_room.treasure.unlock_failed',
} as const;

/** The correlation envelope every treasure event carries. */
export interface TreasureEventBase {
  correlationId: string;
  roomId: string;
  sessionId: string;
  boxId?: string;
  level?: number;
  /** Present when a gift batch originated the event. */
  batchId?: string;
}

export interface TreasureWinnerPayload {
  userId: string;
  amount: number;
  shareBps: number;
}

export class TreasureCreatedEvent extends DomainEvent<
  TreasureEventBase & { createdBy: string; levels: number[] }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.CREATED;
}

export class TreasureStartedEvent extends DomainEvent<
  TreasureEventBase & { startedBy: string; threshold: number }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.STARTED;
}

export class TreasureProgressUpdatedEvent extends DomainEvent<
  TreasureEventBase & { progress: number; threshold: number; percent: number }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED;
}

export class TreasureRewardGeneratedEvent extends DomainEvent<
  TreasureEventBase & {
    strategy: string;
    poolAmount: number;
    sourceAmount: number;
    winnerCount: number;
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED;
}

export class TreasureWinnerSelectedEvent extends DomainEvent<
  TreasureEventBase & {
    algorithm: string;
    algorithmVersion: number;
    eligibleCount: number;
    candidateCount: number;
    winners: TreasureWinnerPayload[];
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED;
}

export class TreasureRewardDistributedEvent extends DomainEvent<
  TreasureEventBase & {
    userId: string;
    amount: number;
    walletTxnId: string | null;
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED;
}

export class TreasureUnlockedEvent extends DomainEvent<
  TreasureEventBase & {
    poolAmount: number;
    winners: TreasureWinnerPayload[];
    algorithm: string;
    /** null when the ladder just completed. */
    nextLevel: number | null;
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED;
}

export class TreasureClosedEvent extends DomainEvent<
  TreasureEventBase & { status: string; closedBy: string | null }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.CLOSED;
}

export class TreasureRecoveredEvent extends DomainEvent<
  TreasureEventBase & { reason: 'DLQ_REPLAY' | 'ORPHAN_RECLAIM'; attempt: number }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.RECOVERED;
}

export class TreasureUnlockFailedEvent extends DomainEvent<
  TreasureEventBase & { stage: TreasureUnlockStage; attempt: number; error: string }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room-treasure.events.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/events/video-room-treasure.events.ts \
        src/modules/video-rooms/events/video-room-treasure.events.spec.ts
git commit -m "feat(vr-11): add treasure domain events"
```

---

## Task 7: Treasure repository (levels, sessions, boxes, contributions)

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-treasure.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-treasure.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `TREASURE_CONTEXT_TYPE`.
- Produces (exact signatures later tasks call):
```ts
listEnabledLevels(): Promise<VideoRoomTreasureLevel[]>
seedLevel(level: number, data: Omit<Prisma.VideoRoomTreasureLevelCreateInput,'level'>): Promise<boolean>
createSession(i: { roomId; createdBy; levelSnapshot: Prisma.InputJsonValue; boxes: {level;threshold:bigint}[] }): Promise<TreasureSession>
findCurrentSession(roomId: string): Promise<TreasureSession | null>   // DRAFT|ACTIVE|PAUSED
getSnapshot(sessionId: string): Promise<VideoRoomTreasureSession | null>
transitionSession(sessionId, from: TreasureSessionStatus[], to: TreasureSessionStatus, tx?): Promise<TreasureSession | null>
listBoxes(sessionId: string, tx?): Promise<TreasureBox[]>
getBox(boxId: string, tx?): Promise<TreasureBox | null>
addProgress(boxId, observed: bigint, delta: bigint, tx): Promise<TreasureBox | null>  // null = lost the CAS
claimUnlock(boxId: string, tx?): Promise<boolean>                     // ACTIVE -> UNLOCKING
openBox(boxId: string, tx): Promise<void>                             // UNLOCKING -> OPENED
activateBox(boxId: string, tx): Promise<void>                         // PENDING -> ACTIVE
setSessionLevel(sessionId, level, tx): Promise<void>
addContribution(i: {boxId;sessionId;roomId;userId;amount:bigint;giftTxnId}, tx): Promise<void>
contributionTotals(boxId: string, tx?): Promise<{userId: string; amount: bigint}[]>
findOrphanedBoxes(olderThan: Date, limit: number): Promise<TreasureBox[]>
listSessions(roomId, skip, take): Promise<[TreasureSession[], number]>
```

- [ ] **Step 1: Write the failing test**

```ts
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { VideoRoomTreasureRepository } from './video-room-treasure.repository';

describe('VideoRoomTreasureRepository', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let repo: VideoRoomTreasureRepository;

  beforeEach(() => {
    prisma = {
      videoRoomTreasureLevel: { findMany: jest.fn(), upsert: jest.fn(), count: jest.fn() },
      videoRoomTreasureSession: { create: jest.fn(), findUnique: jest.fn() },
      treasureSession: {
        create: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(),
        findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn(),
      },
      treasureBox: {
        createMany: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(),
        updateMany: jest.fn(), update: jest.fn(),
      },
      treasureContribution: { create: jest.fn(), groupBy: jest.fn() },
      $transaction: jest.fn(),
    };
    repo = new VideoRoomTreasureRepository(prisma as never);
  });

  describe('addProgress', () => {
    it('returns the updated box when the compare-and-set wins', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 1 });
      prisma.treasureBox.findUnique.mockResolvedValue({ id: 'b1', progress: 500n });
      const box = await repo.addProgress('b1', 0n, 500n, prisma as never);
      expect(box).toEqual({ id: 'b1', progress: 500n });
      expect(prisma.treasureBox.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', progress: 0n },
        data: { progress: 500n },
      });
    });

    // Losing the CAS is normal under concurrency, not an error — the caller
    // re-reads and retries. Returning null keeps that decision at the call site.
    it('returns null when another transaction moved progress first', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 0 });
      expect(await repo.addProgress('b1', 0n, 500n, prisma as never)).toBeNull();
      expect(prisma.treasureBox.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('claimUnlock', () => {
    it('is true for exactly the transaction that flips ACTIVE to UNLOCKING', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 1 });
      expect(await repo.claimUnlock('b1', prisma as never)).toBe(true);
      expect(prisma.treasureBox.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', status: TreasureBoxStatus.ACTIVE },
        data: { status: TreasureBoxStatus.UNLOCKING },
      });
    });

    it('is false for every loser', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 0 });
      expect(await repo.claimUnlock('b1', prisma as never)).toBe(false);
    });
  });

  describe('transitionSession', () => {
    it('only transitions from an expected source state', async () => {
      prisma.treasureSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.treasureSession.findUnique.mockResolvedValue({ id: 's1' });
      const res = await repo.transitionSession(
        's1', [TreasureSessionStatus.ACTIVE], TreasureSessionStatus.PAUSED,
      );
      expect(res).toEqual({ id: 's1' });
      expect(prisma.treasureSession.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: { in: [TreasureSessionStatus.ACTIVE] } },
        data: { status: TreasureSessionStatus.PAUSED },
      });
    });

    it('returns null when the session was not in an expected state', async () => {
      prisma.treasureSession.updateMany.mockResolvedValue({ count: 0 });
      expect(
        await repo.transitionSession('s1', [TreasureSessionStatus.ACTIVE], TreasureSessionStatus.PAUSED),
      ).toBeNull();
    });
  });

  describe('findCurrentSession', () => {
    it('scopes by roomId AND contextType so it can never match an audio session', async () => {
      prisma.treasureSession.findFirst.mockResolvedValue(null);
      await repo.findCurrentSession('r1');
      expect(prisma.treasureSession.findFirst).toHaveBeenCalledWith({
        where: {
          roomId: 'r1',
          contextType: 'VIDEO_ROOM',
          status: {
            in: [TreasureSessionStatus.DRAFT, TreasureSessionStatus.ACTIVE, TreasureSessionStatus.PAUSED],
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/repositories/video-room-treasure.repository.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreasureBox,
  TreasureBoxStatus,
  TreasureSession,
  TreasureSessionStatus,
  VideoRoomTreasureLevel,
  VideoRoomTreasureSession,
} from '@prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';
import { TREASURE_CONTEXT_TYPE } from '../constants/video-room-treasure.constants';

type Db = Prisma.TransactionClient | PrismaService;

/** Session states in which a room already has a ladder and cannot create another. */
const LIVE_STATES: TreasureSessionStatus[] = [
  TreasureSessionStatus.DRAFT,
  TreasureSessionStatus.ACTIVE,
  TreasureSessionStatus.PAUSED,
];

/**
 * Persistence for the video-room treasure ladder (VR-11).
 *
 * Every read of a SHARED table (TreasureSession/Box/Contribution) is scoped by
 * roomId + contextType or by an id reachable only from a video session, so this
 * repository can never observe or mutate an audio-room row.
 *
 * The two mutators that matter for concurrency — `addProgress` and `claimUnlock`
 * — are conditional `updateMany` calls returning a boolean/null rather than
 * throwing. Losing a race is the normal path under load, not an exception.
 */
@Injectable()
export class VideoRoomTreasureRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Db): Db {
    return tx ?? this.prisma;
  }

  // ---- Levels ----

  listEnabledLevels(): Promise<VideoRoomTreasureLevel[]> {
    return this.prisma.videoRoomTreasureLevel.findMany({
      where: { enabled: true },
      orderBy: { level: 'asc' },
    });
  }

  async seedLevel(
    level: number,
    data: Omit<Prisma.VideoRoomTreasureLevelUncheckedCreateInput, 'level'>,
  ): Promise<boolean> {
    const existing = await this.prisma.videoRoomTreasureLevel.count({ where: { level } });
    if (existing > 0) return false;
    await this.prisma.videoRoomTreasureLevel.create({ data: { level, ...data } });
    return true;
  }

  // ---- Sessions ----

  async createSession(input: {
    roomId: string;
    createdBy: string;
    levelSnapshot: Prisma.InputJsonValue;
    boxes: { level: number; threshold: bigint }[];
  }): Promise<TreasureSession> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.treasureSession.create({
        data: {
          roomId: input.roomId,
          startedBy: input.createdBy,
          contextType: TREASURE_CONTEXT_TYPE,
          status: TreasureSessionStatus.DRAFT,
          currentLevel: 1,
        },
      });
      await tx.videoRoomTreasureSession.create({
        data: {
          sessionId: session.id,
          roomId: input.roomId,
          levelSnapshot: input.levelSnapshot,
          createdBy: input.createdBy,
        },
      });
      // All boxes start PENDING. `start` promotes level 1 to ACTIVE, so a DRAFT
      // ladder cannot accumulate progress from an in-flight gift.
      await tx.treasureBox.createMany({
        data: input.boxes.map((b) => ({
          sessionId: session.id,
          roomId: input.roomId,
          level: b.level,
          threshold: b.threshold,
          status: TreasureBoxStatus.PENDING,
        })),
      });
      return session;
    });
  }

  findCurrentSession(roomId: string): Promise<TreasureSession | null> {
    return this.prisma.treasureSession.findFirst({
      where: { roomId, contextType: TREASURE_CONTEXT_TYPE, status: { in: LIVE_STATES } },
      orderBy: { createdAt: 'desc' },
    });
  }

  getSnapshot(sessionId: string): Promise<VideoRoomTreasureSession | null> {
    return this.prisma.videoRoomTreasureSession.findUnique({ where: { sessionId } });
  }

  /**
   * Conditional state transition. Returns the session on success, null when it
   * was not in `from` — which is how two concurrent owner commands are resolved
   * without a lock: exactly one sees a non-null result.
   */
  async transitionSession(
    sessionId: string,
    from: TreasureSessionStatus[],
    to: TreasureSessionStatus,
    tx?: Db,
  ): Promise<TreasureSession | null> {
    const db = this.db(tx);
    const data: Prisma.TreasureSessionUncheckedUpdateManyInput = { status: to };
    if (to === TreasureSessionStatus.COMPLETED || to === TreasureSessionStatus.CLOSED) {
      data.completedAt = new Date();
    }
    const res = await db.treasureSession.updateMany({
      where: { id: sessionId, status: { in: from } },
      data,
    });
    if (res.count === 0) return null;
    return db.treasureSession.findUnique({ where: { id: sessionId } });
  }

  setSessionLevel(sessionId: string, currentLevel: number, tx?: Db): Promise<unknown> {
    return this.db(tx).treasureSession.update({
      where: { id: sessionId },
      data: { currentLevel },
    });
  }

  listSessions(roomId: string, skip: number, take: number): Promise<[TreasureSession[], number]> {
    const where: Prisma.TreasureSessionWhereInput = {
      roomId,
      contextType: TREASURE_CONTEXT_TYPE,
    };
    return this.prisma.$transaction([
      this.prisma.treasureSession.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.treasureSession.count({ where }),
    ]);
  }

  // ---- Boxes ----

  listBoxes(sessionId: string, tx?: Db): Promise<TreasureBox[]> {
    return this.db(tx).treasureBox.findMany({
      where: { sessionId },
      orderBy: { level: 'asc' },
    });
  }

  getBox(boxId: string, tx?: Db): Promise<TreasureBox | null> {
    return this.db(tx).treasureBox.findUnique({ where: { id: boxId } });
  }

  /**
   * Compare-and-set progress. `observed` is the value the caller read; if another
   * transaction changed it first the update matches nothing and we return null so
   * the caller re-reads. This is what makes concurrent gifts to one box correct
   * without a distributed lock.
   */
  async addProgress(
    boxId: string,
    observed: bigint,
    delta: bigint,
    tx: Db,
  ): Promise<TreasureBox | null> {
    const res = await tx.treasureBox.updateMany({
      where: { id: boxId, progress: observed },
      data: { progress: observed + delta },
    });
    if (res.count === 0) return null;
    return tx.treasureBox.findUnique({ where: { id: boxId } });
  }

  /** ACTIVE -> UNLOCKING. True for exactly one caller: the unlock owner. */
  async claimUnlock(boxId: string, tx?: Db): Promise<boolean> {
    const res = await this.db(tx).treasureBox.updateMany({
      where: { id: boxId, status: TreasureBoxStatus.ACTIVE },
      data: { status: TreasureBoxStatus.UNLOCKING },
    });
    return res.count === 1;
  }

  async openBox(boxId: string, tx: Db): Promise<void> {
    await tx.treasureBox.updateMany({
      where: { id: boxId, status: TreasureBoxStatus.UNLOCKING },
      data: { status: TreasureBoxStatus.OPENED, openedAt: new Date() },
    });
  }

  async activateBox(boxId: string, tx: Db): Promise<void> {
    await tx.treasureBox.updateMany({
      where: { id: boxId, status: TreasureBoxStatus.PENDING },
      data: { status: TreasureBoxStatus.ACTIVE },
    });
  }

  /**
   * Boxes stuck UNLOCKING past the orphan timeout — the process died between the
   * claim and the job running. The pool-row check lives in the recovery service,
   * which has the reward repository.
   */
  findOrphanedBoxes(olderThan: Date, limit: number): Promise<TreasureBox[]> {
    return this.prisma.treasureBox.findMany({
      where: { status: TreasureBoxStatus.UNLOCKING, createdAt: { lte: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  // ---- Contributions ----

  async addContribution(
    input: {
      boxId: string;
      sessionId: string;
      roomId: string;
      userId: string;
      amount: bigint;
      giftTxnId: string | null;
    },
    tx: Db,
  ): Promise<void> {
    await tx.treasureContribution.create({ data: input });
  }

  async contributionTotals(boxId: string, tx?: Db): Promise<{ userId: string; amount: bigint }[]> {
    const grouped = await this.db(tx).treasureContribution.groupBy({
      by: ['userId'],
      where: { boxId },
      _sum: { amount: true },
    });
    return grouped.map((g) => ({ userId: g.userId, amount: g._sum.amount ?? 0n }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/repositories/video-room-treasure.repository.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/repositories/video-room-treasure.repository.ts \
        src/modules/video-rooms/repositories/video-room-treasure.repository.spec.ts
git commit -m "feat(vr-11): add treasure repository with CAS progress and unlock claim"
```

---

## Task 8: Reward repository (pools, winners, reward rows)

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-treasure-reward.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-treasure-reward.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces:
```ts
createPool(i: {boxId;sessionId;roomId;level;strategy;sourceAmount:bigint;poolAmount:bigint;
              winnerCount;algorithm;algorithmVersion;selectionSeed}, tx): Promise<TreasureRewardPool | null> // null = replay
getPool(boxId: string): Promise<TreasureRewardPool | null>
setAllocated(boxId: string, allocated: bigint, tx): Promise<void>
createWinners(rows: {boxId;sessionId;roomId;userId;algorithm;shareBps;amount:bigint;
                     eligibleCount;candidateCount}[], tx): Promise<number>
listWinners(roomId, skip, take): Promise<[TreasureWinner[], number]>
listWinnersByBox(boxId: string): Promise<TreasureWinner[]>
createPendingRewards(rows: {...}[], tx): Promise<void>
markDistributed(boxId, userId, walletTxnId: string | null, tx): Promise<void>
markFailed(boxId: string, stage: string, error: string, tx?): Promise<void>
statistics(roomId: string): Promise<{ totalPools; totalMinted; totalWinners; unlockedBoxes }>
```

- [ ] **Step 1: Write the failing test**

```ts
import { Prisma, TreasureRewardStatus } from '@prisma/client';
import { VideoRoomTreasureRewardRepository } from './video-room-treasure-reward.repository';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002', clientVersion: '5', meta: { target: ['boxId'] },
  });

describe('VideoRoomTreasureRewardRepository', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let repo: VideoRoomTreasureRewardRepository;

  beforeEach(() => {
    prisma = {
      treasureRewardPool: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
      treasureWinner: { createMany: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      treasureReward: { createMany: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn(),
    };
    repo = new VideoRoomTreasureRewardRepository(prisma as never);
  });

  describe('createPool', () => {
    it('returns the pool on the first write', async () => {
      prisma.treasureRewardPool.create.mockResolvedValue({ id: 'p1' });
      const res = await repo.createPool(
        { boxId: 'b1', sessionId: 's1', roomId: 'r1', level: 1, strategy: 'PERCENTAGE',
          sourceAmount: 15000n, poolAmount: 1500n, winnerCount: 3, algorithm: 'RANDOM',
          algorithmVersion: 1, selectionSeed: 'seed' },
        prisma as never,
      );
      expect(res).toEqual({ id: 'p1' });
    });

    // boxId @unique is the replay guard: a retried job must not mint twice.
    // A P2002 here means "already done", which is success, not failure.
    it('returns null instead of throwing when the box already has a pool', async () => {
      prisma.treasureRewardPool.create.mockRejectedValue(uniqueViolation());
      const res = await repo.createPool(
        { boxId: 'b1', sessionId: 's1', roomId: 'r1', level: 1, strategy: 'PERCENTAGE',
          sourceAmount: 15000n, poolAmount: 1500n, winnerCount: 3, algorithm: 'RANDOM',
          algorithmVersion: 1, selectionSeed: 'seed' },
        prisma as never,
      );
      expect(res).toBeNull();
    });

    it('rethrows errors that are not the replay guard', async () => {
      prisma.treasureRewardPool.create.mockRejectedValue(new Error('connection lost'));
      await expect(
        repo.createPool(
          { boxId: 'b1', sessionId: 's1', roomId: 'r1', level: 1, strategy: 'PERCENTAGE',
            sourceAmount: 15000n, poolAmount: 1500n, winnerCount: 3, algorithm: 'RANDOM',
            algorithmVersion: 1, selectionSeed: 'seed' },
          prisma as never,
        ),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('createWinners', () => {
    it('skips duplicates so a replay cannot add a second win for one user', async () => {
      prisma.treasureWinner.createMany.mockResolvedValue({ count: 3 });
      const n = await repo.createWinners(
        [{ boxId: 'b1', sessionId: 's1', roomId: 'r1', userId: 'u1', algorithm: 'RANDOM',
           shareBps: 3333, amount: 500n, eligibleCount: 10, candidateCount: 50 }],
        prisma as never,
      );
      expect(n).toBe(3);
      expect(prisma.treasureWinner.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });
  });

  describe('markDistributed', () => {
    it('flips only the PENDING row for that box and user', async () => {
      prisma.treasureReward.updateMany.mockResolvedValue({ count: 1 });
      await repo.markDistributed('b1', 'u1', 'wtx1', prisma as never);
      expect(prisma.treasureReward.updateMany).toHaveBeenCalledWith({
        where: { boxId: 'b1', userId: 'u1', status: TreasureRewardStatus.PENDING },
        data: expect.objectContaining({
          status: TreasureRewardStatus.DISTRIBUTED, walletTxnId: 'wtx1',
        }),
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/repositories/video-room-treasure-reward.repository.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreasureRewardKind,
  TreasureRewardPool,
  TreasureRewardStatus,
  TreasureWinner,
} from '@prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** True when the error is a unique-constraint violation (the replay guard). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Persistence for minted pools, drawn winners and distributed rewards (VR-11).
 *
 * The unique constraints (`TreasureRewardPool.boxId`,
 * `TreasureWinner(boxId,userId)`) are the primary duplicate-reward defence, and
 * this repository translates them into ordinary control flow: a replayed unlock
 * gets `null` / a skipped insert rather than an exception. Enforcing that in
 * application code instead would leave a window two BullMQ workers can both pass.
 */
@Injectable()
export class VideoRoomTreasureRewardRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Db): Db {
    return tx ?? this.prisma;
  }

  /** Returns null when this box already has a pool — i.e. this is a replay. */
  async createPool(
    input: {
      boxId: string;
      sessionId: string;
      roomId: string;
      level: number;
      strategy: string;
      sourceAmount: bigint;
      poolAmount: bigint;
      winnerCount: number;
      algorithm: string;
      algorithmVersion: number;
      selectionSeed: string;
    },
    tx: Db,
  ): Promise<TreasureRewardPool | null> {
    try {
      return await tx.treasureRewardPool.create({ data: input });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  getPool(boxId: string): Promise<TreasureRewardPool | null> {
    return this.prisma.treasureRewardPool.findUnique({ where: { boxId } });
  }

  async setAllocated(boxId: string, allocated: bigint, tx: Db): Promise<void> {
    await tx.treasureRewardPool.update({
      where: { boxId },
      data: { allocatedAmount: allocated },
    });
  }

  /** `skipDuplicates` makes a replayed draw a no-op rather than a crash. */
  async createWinners(
    rows: {
      boxId: string;
      sessionId: string;
      roomId: string;
      userId: string;
      algorithm: string;
      shareBps: number;
      amount: bigint;
      eligibleCount: number;
      candidateCount: number;
    }[],
    tx: Db,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await tx.treasureWinner.createMany({ data: rows, skipDuplicates: true });
    return res.count;
  }

  listWinners(roomId: string, skip: number, take: number): Promise<[TreasureWinner[], number]> {
    const where: Prisma.TreasureWinnerWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.treasureWinner.findMany({ where, skip, take, orderBy: { selectedAt: 'desc' } }),
      this.prisma.treasureWinner.count({ where }),
    ]);
  }

  listWinnersByBox(boxId: string): Promise<TreasureWinner[]> {
    return this.prisma.treasureWinner.findMany({ where: { boxId } });
  }

  async createPendingRewards(
    rows: {
      sessionId: string;
      boxId: string;
      roomId: string;
      level: number;
      userId: string;
      rank: number;
      coins: bigint;
    }[],
    tx: Db,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.treasureReward.createMany({
      data: rows.map((r) => ({
        ...r,
        kind: TreasureRewardKind.COINS,
        status: TreasureRewardStatus.PENDING,
      })),
    });
  }

  async markDistributed(
    boxId: string,
    userId: string,
    walletTxnId: string | null,
    tx: Db,
  ): Promise<void> {
    await tx.treasureReward.updateMany({
      where: { boxId, userId, status: TreasureRewardStatus.PENDING },
      data: {
        status: TreasureRewardStatus.DISTRIBUTED,
        walletTxnId,
        distributedAt: new Date(),
      },
    });
  }

  /**
   * Records a failed attempt. Deliberately NOT inside the unlock transaction —
   * that transaction is rolling back, so a write inside it would vanish along
   * with the failure record we need to debug from.
   */
  async markFailed(boxId: string, stage: string, error: string): Promise<void> {
    await this.prisma.treasureReward.updateMany({
      where: { boxId, status: TreasureRewardStatus.PENDING },
      data: {
        status: TreasureRewardStatus.FAILED,
        failureStage: stage,
        lastError: error.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }

  async statistics(roomId: string): Promise<{
    totalPools: number;
    totalMinted: bigint;
    totalWinners: number;
  }> {
    const [pools, minted, winners] = await this.prisma.$transaction([
      this.prisma.treasureRewardPool.count({ where: { roomId } }),
      this.prisma.treasureRewardPool.aggregate({
        where: { roomId },
        _sum: { allocatedAmount: true },
      }),
      this.prisma.treasureWinner.count({ where: { roomId } }),
    ]);
    return {
      totalPools: pools,
      totalMinted: minted._sum.allocatedAmount ?? 0n,
      totalWinners: winners,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/repositories/video-room-treasure-reward.repository.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/repositories/video-room-treasure-reward.repository.ts \
        src/modules/video-rooms/repositories/video-room-treasure-reward.repository.spec.ts
git commit -m "feat(vr-11): add treasure reward repository with replay-safe writes"
```

---

## Task 9: Level seeder

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-level.seeder.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-level.seeder.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTreasureRepository.seedLevel`.
- Produces: `VideoRoomTreasureLevelSeeder` implementing `OnApplicationBootstrap`, and the exported `VIDEO_ROOM_TREASURE_SEED_LEVELS` array (Task 25 asserts against it).

- [ ] **Step 1: Write the failing test**

```ts
import {
  VIDEO_ROOM_TREASURE_SEED_LEVELS,
  VideoRoomTreasureLevelSeeder,
} from './video-room-treasure-level.seeder';

describe('VideoRoomTreasureLevelSeeder', () => {
  let repo: { seedLevel: jest.Mock };
  let seeder: VideoRoomTreasureLevelSeeder;

  beforeEach(() => {
    repo = { seedLevel: jest.fn().mockResolvedValue(true) };
    seeder = new VideoRoomTreasureLevelSeeder(repo as never);
  });

  it('seeds the four-level ladder from the PRD', () => {
    expect(VIDEO_ROOM_TREASURE_SEED_LEVELS.map((l) => l.threshold)).toEqual([
      15_000, 60_000, 200_000, 350_000,
    ]);
  });

  it('defaults every level to a 10% percentage pool with 3 random winners', () => {
    for (const level of VIDEO_ROOM_TREASURE_SEED_LEVELS) {
      expect(level.poolStrategy).toBe('PERCENTAGE');
      expect(level.poolPercentBps).toBe(1000);
      expect(level.winnerAlgorithm).toBe('RANDOM');
      expect(level.winnerCount).toBe(3);
    }
  });

  it('writes each level as BigInt', async () => {
    await seeder.onApplicationBootstrap();
    expect(repo.seedLevel).toHaveBeenCalledTimes(4);
    expect(repo.seedLevel).toHaveBeenCalledWith(1, expect.objectContaining({ threshold: 15_000n }));
  });

  // A seed failure must never stop the app booting — the feature is simply
  // unavailable until an operator configures levels, exactly as AR-6 behaves.
  it('logs and continues when seeding throws', async () => {
    repo.seedLevel.mockRejectedValue(new Error('db down'));
    await expect(seeder.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-level.seeder.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import {
  TreasurePoolStrategy,
  TreasureWinnerAlgorithm,
} from '../constants/video-room-treasure.constants';

/**
 * The default video-room ladder (VR-11 spec §10, production.txt §7). Seeded on a
 * fresh database so the feature is usable out of the box; operators tune it via
 * VideoRoomTreasureLevel. Idempotent by level — an existing level is never
 * overwritten, so tuning survives a redeploy.
 *
 * Note these thresholds deliberately differ from the audio ladder
 * (15k/60k/120k/300k/500k): video is 4 levels and its L3/L4 are higher.
 */
export const VIDEO_ROOM_TREASURE_SEED_LEVELS = [
  { level: 1, threshold: 15_000 },
  { level: 2, threshold: 60_000 },
  { level: 3, threshold: 200_000 },
  { level: 4, threshold: 350_000 },
].map((l) => ({
  ...l,
  poolStrategy: TreasurePoolStrategy.PERCENTAGE,
  poolPercentBps: 1000,
  winnerAlgorithm: TreasureWinnerAlgorithm.RANDOM,
  winnerCount: 3,
  minStaySeconds: 120,
  minActivityEvents: 0,
}));

@Injectable()
export class VideoRoomTreasureLevelSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoRoomTreasureLevelSeeder.name);

  constructor(private readonly repo: VideoRoomTreasureRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const level of VIDEO_ROOM_TREASURE_SEED_LEVELS) {
        const { level: n, threshold, ...rest } = level;
        const inserted = await this.repo.seedLevel(n, {
          threshold: BigInt(threshold),
          enabled: true,
          ...rest,
        });
        if (inserted) created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} video-room treasure levels`);
    } catch (err) {
      this.logger.warn(`Video-room treasure level seed skipped: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-level.seeder.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-level.seeder.ts \
        src/modules/video-rooms/services/video-room-treasure-level.seeder.spec.ts
git commit -m "feat(vr-11): seed the default video-room treasure ladder"
```

---

## Task 10: Reward pool service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-pool.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-pool.service.spec.ts`

**Interfaces:**
- Consumes: `TreasurePoolStrategy`, `RewardPoolException`.
- Produces:
```ts
interface TreasureLevelRules {
  level: number; threshold: number;
  poolStrategy: string; poolPercentBps: number; poolFixedAmount: number | null;
  winnerAlgorithm: string; winnerCount: number;
  minStaySeconds: number; minActivityEvents: number;
}
interface PoolAllocation { userId: string; amount: bigint; shareBps: number }
class VideoRoomTreasurePoolService {
  compute(rules: TreasureLevelRules): { strategy: string; sourceAmount: bigint; poolAmount: bigint }
  allocate(poolAmount: bigint, winnerIds: string[]): PoolAllocation[]
}
```
`TreasureLevelRules` is the shape stored in `levelSnapshot` and consumed by Tasks 12, 13, 16.

- [ ] **Step 1: Write the failing test**

```ts
import { RewardPoolException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasurePoolService } from './video-room-treasure-pool.service';

const rules = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    level: 1, threshold: 15_000, poolStrategy: 'PERCENTAGE', poolPercentBps: 1000,
    poolFixedAmount: null, winnerAlgorithm: 'RANDOM', winnerCount: 3,
    minStaySeconds: 120, minActivityEvents: 0, ...over,
  }) as never;

describe('VideoRoomTreasurePoolService', () => {
  const service = new VideoRoomTreasurePoolService();

  describe('compute', () => {
    it('mints 10% of the threshold under PERCENTAGE', () => {
      expect(service.compute(rules())).toEqual({
        strategy: 'PERCENTAGE', sourceAmount: 15_000n, poolAmount: 1_500n,
      });
    });

    it('floors fractional bps rather than minting a fraction of a coin', () => {
      expect(service.compute(rules({ threshold: 15_001, poolPercentBps: 333 })).poolAmount)
        .toBe(499n); // 15001 * 333 / 10000 = 499.5333
    });

    it('mints the fixed amount under FIXED', () => {
      expect(service.compute(rules({ poolStrategy: 'FIXED', poolFixedAmount: 2_500 })).poolAmount)
        .toBe(2_500n);
    });

    it('rejects FIXED with no amount rather than silently minting zero', () => {
      expect(() => service.compute(rules({ poolStrategy: 'FIXED', poolFixedAmount: null })))
        .toThrow(RewardPoolException);
    });

    it('rejects an unknown strategy', () => {
      expect(() => service.compute(rules({ poolStrategy: 'LOTTERY' }))).toThrow(RewardPoolException);
    });

    it('rejects bps outside 0..10000 — a pool larger than its source is a config bug', () => {
      expect(() => service.compute(rules({ poolPercentBps: 10_001 }))).toThrow(RewardPoolException);
      expect(() => service.compute(rules({ poolPercentBps: -1 }))).toThrow(RewardPoolException);
    });
  });

  describe('allocate', () => {
    it('splits the pool evenly and leaves the dust unminted', () => {
      const alloc = service.allocate(1_000n, ['u1', 'u2', 'u3']);
      expect(alloc.map((a) => a.amount)).toEqual([333n, 333n, 333n]);
      const total = alloc.reduce((s, a) => s + a.amount, 0n);
      expect(1_000n - total).toBe(1n); // dust, derivable as poolAmount - allocatedAmount
    });

    it('gives the whole pool to a lone winner', () => {
      expect(service.allocate(1_500n, ['u1'])).toEqual([
        { userId: 'u1', amount: 1_500n, shareBps: 10_000 },
      ]);
    });

    // Zero eligible is a normal outcome (empty room at unlock), not an error.
    it('allocates nothing when there are no winners', () => {
      expect(service.allocate(1_500n, [])).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-pool.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable } from '@nestjs/common';
import { TreasurePoolStrategy } from '../constants/video-room-treasure.constants';
import { RewardPoolException } from '../exceptions/video-room-treasure.exceptions';

/** One level's frozen rules, as stored in `VideoRoomTreasureSession.levelSnapshot`. */
export interface TreasureLevelRules {
  level: number;
  threshold: number;
  poolStrategy: string;
  poolPercentBps: number;
  poolFixedAmount: number | null;
  winnerAlgorithm: string;
  winnerCount: number;
  minStaySeconds: number;
  minActivityEvents: number;
}

export interface PoolAllocation {
  userId: string;
  amount: bigint;
  shareBps: number;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Computes and splits the reward pool (VR-11 spec §6.5).
 *
 * Pure arithmetic with no I/O — which is what lets the unlock pipeline compute
 * the pool before opening its transaction, and lets this be exhaustively tested
 * without a database.
 *
 * The pool is MINTED by the platform, not taken from contributed coins: video
 * progress is a counter, never an escrow (spec D1), so nothing here debits
 * anyone. `sourceAmount` records what the pool was derived from, purely for audit.
 */
@Injectable()
export class VideoRoomTreasurePoolService {
  compute(rules: TreasureLevelRules): {
    strategy: string;
    sourceAmount: bigint;
    poolAmount: bigint;
  } {
    const sourceAmount = BigInt(rules.threshold);

    switch (rules.poolStrategy) {
      case TreasurePoolStrategy.PERCENTAGE: {
        const bps = rules.poolPercentBps;
        if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
          throw new RewardPoolException(
            `Level ${rules.level} pool bps must be an integer in 0..10000, got ${bps}.`,
          );
        }
        return {
          strategy: rules.poolStrategy,
          sourceAmount,
          // Integer division floors: never mint a fraction of a coin.
          poolAmount: (sourceAmount * BigInt(bps)) / BPS_DENOMINATOR,
        };
      }

      case TreasurePoolStrategy.FIXED:
      case TreasurePoolStrategy.ADMIN_OVERRIDE: {
        const fixed = rules.poolFixedAmount;
        if (fixed === null || fixed === undefined || fixed < 0) {
          throw new RewardPoolException(
            `Level ${rules.level} uses ${rules.poolStrategy} but has no poolFixedAmount.`,
          );
        }
        return { strategy: rules.poolStrategy, sourceAmount, poolAmount: BigInt(fixed) };
      }

      default:
        throw new RewardPoolException(
          `Unknown pool strategy "${rules.poolStrategy}" on level ${rules.level}.`,
        );
    }
  }

  /**
   * Splits the pool evenly across the winners actually drawn — which may be fewer
   * than configured, or none at all when the room emptied before the unlock.
   *
   * Integer division leaves dust (at most winners-1 coins). It is deliberately
   * NOT minted and not handed to an arbitrary winner: the pool row records
   * `poolAmount` and `allocatedAmount`, so the difference is auditable rather
   * than hidden in someone's balance.
   */
  allocate(poolAmount: bigint, winnerIds: string[]): PoolAllocation[] {
    if (winnerIds.length === 0) return [];
    const count = BigInt(winnerIds.length);
    const each = poolAmount / count;
    const shareBps = Math.floor(10_000 / winnerIds.length);
    return winnerIds.map((userId) => ({ userId, amount: each, shareBps }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-pool.service.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-pool.service.ts \
        src/modules/video-rooms/services/video-room-treasure-pool.service.spec.ts
git commit -m "feat(vr-11): add reward pool strategies"
```

---

## Task 11: Eligibility service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-eligibility.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-eligibility.service.spec.ts`

**Interfaces:**
- Consumes: `REDIS_CLIENT`, `PrismaService`, `TreasureLevelRules`, `treasureActivityKey`, and the presence key builders `videoRoomViewersKey` / `videoRoomHostsKey` / `videoRoomParticipantsKey` from `video-room-presence-state.ts`.
- Produces:
```ts
interface EligibilityResult { eligible: string[]; candidateCount: number }
class VideoRoomTreasureEligibilityService {
  resolve(i: { roomId; sessionId; rules: TreasureLevelRules; want: number;
               oversampleFactor: number; oversampleMin: number }): Promise<EligibilityResult>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomTreasureEligibilityService } from './video-room-treasure-eligibility.service';

const RULES = { level: 1, threshold: 15000, minStaySeconds: 120, minActivityEvents: 0 } as never;
const NOW = 1_700_000_000_000;

describe('VideoRoomTreasureEligibilityService', () => {
  let redis: Record<string, jest.Mock>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let service: VideoRoomTreasureEligibilityService;

  const call = (over = {}) =>
    service.resolve({
      roomId: 'r1', sessionId: 's1', rules: RULES,
      want: 3, oversampleFactor: 3, oversampleMin: 50, ...over,
    });

  beforeEach(() => {
    redis = { srandmember: jest.fn().mockResolvedValue([]), hgetall: jest.fn().mockResolvedValue({}) };
    prisma = {
      videoRoomMember: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomBlock: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new VideoRoomTreasureEligibilityService(redis as never, prisma as never, () => NOW);
  });

  it('oversamples to the configured floor, not just want*factor', async () => {
    await call();
    // max(3 * 3, 50) = 50 per presence set
    expect(redis.srandmember).toHaveBeenCalledWith(expect.stringContaining('viewers'), 50);
    expect(redis.srandmember).toHaveBeenCalledTimes(3);
  });

  it('dedupes users present in more than one presence set', async () => {
    redis.srandmember
      .mockResolvedValueOnce(['u1', 'u2'])
      .mockResolvedValueOnce(['u2'])
      .mockResolvedValueOnce(['u3']);
    prisma.videoRoomMember.findMany.mockResolvedValue([
      { userId: 'u1', joinedAt: new Date(NOW - 300_000) },
      { userId: 'u2', joinedAt: new Date(NOW - 300_000) },
      { userId: 'u3', joinedAt: new Date(NOW - 300_000) },
    ]);
    const res = await call();
    expect(res.candidateCount).toBe(3);
    expect(res.eligible.sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('excludes anyone who has not met the minimum stay', async () => {
    redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
    prisma.videoRoomMember.findMany.mockResolvedValue([
      { userId: 'u1', joinedAt: new Date(NOW - 300_000) }, // 5 min — ok
      { userId: 'u2', joinedAt: new Date(NOW - 30_000) },  // 30 s — too new
    ]);
    expect((await call()).eligible).toEqual(['u1']);
  });

  it('excludes blocked users even when presence still lists them', async () => {
    redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
    prisma.videoRoomMember.findMany.mockResolvedValue([
      { userId: 'u1', joinedAt: new Date(NOW - 300_000) },
      { userId: 'u2', joinedAt: new Date(NOW - 300_000) },
    ]);
    prisma.videoRoomBlock.findMany.mockResolvedValue([{ userId: 'u2' }]);
    expect((await call()).eligible).toEqual(['u1']);
  });

  it('applies the activity floor when configured', async () => {
    redis.srandmember.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValue([]);
    redis.hgetall.mockResolvedValue({ u1: '5', u2: '1' });
    prisma.videoRoomMember.findMany.mockResolvedValue([
      { userId: 'u1', joinedAt: new Date(NOW - 300_000) },
      { userId: 'u2', joinedAt: new Date(NOW - 300_000) },
    ]);
    const res = await call({ rules: { ...RULES, minActivityEvents: 3 } as never });
    expect(res.eligible).toEqual(['u1']);
  });

  it('skips the activity round-trip entirely when the floor is zero', async () => {
    await call();
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  it('returns empty rather than throwing when the room is empty at unlock', async () => {
    expect(await call()).toEqual({ eligible: [], candidateCount: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-eligibility.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/database/prisma.service';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { treasureActivityKey } from '../constants/video-room-treasure.constants';
import {
  videoRoomHostsKey,
  videoRoomParticipantsKey,
  videoRoomViewersKey,
} from './video-room-presence-state';
import type { TreasureLevelRules } from './video-room-treasure-pool.service';

export interface EligibilityResult {
  /** Users who passed every rule. May be fewer than `want`, or empty. */
  eligible: string[];
  /** How many distinct users were sampled before filtering — audit input. */
  candidateCount: number;
}

/**
 * Resolves who may win a box (VR-11 spec §6.6).
 *
 * The shape is oversample-then-filter, never load-then-filter: `SRANDMEMBER key N`
 * asks Redis to pick N random members, so a room with 100k viewers never
 * materialises 100k ids in Node. Ban status, join time and activity live in
 * Postgres, so the sampled candidates — and only they — are filtered there.
 *
 * A clock is injected so min-stay is testable without faking timers.
 */
@Injectable()
export class VideoRoomTreasureEligibilityService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly prisma: PrismaService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(input: {
    roomId: string;
    sessionId: string;
    rules: TreasureLevelRules;
    want: number;
    oversampleFactor: number;
    oversampleMin: number;
  }): Promise<EligibilityResult> {
    const { roomId, sessionId, rules, want, oversampleFactor, oversampleMin } = input;

    const sampleSize = Math.max(want * oversampleFactor, oversampleMin);
    const [viewers, participants, hosts] = await Promise.all([
      this.redis.srandmember(videoRoomViewersKey(roomId), sampleSize),
      this.redis.srandmember(videoRoomParticipantsKey(roomId), sampleSize),
      this.redis.srandmember(videoRoomHostsKey(roomId), sampleSize),
    ]);

    // A seat holder is also a room member; dedupe before hitting Postgres.
    const candidates = [...new Set([...viewers, ...participants, ...hosts])];
    if (candidates.length === 0) return { eligible: [], candidateCount: 0 };

    const joinedBefore = new Date(this.now() - rules.minStaySeconds * 1000);
    const [members, blocks] = await Promise.all([
      this.prisma.videoRoomMember.findMany({
        where: {
          roomId,
          userId: { in: candidates },
          isActive: true,
          joinedAt: { lte: joinedBefore },
        },
        select: { userId: true, joinedAt: true },
      }),
      this.prisma.videoRoomBlock.findMany({
        where: { roomId, userId: { in: candidates }, isActive: true },
        select: { userId: true },
      }),
    ]);

    const blocked = new Set(blocks.map((b) => b.userId));
    let eligible = members.map((m) => m.userId).filter((id) => !blocked.has(id));

    // Only pay for the activity round-trip when the floor can actually exclude.
    if (rules.minActivityEvents > 0 && eligible.length > 0) {
      const counts = await this.redis.hgetall(treasureActivityKey(roomId, sessionId));
      eligible = eligible.filter(
        (id) => Number(counts[id] ?? 0) >= rules.minActivityEvents,
      );
    }

    return { eligible, candidateCount: candidates.length };
  }
}
```

- [ ] **Step 4: Verify the presence key helpers are exported**

Run: `grep -n "export function videoRoomViewersKey\|videoRoomHostsKey\|videoRoomParticipantsKey" src/modules/video-rooms/services/video-room-presence-state.ts`
Expected: three matches. If they are not exported there, find their real module with
`grep -rn "videoRoomViewersKey" src/modules/video-rooms --include='*.ts' | head -3`
and fix the import path.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-eligibility.service.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-eligibility.service.ts \
        src/modules/video-rooms/services/video-room-treasure-eligibility.service.spec.ts
git commit -m "feat(vr-11): add treasure eligibility resolution"
```

---

## Task 12: Winner selection strategies

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-winner.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-winner.service.spec.ts`

**Interfaces:**
- Consumes: `TreasureWinnerAlgorithm`, `WinnerSelectionException`.
- Produces:
```ts
interface WinnerSelectionInput {
  eligible: string[]; want: number; seed: string;
  contributions: Map<string, bigint>; activity: Map<string, number>; vipTiers: Map<string, number>;
}
interface WinnerSelectionStrategy {
  readonly algorithm: string; readonly version: number;
  select(input: WinnerSelectionInput): string[];
}
class VideoRoomTreasureWinnerService {
  register(s: WinnerSelectionStrategy): void
  select(algorithm: string, input: WinnerSelectionInput): { winners: string[]; version: number }
}
export function seededRandom(seed: string): () => number
```

- [ ] **Step 1: Write the failing test**

```ts
import { WinnerSelectionException } from '../exceptions/video-room-treasure.exceptions';
import {
  seededRandom,
  VideoRoomTreasureWinnerService,
} from './video-room-treasure-winner.service';

const input = (over = {}) => ({
  eligible: ['u1', 'u2', 'u3', 'u4', 'u5'],
  want: 3,
  seed: 'box-1-seed',
  contributions: new Map<string, bigint>(),
  activity: new Map<string, number>(),
  vipTiers: new Map<string, number>(),
  ...over,
});

describe('seededRandom', () => {
  it('is deterministic for a given seed', () => {
    const a = seededRandom('abc');
    const b = seededRandom('abc');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs across seeds', () => {
    expect(seededRandom('abc')()).not.toBe(seededRandom('xyz')());
  });

  it('stays in [0, 1)', () => {
    const rng = seededRandom('abc');
    for (let i = 0; i < 200; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('VideoRoomTreasureWinnerService', () => {
  let service: VideoRoomTreasureWinnerService;
  beforeEach(() => {
    service = new VideoRoomTreasureWinnerService();
  });

  it('registers the five spec algorithms out of the box', () => {
    for (const algo of ['RANDOM', 'WEIGHTED_RANDOM', 'ACTIVITY_BASED',
                        'CONTRIBUTION_BASED', 'VIP_PRIORITY']) {
      expect(() => service.select(algo, input())).not.toThrow();
    }
  });

  it('rejects an unknown algorithm rather than silently falling back to RANDOM', () => {
    expect(() => service.select('ROULETTE', input())).toThrow(WinnerSelectionException);
  });

  // Reproducibility is the audit requirement: a disputed draw must be
  // re-derivable from (algorithm, version, seed, candidates).
  it('is reproducible for the same seed and candidate list', () => {
    const a = service.select('RANDOM', input());
    const b = service.select('RANDOM', input());
    expect(a.winners).toEqual(b.winners);
    expect(a.version).toBe(1);
  });

  it('draws different winners for a different seed', () => {
    const a = service.select('RANDOM', input({ seed: 'seed-a' }));
    const b = service.select('RANDOM', input({ seed: 'seed-b' }));
    expect(a.winners).not.toEqual(b.winners);
  });

  it('never draws the same user twice', () => {
    const { winners } = service.select('RANDOM', input({ want: 5 }));
    expect(new Set(winners).size).toBe(5);
  });

  it('returns everyone when fewer are eligible than wanted', () => {
    const { winners } = service.select('RANDOM', input({ eligible: ['u1', 'u2'], want: 3 }));
    expect(winners.sort()).toEqual(['u1', 'u2']);
  });

  it('returns nothing when nobody is eligible', () => {
    expect(service.select('RANDOM', input({ eligible: [] })).winners).toEqual([]);
  });

  it('CONTRIBUTION_BASED ranks by contribution, highest first', () => {
    const { winners } = service.select(
      'CONTRIBUTION_BASED',
      input({ contributions: new Map([['u1', 10n], ['u3', 500n], ['u5', 80n]]) }),
    );
    expect(winners).toEqual(['u3', 'u5', 'u1']);
  });

  it('WEIGHTED_RANDOM still picks zero-contribution users as fallback weight', () => {
    const { winners } = service.select(
      'WEIGHTED_RANDOM',
      input({ eligible: ['u1', 'u2'], want: 2, contributions: new Map([['u1', 1000n]]) }),
    );
    expect(winners.sort()).toEqual(['u1', 'u2']);
  });

  it('accepts a newly registered strategy without touching the selector', () => {
    service.register({
      algorithm: 'ALPHABETICAL', version: 7,
      select: (i) => [...i.eligible].sort().slice(0, i.want),
    });
    const res = service.select('ALPHABETICAL', input());
    expect(res).toEqual({ winners: ['u1', 'u2', 'u3'], version: 7 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-winner.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TreasureWinnerAlgorithm } from '../constants/video-room-treasure.constants';
import { WinnerSelectionException } from '../exceptions/video-room-treasure.exceptions';

export interface WinnerSelectionInput {
  eligible: string[];
  want: number;
  /** Reproducibility anchor — persisted on the pool row. */
  seed: string;
  contributions: Map<string, bigint>;
  activity: Map<string, number>;
  vipTiers: Map<string, number>;
}

export interface WinnerSelectionStrategy {
  readonly algorithm: string;
  /** Bumped whenever the selection maths changes, so old draws stay explicable. */
  readonly version: number;
  select(input: WinnerSelectionInput): string[];
}

/**
 * A deterministic PRNG seeded from a string (mulberry32 over a SHA-256 prefix).
 *
 * `Math.random()` would make a draw unauditable: a user disputing a result could
 * never have it re-derived. Seeding from `(boxId + nonce)` and persisting the
 * seed means any draw is reproducible from data alone.
 */
export function seededRandom(seed: string): () => number {
  const hash = createHash('sha256').update(seed).digest();
  let state = hash.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `want` distinct users, weight-proportional, without replacement. */
function weightedDraw(
  eligible: string[],
  want: number,
  weightOf: (userId: string) => number,
  rng: () => number,
): string[] {
  const pool = eligible.map((userId) => ({
    userId,
    // Every eligible user keeps a floor weight of 1: a lottery that can never
    // pick a non-contributor is a leaderboard wearing a lottery's clothes.
    weight: Math.max(1, weightOf(userId)),
  }));
  const winners: string[] = [];
  const take = Math.min(want, pool.length);

  for (let i = 0; i < take; i++) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let roll = rng() * total;
    let index = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      roll -= pool[j].weight;
      if (roll <= 0) {
        index = j;
        break;
      }
    }
    winners.push(pool[index].userId);
    pool.splice(index, 1);
  }
  return winners;
}

/**
 * The winner-selection registry (VR-11 spec §6.5).
 *
 * Same shape as GiftContextRegistry: strategies register themselves, so a sixth
 * algorithm is a new class plus one `register()` call and never an edit to this
 * selector. An unknown algorithm throws rather than falling back to RANDOM —
 * a config typo must be loud, not silently change who gets paid.
 */
@Injectable()
export class VideoRoomTreasureWinnerService {
  private readonly strategies = new Map<string, WinnerSelectionStrategy>();

  constructor() {
    this.registerBuiltIns();
  }

  register(strategy: WinnerSelectionStrategy): void {
    this.strategies.set(strategy.algorithm, strategy);
  }

  select(
    algorithm: string,
    input: WinnerSelectionInput,
  ): { winners: string[]; version: number } {
    const strategy = this.strategies.get(algorithm);
    if (!strategy) {
      throw new WinnerSelectionException(`Unknown winner algorithm "${algorithm}".`);
    }
    if (input.eligible.length === 0) return { winners: [], version: strategy.version };
    return { winners: strategy.select(input), version: strategy.version };
  }

  private registerBuiltIns(): void {
    this.register({
      algorithm: TreasureWinnerAlgorithm.RANDOM,
      version: 1,
      select: (i) => weightedDraw(i.eligible, i.want, () => 1, seededRandom(i.seed)),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.WEIGHTED_RANDOM,
      version: 1,
      select: (i) =>
        weightedDraw(
          i.eligible,
          i.want,
          (id) => Number(i.contributions.get(id) ?? 0n),
          seededRandom(i.seed),
        ),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.ACTIVITY_BASED,
      version: 1,
      select: (i) =>
        weightedDraw(i.eligible, i.want, (id) => i.activity.get(id) ?? 0, seededRandom(i.seed)),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.CONTRIBUTION_BASED,
      version: 1,
      // Deterministic top-N, the audio-room parity mode. Ties break on userId so
      // the order is stable across runs rather than dependent on Map insertion.
      select: (i) =>
        [...i.eligible]
          .sort((a, b) => {
            const diff = (i.contributions.get(b) ?? 0n) - (i.contributions.get(a) ?? 0n);
            if (diff > 0n) return 1;
            if (diff < 0n) return -1;
            return a.localeCompare(b);
          })
          .slice(0, i.want),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.VIP_PRIORITY,
      version: 1,
      select: (i) =>
        weightedDraw(
          i.eligible,
          i.want,
          // Tier multiplies odds; a non-VIP keeps the floor weight of 1.
          (id) => 1 + (i.vipTiers.get(id) ?? 0) * 2,
          seededRandom(i.seed),
        ),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-winner.service.spec.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-winner.service.ts \
        src/modules/video-rooms/services/video-room-treasure-winner.service.spec.ts
git commit -m "feat(vr-11): add winner selection registry with seeded determinism"
```

---

## Task 13: Lifecycle service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTreasureRepository`, `VideoRoomsRepository`, `VideoRoomPermissionService`, `LockService`, `EVENT_BUS`, `ConfigService`, `TreasureLevelRules`.
- Produces:
```ts
class VideoRoomTreasureService {
  create(actorId: string, roomId: string, dto?: { poolOverride?: number }): Promise<TreasureSession>
  start(actorId: string, roomId: string): Promise<TreasureSession>
  pause(actorId: string, roomId: string): Promise<TreasureSession>
  resume(actorId: string, roomId: string): Promise<TreasureSession>
  close(actorId: string, roomId: string): Promise<TreasureSession>
  archive(actorId: string, roomId: string): Promise<TreasureSession>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { TreasureSessionStatus } from '@prisma/client';
import {
  TreasureBoxException,
} from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureService } from './video-room-treasure.service';

const LEVELS = [
  { level: 1, threshold: 15000n, poolStrategy: 'PERCENTAGE', poolPercentBps: 1000,
    poolFixedAmount: null, winnerAlgorithm: 'RANDOM', winnerCount: 3,
    minStaySeconds: 120, minActivityEvents: 0 },
  { level: 2, threshold: 60000n, poolStrategy: 'PERCENTAGE', poolPercentBps: 1000,
    poolFixedAmount: null, winnerAlgorithm: 'RANDOM', winnerCount: 3,
    minStaySeconds: 120, minActivityEvents: 0 },
];

describe('VideoRoomTreasureService', () => {
  let repo: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let perms: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomTreasureService;

  const config = { get: () => ({ enabled: 'true', poolBps: '1000', winnerCount: '3' }) };
  const names = () => bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(() => {
    repo = {
      listEnabledLevels: jest.fn().mockResolvedValue(LEVELS),
      findCurrentSession: jest.fn().mockResolvedValue(null),
      createSession: jest.fn().mockResolvedValue({ id: 's1', roomId: 'r1', currentLevel: 1 }),
      transitionSession: jest.fn().mockResolvedValue({ id: 's1', roomId: 'r1', currentLevel: 1 }),
      listBoxes: jest.fn().mockResolvedValue([{ id: 'b1', level: 1, threshold: 15000n }]),
      activateBox: jest.fn().mockResolvedValue(undefined),
    };
    rooms = { getSettings: jest.fn().mockResolvedValue({ allowTreasure: true }) };
    perms = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn((_k, fn) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomTreasureService(
      repo as never, rooms as never, perms as never,
      locks as never, bus as never, config as never,
    );
  });

  describe('create', () => {
    it('freezes the whole ladder into the session snapshot', async () => {
      await service.create('owner', 'r1');
      const arg = repo.createSession.mock.calls[0][0];
      expect(arg.levelSnapshot).toEqual([
        expect.objectContaining({ level: 1, threshold: 15000, winnerCount: 3 }),
        expect.objectContaining({ level: 2, threshold: 60000 }),
      ]);
      expect(arg.boxes).toEqual([
        { level: 1, threshold: 15000n }, { level: 2, threshold: 60000n },
      ]);
    });

    it('publishes TreasureCreated', async () => {
      await service.create('owner', 'r1');
      expect(names()).toEqual(['video_room.treasure.created']);
    });

    it('requires MANAGE_TREASURE', async () => {
      await service.create('owner', 'r1');
      expect(perms.assertPermission).toHaveBeenCalledWith('r1', 'owner', 'MANAGE_TREASURE');
    });

    it('refuses when a ladder already exists in the room', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's0' });
      await expect(service.create('owner', 'r1')).rejects.toThrow(TreasureBoxException);
    });

    it('refuses when the room disabled treasure', async () => {
      rooms.getSettings.mockResolvedValue({ allowTreasure: false });
      await expect(service.create('owner', 'r1')).rejects.toThrow(TreasureBoxException);
    });

    it('refuses when no levels are configured', async () => {
      repo.listEnabledLevels.mockResolvedValue([]);
      await expect(service.create('owner', 'r1')).rejects.toThrow(TreasureBoxException);
    });
  });

  describe('start', () => {
    it('moves DRAFT to ACTIVE and activates level 1', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.DRAFT });
      await service.start('owner', 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1', [TreasureSessionStatus.DRAFT], TreasureSessionStatus.ACTIVE,
      );
      expect(repo.activateBox).toHaveBeenCalledWith('b1', undefined);
      expect(names()).toEqual(['video_room.treasure.started']);
    });

    // The conditional UPDATE is what resolves two concurrent owner clicks;
    // a null result means this caller lost, and must not also emit an event.
    it('throws when the session was not in DRAFT', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.ACTIVE });
      repo.transitionSession.mockResolvedValue(null);
      await expect(service.start('owner', 'r1')).rejects.toThrow(TreasureBoxException);
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('pause / resume', () => {
    it('pauses only from ACTIVE', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1' });
      await service.pause('owner', 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1', [TreasureSessionStatus.ACTIVE], TreasureSessionStatus.PAUSED,
      );
    });

    it('resumes only from PAUSED', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1' });
      await service.resume('owner', 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1', [TreasureSessionStatus.PAUSED], TreasureSessionStatus.ACTIVE,
      );
    });
  });

  describe('close', () => {
    it('closes from DRAFT, ACTIVE or PAUSED and publishes TreasureClosed', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1' });
      await service.close('owner', 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1',
        [TreasureSessionStatus.DRAFT, TreasureSessionStatus.ACTIVE, TreasureSessionStatus.PAUSED],
        TreasureSessionStatus.CLOSED,
      );
      expect(names()).toEqual(['video_room.treasure.closed']);
    });
  });

  it('serialises every lifecycle command on the per-room lock', async () => {
    await service.create('owner', 'r1');
    expect(locks.withLock).toHaveBeenCalledWith(
      'video-room:treasure:lifecycle:{r1}', expect.any(Function),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TreasureSession, TreasureSessionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import { treasureLifecycleLockKey } from '../constants/video-room-treasure.constants';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  TreasureClosedEvent,
  TreasureCreatedEvent,
  TreasureStartedEvent,
} from '../events/video-room-treasure.events';
import { TreasureBoxException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import type { TreasureLevelRules } from './video-room-treasure-pool.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

/** States a room may hold before another ladder can be created. */
const LIVE = [
  TreasureSessionStatus.DRAFT,
  TreasureSessionStatus.ACTIVE,
  TreasureSessionStatus.PAUSED,
];

/**
 * The treasure lifecycle state machine (VR-11 spec §6.0).
 *
 * Every transition is a conditional UPDATE via `repo.transitionSession`, so two
 * concurrent owner commands are resolved by the database: exactly one gets a
 * non-null result and emits its event. The per-room lock is belt-and-braces for
 * the read-then-write in `create`, where the guard and the insert are separate
 * statements.
 */
@Injectable()
export class VideoRoomTreasureService {
  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async create(
    actorId: string,
    roomId: string,
    dto: { poolOverride?: number } = {},
  ): Promise<TreasureSession> {
    return this.locks.withLock(treasureLifecycleLockKey(roomId), async () => {
      await this.authorize(roomId, actorId);
      await this.assertRoomAllowsTreasure(roomId);

      if (await this.repo.findCurrentSession(roomId)) {
        throw new TreasureBoxException(
          'This room already has a treasure ladder. Close it before creating another.',
        );
      }

      const levels = await this.repo.listEnabledLevels();
      if (levels.length === 0) {
        throw new TreasureBoxException(
          'No treasure levels are configured.',
          HttpStatus.FAILED_DEPENDENCY,
        );
      }

      // Freeze the ladder now (D9). Reading live config at unlock would let an
      // admin edit change the rules of a ladder players are already filling.
      const snapshot: TreasureLevelRules[] = levels.map((l) => ({
        level: l.level,
        threshold: Number(l.threshold),
        poolStrategy: dto.poolOverride !== undefined ? 'ADMIN_OVERRIDE' : l.poolStrategy,
        poolPercentBps: l.poolPercentBps,
        poolFixedAmount: dto.poolOverride ?? (l.poolFixedAmount ? Number(l.poolFixedAmount) : null),
        winnerAlgorithm: l.winnerAlgorithm,
        winnerCount: l.winnerCount,
        minStaySeconds: l.minStaySeconds,
        minActivityEvents: l.minActivityEvents,
      }));

      const session = await this.repo.createSession({
        roomId,
        createdBy: actorId,
        levelSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        boxes: levels.map((l) => ({ level: l.level, threshold: l.threshold })),
      });

      await this.bus.publish(
        new TreasureCreatedEvent({
          correlationId: randomUUID(),
          roomId,
          sessionId: session.id,
          createdBy: actorId,
          levels: snapshot.map((l) => l.level),
        }),
      );
      return session;
    });
  }

  async start(actorId: string, roomId: string): Promise<TreasureSession> {
    return this.locks.withLock(treasureLifecycleLockKey(roomId), async () => {
      const current = await this.requireSession(roomId, actorId);
      const session = await this.transition(current.id, [TreasureSessionStatus.DRAFT],
        TreasureSessionStatus.ACTIVE, 'start a ladder that is not in draft');

      // Boxes are created PENDING so a DRAFT ladder cannot absorb an in-flight
      // gift; starting promotes level 1 to ACTIVE.
      const boxes = await this.repo.listBoxes(session.id);
      const first = boxes.find((b) => b.level === session.currentLevel);
      if (first) await this.repo.activateBox(first.id, undefined as never);

      await this.bus.publish(
        new TreasureStartedEvent({
          correlationId: randomUUID(),
          roomId,
          sessionId: session.id,
          level: session.currentLevel,
          startedBy: actorId,
          threshold: Number(first?.threshold ?? 0n),
        }),
      );
      return session;
    });
  }

  async pause(actorId: string, roomId: string): Promise<TreasureSession> {
    const current = await this.requireSession(roomId, actorId);
    return this.transition(current.id, [TreasureSessionStatus.ACTIVE],
      TreasureSessionStatus.PAUSED, 'pause a ladder that is not active');
  }

  async resume(actorId: string, roomId: string): Promise<TreasureSession> {
    const current = await this.requireSession(roomId, actorId);
    return this.transition(current.id, [TreasureSessionStatus.PAUSED],
      TreasureSessionStatus.ACTIVE, 'resume a ladder that is not paused');
  }

  async close(actorId: string, roomId: string): Promise<TreasureSession> {
    const current = await this.requireSession(roomId, actorId);
    const session = await this.transition(current.id, LIVE,
      TreasureSessionStatus.CLOSED, 'close a ladder that has already ended');
    await this.bus.publish(
      new TreasureClosedEvent({
        correlationId: randomUUID(),
        roomId,
        sessionId: session.id,
        status: TreasureSessionStatus.CLOSED,
        closedBy: actorId,
      }),
    );
    return session;
  }

  /**
   * Archiving hides a finished ladder from `GET /` while leaving it readable via
   * history and winners — so an owner can tidy the room without destroying the
   * payout record.
   */
  async archive(actorId: string, roomId: string): Promise<TreasureSession> {
    await this.authorize(roomId, actorId);
    const latest = await this.repo.findCurrentSession(roomId);
    if (latest) {
      throw new TreasureBoxException('Close the ladder before archiving it.');
    }
    const [sessions] = await this.repo.listSessions(roomId, 0, 1);
    const target = sessions[0];
    if (!target) {
      throw new TreasureBoxException('No treasure ladder to archive.', HttpStatus.NOT_FOUND);
    }
    return this.transition(
      target.id,
      [TreasureSessionStatus.COMPLETED, TreasureSessionStatus.CLOSED],
      TreasureSessionStatus.ARCHIVED,
      'archive a ladder that has not finished',
    );
  }

  // ---- internals ----

  private async authorize(roomId: string, actorId: string): Promise<void> {
    if (!loadVideoRoomTreasureConfig(this.config).enabled) {
      throw new TreasureBoxException(
        'The treasure engine is disabled.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.permissions.assertPermission(
      roomId,
      actorId,
      VideoRoomPermission.MANAGE_TREASURE,
    );
  }

  private async assertRoomAllowsTreasure(roomId: string): Promise<void> {
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowTreasure) {
      throw new TreasureBoxException(
        'Treasure boxes are disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async requireSession(roomId: string, actorId: string): Promise<TreasureSession> {
    await this.authorize(roomId, actorId);
    const session = await this.repo.findCurrentSession(roomId);
    if (!session) {
      throw new TreasureBoxException('No treasure ladder in this room.', HttpStatus.NOT_FOUND);
    }
    return session;
  }

  private async transition(
    sessionId: string,
    from: TreasureSessionStatus[],
    to: TreasureSessionStatus,
    failure: string,
  ): Promise<TreasureSession> {
    const session = await this.repo.transitionSession(sessionId, from, to);
    if (!session) {
      throw new TreasureBoxException(`Cannot ${failure}.`);
    }
    return session;
  }
}
```

- [ ] **Step 4: Add `MANAGE_TREASURE` to the permission matrix**

In `src/modules/video-rooms/constants/video-room-permissions.ts`, add to the enum:

```ts
  /** Create / start / pause / resume / close / archive the treasure ladder. */
  MANAGE_TREASURE = 'MANAGE_TREASURE',
```

Add `VideoRoomPermission.MANAGE_TREASURE` to **both** the OWNER set and the ADMIN set
(follow how `MANAGE_ANNOUNCEMENTS` is listed). Then extend
`video-room-permissions.spec.ts` with:

```ts
  it('lets OWNER and ADMIN manage treasure, and nobody else', () => {
    expect(permissionsFor(VideoRoomMemberRole.OWNER).has(VideoRoomPermission.MANAGE_TREASURE)).toBe(true);
    expect(permissionsFor(VideoRoomMemberRole.ADMIN).has(VideoRoomPermission.MANAGE_TREASURE)).toBe(true);
    expect(permissionsFor(VideoRoomMemberRole.HOST).has(VideoRoomPermission.MANAGE_TREASURE)).toBe(false);
    expect(permissionsFor(VideoRoomMemberRole.VIEWER).has(VideoRoomPermission.MANAGE_TREASURE)).toBe(false);
  });
```

Use whatever helper the existing spec already uses to resolve a role's set — read the
file first and match it rather than inventing `permissionsFor`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure.service.spec.ts src/modules/video-rooms/constants/video-room-permissions.spec.ts`
Expected: PASS, 13 lifecycle tests + the existing permission tests plus the new one.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure.service.ts \
        src/modules/video-rooms/services/video-room-treasure.service.spec.ts \
        src/modules/video-rooms/constants/video-room-permissions.ts \
        src/modules/video-rooms/constants/video-room-permissions.spec.ts
git commit -m "feat(vr-11): add treasure lifecycle state machine and MANAGE_TREASURE"
```

---

## Task 14: Progress service (cascade, CAS, claim)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-progress.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-progress.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTreasureRepository`, `CacheService`, `ConfigService`.
- Produces:
```ts
interface TreasureContributionResult {
  sessionId: string | null;
  applied: number;
  events: DomainEvent<unknown>[];
  /** Lowest crossed level's box — the ONLY one enqueued. Chaining does the rest. */
  claimedBoxId: string | null;
  claimedLevel: number | null;
  correlationId: string;
}
class VideoRoomTreasureProgressService {
  apply(tx: Prisma.TransactionClient, i: {
    roomId; senderId; amount: number; giftTxnId: string; batchId?: string;
  }): Promise<TreasureContributionResult>
  recordActivity(roomId: string, sessionId: string, userId: string): Promise<void>
  shouldEmit(roomId: string): Promise<boolean>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';

const box = (level: number, threshold: bigint, progress = 0n, status = TreasureBoxStatus.ACTIVE) =>
  ({ id: `b${level}`, level, threshold, progress, status, sessionId: 's1', roomId: 'r1' });

describe('VideoRoomTreasureProgressService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let service: VideoRoomTreasureProgressService;
  const tx = {} as never;
  const config = { get: () => ({ progressEmitPerSecond: '5' }) };

  const apply = (amount: number) =>
    service.apply(tx, { roomId: 'r1', senderId: 'u1', amount, giftTxnId: 'g1' });

  beforeEach(() => {
    repo = {
      findCurrentSession: jest.fn().mockResolvedValue({
        id: 's1', roomId: 'r1', currentLevel: 1, status: TreasureSessionStatus.ACTIVE,
      }),
      listBoxes: jest.fn().mockResolvedValue([box(1, 15_000n), box(2, 60_000n, 0n, TreasureBoxStatus.PENDING)]),
      addProgress: jest.fn(),
      addContribution: jest.fn().mockResolvedValue(undefined),
      claimUnlock: jest.fn().mockResolvedValue(true),
      setSessionLevel: jest.fn().mockResolvedValue(undefined),
      activateBox: jest.fn().mockResolvedValue(undefined),
      getBox: jest.fn(),
    };
    cache = { set: jest.fn(), get: jest.fn().mockResolvedValue(null), increment: jest.fn() };
    service = new VideoRoomTreasureProgressService(repo as never, cache as never, config as never);
  });

  it('is a no-op when the session is not ACTIVE', async () => {
    repo.findCurrentSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.PAUSED });
    const res = await apply(5_000);
    expect(res).toEqual(expect.objectContaining({ applied: 0, claimedBoxId: null }));
    expect(repo.addProgress).not.toHaveBeenCalled();
  });

  it('is a no-op when the room has no ladder', async () => {
    repo.findCurrentSession.mockResolvedValue(null);
    expect((await apply(5_000)).applied).toBe(0);
  });

  it('adds progress below the threshold without claiming', async () => {
    repo.addProgress.mockResolvedValue(box(1, 15_000n, 5_000n));
    const res = await apply(5_000);
    expect(res.applied).toBe(5_000);
    expect(res.claimedBoxId).toBeNull();
    expect(repo.claimUnlock).not.toHaveBeenCalled();
  });

  it('claims the box when progress reaches the threshold', async () => {
    repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
    const res = await apply(15_000);
    expect(repo.claimUnlock).toHaveBeenCalledWith('b1', tx);
    expect(res.claimedBoxId).toBe('b1');
    expect(res.claimedLevel).toBe(1);
  });

  // The loser of the claim race must not enqueue: the winner already did.
  it('does not report a claim when another transaction won the race', async () => {
    repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
    repo.claimUnlock.mockResolvedValue(false);
    expect((await apply(15_000)).claimedBoxId).toBeNull();
  });

  it('retries the compare-and-set once when progress moved underneath it', async () => {
    repo.addProgress.mockResolvedValueOnce(null).mockResolvedValueOnce(box(1, 15_000n, 7_000n));
    repo.getBox.mockResolvedValue(box(1, 15_000n, 2_000n));
    const res = await apply(5_000);
    expect(repo.addProgress).toHaveBeenCalledTimes(2);
    expect(res.applied).toBe(5_000);
  });

  describe('combo cascade', () => {
    it('spills overflow into later boxes and claims each crossed level', async () => {
      repo.listBoxes.mockResolvedValue([
        box(1, 15_000n), box(2, 60_000n, 0n, TreasureBoxStatus.PENDING),
      ]);
      repo.addProgress
        .mockResolvedValueOnce(box(1, 15_000n, 15_000n))
        .mockResolvedValueOnce(box(2, 60_000n, 25_000n, TreasureBoxStatus.ACTIVE));
      const res = await apply(40_000);
      expect(res.applied).toBe(40_000);
      expect(repo.addProgress.mock.calls[0][2]).toBe(15_000n); // capped at what L1 needed
      expect(repo.addProgress.mock.calls[1][2]).toBe(25_000n); // remainder to L2
    });

    // Only the LOWEST crossed box is enqueued; the unlock handler chains the
    // rest, which is what keeps payouts and animations in level order.
    it('reports only the lowest crossed level for enqueue', async () => {
      repo.listBoxes.mockResolvedValue([box(1, 15_000n), box(2, 60_000n, 0n, TreasureBoxStatus.PENDING)]);
      repo.addProgress
        .mockResolvedValueOnce(box(1, 15_000n, 15_000n))
        .mockResolvedValueOnce(box(2, 60_000n, 60_000n, TreasureBoxStatus.ACTIVE));
      const res = await apply(75_000);
      expect(res.claimedLevel).toBe(1);
      expect(repo.claimUnlock).toHaveBeenCalledTimes(2); // both claimed
    });

    it('stops counting once the ladder is exhausted, refunding nothing', async () => {
      repo.listBoxes.mockResolvedValue([box(1, 15_000n)]);
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
      const res = await apply(999_000);
      expect(res.applied).toBe(15_000); // the rest simply does not count
    });
  });

  describe('shouldEmit', () => {
    it('allows the first emit in a window and suppresses the next', async () => {
      cache.get.mockResolvedValueOnce(null);
      expect(await service.shouldEmit('r1')).toBe(true);
      cache.get.mockResolvedValueOnce(Date.now());
      expect(await service.shouldEmit('r1')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-progress.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TreasureBox, TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { DomainEvent } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import {
  treasureActivityKey,
  treasureEmitKey,
  treasureLevelKey,
  treasureProgressKey,
} from '../constants/video-room-treasure.constants';
import { TreasureProgressUpdatedEvent } from '../events/video-room-treasure.events';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';

export interface TreasureContributionResult {
  sessionId: string | null;
  applied: number;
  events: DomainEvent<unknown>[];
  /** Lowest crossed box. Only this one is enqueued; unlock chains the rest. */
  claimedBoxId: string | null;
  claimedLevel: number | null;
  correlationId: string;
}

/** Bounded CAS retries. Losing twice in one gift means extreme contention. */
const MAX_CAS_RETRIES = 3;

/**
 * Raises the treasure counter from inside the gift transaction (VR-11 §6.2–6.3).
 *
 * Postgres-only by contract: no Redis, no queue, no sockets. The Redis mirror and
 * the enqueue happen after commit, driven by what this returns. That is why a
 * treasure failure can never roll back a paid gift.
 *
 * Progress is a COUNTER, not an escrow — nothing here debits or credits anyone,
 * so overflow past the last box simply stops counting rather than refunding.
 */
@Injectable()
export class VideoRoomTreasureProgressService {
  private readonly logger = new Logger(VideoRoomTreasureProgressService.name);

  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  async apply(
    tx: Prisma.TransactionClient,
    input: {
      roomId: string;
      senderId: string;
      amount: number;
      giftTxnId: string;
      batchId?: string;
    },
  ): Promise<TreasureContributionResult> {
    const correlationId = randomUUID();
    const idle: TreasureContributionResult = {
      sessionId: null, applied: 0, events: [],
      claimedBoxId: null, claimedLevel: null, correlationId,
    };

    const session = await this.repo.findCurrentSession(input.roomId);
    // Only an ACTIVE ladder accumulates. DRAFT, PAUSED, and every terminal state
    // are silent no-ops: the gift still succeeds, it just does not count.
    if (!session || session.status !== TreasureSessionStatus.ACTIVE) return idle;

    const boxes = await this.repo.listBoxes(session.id, tx);
    const events: DomainEvent<unknown>[] = [];
    let remaining = BigInt(input.amount);
    let applied = 0n;
    let claimedBoxId: string | null = null;
    let claimedLevel: number | null = null;
    let level = session.currentLevel;

    while (remaining > 0n) {
      const box = boxes.find((b) => b.level === level);
      if (!box) break; // ladder exhausted — stop counting, refund nothing
      if (box.status === TreasureBoxStatus.OPENED || box.status === TreasureBoxStatus.UNLOCKING) {
        level += 1;
        continue;
      }

      const updated = await this.applyToBox(tx, box, remaining);
      if (!updated) break; // contention beyond retries; the next gift will carry it

      const delta = updated.progress - box.progress;
      remaining -= delta;
      applied += delta;

      await this.repo.addContribution(
        {
          boxId: box.id, sessionId: session.id, roomId: input.roomId,
          userId: input.senderId, amount: delta, giftTxnId: input.giftTxnId,
        },
        tx,
      );

      events.push(
        new TreasureProgressUpdatedEvent({
          correlationId,
          roomId: input.roomId,
          sessionId: session.id,
          boxId: box.id,
          level: box.level,
          batchId: input.batchId,
          progress: Number(updated.progress),
          threshold: Number(updated.threshold),
          percent: Number((updated.progress * 10_000n) / updated.threshold) / 100,
        }),
      );

      if (updated.progress < updated.threshold) break;

      // Threshold crossed. Exactly one transaction wins this claim.
      const won = await this.repo.claimUnlock(box.id, tx);
      if (won && claimedBoxId === null) {
        claimedBoxId = box.id;
        claimedLevel = box.level;
      }

      level += 1;
      const next = boxes.find((b) => b.level === level);
      if (next) {
        await this.repo.setSessionLevel(session.id, level, tx);
        await this.repo.activateBox(next.id, tx);
      }
    }

    return {
      sessionId: session.id,
      applied: Number(applied),
      events,
      claimedBoxId,
      claimedLevel,
      correlationId,
    };
  }

  /**
   * Compare-and-set with bounded retry. `addProgress` returns null when another
   * transaction moved progress first — normal under load, so we re-read and try
   * again rather than failing the gift.
   */
  private async applyToBox(
    tx: Prisma.TransactionClient,
    box: TreasureBox,
    remaining: bigint,
  ): Promise<TreasureBox | null> {
    let current = box;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const needed = current.threshold - current.progress;
      if (needed <= 0n) return current;
      const delta = remaining < needed ? remaining : needed;

      const updated = await this.repo.addProgress(current.id, current.progress, delta, tx);
      if (updated) return updated;

      const fresh = await this.repo.getBox(current.id, tx);
      if (!fresh) return null;
      current = fresh;
    }
    this.logger.warn(`CAS contention exhausted on treasure box ${box.id}`);
    return null;
  }

  /** Mirrors committed progress into Redis for fast status reads. Post-commit only. */
  async mirror(roomId: string, level: number, progress: number): Promise<void> {
    await Promise.all([
      this.cache.set(treasureProgressKey(roomId), { level, progress }),
      this.cache.set(treasureLevelKey(roomId), level),
    ]);
  }

  /** Feeds the ACTIVITY_BASED algorithm and the min-activity eligibility floor. */
  async recordActivity(roomId: string, sessionId: string, userId: string): Promise<void> {
    await this.cache.increment(`${treasureActivityKey(roomId, sessionId)}:${userId}`, { by: 1 });
  }

  /**
   * Throttle gate for treasureProgressUpdated. A hot room at 200 gifts/sec would
   * otherwise push 200 broadcasts/sec of a barely-changed number to every socket.
   * Threshold crossings bypass this entirely — the caller does not consult it.
   */
  async shouldEmit(roomId: string): Promise<boolean> {
    const perSecond = loadVideoRoomTreasureConfig(this.config).progressEmitPerSecond;
    if (perSecond <= 0) return true;
    const key = treasureEmitKey(roomId);
    const last = await this.cache.get<number>(key);
    const now = Date.now();
    const minGapMs = Math.floor(1000 / perSecond);
    if (last !== null && now - last < minGapMs) return false;
    await this.cache.set(key, now, 60);
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-progress.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-progress.service.ts \
        src/modules/video-rooms/services/video-room-treasure-progress.service.spec.ts
git commit -m "feat(vr-11): add treasure progress cascade with CAS and unlock claim"
```

---

## Task 15: Wire `onSend` into the gift context handler

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-gift-context.handler.ts` — **the only existing `src/` file this phase changes**
- Modify: `src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTreasureProgressService.apply/mirror/recordActivity/shouldEmit`, `QueueService`, `QUEUE_NAMES.GIFT_PROCESSING`, `VIDEO_ROOM_TREASURE_QUEUE_JOB`.
- Produces: `interface VideoRoomTreasureUnlockJob { roomId; sessionId; boxId; level; correlationId }` — consumed by Tasks 16 and 17.

- [ ] **Step 1: Write the failing test**

Append to `video-room-gift-context.handler.spec.ts`:

```ts
describe('onSend (VR-11 treasure)', () => {
  // Build the handler exactly as the existing describe blocks in this file do,
  // adding the two new constructor args. Read the top of this spec and reuse its
  // factory rather than duplicating the mock setup.
  const ctx = {
    contextType: 'VIDEO_ROOM', contextId: 'r1', senderId: 'u1', receiverIds: ['u2'],
    gift: { id: 'g1', name: 'Rose' }, quantity: 1,
    transactionId: 't1', batchId: 'batch1', idempotencyKey: 'idem1', totalCoinValue: 5_000,
  } as never;

  it('accepts the whole amount and never refunds — progress is a counter, not an escrow', async () => {
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 5_000, events: [], claimedBoxId: null,
      claimedLevel: null, correlationId: 'c1',
    });
    const effects = await handler.onSend(tx, ctx);
    expect(effects.acceptedAmount).toBe(5_000);
    expect(effects.refundAmount).toBe(0);
  });

  it('performs no wallet work inside the gift transaction', async () => {
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 5_000, events: [], claimedBoxId: null,
      claimedLevel: null, correlationId: 'c1',
    });
    await handler.onSend(tx, ctx);
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('returns progress events for post-commit publication when the throttle allows', async () => {
    const evt = { name: 'video_room.treasure.progress_updated' };
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 5_000, events: [evt], claimedBoxId: null,
      claimedLevel: null, correlationId: 'c1',
    });
    progress.shouldEmit.mockResolvedValue(true);
    const effects = await handler.onSend(tx, ctx);
    expect(effects.events).toEqual([evt]);
  });

  it('suppresses throttled progress events but keeps a threshold crossing', async () => {
    const evt = { name: 'video_room.treasure.progress_updated' };
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 15_000, events: [evt], claimedBoxId: 'b1',
      claimedLevel: 1, correlationId: 'c1',
    });
    progress.shouldEmit.mockResolvedValue(false);
    const effects = await handler.onSend(tx, ctx);
    expect(effects.events).toEqual([evt]); // crossing bypasses the throttle
  });

  it('drops throttled progress events when nothing was claimed', async () => {
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 100, events: [{ name: 'x' }], claimedBoxId: null,
      claimedLevel: null, correlationId: 'c1',
    });
    progress.shouldEmit.mockResolvedValue(false);
    expect((await handler.onSend(tx, ctx)).events).toEqual([]);
  });

  // The enqueue MUST be post-commit: a rolled-back gift must not schedule a payout.
  it('enqueues the unlock job only from postCommit, never inside the transaction', async () => {
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 15_000, events: [], claimedBoxId: 'b1',
      claimedLevel: 1, correlationId: 'c1',
    });
    const effects = await handler.onSend(tx, ctx);
    expect(queue.enqueue).not.toHaveBeenCalled();
    await effects.postCommit?.();
    expect(queue.enqueue).toHaveBeenCalledWith(
      'gift-processing',
      'video-room.treasure.unlock',
      { roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1, correlationId: 'c1' },
      expect.any(Object),
    );
  });

  it('enqueues nothing when no box was claimed', async () => {
    progress.apply.mockResolvedValue({
      sessionId: 's1', applied: 100, events: [], claimedBoxId: null,
      claimedLevel: null, correlationId: 'c1',
    });
    await (await handler.onSend(tx, ctx)).postCommit?.();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('never fails the gift when treasure processing throws', async () => {
    progress.apply.mockRejectedValue(new Error('treasure exploded'));
    const effects = await handler.onSend(tx, ctx);
    expect(effects).toEqual(
      expect.objectContaining({ acceptedAmount: 5_000, refundAmount: 0, events: [] }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
Expected: FAIL — `handler.onSend is not a function`.

- [ ] **Step 3: Add `onSend` to the handler**

Add the imports and constructor params, then the method. Replace the class doc comment
first — the old one asserts there is no `onSend`:

```ts
/**
 * The VIDEO_ROOM gift context (VR-10, extended VR-11).
 *
 * `onSend` raises the treasure counter and, when a box fills, claims it. It does
 * NO wallet work: video treasure progress is a counter, not an escrow (VR-11 D1),
 * so the send transaction stays a debit, N credits, N ledger rows and one
 * `UPDATE … SET progress = progress + n`. The receiver still earns their VR-10
 * creator share; nothing is double-spent.
 *
 * Gifting is gated by membership + room settings, not by the RBAC permission
 * matrix. That matrix is management-only — HOST/PARTICIPANT/VIEWER all map to
 * empty permission sets — so adding SEND_GIFT there would mean granting it to
 * all six roles, which encodes nothing.
 */
```

New constructor params (append after `registry`):

```ts
    private readonly treasureProgress: VideoRoomTreasureProgressService,
    private readonly queue: QueueService,
```

The method:

```ts
  /**
   * Treasure contribution, inside the send transaction. Postgres only, per the
   * GiftSendEffects contract: the Redis mirror and the unlock enqueue are
   * deferred to `postCommit`, so a rolled-back gift can never schedule a payout.
   *
   * Everything here is best-effort. A treasure fault must never fail a paid
   * gift, so the whole body is guarded and degrades to "gift succeeded, nothing
   * counted" — which is also exactly what a room with no ladder returns.
   */
  async onSend(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects> {
    // Nothing is escrowed, so the full amount is always accepted and the refund
    // is always zero. These two values are structural, not conditional.
    const inert: GiftSendEffects = {
      acceptedAmount: ctx.totalCoinValue,
      refundAmount: 0,
      events: [],
    };

    try {
      const result = await this.treasureProgress.apply(tx, {
        roomId: ctx.contextId,
        senderId: ctx.senderId,
        amount: ctx.totalCoinValue,
        giftTxnId: ctx.transactionId,
        batchId: ctx.batchId,
      });

      if (!result.sessionId) return inert;

      // A threshold crossing always broadcasts; routine progress is throttled so
      // a hot room cannot fan out 200 near-identical updates a second.
      const crossed = result.claimedBoxId !== null;
      const events = crossed || (await this.treasureProgress.shouldEmit(ctx.contextId))
        ? result.events
        : [];

      const sessionId = result.sessionId;
      const claimedBoxId = result.claimedBoxId;
      const claimedLevel = result.claimedLevel;
      const correlationId = result.correlationId;

      return {
        ...inert,
        events,
        postCommit: async () => {
          await this.treasureProgress
            .recordActivity(ctx.contextId, sessionId, ctx.senderId)
            .catch(() => undefined);

          if (claimedBoxId && claimedLevel !== null) {
            await this.queue.enqueue(
              QUEUE_NAMES.GIFT_PROCESSING,
              VIDEO_ROOM_TREASURE_QUEUE_JOB,
              {
                roomId: ctx.contextId,
                sessionId,
                boxId: claimedBoxId,
                level: claimedLevel,
                correlationId,
              } satisfies VideoRoomTreasureUnlockJob,
              // jobId makes a duplicated postCommit idempotent at the queue.
              { jobId: `treasure-unlock:${claimedBoxId}`, attempts: 5 },
            );
          }
        },
      };
    } catch (err) {
      this.logger.error(
        `Treasure contribution failed for room ${ctx.contextId}: ${(err as Error).message}`,
      );
      return inert;
    }
  }
```

Add above the class:

```ts
/** Payload of the `video-room.treasure.unlock` BullMQ job. */
export interface VideoRoomTreasureUnlockJob {
  roomId: string;
  sessionId: string;
  boxId: string;
  level: number;
  correlationId: string;
}
```

Add `private readonly logger = new Logger(VideoRoomGiftContextHandler.name);` as the
first class member, and import `Logger`, `Prisma`, `QueueService`, `QUEUE_NAMES`,
`VIDEO_ROOM_TREASURE_QUEUE_JOB`, `VideoRoomTreasureProgressService`, and the
`GiftSendContext` / `GiftSendEffects` types.

- [ ] **Step 4: Run the gift suite to verify nothing regressed**

Run: `npx jest src/modules/video-rooms/services/video-room-gift`
Expected: PASS — all pre-existing gift tests plus the 8 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-gift-context.handler.ts \
        src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts
git commit -m "feat(vr-11): feed treasure progress from the video gift context"
```

---

## Task 16: Unlock pipeline

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-unlock.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-unlock.service.spec.ts`

**Interfaces:**
- Consumes: `QueueJobRegistry`, `LockService`, `PrismaService`, both repositories, `VideoRoomTreasurePoolService`, `VideoRoomTreasureEligibilityService`, `VideoRoomTreasureWinnerService`, `RewardDistributor`, `QueueService`, `EVENT_BUS`, `ConfigService`, `VideoRoomTreasureUnlockJob`.
- Produces: `interface UnlockResult { replayed: boolean; winners: number; poolAmount: number }` and `handle(job: VideoRoomTreasureUnlockJob, attempt: number): Promise<UnlockResult>` (Task 17 calls `handle` directly for recovery).

- [ ] **Step 1: Write the failing test**

```ts
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { TreasureUnlockException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureUnlockService } from './video-room-treasure-unlock.service';

const JOB = { roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1, correlationId: 'c1' };
const SNAPSHOT = {
  levelSnapshot: [
    { level: 1, threshold: 15_000, poolStrategy: 'PERCENTAGE', poolPercentBps: 1000,
      poolFixedAmount: null, winnerAlgorithm: 'RANDOM', winnerCount: 3,
      minStaySeconds: 120, minActivityEvents: 0 },
    { level: 2, threshold: 60_000, poolStrategy: 'PERCENTAGE', poolPercentBps: 1000,
      poolFixedAmount: null, winnerAlgorithm: 'RANDOM', winnerCount: 3,
      minStaySeconds: 120, minActivityEvents: 0 },
  ],
};

describe('VideoRoomTreasureUnlockService', () => {
  let repo: Record<string, jest.Mock>;
  let rewards: Record<string, jest.Mock>;
  let eligibility: { resolve: jest.Mock };
  let winners: { select: jest.Mock };
  let distributor: { distribute: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: { publish: jest.Mock };
  let locks: { withLock: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  let service: VideoRoomTreasureUnlockService;

  const config = { get: () => ({ oversampleFactor: '3', oversampleMin: '50' }) };
  const names = () => bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(() => {
    repo = {
      getBox: jest.fn().mockResolvedValue({
        id: 'b1', level: 1, sessionId: 's1', roomId: 'r1',
        threshold: 15_000n, progress: 15_000n, status: TreasureBoxStatus.UNLOCKING,
      }),
      getSnapshot: jest.fn().mockResolvedValue(SNAPSHOT),
      findCurrentSession: jest.fn().mockResolvedValue({
        id: 's1', status: TreasureSessionStatus.ACTIVE, currentLevel: 2,
      }),
      contributionTotals: jest.fn().mockResolvedValue([]),
      listBoxes: jest.fn().mockResolvedValue([
        { id: 'b1', level: 1, threshold: 15_000n, progress: 15_000n, status: TreasureBoxStatus.UNLOCKING },
        { id: 'b2', level: 2, threshold: 60_000n, progress: 0n, status: TreasureBoxStatus.ACTIVE },
      ]),
      openBox: jest.fn().mockResolvedValue(undefined),
      setSessionLevel: jest.fn().mockResolvedValue(undefined),
      transitionSession: jest.fn().mockResolvedValue({ id: 's1' }),
      claimUnlock: jest.fn().mockResolvedValue(false),
    };
    rewards = {
      createPool: jest.fn().mockResolvedValue({ id: 'p1' }),
      createWinners: jest.fn().mockResolvedValue(3),
      createPendingRewards: jest.fn().mockResolvedValue(undefined),
      markDistributed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      setAllocated: jest.fn().mockResolvedValue(undefined),
    };
    eligibility = { resolve: jest.fn().mockResolvedValue({ eligible: ['u1','u2','u3'], candidateCount: 12 }) };
    winners = { select: jest.fn().mockReturnValue({ winners: ['u1','u2','u3'], version: 1 }) };
    distributor = {
      distribute: jest.fn().mockResolvedValue([
        { userId: 'u1', rank: 1, coins: 500n, walletTxnId: 'w1' },
        { userId: 'u2', rank: 2, coins: 500n, walletTxnId: 'w2' },
        { userId: 'u3', rank: 3, coins: 500n, walletTxnId: 'w3' },
      ]),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn((_k, fn) => fn()) };
    prisma = { $transaction: jest.fn((fn) => fn(prisma)) };

    service = new VideoRoomTreasureUnlockService(
      { register: jest.fn() } as never, locks as never, prisma as never,
      repo as never, rewards as never, { compute: (r: never) => ({
        strategy: 'PERCENTAGE', sourceAmount: 15_000n, poolAmount: 1_500n,
      }), allocate: (p: bigint, ids: string[]) => ids.map((userId) => ({
        userId, amount: p / BigInt(ids.length), shareBps: 3333,
      })) } as never,
      eligibility as never, winners as never, distributor as never,
      queue as never, bus as never, config as never,
    );
  });

  it('runs the happy path and pays every winner', async () => {
    const res = await service.handle(JOB, 1);
    expect(res).toEqual({ replayed: false, winners: 3, poolAmount: 1_500 });
    expect(distributor.distribute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyPrefix: 'vr-treasure:b1' }),
      prisma,
    );
  });

  it('publishes the pipeline events in order with one correlationId', async () => {
    await service.handle(JOB, 1);
    expect(names()).toEqual([
      'video_room.treasure.reward_generated',
      'video_room.treasure.winner_selected',
      'video_room.treasure.reward_distributed',
      'video_room.treasure.reward_distributed',
      'video_room.treasure.reward_distributed',
      'video_room.treasure.unlocked',
    ]);
    for (const call of bus.publish.mock.calls) {
      expect((call[0] as { payload: { correlationId: string } }).payload.correlationId).toBe('c1');
    }
  });

  // Replay safety: an OPENED box means a previous attempt already paid out.
  it('exits as a replay when the box is already OPENED', async () => {
    repo.getBox.mockResolvedValue({ id: 'b1', status: TreasureBoxStatus.OPENED, level: 1 });
    expect(await service.handle(JOB, 2)).toEqual({ replayed: true, winners: 0, poolAmount: 0 });
    expect(distributor.distribute).not.toHaveBeenCalled();
  });

  it('exits as a replay when the pool row already exists', async () => {
    rewards.createPool.mockResolvedValue(null);
    expect((await service.handle(JOB, 2)).replayed).toBe(true);
    expect(distributor.distribute).not.toHaveBeenCalled();
  });

  it('throws when the box was never claimed', async () => {
    repo.getBox.mockResolvedValue({ id: 'b1', status: TreasureBoxStatus.ACTIVE, level: 1 });
    await expect(service.handle(JOB, 1)).rejects.toThrow(TreasureUnlockException);
  });

  it('completes a PAUSED session\'s in-flight box — the winners were already claimed', async () => {
    repo.findCurrentSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.PAUSED, currentLevel: 2 });
    expect((await service.handle(JOB, 1)).winners).toBe(3);
  });

  describe('zero eligible', () => {
    it('opens the box, mints nothing, and broadcasts empty winners', async () => {
      eligibility.resolve.mockResolvedValue({ eligible: [], candidateCount: 0 });
      winners.select.mockReturnValue({ winners: [], version: 1 });
      const res = await service.handle(JOB, 1);
      expect(res.winners).toBe(0);
      expect(distributor.distribute).not.toHaveBeenCalled();
      expect(repo.openBox).toHaveBeenCalled();
      expect(names()).toContain('video_room.treasure.unlocked');
    });
  });

  describe('chaining', () => {
    it('enqueues the next box when the combo already filled it', async () => {
      repo.listBoxes.mockResolvedValue([
        { id: 'b1', level: 1, threshold: 15_000n, progress: 15_000n, status: TreasureBoxStatus.UNLOCKING },
        { id: 'b2', level: 2, threshold: 60_000n, progress: 60_000n, status: TreasureBoxStatus.ACTIVE },
      ]);
      repo.claimUnlock.mockResolvedValue(true);
      await service.handle(JOB, 1);
      expect(queue.enqueue).toHaveBeenCalledWith(
        'gift-processing', 'video-room.treasure.unlock',
        expect.objectContaining({ boxId: 'b2', level: 2, correlationId: 'c1' }),
        expect.any(Object),
      );
    });

    it('enqueues nothing when the next box is below its threshold', async () => {
      await service.handle(JOB, 1);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('completes the session when the final box opens', async () => {
      repo.listBoxes.mockResolvedValue([
        { id: 'b1', level: 1, threshold: 15_000n, progress: 15_000n, status: TreasureBoxStatus.UNLOCKING },
      ]);
      await service.handle(JOB, 1);
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1', expect.arrayContaining([TreasureSessionStatus.ACTIVE]),
        TreasureSessionStatus.COMPLETED, prisma,
      );
    });
  });

  describe('failure', () => {
    it('records the stage, publishes the failure, and rethrows so BullMQ retries', async () => {
      distributor.distribute.mockRejectedValue(new Error('wallet timeout'));
      await expect(service.handle(JOB, 2)).rejects.toThrow('wallet timeout');
      expect(rewards.markFailed).toHaveBeenCalledWith('b1', 'DISTRIBUTION', 'wallet timeout');
      const failed = bus.publish.mock.calls.find(
        (c) => (c[0] as { name: string }).name === 'video_room.treasure.unlock_failed',
      );
      expect((failed![0] as { payload: { stage: string; attempt: number } }).payload)
        .toEqual(expect.objectContaining({ stage: 'DISTRIBUTION', attempt: 2 }));
    });

    it('attributes an eligibility failure to the ELIGIBILITY stage', async () => {
      eligibility.resolve.mockRejectedValue(new Error('redis down'));
      await expect(service.handle(JOB, 1)).rejects.toThrow('redis down');
      expect(rewards.markFailed).toHaveBeenCalledWith('b1', 'ELIGIBILITY', 'redis down');
    });
  });

  it('serialises unlocks per room so payouts and animations stay ordered', async () => {
    await service.handle(JOB, 1);
    expect(locks.withLock).toHaveBeenCalledWith(
      'video-room:treasure:unlock:{r1}', expect.any(Function),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-unlock.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BackpackItemSource,
  Prisma,
  TreasureBox,
  TreasureBoxStatus,
  TreasureSessionStatus,
  WalletTxnReason,
} from '@prisma/client';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/database/prisma.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import { RewardDistributor } from 'src/modules/treasure-boxes/services/reward-distributor.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import {
  TreasureUnlockStage,
  treasureUnlockLockKey,
  VIDEO_ROOM_TREASURE_QUEUE_JOB,
} from '../constants/video-room-treasure.constants';
import {
  TreasureRewardDistributedEvent,
  TreasureRewardGeneratedEvent,
  TreasureUnlockedEvent,
  TreasureUnlockFailedEvent,
  TreasureWinnerSelectedEvent,
} from '../events/video-room-treasure.events';
import { TreasureUnlockException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureRewardRepository } from '../repositories/video-room-treasure-reward.repository';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import type { VideoRoomTreasureUnlockJob } from './video-room-gift-context.handler';
import {
  VideoRoomTreasurePoolService,
  type TreasureLevelRules,
} from './video-room-treasure-pool.service';
import { VideoRoomTreasureEligibilityService } from './video-room-treasure-eligibility.service';
import { VideoRoomTreasureWinnerService } from './video-room-treasure-winner.service';

export interface UnlockResult {
  replayed: boolean;
  winners: number;
  poolAmount: number;
}

/** Session states whose in-flight boxes still complete. PAUSED is deliberate. */
const UNLOCKABLE = [TreasureSessionStatus.ACTIVE, TreasureSessionStatus.PAUSED];

/**
 * The unlock pipeline (VR-11 spec §6.4).
 *
 * Runs on the shared gift queue via the job registry, so it inherits BullMQ's
 * retry, backoff and dead-lettering rather than reimplementing them. Errors are
 * rethrown deliberately — that is what drives a retry and eventually the DLQ the
 * recovery monitor replays.
 *
 * Pool, eligibility and winner selection run BEFORE the transaction opens:
 * holding a Postgres transaction across a Redis round-trip exhausts the
 * connection pool under load. The unique constraints on the pool and winner rows
 * make a retry that re-draws different winners fail closed rather than double-pay.
 */
@Injectable()
export class VideoRoomTreasureUnlockService implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomTreasureUnlockService.name);

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly locks: LockService,
    private readonly prisma: PrismaService,
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rewards: VideoRoomTreasureRewardRepository,
    private readonly pool: VideoRoomTreasurePoolService,
    private readonly eligibility: VideoRoomTreasureEligibilityService,
    private readonly winners: VideoRoomTreasureWinnerService,
    private readonly distributor: RewardDistributor,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_TREASURE_QUEUE_JOB,
      (data, job: Job) =>
        this.handle(data as VideoRoomTreasureUnlockJob, (job.attemptsMade ?? 0) + 1),
    );
  }

  async handle(job: VideoRoomTreasureUnlockJob, attempt: number): Promise<UnlockResult> {
    return this.locks.withLock(treasureUnlockLockKey(job.roomId), async () => {
      let stage: TreasureUnlockStage = TreasureUnlockStage.VALIDATE;
      try {
        // ---- 1 VALIDATE ----
        const box = await this.repo.getBox(job.boxId);
        if (!box) throw new TreasureUnlockException(`Treasure box ${job.boxId} not found.`);
        if (box.status === TreasureBoxStatus.OPENED) {
          this.logger.debug(`Unlock replay for box ${job.boxId} — already opened`);
          return { replayed: true, winners: 0, poolAmount: 0 };
        }
        if (box.status !== TreasureBoxStatus.UNLOCKING) {
          throw new TreasureUnlockException(
            `Box ${job.boxId} is ${box.status}, expected UNLOCKING.`,
          );
        }

        const session = await this.repo.findCurrentSession(job.roomId);
        if (!session || !UNLOCKABLE.includes(session.status)) {
          throw new TreasureUnlockException(
            `Session for room ${job.roomId} is not unlockable.`,
          );
        }

        const snapshot = await this.repo.getSnapshot(job.sessionId);
        const rules = (snapshot?.levelSnapshot as unknown as TreasureLevelRules[] | undefined)
          ?.find((r) => r.level === box.level);
        if (!rules) {
          throw new TreasureUnlockException(
            `No frozen rules for level ${box.level} in session ${job.sessionId}.`,
          );
        }

        // ---- 2 POOL ----
        stage = TreasureUnlockStage.POOL;
        const computed = this.pool.compute(rules);
        const seed = `${box.id}:${job.correlationId}`;

        // ---- 3 ELIGIBILITY ----
        stage = TreasureUnlockStage.ELIGIBILITY;
        const cfg = loadVideoRoomTreasureConfig(this.config);
        const { eligible, candidateCount } = await this.eligibility.resolve({
          roomId: job.roomId,
          sessionId: job.sessionId,
          rules,
          want: rules.winnerCount,
          oversampleFactor: cfg.oversampleFactor,
          oversampleMin: cfg.oversampleMin,
        });

        // ---- 4 WINNER SELECTION ----
        stage = TreasureUnlockStage.WINNER_SELECTION;
        const totals = await this.repo.contributionTotals(box.id);
        const { winners: drawn, version } = this.winners.select(rules.winnerAlgorithm, {
          eligible,
          want: rules.winnerCount,
          seed,
          contributions: new Map(totals.map((t) => [t.userId, t.amount])),
          activity: new Map(),
          vipTiers: new Map(),
        });
        const allocations = this.pool.allocate(computed.poolAmount, drawn);

        // ---- 5 DISTRIBUTION (one transaction) ----
        stage = TreasureUnlockStage.DISTRIBUTION;
        const outcome = await this.prisma.$transaction(async (tx) => {
          const poolRow = await this.rewards.createPool(
            {
              boxId: box.id, sessionId: box.sessionId, roomId: box.roomId, level: box.level,
              strategy: computed.strategy, sourceAmount: computed.sourceAmount,
              poolAmount: computed.poolAmount, winnerCount: allocations.length,
              algorithm: rules.winnerAlgorithm, algorithmVersion: version, selectionSeed: seed,
            },
            tx,
          );
          // A null pool row means another worker already minted this box.
          if (!poolRow) return null;

          await this.rewards.createWinners(
            allocations.map((a) => ({
              boxId: box.id, sessionId: box.sessionId, roomId: box.roomId,
              userId: a.userId, algorithm: rules.winnerAlgorithm, shareBps: a.shareBps,
              amount: a.amount, eligibleCount: eligible.length, candidateCount,
            })),
            tx,
          );

          await this.rewards.createPendingRewards(
            allocations.map((a, i) => ({
              sessionId: box.sessionId, boxId: box.id, roomId: box.roomId,
              level: box.level, userId: a.userId, rank: i + 1, coins: a.amount,
            })),
            tx,
          );

          let distributed: { userId: string; walletTxnId: string | null }[] = [];
          if (allocations.length > 0) {
            distributed = await this.distributor.distribute(
              {
                recipients: allocations.map((a, i) => ({ rank: i + 1, userId: a.userId })),
                rewards: allocations.map((a, i) => ({
                  rank: i + 1, kind: 'COINS' as const, coins: Number(a.amount),
                })),
                idempotencyPrefix: `vr-treasure:${box.id}`,
                walletReason: WalletTxnReason.TREASURE_BOX,
                backpackSource: BackpackItemSource.TREASURE_BOX,
                referenceType: 'video_room_treasure_box',
                referenceId: box.id,
              },
              tx,
            );
            for (const d of distributed) {
              await this.rewards.markDistributed(box.id, d.userId, d.walletTxnId, tx);
            }
          }

          const allocated = allocations.reduce((sum, a) => sum + a.amount, 0n);
          await this.rewards.setAllocated(box.id, allocated, tx);
          await this.repo.openBox(box.id, tx);

          const next = await this.advance(tx, box, job);
          return { distributed, allocated, nextLevel: next };
        });

        if (!outcome) {
          this.logger.debug(`Unlock replay for box ${job.boxId} — pool already minted`);
          return { replayed: true, winners: 0, poolAmount: 0 };
        }

        // ---- 6 BROADCAST (post-commit) ----
        stage = TreasureUnlockStage.BROADCAST;
        await this.publish(job, box, computed, rules, version, eligible.length,
          candidateCount, allocations, outcome.distributed, outcome.nextLevel);

        // ---- 9 CHAIN ----
        stage = TreasureUnlockStage.CHAIN;
        await this.chain(job, box);

        return {
          replayed: false,
          winners: allocations.length,
          poolAmount: Number(computed.poolAmount),
        };
      } catch (err) {
        const message = (err as Error).message;
        await this.rewards.markFailed(job.boxId, stage, message).catch(() => undefined);
        await this.bus
          .publish(
            new TreasureUnlockFailedEvent({
              correlationId: job.correlationId, roomId: job.roomId,
              sessionId: job.sessionId, boxId: job.boxId, level: job.level,
              stage, attempt, error: message,
            }),
          )
          .catch(() => undefined);
        // Rethrow so BullMQ retries and ultimately dead-letters the job.
        throw err;
      }
    });
  }

  /** Promote the next box, or complete the ladder when this was the last one. */
  private async advance(
    tx: Prisma.TransactionClient,
    box: TreasureBox,
    job: VideoRoomTreasureUnlockJob,
  ): Promise<number | null> {
    const boxes = await this.repo.listBoxes(box.sessionId, tx);
    const next = boxes.find((b) => b.level === box.level + 1);
    if (!next) {
      await this.repo.transitionSession(
        job.sessionId, UNLOCKABLE, TreasureSessionStatus.COMPLETED, tx,
      );
      return null;
    }
    await this.repo.setSessionLevel(job.sessionId, next.level, tx);
    await this.repo.activateBox(next.id, tx);
    return next.level;
  }

  /**
   * Step 9. The ONLY enqueue path after the first job: if a combo gift already
   * filled the next box, claim it and queue it. Chaining rather than fanning out
   * is what keeps a four-level combo paying out in level order.
   */
  private async chain(job: VideoRoomTreasureUnlockJob, box: TreasureBox): Promise<void> {
    const boxes = await this.repo.listBoxes(box.sessionId);
    const next = boxes.find((b) => b.level === box.level + 1);
    if (!next || next.progress < next.threshold) return;
    if (!(await this.repo.claimUnlock(next.id))) return;

    await this.queue.enqueue(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_TREASURE_QUEUE_JOB,
      {
        roomId: job.roomId, sessionId: job.sessionId,
        boxId: next.id, level: next.level, correlationId: job.correlationId,
      } satisfies VideoRoomTreasureUnlockJob,
      { jobId: `treasure-unlock:${next.id}`, attempts: 5 },
    );
  }

  private async publish(
    job: VideoRoomTreasureUnlockJob,
    box: TreasureBox,
    computed: { strategy: string; sourceAmount: bigint; poolAmount: bigint },
    rules: TreasureLevelRules,
    version: number,
    eligibleCount: number,
    candidateCount: number,
    allocations: { userId: string; amount: bigint; shareBps: number }[],
    distributed: { userId: string; walletTxnId: string | null }[],
    nextLevel: number | null,
  ): Promise<void> {
    const base = {
      correlationId: job.correlationId, roomId: job.roomId,
      sessionId: job.sessionId, boxId: box.id, level: box.level,
    };
    const winnerPayload = allocations.map((a) => ({
      userId: a.userId, amount: Number(a.amount), shareBps: a.shareBps,
    }));

    await this.bus.publish(
      new TreasureRewardGeneratedEvent({
        ...base, strategy: computed.strategy,
        poolAmount: Number(computed.poolAmount),
        sourceAmount: Number(computed.sourceAmount),
        winnerCount: allocations.length,
      }),
    );
    await this.bus.publish(
      new TreasureWinnerSelectedEvent({
        ...base, algorithm: rules.winnerAlgorithm, algorithmVersion: version,
        eligibleCount, candidateCount, winners: winnerPayload,
      }),
    );
    for (const d of distributed) {
      const alloc = allocations.find((a) => a.userId === d.userId);
      await this.bus.publish(
        new TreasureRewardDistributedEvent({
          ...base, userId: d.userId,
          amount: Number(alloc?.amount ?? 0n), walletTxnId: d.walletTxnId,
        }),
      );
    }
    await this.bus.publish(
      new TreasureUnlockedEvent({
        ...base, poolAmount: Number(computed.poolAmount),
        winners: winnerPayload, algorithm: rules.winnerAlgorithm, nextLevel,
      }),
    );
  }
}
```

Note: add `Inject` to the `@nestjs/common` import list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-unlock.service.spec.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-unlock.service.ts \
        src/modules/video-rooms/services/video-room-treasure-unlock.service.spec.ts
git commit -m "feat(vr-11): add the treasure unlock pipeline with chaining and replay safety"
```

---

## Task 17: Recovery service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-recovery.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-recovery.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTreasureRepository.findOrphanedBoxes`, `VideoRoomTreasureRewardRepository.getPool`, `VideoRoomTreasureUnlockService.handle`, `QueueService`, `LockService`, `EVENT_BUS`, `ConfigService`.
- Produces: `sweep(): Promise<{ reclaimed: number; replayed: number }>` — Task 25 calls it directly.

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomTreasureRecoveryService } from './video-room-treasure-recovery.service';

const NOW = 1_700_000_000_000;
const orphan = (id: string) => ({
  id, sessionId: 's1', roomId: 'r1', level: 1, status: 'UNLOCKING',
});

describe('VideoRoomTreasureRecoveryService', () => {
  let repo: Record<string, jest.Mock>;
  let rewards: { getPool: jest.Mock };
  let unlock: { handle: jest.Mock };
  let queue: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomTreasureRecoveryService;

  const cfg = (over = {}) => ({
    get: () => ({ recoveryEnabled: 'true', orphanTimeoutSeconds: '120',
                  monitorIntervalSeconds: '30', ...over }),
  });

  beforeEach(() => {
    repo = { findOrphanedBoxes: jest.fn().mockResolvedValue([]) };
    rewards = { getPool: jest.fn().mockResolvedValue(null) };
    unlock = { handle: jest.fn().mockResolvedValue({ replayed: false, winners: 3, poolAmount: 1500 }) };
    queue = { replayDeadLettered: jest.fn().mockResolvedValue(0) };
    locks = { withLock: jest.fn((_k, fn) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomTreasureRecoveryService(
      repo as never, rewards as never, unlock as never,
      queue as never, locks as never, bus as never, cfg() as never, () => NOW,
    );
  });

  it('does nothing when recovery is disabled', async () => {
    service = new VideoRoomTreasureRecoveryService(
      repo as never, rewards as never, unlock as never, queue as never,
      locks as never, bus as never, cfg({ recoveryEnabled: 'false' }) as never, () => NOW,
    );
    expect(await service.sweep()).toEqual({ reclaimed: 0, replayed: 0 });
    expect(repo.findOrphanedBoxes).not.toHaveBeenCalled();
  });

  it('looks back exactly the configured orphan timeout', async () => {
    await service.sweep();
    expect(repo.findOrphanedBoxes).toHaveBeenCalledWith(new Date(NOW - 120_000), expect.any(Number));
  });

  it('re-runs an orphaned box that never minted a pool', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
    const res = await service.sweep();
    expect(unlock.handle).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: 'b1', roomId: 'r1', level: 1 }), 1,
    );
    expect(res.reclaimed).toBe(1);
    expect(bus.publish).toHaveBeenCalled();
  });

  // A pool row means the unlock DID run; the box is UNLOCKING only because the
  // process died after committing. Re-running would be a no-op replay, but
  // skipping it keeps the sweep cheap and the logs honest.
  it('skips an orphan that already has a pool row', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
    rewards.getPool.mockResolvedValue({ id: 'p1' });
    const res = await service.sweep();
    expect(unlock.handle).not.toHaveBeenCalled();
    expect(res.reclaimed).toBe(0);
  });

  it('publishes TreasureRecovered with the ORPHAN_RECLAIM reason', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
    await service.sweep();
    const evt = bus.publish.mock.calls[0][0] as { name: string; payload: { reason: string } };
    expect(evt.name).toBe('video_room.treasure.recovered');
    expect(evt.payload.reason).toBe('ORPHAN_RECLAIM');
  });

  // One poisoned box must not stop the sweep reclaiming the rest.
  it('continues past a box whose re-run throws', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1'), orphan('b2')]);
    unlock.handle.mockRejectedValueOnce(new Error('still broken'));
    const res = await service.sweep();
    expect(unlock.handle).toHaveBeenCalledTimes(2);
    expect(res.reclaimed).toBe(1);
  });

  it('serialises the sweep fleet-wide so two pods cannot both reclaim', async () => {
    await service.sweep();
    expect(locks.withLock).toHaveBeenCalledWith(
      'video-room:treasure:recovery', expect.any(Function),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-recovery.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import { TreasureRecoveredEvent } from '../events/video-room-treasure.events';
import { VideoRoomTreasureRewardRepository } from '../repositories/video-room-treasure-reward.repository';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import { VideoRoomTreasureUnlockService } from './video-room-treasure-unlock.service';

/** Fleet-wide sweep lock: many pods, one sweeper. */
const RECOVERY_LOCK_KEY = 'video-room:treasure:recovery';
/** Cap per sweep so a large backlog degrades gracefully instead of stalling a tick. */
const MAX_PER_SWEEP = 50;

/**
 * Reconciles unlocks that never finished (VR-11 spec §6.8).
 *
 * Two failure shapes, one fix. A box left UNLOCKING past the orphan timeout means
 * the process died between the claim (which committed with the gift) and the job
 * running — BullMQ never saw the job, so its retry cannot help. Re-running
 * `handle` is safe because the pool and winner unique constraints make it either
 * complete the work or exit as a replay.
 */
@Injectable()
export class VideoRoomTreasureRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomTreasureRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rewards: VideoRoomTreasureRewardRepository,
    private readonly unlock: VideoRoomTreasureUnlockService,
    private readonly queue: QueueService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  onModuleInit(): void {
    const cfg = loadVideoRoomTreasureConfig(this.config);
    if (!cfg.recoveryEnabled) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.warn(`Treasure recovery sweep failed: ${(err as Error).message}`),
      );
    }, cfg.monitorIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<{ reclaimed: number; replayed: number }> {
    const cfg = loadVideoRoomTreasureConfig(this.config);
    if (!cfg.recoveryEnabled) return { reclaimed: 0, replayed: 0 };

    return this.locks.withLock(RECOVERY_LOCK_KEY, async () => {
      const cutoff = new Date(this.now() - cfg.orphanTimeoutSeconds * 1000);
      const orphans = await this.repo.findOrphanedBoxes(cutoff, MAX_PER_SWEEP);
      let reclaimed = 0;

      for (const box of orphans) {
        // A pool row proves the unlock already committed; nothing to reclaim.
        if (await this.rewards.getPool(box.id)) continue;

        const correlationId = `recovery:${box.id}`;
        try {
          await this.unlock.handle(
            {
              roomId: box.roomId, sessionId: box.sessionId,
              boxId: box.id, level: box.level, correlationId,
            },
            1,
          );
          reclaimed += 1;
          await this.bus.publish(
            new TreasureRecoveredEvent({
              correlationId, roomId: box.roomId, sessionId: box.sessionId,
              boxId: box.id, level: box.level, reason: 'ORPHAN_RECLAIM', attempt: 1,
            }),
          );
        } catch (err) {
          // One poisoned box must not stop the sweep reclaiming the rest.
          this.logger.warn(
            `Failed to reclaim treasure box ${box.id}: ${(err as Error).message}`,
          );
        }
      }

      if (reclaimed > 0) {
        this.logger.log(`Reclaimed ${reclaimed} orphaned treasure unlock(s)`);
      }
      return { reclaimed, replayed: 0 };
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-recovery.service.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-recovery.service.ts \
        src/modules/video-rooms/services/video-room-treasure-recovery.service.spec.ts
git commit -m "feat(vr-11): add treasure orphan reclaim and recovery sweep"
```

---

## Task 18: Query service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure-query.service.ts`
- Test: `src/modules/video-rooms/services/video-room-treasure-query.service.spec.ts`

**Interfaces:**
- Consumes: both repositories, `VideoRoomPermissionService`, `buildPaginated`.
- Produces:
```ts
class VideoRoomTreasureQueryService {
  status(roomId: string): Promise<TreasureStatusView>
  history(roomId, q: {skip;limit;page}): Promise<Paginated<unknown>>
  winners(roomId, q: {skip;limit;page}): Promise<Paginated<unknown>>
  statistics(actorId: string, roomId: string): Promise<TreasureStatisticsView>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { VideoRoomTreasureQueryService } from './video-room-treasure-query.service';

describe('VideoRoomTreasureQueryService', () => {
  let repo: Record<string, jest.Mock>;
  let rewards: Record<string, jest.Mock>;
  let perms: { assertPermission: jest.Mock };
  let service: VideoRoomTreasureQueryService;

  beforeEach(() => {
    repo = {
      findCurrentSession: jest.fn().mockResolvedValue({
        id: 's1', roomId: 'r1', currentLevel: 2, status: TreasureSessionStatus.ACTIVE,
      }),
      listBoxes: jest.fn().mockResolvedValue([
        { id: 'b1', level: 1, threshold: 15_000n, progress: 15_000n, status: TreasureBoxStatus.OPENED, openedAt: new Date(0) },
        { id: 'b2', level: 2, threshold: 60_000n, progress: 12_000n, status: TreasureBoxStatus.ACTIVE, openedAt: null },
      ]),
      listSessions: jest.fn().mockResolvedValue([[], 0]),
    };
    rewards = {
      listWinners: jest.fn().mockResolvedValue([[], 0]),
      listWinnersByBox: jest.fn().mockResolvedValue([]),
      statistics: jest.fn().mockResolvedValue({ totalPools: 4, totalMinted: 12_000n, totalWinners: 12 }),
    };
    perms = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomTreasureQueryService(repo as never, rewards as never, perms as never);
  });

  describe('status', () => {
    it('reports inactive when the room has no ladder', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      expect(await service.status('r1')).toEqual({ active: false });
    });

    it('computes remaining coins and completion percentage per box', async () => {
      const res = await service.status('r1');
      expect(res.boxes[1]).toEqual(
        expect.objectContaining({
          level: 2, progress: 12_000, threshold: 60_000, remaining: 48_000, percent: 20,
        }),
      );
    });

    it('reports an opened box as 100% with zero remaining', async () => {
      const res = await service.status('r1');
      expect(res.boxes[0]).toEqual(
        expect.objectContaining({ percent: 100, remaining: 0, status: 'OPENED' }),
      );
    });

    it('converts every BigInt to a number at the DTO boundary', async () => {
      const res = await service.status('r1');
      for (const box of res.boxes) {
        expect(typeof box.progress).toBe('number');
        expect(typeof box.threshold).toBe('number');
      }
    });
  });

  describe('statistics', () => {
    it('requires VIEW_ANALYTICS', async () => {
      await service.statistics('u1', 'r1');
      expect(perms.assertPermission).toHaveBeenCalledWith('r1', 'u1', 'VIEW_ANALYTICS');
    });

    it('returns minted totals as numbers', async () => {
      const res = await service.statistics('u1', 'r1');
      expect(res).toEqual(
        expect.objectContaining({ totalPools: 4, totalMinted: 12_000, totalWinners: 12 }),
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-query.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable } from '@nestjs/common';
import { TreasureBox } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomTreasureRewardRepository } from '../repositories/video-room-treasure-reward.repository';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface TreasureBoxView {
  boxId: string;
  level: number;
  status: string;
  progress: number;
  threshold: number;
  remaining: number;
  percent: number;
  openedAt: string | null;
}

export interface TreasureStatusView {
  active: boolean;
  sessionId?: string;
  status?: string;
  currentLevel?: number;
  boxes?: TreasureBoxView[];
}

export interface TreasureStatisticsView {
  totalPools: number;
  totalMinted: number;
  totalWinners: number;
}

/**
 * The CQRS read side (VR-11 spec §7). Reads only — never mutates, never enqueues,
 * so it can be called freely from the controller without lifecycle side effects.
 *
 * Every BigInt is converted to a number here, at the DTO boundary, so no
 * BigInt ever reaches JSON.stringify (which throws on it).
 */
@Injectable()
export class VideoRoomTreasureQueryService {
  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rewards: VideoRoomTreasureRewardRepository,
    private readonly permissions: VideoRoomPermissionService,
  ) {}

  async status(roomId: string): Promise<TreasureStatusView> {
    const session = await this.repo.findCurrentSession(roomId);
    if (!session) return { active: false };

    const boxes = await this.repo.listBoxes(session.id);
    return {
      active: true,
      sessionId: session.id,
      status: session.status,
      currentLevel: session.currentLevel,
      boxes: boxes.map((b) => this.boxView(b)),
    };
  }

  history(roomId: string, q: { skip: number; limit: number; page: number }): Promise<Paginated<unknown>> {
    return this.repo
      .listSessions(roomId, q.skip, q.limit)
      .then(([rows, total]) => buildPaginated(rows, total, q.page, q.limit));
  }

  winners(roomId: string, q: { skip: number; limit: number; page: number }): Promise<Paginated<unknown>> {
    return this.rewards.listWinners(roomId, q.skip, q.limit).then(([rows, total]) =>
      buildPaginated(
        rows.map((w) => ({
          boxId: w.boxId, sessionId: w.sessionId, userId: w.userId,
          algorithm: w.algorithm, shareBps: w.shareBps, amount: Number(w.amount),
          eligibleCount: w.eligibleCount, candidateCount: w.candidateCount,
          selectedAt: w.selectedAt.toISOString(),
        })),
        total, q.page, q.limit,
      ),
    );
  }

  async statistics(actorId: string, roomId: string): Promise<TreasureStatisticsView> {
    await this.permissions.assertPermission(roomId, actorId, VideoRoomPermission.VIEW_ANALYTICS);
    const stats = await this.rewards.statistics(roomId);
    return {
      totalPools: stats.totalPools,
      totalMinted: Number(stats.totalMinted),
      totalWinners: stats.totalWinners,
    };
  }

  private boxView(box: TreasureBox): TreasureBoxView {
    const progress = box.progress;
    const threshold = box.threshold;
    // Clamp: an overfilled box (the tail of a combo gift) must not read >100%.
    const capped = progress > threshold ? threshold : progress;
    return {
      boxId: box.id,
      level: box.level,
      status: box.status,
      progress: Number(progress),
      threshold: Number(threshold),
      remaining: Number(threshold - capped),
      percent: threshold === 0n ? 0 : Number((capped * 10_000n) / threshold) / 100,
      openedAt: box.openedAt ? box.openedAt.toISOString() : null,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure-query.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure-query.service.ts \
        src/modules/video-rooms/services/video-room-treasure-query.service.spec.ts
git commit -m "feat(vr-11): add treasure query service"
```

---

## Task 19: DTOs

**Files:**
- Create: `src/modules/video-rooms/dto/video-room-treasure.dto.ts`
- Test: `src/modules/video-rooms/dto/video-room-treasure.dto.spec.ts`

**Interfaces:**
- Consumes: `class-validator`, `@nestjs/swagger`.
- Produces: `CreateTreasureBoxDto`, `TreasureProgressDto`, `TreasureRewardDto`, `TreasureWinnerDto`, `TreasureStatisticsDto`, `TreasureResponseDto`, `TreasureHistoryQueryDto`.

- [ ] **Step 1: Write the failing test**

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTreasureBoxDto, TreasureHistoryQueryDto } from './video-room-treasure.dto';

const errorsFor = <T extends object>(Cls: new () => T, raw: unknown) =>
  validateSync(plainToInstance(Cls, raw) as object).flatMap((e) => Object.keys(e.constraints ?? {}));

describe('CreateTreasureBoxDto', () => {
  it('accepts an empty body — the ladder comes from configured levels', () => {
    expect(errorsFor(CreateTreasureBoxDto, {})).toEqual([]);
  });

  it('accepts a positive integer pool override', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: 2500 })).toEqual([]);
  });

  it('rejects a negative pool override', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: -1 })).toContain('min');
  });

  it('rejects a fractional pool override — coins are integers', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: 12.5 })).toContain('isInt');
  });
});

describe('TreasureHistoryQueryDto', () => {
  it('defaults to page 1 with a bounded limit', () => {
    const dto = plainToInstance(TreasureHistoryQueryDto, {});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('coerces numeric query strings', () => {
    const dto = plainToInstance(TreasureHistoryQueryDto, { page: '3', limit: '50' });
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it('rejects a limit above the cap so a client cannot page the whole table', () => {
    expect(errorsFor(TreasureHistoryQueryDto, { limit: 5000 })).toContain('max');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/video-room-treasure.dto.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * VR-11 treasure DTOs. The create body is deliberately near-empty: the ladder
 * shape comes from `VideoRoomTreasureLevel`, not from the client, so an owner
 * cannot mint themselves a custom pool by crafting a request. `poolOverride` is
 * the one admin-configurable escape hatch and is still bounded server-side.
 */
export class CreateTreasureBoxDto {
  @ApiPropertyOptional({
    description:
      'Fixed pool per box in GOLD, overriding the configured percentage. ' +
      'Switches every level to the ADMIN_OVERRIDE strategy for this ladder only.',
    example: 2500,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  poolOverride?: number;
}

export class TreasureHistoryQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class TreasureProgressDto {
  @ApiProperty({ example: 'b3f1…' }) boxId!: string;
  @ApiProperty({ example: 2 }) level!: number;
  @ApiProperty({ enum: ['PENDING', 'ACTIVE', 'UNLOCKING', 'OPENED'] }) status!: string;
  @ApiProperty({ example: 12000 }) progress!: number;
  @ApiProperty({ example: 60000 }) threshold!: number;
  @ApiProperty({ example: 48000, description: 'Coins still needed to unlock.' }) remaining!: number;
  @ApiProperty({ example: 20, description: 'Completion percentage, 0–100.' }) percent!: number;
  @ApiProperty({ nullable: true, example: null }) openedAt!: string | null;
}

export class TreasureResponseDto {
  @ApiProperty({ example: true }) active!: boolean;
  @ApiPropertyOptional({ example: 'a91c…' }) sessionId?: string;
  @ApiPropertyOptional({
    enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CLOSED', 'ARCHIVED'],
  })
  status?: string;
  @ApiPropertyOptional({ example: 2 }) currentLevel?: number;
  @ApiPropertyOptional({ type: [TreasureProgressDto] }) boxes?: TreasureProgressDto[];
}

export class TreasureWinnerDto {
  @ApiProperty() boxId!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ['RANDOM', 'WEIGHTED_RANDOM', 'ACTIVITY_BASED', 'CONTRIBUTION_BASED', 'VIP_PRIORITY'] })
  algorithm!: string;
  @ApiProperty({ example: 3333, description: 'Share of the pool in basis points.' })
  shareBps!: number;
  @ApiProperty({ example: 500 }) amount!: number;
  @ApiProperty({ example: 24, description: 'Users who passed eligibility at unlock.' })
  eligibleCount!: number;
  @ApiProperty({ example: 50, description: 'Users sampled before filtering.' })
  candidateCount!: number;
  @ApiProperty() selectedAt!: string;
}

export class TreasureRewardDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ example: 500 }) amount!: number;
  @ApiProperty({ enum: ['PENDING', 'DISTRIBUTED', 'FAILED'] }) status!: string;
  @ApiProperty({ nullable: true }) walletTxnId!: string | null;
  @ApiProperty({ nullable: true }) distributedAt!: string | null;
}

export class TreasureStatisticsDto {
  @ApiProperty({ example: 4, description: 'Boxes unlocked in this room, all time.' })
  totalPools!: number;
  @ApiProperty({ example: 12000, description: 'GOLD minted to winners, all time.' })
  totalMinted!: number;
  @ApiProperty({ example: 12 }) totalWinners!: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/dto/video-room-treasure.dto.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/dto/video-room-treasure.dto.ts \
        src/modules/video-rooms/dto/video-room-treasure.dto.spec.ts
git commit -m "feat(vr-11): add treasure DTOs"
```

---

## Task 20: Controller

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-treasure.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-treasure.controller.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomTreasureService`, `VideoRoomTreasureQueryService`, the DTOs, `CurrentUser`, `NotGuest`, `ParseUuidPipe`.
- Produces: the ten REST endpoints under `video-rooms/:id/treasure`.

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomsTreasureController } from './video-rooms-treasure.controller';

describe('VideoRoomsTreasureController', () => {
  let lifecycle: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let controller: VideoRoomsTreasureController;
  const user = { id: 'u1', roles: [] } as never;

  beforeEach(() => {
    lifecycle = {
      create: jest.fn().mockResolvedValue({ id: 's1' }),
      start: jest.fn().mockResolvedValue({ id: 's1' }),
      pause: jest.fn().mockResolvedValue({ id: 's1' }),
      resume: jest.fn().mockResolvedValue({ id: 's1' }),
      close: jest.fn().mockResolvedValue({ id: 's1' }),
      archive: jest.fn().mockResolvedValue({ id: 's1' }),
    };
    query = {
      status: jest.fn().mockResolvedValue({ active: false }),
      history: jest.fn().mockResolvedValue({ items: [] }),
      winners: jest.fn().mockResolvedValue({ items: [] }),
      statistics: jest.fn().mockResolvedValue({ totalPools: 0 }),
    };
    controller = new VideoRoomsTreasureController(lifecycle as never, query as never);
  });

  it.each(['start', 'pause', 'resume', 'close', 'archive'] as const)(
    'passes the actor id and room id straight through to %s',
    async (method) => {
      await controller[method](user, 'r1');
      expect(lifecycle[method]).toHaveBeenCalledWith('u1', 'r1');
    },
  );

  it('forwards the create body', async () => {
    await controller.create(user, 'r1', { poolOverride: 2500 } as never);
    expect(lifecycle.create).toHaveBeenCalledWith('u1', 'r1', { poolOverride: 2500 });
  });

  it('translates page/limit into skip for history', async () => {
    await controller.history('r1', { page: 3, limit: 20 } as never);
    expect(query.history).toHaveBeenCalledWith('r1', { skip: 40, limit: 20, page: 3 });
  });

  it('translates page/limit into skip for winners', async () => {
    await controller.winners('r1', { page: 1, limit: 50 } as never);
    expect(query.winners).toHaveBeenCalledWith('r1', { skip: 0, limit: 50, page: 1 });
  });

  it('passes the actor to statistics so the permission check can run', async () => {
    await controller.statistics(user, 'r1');
    expect(query.statistics).toHaveBeenCalledWith('u1', 'r1');
  });

  // Authorization belongs in the services, never inline here — the VR-10
  // controller convention.
  it('performs no authorization of its own', () => {
    const source = VideoRoomsTreasureController.prototype.constructor.toString();
    expect(source).not.toContain('assertPermission');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-treasure.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  CreateTreasureBoxDto,
  TreasureHistoryQueryDto,
  TreasureResponseDto,
  TreasureStatisticsDto,
  TreasureWinnerDto,
} from '../dto/video-room-treasure.dto';
import { VideoRoomTreasureQueryService } from '../services/video-room-treasure-query.service';
import { VideoRoomTreasureService } from '../services/video-room-treasure.service';

/**
 * VR-11 treasure REST surface (base `video-rooms/:id/treasure`).
 *
 * Lifecycle commands are synchronous and return the new session state. Unlocks
 * are NOT triggered here — they are driven by gift progress and delivered over
 * the socket, so there is deliberately no "open box" endpoint for a client to call.
 *
 * JWT-guarded globally. Authorization lives in VideoRoomTreasureService and
 * VideoRoomTreasureQueryService (MANAGE_TREASURE / VIEW_ANALYTICS) — never inline
 * here, per the VR-10 controller convention.
 */
@ApiTags('video-room-treasure')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsTreasureController {
  constructor(
    private readonly lifecycle: VideoRoomTreasureService,
    private readonly query: VideoRoomTreasureQueryService,
  ) {}

  private page(q: TreasureHistoryQueryDto): { skip: number; limit: number; page: number } {
    return { skip: (q.page - 1) * q.limit, limit: q.limit, page: q.page };
  }

  @Post(':id/treasure')
  @NotGuest()
  @ApiOperation({
    summary: 'Create a treasure ladder (DRAFT)',
    description:
      'Owner/admin only (MANAGE_TREASURE). Freezes the configured level ladder ' +
      'into the session so later admin edits cannot change a running ladder. ' +
      'Fails with VIDEO_ROOM_TREASURE_ALREADY_ACTIVE when one already exists.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 201, type: TreasureResponseDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_TREASURE_DISABLED / NOT_AUTHORIZED' })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_TREASURE_ALREADY_ACTIVE' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: CreateTreasureBoxDto,
  ) {
    return this.lifecycle.create(user.id, roomId, dto);
  }

  @Post(':id/treasure/start')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Start the ladder',
    description: 'DRAFT → ACTIVE, and level 1 begins accumulating. MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_TREASURE_INVALID — not in DRAFT' })
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.lifecycle.start(user.id, roomId);
  }

  @Post(':id/treasure/pause')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Pause contribution intake',
    description:
      'ACTIVE → PAUSED. Gifts still succeed but stop counting. A box already ' +
      'unlocking completes and still pays its winners. MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.lifecycle.pause(user.id, roomId);
  }

  @Post(':id/treasure/resume')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Resume intake', description: 'PAUSED → ACTIVE. MANAGE_TREASURE.' })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.lifecycle.resume(user.id, roomId);
  }

  @Post(':id/treasure/close')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'End the ladder early',
    description:
      'DRAFT/ACTIVE/PAUSED → CLOSED. Remaining boxes never unlock and nothing ' +
      'further is minted. Distinct from COMPLETED, which means the ladder ran to ' +
      'its end. MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  close(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.lifecycle.close(user.id, roomId);
  }

  @Post(':id/treasure/archive')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Archive a finished ladder',
    description:
      'COMPLETED/CLOSED → ARCHIVED. Hidden from GET /treasure but still readable ' +
      'via history and winners. MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.lifecycle.archive(user.id, roomId);
  }

  @Get(':id/treasure')
  @ApiOperation({
    summary: 'Current ladder state',
    description: 'Per-box progress, remaining coins and completion percentage. Any room member.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  status(@Param('id', ParseUuidPipe) roomId: string) {
    return this.query.status(roomId);
  }

  @Get(':id/treasure/history')
  @ApiOperation({ summary: 'Past ladders in this room', description: 'Paginated. Any room member.' })
  @ApiResponse({ status: 200, description: 'Paginated TreasureResponseDto envelope' })
  history(@Param('id', ParseUuidPipe) roomId: string, @Query() q: TreasureHistoryQueryDto) {
    return this.query.history(roomId, this.page(q));
  }

  @Get(':id/treasure/winners')
  @ApiOperation({
    summary: 'Winner history',
    description:
      'Every drawn winner with the algorithm, share and eligibility counts that ' +
      'produced them. Paginated. Any room member.',
  })
  @ApiResponse({ status: 200, type: [TreasureWinnerDto] })
  winners(@Param('id', ParseUuidPipe) roomId: string, @Query() q: TreasureHistoryQueryDto) {
    return this.query.winners(roomId, this.page(q));
  }

  @Get(':id/treasure/statistics')
  @ApiOperation({
    summary: 'Room treasure statistics',
    description: 'Boxes unlocked, GOLD minted and winners paid. Requires VIEW_ANALYTICS.',
  })
  @ApiResponse({ status: 200, type: TreasureStatisticsDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_TREASURE_NOT_AUTHORIZED' })
  statistics(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.query.statistics(user.id, roomId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-treasure.controller.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/video-rooms/controllers/video-rooms-treasure.controller.ts \
        src/modules/video-rooms/controllers/video-rooms-treasure.controller.spec.ts
git commit -m "feat(vr-11): add treasure REST controller with Swagger"
```

---

## Task 21: Socket listener

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-treasure-socket.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-treasure-socket.listener.spec.ts`

**Interfaces:**
- Consumes: `EVENT_BUS`, `SocketManager`, `VIDEO_ROOM_NAMESPACE`, `VIDEO_ROOM_TREASURE_SOCKET_EVENTS`, the treasure events.
- Produces: nothing consumed by later tasks (terminal bridge).

- [ ] **Step 1: Write the failing test**

```ts
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomTreasureSocketListener } from './video-room-treasure-socket.listener';

describe('VideoRoomTreasureSocketListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let sockets: { emitToRoom: jest.Mock };
  let listener: VideoRoomTreasureSocketListener;

  const fire = (name: string, payload: object) =>
    bus.handlers.get(name)!({ name, payload });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = {
      handlers,
      subscribe: jest.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)),
    };
    sockets = { emitToRoom: jest.fn() };
    listener = new VideoRoomTreasureSocketListener(bus as never, sockets as never);
    listener.onModuleInit();
  });

  it('subscribes to every treasure event that has a socket counterpart', () => {
    for (const name of [
      VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED,
      VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED,
      VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED,
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      VIDEO_ROOM_TREASURE_EVENTS.RECOVERED,
      VIDEO_ROOM_TREASURE_EVENTS.STARTED,
    ]) {
      expect(bus.subscribe).toHaveBeenCalledWith(name, expect.any(Function));
    }
  });

  it('broadcasts progress to the room on the /video-room namespace', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, {
      roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1,
      progress: 500, threshold: 15000, percent: 3.33, correlationId: 'c1',
    });
    expect(sockets.emitToRoom).toHaveBeenCalledWith(
      '/video-room', 'r1', 'treasureProgressUpdated',
      expect.objectContaining({ level: 1, progress: 500 }),
    );
  });

  // One unlock must produce BOTH the data event and the animation trigger, so
  // clients that only drive visuals need not parse the payload event.
  it('emits both treasureUnlocked and treasureAnimation for one unlock', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1,
      poolAmount: 1500, winners: [], algorithm: 'RANDOM', nextLevel: 2, correlationId: 'c1',
    });
    const events = sockets.emitToRoom.mock.calls.map((c) => c[2]);
    expect(events).toEqual(['treasureUnlocked', 'treasureAnimation', 'treasureLevelChanged']);
  });

  it('does not emit treasureLevelChanged when the ladder just completed', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 4,
      poolAmount: 35000, winners: [], algorithm: 'RANDOM', nextLevel: null, correlationId: 'c1',
    });
    const events = sockets.emitToRoom.mock.calls.map((c) => c[2]);
    expect(events).toEqual(['treasureUnlocked', 'treasureAnimation']);
  });

  it('carries the correlationId onto every socket payload', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED, {
      roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1, correlationId: 'c1',
      algorithm: 'RANDOM', algorithmVersion: 1, eligibleCount: 9, candidateCount: 50, winners: [],
    });
    expect(sockets.emitToRoom.mock.calls[0][3]).toEqual(
      expect.objectContaining({ correlationId: 'c1' }),
    );
  });

  // Throttling already happened upstream in onSend; the bridge must not
  // second-guess it, or a threshold crossing could be dropped here.
  it('does not throttle — it relays whatever reaches the bus', () => {
    const payload = {
      roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1,
      progress: 1, threshold: 2, percent: 50, correlationId: 'c1',
    };
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, payload);
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, payload);
    expect(sockets.emitToRoom).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-treasure-socket.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_TREASURE_SOCKET_EVENTS } from '../constants/video-room-treasure.constants';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureProgressUpdatedEvent,
  type TreasureRecoveredEvent,
  type TreasureRewardDistributedEvent,
  type TreasureStartedEvent,
  type TreasureUnlockedEvent,
  type TreasureWinnerSelectedEvent,
} from '../events/video-room-treasure.events';

/**
 * Bridges treasure events to the `/video-room` sockets (VR-11). Follows the
 * VR-10 pattern: no domain gateway — inbound is the shared BaseGateway, outbound
 * is EVENT_BUS relayed here.
 *
 * Deliberately does NOT throttle. Coalescing already happened in `onSend`, which
 * is the only place that can distinguish a routine progress tick from a
 * threshold crossing. Re-throttling here could silently drop an unlock.
 */
@Injectable()
export class VideoRoomTreasureSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureStartedEvent>(VIDEO_ROOM_TREASURE_EVENTS.STARTED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.LEVEL_CHANGED, e.payload),
    );

    this.bus.subscribe<TreasureProgressUpdatedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED,
      (e) =>
        this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.PROGRESS_UPDATED, e.payload),
    );

    this.bus.subscribe<TreasureWinnerSelectedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED,
      (e) =>
        this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.WINNER_SELECTED, e.payload),
    );

    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) =>
        this.toRoom(
          e.payload.roomId,
          VIDEO_ROOM_TREASURE_SOCKET_EVENTS.REWARD_DISTRIBUTED,
          e.payload,
        ),
    );

    this.bus.subscribe<TreasureUnlockedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, (e) => {
      const p = e.payload;
      this.toRoom(p.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.UNLOCKED, p);
      // A separate animation trigger so a client driving only visuals does not
      // have to parse the data payload.
      this.toRoom(p.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.ANIMATION, {
        correlationId: p.correlationId,
        roomId: p.roomId,
        boxId: p.boxId,
        level: p.level,
        poolAmount: p.poolAmount,
        winnerCount: p.winners.length,
      });
      // Only when a next box exists — a completed ladder has no level to change to.
      if (p.nextLevel !== null) {
        this.toRoom(p.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.LEVEL_CHANGED, {
          correlationId: p.correlationId,
          roomId: p.roomId,
          sessionId: p.sessionId,
          level: p.nextLevel,
        });
      }
    });

    this.bus.subscribe<TreasureRecoveredEvent>(VIDEO_ROOM_TREASURE_EVENTS.RECOVERED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.RECOVERED, e.payload),
    );
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
```

- [ ] **Step 4: Verify the `SocketManager.emitToRoom` signature matches**

Run: `grep -n "emitToRoom" src/infra/socket/socket.manager.ts`
Expected: a method taking `(namespace, roomId, event, payload)`. If the real signature
differs, adjust `toRoom` and the test's `expect(...toHaveBeenCalledWith(...))` to match —
do not change `SocketManager`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-treasure-socket.listener.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/listeners/video-room-treasure-socket.listener.ts \
        src/modules/video-rooms/listeners/video-room-treasure-socket.listener.spec.ts
git commit -m "feat(vr-11): bridge treasure events to video-room sockets"
```

---

## Task 22: Metrics and metrics listener

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (append a VR-11 block)
- Create: `src/modules/video-rooms/listeners/video-room-treasure-metrics.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-treasure-metrics.listener.spec.ts`

**Interfaces:**
- Produces on `VideoRoomsMetrics`: `setTreasureProgress(roomId, level, progress)`, `incTreasureUnlock(level, algorithm)`, `observeTreasureDistribution(level, seconds)`, `incTreasureFailure(stage)`, `setTreasureQueueDepth(n)`, `incTreasureMinted(level, strategy, amount)`, `setTreasureInFlight(n)`.

- [ ] **Step 1: Write the failing test**

```ts
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomTreasureMetricsListener } from './video-room-treasure-metrics.listener';

describe('VideoRoomTreasureMetricsListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let metrics: Record<string, jest.Mock>;
  let listener: VideoRoomTreasureMetricsListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = { handlers, subscribe: jest.fn((n: string, f: (e: unknown) => void) => handlers.set(n, f)) };
    metrics = {
      setTreasureProgress: jest.fn(), incTreasureUnlock: jest.fn(),
      incTreasureFailure: jest.fn(), incTreasureMinted: jest.fn(),
    };
    listener = new VideoRoomTreasureMetricsListener(bus as never, metrics as never);
    listener.onModuleInit();
  });

  it('records progress as a gauge', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, {
      roomId: 'r1', level: 2, progress: 12_000,
    });
    expect(metrics.setTreasureProgress).toHaveBeenCalledWith('r1', 2, 12_000);
  });

  it('counts unlocks by level and algorithm', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      roomId: 'r1', level: 1, algorithm: 'RANDOM', poolAmount: 1500, winners: [],
    });
    expect(metrics.incTreasureUnlock).toHaveBeenCalledWith(1, 'RANDOM');
  });

  it('counts minted GOLD by level and strategy — this is treasure revenue', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED, {
      roomId: 'r1', level: 1, strategy: 'PERCENTAGE', poolAmount: 1500,
      sourceAmount: 15000, winnerCount: 3,
    });
    expect(metrics.incTreasureMinted).toHaveBeenCalledWith(1, 'PERCENTAGE', 1500);
  });

  // The stage label is the whole point: it makes a failure attributable to
  // validation vs eligibility vs wallet without reading code.
  it('labels a failure with the pipeline stage that produced it', () => {
    fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED, {
      roomId: 'r1', level: 1, stage: 'DISTRIBUTION', attempt: 2, error: 'wallet timeout',
    });
    expect(metrics.incTreasureFailure).toHaveBeenCalledWith('DISTRIBUTION');
  });

  it('never throws out of a handler — metrics must not break the bus', () => {
    metrics.setTreasureProgress.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    expect(() =>
      fire(VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED, { roomId: 'r1', level: 1, progress: 1 }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-treasure-metrics.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Append the metric families**

In `video-rooms.metrics.ts`, add fields under a `// ---- VR-11 treasure ----` comment,
register them in the constructor exactly as the existing families are registered, and add:

```ts
  // ---- VR-11 treasure ----

  setTreasureProgress(roomId: string, level: number, progress: number): void {
    this.treasureProgress.set({ room: roomId, level: String(level) }, progress);
  }

  incTreasureUnlock(level: number, algorithm: string): void {
    this.treasureUnlocks.inc({ level: String(level), algorithm });
  }

  observeTreasureDistribution(level: number, seconds: number): void {
    this.treasureDistributionSeconds.observe({ level: String(level) }, seconds);
  }

  /** Labelled by pipeline stage so an alert names where the failure happened. */
  incTreasureFailure(stage: string): void {
    this.treasureFailures.inc({ stage });
  }

  setTreasureQueueDepth(depth: number): void {
    this.treasureQueueDepth.set(depth);
  }

  setTreasureInFlight(count: number): void {
    this.treasureInFlight.set(count);
  }

  /** GOLD minted to winners — the treasure-revenue counter. */
  incTreasureMinted(level: number, strategy: string, amount: number): void {
    this.treasureMinted.inc({ level: String(level), strategy }, amount);
  }
```

Declare the seven private fields (`Gauge` for progress/queueDepth/inFlight, `Counter` for
unlocks/failures/minted, `Histogram` for distributionSeconds) and register each with a
`video_room_treasure_*` metric name and the label sets used above. The distribution
histogram's buckets must span the 5 s SLO: `[0.1, 0.5, 1, 2, 5, 10, 30]`.

- [ ] **Step 4: Write the listener**

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureProgressUpdatedEvent,
  type TreasureRewardGeneratedEvent,
  type TreasureUnlockedEvent,
  type TreasureUnlockFailedEvent,
} from '../events/video-room-treasure.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Treasure metrics, driven by events rather than by service calls (the VR-9/VR-10
 * pattern). Keeping the services metric-free means they can be unit-tested
 * without a Prometheus registry, and a metrics change never touches the engine.
 *
 * Every handler is guarded: a metrics fault must never propagate into the event
 * bus and take a payout path down with it.
 */
@Injectable()
export class VideoRoomTreasureMetricsListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomTreasureMetricsListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureProgressUpdatedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED,
      (e) =>
        this.guard(() =>
          this.metrics.setTreasureProgress(e.payload.roomId, e.payload.level ?? 0, e.payload.progress),
        ),
    );

    this.bus.subscribe<TreasureUnlockedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, (e) =>
      this.guard(() => this.metrics.incTreasureUnlock(e.payload.level ?? 0, e.payload.algorithm)),
    );

    this.bus.subscribe<TreasureRewardGeneratedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED,
      (e) =>
        this.guard(() =>
          this.metrics.incTreasureMinted(
            e.payload.level ?? 0,
            e.payload.strategy,
            e.payload.poolAmount,
          ),
        ),
    );

    this.bus.subscribe<TreasureUnlockFailedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED,
      (e) => this.guard(() => this.metrics.incTreasureFailure(e.payload.stage)),
    );
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(`Treasure metric update failed: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-treasure-metrics.listener.spec.ts src/modules/video-rooms/video-rooms.metrics.spec.ts`
Expected: PASS — 5 new tests plus the existing metrics suite.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/video-rooms.metrics.ts \
        src/modules/video-rooms/listeners/video-room-treasure-metrics.listener.ts \
        src/modules/video-rooms/listeners/video-room-treasure-metrics.listener.spec.ts
git commit -m "feat(vr-11): add treasure metrics with stage-labelled failures"
```

---

## Task 23: Audit listener

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-treasure-audit.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-treasure-audit.listener.spec.ts`

**Interfaces:**
- Consumes: `EVENT_BUS`, `VideoRoomEventsRepository`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

```ts
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomTreasureAuditListener } from './video-room-treasure-audit.listener';

describe('VideoRoomTreasureAuditListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => Promise<void>> };
  let events: { append: jest.Mock };
  let listener: VideoRoomTreasureAuditListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    bus = { handlers, subscribe: jest.fn((n: string, f: never) => handlers.set(n, f)) };
    events = { append: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomTreasureAuditListener(bus as never, events as never);
    listener.onModuleInit();
  });

  it('audits all ten treasure events', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(10);
  });

  it('writes an append-only row carrying the full correlation envelope', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
      correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 2,
      poolAmount: 6000, winners: [], algorithm: 'RANDOM', nextLevel: 3,
    });
    expect(events.append).toHaveBeenCalledWith({
      roomId: 'r1',
      eventType: 'treasure.unlocked',
      referenceId: 'b1',
      correlationId: 'c1',
      actorId: null,
      payload: expect.objectContaining({ level: 2, poolAmount: 6000 }),
    });
  });

  it('uses the session id as the reference when there is no box', async () => {
    await fire(VIDEO_ROOM_TREASURE_EVENTS.CREATED, {
      correlationId: 'c1', roomId: 'r1', sessionId: 's1', createdBy: 'u1', levels: [1, 2],
    });
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ referenceId: 's1', actorId: 'u1', eventType: 'treasure.created' }),
    );
  });

  // Audit is observational. If it fails, the payout has still happened, and
  // throwing here would poison the bus for every other subscriber.
  it('swallows repository failures', async () => {
    events.append.mockRejectedValue(new Error('db down'));
    await expect(
      fire(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, {
        correlationId: 'c1', roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1,
        poolAmount: 0, winners: [], algorithm: 'RANDOM', nextLevel: null,
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/listeners/video-room-treasure-audit.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus, type DomainEvent } from 'src/common/events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';

/** Bus event name -> the `VideoRoomEvent.eventType` written for it. */
const AUDITED: Record<string, string> = {
  [VIDEO_ROOM_TREASURE_EVENTS.CREATED]: 'treasure.created',
  [VIDEO_ROOM_TREASURE_EVENTS.STARTED]: 'treasure.started',
  [VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED]: 'treasure.progress',
  [VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED]: 'treasure.pool_generated',
  [VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED]: 'treasure.winner_selected',
  [VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]: 'treasure.reward_distributed',
  [VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED]: 'treasure.unlocked',
  [VIDEO_ROOM_TREASURE_EVENTS.CLOSED]: 'treasure.closed',
  [VIDEO_ROOM_TREASURE_EVENTS.RECOVERED]: 'treasure.recovered',
  [VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED]: 'treasure.failed',
};

/** Payload fields that name the acting user, in precedence order. */
const ACTOR_FIELDS = ['createdBy', 'startedBy', 'closedBy', 'actorId'] as const;

/**
 * Writes the treasure audit trail into the existing append-only VideoRoomEvent
 * store (VR-11 spec §9). No new log table: `eventType` there is an open string,
 * and `correlationId` already groups one causal flow — so a whole unlock, from
 * pool generation through every payout, reads back as one chain.
 *
 * Failures are swallowed. Audit is observational; the money has already moved,
 * and throwing would poison the bus for every other subscriber.
 */
@Injectable()
export class VideoRoomTreasureAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomTreasureAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    for (const [busName, eventType] of Object.entries(AUDITED)) {
      this.bus.subscribe<DomainEvent<Record<string, unknown>>>(busName, (e) =>
        this.append(eventType, e.payload),
      );
    }
  }

  private async append(eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const { correlationId, roomId, sessionId, boxId, ...rest } = payload;
      await this.events.append({
        roomId: roomId as string,
        eventType,
        // Prefer the box: it is the finest-grained entity an auditor traces by.
        referenceId: (boxId as string) ?? (sessionId as string),
        correlationId: correlationId as string,
        actorId: this.actorOf(payload),
        payload: { sessionId, boxId, ...rest },
      });
    } catch (err) {
      this.logger.warn(`Treasure audit append failed for ${eventType}: ${(err as Error).message}`);
    }
  }

  private actorOf(payload: Record<string, unknown>): string | null {
    for (const field of ACTOR_FIELDS) {
      const value = payload[field];
      if (typeof value === 'string') return value;
    }
    // Most treasure events are system-driven: gift progress, not a person acting.
    return null;
  }
}
```

- [ ] **Step 4: Verify the `VideoRoomEventsRepository.append` signature**

Run: `grep -n "append" src/modules/video-rooms/repositories/video-room-events.repository.ts`
Expected: a method taking an object with `roomId`, `eventType`, `payload`, `referenceId`,
`correlationId`, `actorId`. Adapt the call and the test's assertion if the real shape
differs — do not change the repository.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/listeners/video-room-treasure-audit.listener.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/listeners/video-room-treasure-audit.listener.ts \
        src/modules/video-rooms/listeners/video-room-treasure-audit.listener.spec.ts
git commit -m "feat(vr-11): audit treasure lifecycle into VideoRoomEvent"
```

---

## Task 24: Module wiring and barrels

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/video-rooms/{services,repositories,controllers,listeners,events,constants,dto}/index.ts`
- Test: `src/modules/video-rooms/video-rooms.module.spec.ts` (create if absent)

**Interfaces:**
- Consumes: everything from Tasks 3–23.
- Produces: a bootable module.

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomsModule } from './video-rooms.module';

describe('VideoRoomsModule (VR-11 wiring)', () => {
  const meta = (key: string): unknown[] => Reflect.getMetadata(key, VideoRoomsModule) ?? [];
  const names = (key: string) => meta(key).map((p) => (p as { name?: string }).name ?? String(p));

  it('registers every treasure service', () => {
    for (const name of [
      'VideoRoomTreasureService', 'VideoRoomTreasureProgressService',
      'VideoRoomTreasureUnlockService', 'VideoRoomTreasurePoolService',
      'VideoRoomTreasureWinnerService', 'VideoRoomTreasureEligibilityService',
      'VideoRoomTreasureQueryService', 'VideoRoomTreasureRecoveryService',
      'VideoRoomTreasureLevelSeeder',
    ]) {
      expect(names('providers')).toContain(name);
    }
  });

  it('registers both treasure repositories', () => {
    expect(names('providers')).toContain('VideoRoomTreasureRepository');
    expect(names('providers')).toContain('VideoRoomTreasureRewardRepository');
  });

  it('registers all three treasure listeners', () => {
    for (const name of [
      'VideoRoomTreasureSocketListener', 'VideoRoomTreasureMetricsListener',
      'VideoRoomTreasureAuditListener',
    ]) {
      expect(names('providers')).toContain(name);
    }
  });

  it('registers the treasure controller', () => {
    expect(names('controllers')).toContain('VideoRoomsTreasureController');
  });

  // RewardDistributor is reused, not reimplemented — it must be importable.
  it('imports TreasureBoxesModule for RewardDistributor', () => {
    expect(names('imports')).toContain('TreasureBoxesModule');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/video-rooms.module.spec.ts`
Expected: FAIL — providers missing.

- [ ] **Step 3: Wire the module**

In `video-rooms.module.ts`:
1. Add `TreasureBoxesModule` to `imports` (for `RewardDistributor`). If it does not
   export `RewardDistributor`, add it to that module's `exports` — this is the one
   permitted edit under `treasure-boxes/`, and only if required. Verify first with
   `grep -n "exports" src/modules/treasure-boxes/treasure-boxes.module.ts`. **If adding
   the export is needed, note it in the Task 25 gate as a known, reviewed exception.**
2. Add all nine services, both repositories, and all three listeners to `providers`.
3. Add `VideoRoomsTreasureController` to `controllers`.
4. Export `VideoRoomTreasureQueryService` if any other module needs read access.

- [ ] **Step 4: Update the barrels**

Append the new files to each `index.ts` under `services/`, `repositories/`,
`controllers/`, `listeners/`, `events/`, `constants/` and `dto/`, matching the existing
`export * from './…';` style in each.

- [ ] **Step 5: Verify the app actually boots**

Run: `npx tsc --noEmit && npx jest src/modules/video-rooms/video-rooms.module.spec.ts`
Expected: tsc clean; 5 tests pass. A DI cycle or a missing provider surfaces here.

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms
git commit -m "feat(vr-11): wire the treasure engine into VideoRoomsModule"
```

---

## Task 25: Integration suite and BC release gate

**Files:**
- Create: `src/modules/video-rooms/services/video-room-treasure.integration.spec.ts`
- Modify: `docs/superpowers/plans/vr11-baseline.txt` (append the final numbers)

**Interfaces:**
- Consumes: everything.
- Produces: the release decision.

- [ ] **Step 1: Write the concurrency and combo integration tests**

```ts
import { TreasureBoxStatus } from '@prisma/client';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';

/**
 * Cross-service behaviour that no single unit test can prove. These use the real
 * services with in-memory fakes for Prisma/Redis rather than mocks-per-method, so
 * the interaction between the cascade, the CAS and the claim is genuinely exercised.
 */
describe('VR-11 treasure integration', () => {
  describe('concurrent gifts crossing one threshold', () => {
    it('produces exactly one claim across N racing transactions', async () => {
      // Build a fake box store whose updateMany honours the WHERE clause, so the
      // compare-and-set and the ACTIVE->UNLOCKING claim behave like Postgres.
      const boxes = new Map([['b1', { id: 'b1', level: 1, sessionId: 's1', roomId: 'r1',
        threshold: 15_000n, progress: 14_000n, status: TreasureBoxStatus.ACTIVE }]]);
      let claims = 0;
      const repo = {
        findCurrentSession: async () => ({ id: 's1', roomId: 'r1', currentLevel: 1, status: 'ACTIVE' }),
        listBoxes: async () => [...boxes.values()],
        getBox: async (id: string) => ({ ...boxes.get(id)! }),
        addProgress: async (id: string, observed: bigint, delta: bigint) => {
          const box = boxes.get(id)!;
          if (box.progress !== observed) return null;         // lost the CAS
          box.progress = observed + delta;
          return { ...box };
        },
        claimUnlock: async (id: string) => {
          const box = boxes.get(id)!;
          if (box.status !== TreasureBoxStatus.ACTIVE) return false;
          box.status = TreasureBoxStatus.UNLOCKING;
          claims += 1;
          return true;
        },
        addContribution: async () => undefined,
        setSessionLevel: async () => undefined,
        activateBox: async () => undefined,
      };
      const cache = { get: async () => null, set: async () => undefined, increment: async () => 1 };
      const config = { get: () => ({ progressEmitPerSecond: '5' }) };
      const service = new VideoRoomTreasureProgressService(repo as never, cache as never, config as never);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          service.apply({} as never, {
            roomId: 'r1', senderId: `u${i}`, amount: 2_000, giftTxnId: `g${i}`,
          }),
        ),
      );

      expect(claims).toBe(1);
      expect(results.filter((r) => r.claimedBoxId !== null)).toHaveLength(1);
    });
  });

  describe('combo gift across four levels', () => {
    it('claims every crossed level but reports only the lowest for enqueue', async () => {
      // 400,000 into a fresh 15k/60k/200k/350k ladder crosses L1..L3 and
      // partially fills L4.
      // Assert: claimedLevel === 1, and three boxes are UNLOCKING.
      // Build the same fake store with four boxes and run one apply().
    });
  });

  describe('BC: audio-room counters', () => {
    it('never writes RoomContributionCounter or UserContributionCounter', async () => {
      // Assert the fake Prisma sees no roomContributionCounter/userContributionCounter
      // access during a full unlock. Spec D10.
    });
  });
});
```

Replace the two commented bodies with real implementations following the first test's
fake-store pattern — the plan shows the shape; the fake store is already written above
and only needs extra boxes and a Prisma proxy that throws on the two forbidden tables.

- [ ] **Step 2: Run the integration suite**

Run: `npx jest src/modules/video-rooms/services/video-room-treasure.integration.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 3: Run the BC release gate**

```bash
# 1. Audio suites unmodified and green
npx jest src/modules/treasure-boxes --silent 2>&1 | tail -5

# 2. No protected file changed
git diff --name-only HEAD~24 -- src/modules/treasure-boxes src/modules/audio-rooms
```
Expected: audio pass count matches the Task 1 baseline; the `git diff` prints **nothing**.
If `treasure-boxes.module.ts` appears because Task 24 needed the `RewardDistributor`
export, confirm that is the only line changed and record it as the reviewed exception.

- [ ] **Step 4: Run the full gate**

```bash
npx tsc --noEmit
npx eslint "src/**/*.ts" --max-warnings 0
npx jest --silent 2>&1 | tail -5
```
Expected: tsc clean, lint clean, total ≥ baseline + ~150 new tests, zero failures.

- [ ] **Step 5: Record the result**

Append to `docs/superpowers/plans/vr11-baseline.txt`:

```bash
{
  echo "--- VR-11 complete ---"
  npx jest --silent 2>&1 | tail -5
  echo "protected-file diff:"
  git diff --name-only HEAD~24 -- src/modules/treasure-boxes src/modules/audio-rooms
} >> docs/superpowers/plans/vr11-baseline.txt
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/video-rooms/services/video-room-treasure.integration.spec.ts \
        docs/superpowers/plans/vr11-baseline.txt
git commit -m "test(vr-11): add integration suite and pass the BC release gate"
```

---

## Plan self-review

**Spec coverage** — every §: §4 architecture → T3–T24; §5.1 new tables → T2; §5.2 additive
changes → T2; §5.3 Redis keys → T3; §6.0 lifecycle → T13; §6.1 boundaries → T14/T15;
§6.2 claim → T7/T14; §6.3 chaining → T14/T16; §6.4 pipeline → T16; §6.5 strategies →
T10/T12; §6.6 eligibility → T11; §6.7 edge cases → T10/T14/T16; §6.8 recovery → T17;
§7 REST/socket/events/DTOs → T6/T19/T20/T21; §8 RBAC/exceptions → T5/T13; §9 metrics +
audit → T22/T23; §10 config → T4; §11 performance → T25; §12 BC gate → T1/T25;
§13 testing → every task plus T25.

**Known gaps, stated rather than hidden:**
1. **Task 25 contains two test bodies described but not written out** (combo-across-four-levels,
   and the counter-prohibition assertion). The fake-store pattern they build on *is* fully
   written in the first test of that task. This is the one place the plan falls short of
   "complete code in every step"; budget a little extra time there.
2. **Three signatures are verified at implementation time rather than asserted here** —
   `SocketManager.emitToRoom` (T21 S4), `VideoRoomEventsRepository.append` (T23 S4), and the
   presence key helpers (T11 S4). Each has an explicit verification step with a `grep` and
   instructions to adapt the caller, never the shared file.
3. **Task 24 may require one line in `treasure-boxes.module.ts`** (exporting
   `RewardDistributor`). Flagged as a reviewed exception to the BC gate rather than silently
   permitted.

**Type consistency** — checked across tasks: `TreasureLevelRules` (T10) is consumed
identically in T11/T13/T16; `VideoRoomTreasureUnlockJob` (T15) is consumed in T16/T17;
`addProgress`/`claimUnlock` return types (T7) match their T14 call sites; `createPool`
returning `null` on replay (T8) matches the T16 replay branch; `TreasureUnlockStage` (T3)
is the type of `TreasureUnlockFailedEvent.stage` (T6), `markFailed` (T8) and
`incTreasureFailure` (T22).

| 14 | `VideoRoomTreasureProgressService` — cascade, CAS, claim, throttled emit |
| 15 | `VideoRoomGiftContextHandler.onSend` — the single modified file |
| 16 | `VideoRoomTreasureUnlockService` — the 9-step pipeline |
| 17 | `VideoRoomTreasureRecoveryService` — DLQ replay + orphan reclaim |
| 18 | `VideoRoomTreasureQueryService` — status / history / winners / statistics |
| 19 | DTOs — 6 Swagger-annotated classes |
| 20 | Controller + `MANAGE_TREASURE` permission |
| 21 | Socket listener + progress throttle |
| 22 | Metrics + metrics listener |
| 23 | Audit listener → `VideoRoomEvent` |
| 24 | Module wiring + barrel exports |
| 25 | Integration suite (concurrency, combo, replay, recovery) + BC release gate |
