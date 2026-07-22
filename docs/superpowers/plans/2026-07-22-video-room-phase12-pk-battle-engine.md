# VR-12 — Video Room PK Battle Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-grade PK Battle engine for Video Rooms — 1v1 and Team battles with a persisted invitation workflow, an 11-state validated machine, gift-driven atomic scoring, countdown/pause/resume, automatic recovery, winner calculation, wallet-backed rewards, history, Redis sync, sockets, events, audit and monitoring.

**Architecture:** Video-owned `video_room_pk_*` tables (the audio `PkExpiryMonitor` sweeps `pk_battles` unfiltered and would settle video battles under audio rules — spec §2.1). Sides are rows in `VideoRoomPkTeam`, not columns, so multi-host is additive. Scoring runs **inside the gift transaction** through the existing `IGiftContextHandler.onSend` seam, making rollback and dedup structural. One battle aggregate carries all 11 states; invitations are child rows. Countdown/end are BullMQ delayed jobs with a recovery sweep backstop. Reward pools are minted from **base** (pre-multiplier) contribution.

**Tech Stack:** NestJS 11 · Prisma 6 / PostgreSQL 16 · Redis (ioredis) · BullMQ · Socket.IO · Jest · prom-client

---

## Global Constraints

Every task's requirements implicitly include this section.

- **NO GIT OPERATIONS.** Do not run `git add`, `git commit`, `git stash`, `git reset`, `git checkout`, or any other git command. All work stays uncommitted in the working directory on top of baseline `9d31ece`. This overrides any instruction in any skill.
- **Migration authored, NOT applied.** Create the migration SQL file. Do **not** run `prisma migrate dev`, `migrate deploy`, or `db push`. Run `npx prisma generate` only, to refresh the client types.
- **Zero audio regression.** Do not modify any file under `src/modules/audio-rooms/` or `prisma/schema/audio_rooms_*.prisma`.
- **Zero shared-infrastructure mutation.** No changes under `src/common/`, `src/infra/`, `src/modules/gifts/`, `src/modules/wallet/` — except exactly: (a) 11 new `ERROR_CODES` keys, (b) `WalletTxnReason += PK_REWARD`, (c) `VideoRoomLogAction += 9 PK_* values`, (d) one added call inside `VideoRoomGiftContextHandler.onSend`.
- **No Prisma in services.** All database access goes through a repository.
- **Test command:** `npx jest <path> -t "<name>"`. Full suite: `npx jest`.
- **Type check:** `npx tsc --noEmit`. **Lint:** `npm run lint`.
- **Multiplier base is 10 000 bps.** Multipliers compose additively and are capped.
- **All monetary/score columns are `BigInt`** in Prisma, converted to `Number` only at the read-model boundary.
- **Redis lock keys are hash-tagged** `{roomId}` for Cluster slot affinity. Plain data keys are not.
- Every task ends with a **verification step**, not a commit.

---

## File Structure

**New Prisma schema**
- `prisma/schema/video_rooms_pk.prisma` — 5 enums, 7 models
- `prisma/migrations/20260722120000_vr12_pk_battle_engine/migration.sql` — authored, unapplied

**New files under `src/modules/video-rooms/`**

| Path | Responsibility |
|---|---|
| `constants/video-room-pk.constants.ts` | socket vocabulary, job names, Redis keys, FSM table |
| `config/video-room-pk.config.ts` | typed config view + coercion |
| `exceptions/video-room-pk.exceptions.ts` | 8 exception classes |
| `events/video-room-pk.events.ts` | 12 domain events |
| `dto/video-room-pk.dto.ts` | 10 DTOs |
| `repositories/video-room-pk.repository.ts` | battles, teams, participants, contributions |
| `repositories/video-room-pk-invitation.repository.ts` | invitations |
| `repositories/video-room-pk-reward.repository.ts` | pool + rewards |
| `services/video-room-pk-state.service.ts` | FSM assertion + conditional transition |
| `services/video-room-pk-score.engine.ts` | strategy registry + resolve |
| `services/strategies/vip-multiplier.strategy.ts` | VIP bonus bps |
| `services/strategies/event-multiplier.strategy.ts` | event-window bonus bps |
| `services/video-room-pk-scoring.service.ts` | in-transaction `apply` |
| `services/video-room-pk-validation.service.ts` | the 9 gates |
| `services/video-room-pk-invitation.service.ts` | invitation workflow |
| `services/video-room-pk-timer.service.ts` | job scheduling + pause/resume math |
| `services/video-room-pk.service.ts` | lifecycle facade (create/start/pause/resume/end/cancel) |
| `services/video-room-pk-settlement.service.ts` | winner + pool + distribution |
| `services/video-room-pk-recovery.service.ts` | sweep, 5 conditions |
| `services/video-room-pk-query.service.ts` | get / history / statistics |
| `controllers/video-rooms-pk.controller.ts` | 11 REST endpoints |
| `services/video-room-pk-jobs.service.ts` | BullMQ job registration + handlers |
| `listeners/video-room-pk-socket.listener.ts` | event → socket relay |
| `listeners/video-room-pk-audit.listener.ts` | event → `video_room_logs` |
| `listeners/video-room-pk-metrics.listener.ts` | event → metrics |
| `listeners/video-room-pk-reversal.listener.ts` | gift refund → compensating score reversal |

**Modified files (all additive)**
- `src/common/exceptions/error-codes.ts` — 11 keys
- `prisma/schema/wallet.prisma` — `WalletTxnReason += PK_REWARD`
- `prisma/schema/video_rooms.prisma` — `VideoRoomLogAction += 9 values`
- `src/config/env.validation.ts` + `src/config/configuration.ts` — the `videoRoomPk` namespace
- `src/modules/video-rooms/services/video-room-gift-context.handler.ts` — one added call
- `src/modules/video-rooms/video-rooms.metrics.ts` — 9 metric families
- `src/modules/video-rooms/video-rooms.module.ts` — provider registration
- barrels: `constants/index.ts`, `controllers/index.ts`, `dto/index.ts`, `events/index.ts`, `listeners/index.ts`, `repositories/index.ts`, `services/index.ts`

---

## Task 1: Baseline release gate

**Files:**
- Create: `docs/superpowers/plans/vr12-baseline.txt`

**Interfaces:**
- Consumes: nothing
- Produces: `vr12-baseline.txt` containing the pre-change test count, tsc status and lint status. Task 24 diffs against it.

- [ ] **Step 1: Capture the baseline test count**

Run:
```bash
npx jest 2>&1 | tail -20 | tee docs/superpowers/plans/vr12-baseline.txt
```

Expected: a summary like `Tests: 3 failed, 2145 passed, 2148 total`. The 3 pre-existing `TreasureService` failures are known and quarantined — record them, do not fix them.

- [ ] **Step 2: Capture tsc and lint status**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -5 >> docs/superpowers/plans/vr12-baseline.txt
npm run lint 2>&1 | tail -5 >> docs/superpowers/plans/vr12-baseline.txt
```

Expected: both clean (no output lines beyond the command echo).

- [ ] **Step 3: Verify the baseline file is readable**

Run: `cat docs/superpowers/plans/vr12-baseline.txt`
Expected: test totals, tsc status, and the **per-file** lint problem list.

> **AMENDED 2026-07-22 (Task 1 execution).** An earlier revision said to STOP if
> lint was dirty. It is: the repo carries **123 pre-existing lint problems across
> 21 files** — `audio-rooms`, `wallet`, `gifts`, `auth`, `casino`, `games`,
> `backpack`, `otp`, `treasure-boxes`, `infra/socket`, and one VR-9 video-room
> spec. Fixing them would require editing exactly the directories this phase's
> Global Constraints forbid touching, so "clean lint first" and "zero audio-room
> / zero shared-infrastructure mutation" cannot both hold.
>
> **The lint gate is therefore RELATIVE, not absolute:** VR-12 must introduce
> **zero lint problems in the files it creates or modifies**, and must not change
> the count in any file it does not touch. Task 24 enforces this per-file rather
> than repo-wide. tsc, by contrast, IS clean and must stay absolutely clean.

---

## Task 2: Prisma schema and migration

**Files:**
- Create: `prisma/schema/video_rooms_pk.prisma`
- Create: `prisma/migrations/20260722120000_vr12_pk_battle_engine/migration.sql`
- Modify: `prisma/schema/wallet.prisma` (add `PK_REWARD` to `WalletTxnReason`)
- Modify: `prisma/schema/video_rooms.prisma` (add 9 values to `VideoRoomLogAction`)

**Interfaces:**
- Consumes: nothing
- Produces: Prisma client types `VideoRoomPkBattle`, `VideoRoomPkTeam`, `VideoRoomPkParticipant`, `VideoRoomPkInvitation`, `VideoRoomPkContribution`, `VideoRoomPkRewardPool`, `VideoRoomPkReward` and enums `VideoRoomPkStatus`, `VideoRoomPkMode`, `VideoRoomPkSide`, `VideoRoomPkInvitationStatus`, `VideoRoomPkRewardKind`. Every later task imports these from `@prisma/client`.

- [ ] **Step 1: Write the schema file**

Create `prisma/schema/video_rooms_pk.prisma`:

```prisma
// ============================================================
// VR-12 PK Battle Engine (Video Rooms). Video-OWNED tables.
//
// Deliberately NOT sharing the audio `pk_battles` family. The audio
// PkBattleRepository.findExpired() selects `{ status: ACTIVE, endsAt <= now }`
// with NO room-type discriminator, and PkExpiryMonitor sweeps it fleet-wide.
// A video battle in that table would be completed by the AUDIO engine, granting
// an audio badge, writing the shared PK_WINS leaderboard and broadcasting a
// PkEndedEvent on the /audio-room namespace. Audio's PkStatus also has only
// ACTIVE/COMPLETED/CANCELLED, so every VR-12 state would be unrepresentable.
// Same hazard class as the TreasureBoxConfig note in video_rooms_treasure.prisma.
// ============================================================

enum VideoRoomPkStatus {
  CREATED
  INVITED
  PENDING
  ACCEPTED
  COUNTDOWN
  LIVE
  PAUSED
  RECOVERING
  COMPLETED
  CANCELLED
  FAILED
}

/// ONE_VS_ONE and TEAM today. MULTI_HOST / CROSS_ROOM are additive later.
enum VideoRoomPkMode {
  ONE_VS_ONE
  TEAM
}

/// Two sides today. GREEN/YELLOW are additive for multi-host PK — the schema
/// needs no change because sides are ROWS in VideoRoomPkTeam, not columns.
enum VideoRoomPkSide {
  RED
  BLUE
}

enum VideoRoomPkInvitationStatus {
  SENT
  DELIVERED
  ACCEPTED
  REJECTED
  CANCELLED
  EXPIRED
}

enum VideoRoomPkRewardKind {
  WINNER
  PARTICIPATION
  BONUS
}

/// The aggregate root. Carries the full 11-state machine from invitation to a
/// terminal state, so an audit row written at invite time can already carry the
/// battle id.
///
/// NO totalContributed / giftCount counters here: a per-battle counter would
/// make every gift take a row lock on this single row, serialising RED and BLUE
/// against each other. Live counters live in Redis; authoritative totals are
/// derived from the contribution ledger at settlement.
///
/// `endsAt` is MUTABLE — resume recomputes it. `resumeSeq` disambiguates the
/// scheduled end job so a stale pre-pause job settles against a sequence that no
/// longer matches and becomes a no-op.
model VideoRoomPkBattle {
  id        String            @id @default(uuid()) @db.Uuid
  roomId    String            @db.Uuid
  mode      VideoRoomPkMode
  status    VideoRoomPkStatus @default(CREATED)
  createdBy String            @db.Uuid

  countdownSeconds Int
  durationSeconds  Int
  startedAt        DateTime?
  endsAt           DateTime?
  pausedAt         DateTime?
  totalPausedMs    Int       @default(0)
  resumeSeq        Int       @default(0)

  /// Frozen at create: which score strategies apply and at what rates.
  scoringSnapshot Json
  /// Frozen at create: poolBps / winnerBps / participationBps / bonusBps.
  rewardSnapshot  Json

  winningTeamId String?   @db.Uuid
  isDraw        Boolean   @default(false)
  completedAt   DateTime?
  cancelledAt   DateTime?
  failureReason String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([roomId, status])
  @@index([status, endsAt])
  @@map("video_room_pk_battles")
}

/// A side. `@@unique([battleId, side])` is what keeps "exactly one RED, one
/// BLUE" true at the database while the service enforces "exactly 2 teams".
model VideoRoomPkTeam {
  id        String          @id @default(uuid()) @db.Uuid
  battleId  String          @db.Uuid
  roomId    String          @db.Uuid
  side      VideoRoomPkSide
  score     BigInt          @default(0)
  giftCount Int             @default(0)
  createdAt DateTime        @default(now())

  @@unique([battleId, side])
  @@index([battleId])
  @@map("video_room_pk_teams")
}

model VideoRoomPkParticipant {
  id        String          @id @default(uuid()) @db.Uuid
  battleId  String          @db.Uuid
  teamId    String          @db.Uuid
  roomId    String          @db.Uuid
  userId    String          @db.Uuid
  side      VideoRoomPkSide
  score     BigInt          @default(0)
  giftCount Int             @default(0)
  joinedAt  DateTime        @default(now())

  @@unique([battleId, userId])
  @@index([battleId])
  @@map("video_room_pk_participants")
}

/// Per-invitee delivery record. `targetRoomId` equals `roomId` today; it is the
/// cross-room extension point. `attempt` is what makes Retry replay-safe.
model VideoRoomPkInvitation {
  id            String                      @id @default(uuid()) @db.Uuid
  battleId      String                      @db.Uuid
  roomId        String                      @db.Uuid
  targetRoomId  String                      @db.Uuid
  inviteeUserId String                      @db.Uuid
  inviterUserId String                      @db.Uuid
  side          VideoRoomPkSide
  status        VideoRoomPkInvitationStatus @default(SENT)
  attempt       Int                         @default(1)
  expiresAt     DateTime
  deliveredAt   DateTime?
  respondedAt   DateTime?
  createdAt     DateTime                    @default(now())

  @@unique([battleId, inviteeUserId, attempt])
  @@index([battleId])
  @@index([inviteeUserId, status])
  @@index([status, expiresAt])
  @@map("video_room_pk_invitations")
}

/// Append-only scoring ledger.
///
/// `baseAmount` = coins the sender actually spent for this leg.
/// `scoredAmount` = baseAmount * multiplierBps / 10000, what the board shows.
/// The reward pool is sized on baseAmount ONLY — a multiplier must never mint
/// money nobody spent.
///
/// Stores BOTH senderId and receiverId. Audio's equivalent writes
/// `contributorId: receiverId` (pk-battle.service.ts:256), making the sender
/// unrecoverable and "top contributor" unanswerable.
///
/// A compensating reversal (§6.5) writes a row with NEGATIVE amounts and a
/// giftTxnId suffixed ":reversal", which is why the unique key still holds.
model VideoRoomPkContribution {
  id            String          @id @default(uuid()) @db.Uuid
  battleId      String          @db.Uuid
  roomId        String          @db.Uuid
  teamId        String          @db.Uuid
  participantId String          @db.Uuid
  side          VideoRoomPkSide
  senderId      String          @db.Uuid
  receiverId    String          @db.Uuid
  baseAmount    BigInt
  multiplierBps Int             @default(10000)
  scoredAmount  BigInt
  giftTxnId     String
  batchId       String?
  createdAt     DateTime        @default(now())

  @@unique([battleId, giftTxnId, participantId])
  @@index([battleId])
  @@index([participantId])
  @@map("video_room_pk_contributions")
}

/// `battleId @unique` is the mint-once guard: a replayed settlement hits the
/// constraint and loads the existing row rather than minting a second pool.
/// Dust is derivable as poolAmount - allocatedAmount and is deliberately not
/// minted (the VR-11 rule).
model VideoRoomPkRewardPool {
  id               String   @id @default(uuid()) @db.Uuid
  battleId         String   @unique @db.Uuid
  roomId           String   @db.Uuid
  strategy         String   @default("PERCENTAGE")
  sourceAmount     BigInt
  poolAmount       BigInt
  winnerBps        Int
  participationBps Int
  bonusBps         Int
  allocatedAmount  BigInt   @default(0)
  computedAt       DateTime @default(now())

  @@index([roomId])
  @@map("video_room_pk_reward_pools")
}

/// One row per (battle, user, kind). The unique key fails a replayed payout
/// closed at the database, independently of the wallet's own idempotency key.
model VideoRoomPkReward {
  id             String                @id @default(uuid()) @db.Uuid
  battleId       String                @db.Uuid
  roomId         String                @db.Uuid
  userId         String                @db.Uuid
  teamId         String?               @db.Uuid
  side           VideoRoomPkSide?
  kind           VideoRoomPkRewardKind
  amount         BigInt
  currency       WalletCurrency
  walletTxnId    String?
  idempotencyKey String                @unique
  createdAt      DateTime              @default(now())

  @@unique([battleId, userId, kind])
  @@index([battleId])
  @@index([userId])
  @@map("video_room_pk_rewards")
}
```

- [ ] **Step 2: Add the additive enum values**

In `prisma/schema/wallet.prisma`, inside `enum WalletTxnReason`, add after `CASINO_REFUND`:

```prisma
  PK_REWARD
```

In `prisma/schema/video_rooms.prisma`, inside `enum VideoRoomLogAction`, add after `ANNOUNCEMENT_DELETED`:

```prisma
  PK_INVITED
  PK_INVITATION_ACCEPTED
  PK_INVITATION_REJECTED
  PK_STARTED
  PK_PAUSED
  PK_RESUMED
  PK_ENDED
  PK_RECOVERED
  PK_REWARD_DISTRIBUTED
```

- [ ] **Step 3: Write the migration SQL**

Create `prisma/migrations/20260722120000_vr12_pk_battle_engine/migration.sql`. Include the `CREATE TYPE` statements for the 5 new enums, `ALTER TYPE ... ADD VALUE` for the 10 additive values, the 7 `CREATE TABLE` statements with their indexes, and finally the partial unique index Prisma cannot express:

```sql
-- Additive enum values. ALTER TYPE ... ADD VALUE is safe on PostgreSQL 12+;
-- the deployed server is 16.14.
ALTER TYPE "WalletTxnReason" ADD VALUE IF NOT EXISTS 'PK_REWARD';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_INVITED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_INVITATION_ACCEPTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_INVITATION_REJECTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_STARTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_PAUSED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_RESUMED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_ENDED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_RECOVERED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_REWARD_DISTRIBUTED';

-- ... CREATE TYPE / CREATE TABLE / CREATE INDEX for the 7 tables ...

-- THE duplicate-PK gate. Prisma cannot express a partial unique index, so it is
-- authored here by hand. This is the enforcement; the service pre-check exists
-- only to return a clean DuplicatePKException instead of a raw 23505.
CREATE UNIQUE INDEX "video_room_pk_battles_one_active_per_room"
  ON "video_room_pk_battles" ("roomId")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');
```

Generate the table DDL by running `npx prisma migrate diff --from-schema-datamodel prisma/schema --to-schema-datamodel prisma/schema --script` is NOT reliable here; instead write the `CREATE TABLE` statements to match the models above exactly, using `uuid` for `@db.Uuid`, `BIGINT` for `BigInt`, `JSONB` for `Json`, and `TIMESTAMP(3)` for `DateTime`.

- [ ] **Step 4: Regenerate the Prisma client — do NOT apply the migration**

Run:
```bash
npx prisma generate
```
Expected: `✔ Generated Prisma Client`. **Do not run `prisma migrate dev` or `migrate deploy`.**

- [ ] **Step 5: Verify the new types exist**

Run:
```bash
npx tsc --noEmit
node -e "const {VideoRoomPkStatus}=require('@prisma/client');console.log(Object.keys(VideoRoomPkStatus).length)"
```
Expected: tsc clean; the node command prints `11`.

---

## Task 3: Constants and the FSM transition table

**Files:**
- Create: `src/modules/video-rooms/constants/video-room-pk.constants.ts`
- Create: `src/modules/video-rooms/constants/video-room-pk.constants.spec.ts`
- Modify: `src/modules/video-rooms/constants/index.ts` (add the export line)

**Interfaces:**
- Consumes: `VideoRoomPkStatus` from Task 2
- Produces:
  - `VIDEO_ROOM_PK_SOCKET_EVENTS` — 11 outbound socket event names
  - `VIDEO_ROOM_PK_START_JOB: 'video-room.pk.start'`, `VIDEO_ROOM_PK_END_JOB: 'video-room.pk.end'`
  - `pkLifecycleLockKey(roomId): string`, `PK_RECOVERY_LOCK_KEY: string`
  - `pkScoreKey(battleId): string`, `pkStateKey(roomId): string`, `pkEmitKey(battleId): string`
  - `PK_MULTIPLIER_BASE_BPS = 10_000`
  - `VIDEO_ROOM_PK_TRANSITIONS: Record<VideoRoomPkStatus, ReadonlySet<VideoRoomPkStatus>>`
  - `PK_TERMINAL_STATUSES: readonly VideoRoomPkStatus[]`
  - `isPkTerminal(status): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/constants/video-room-pk.constants.spec.ts`:

```ts
import { VideoRoomPkStatus } from '@prisma/client';
import {
  PK_TERMINAL_STATUSES,
  VIDEO_ROOM_PK_TRANSITIONS,
  isPkTerminal,
  pkLifecycleLockKey,
  pkScoreKey,
} from './video-room-pk.constants';

describe('video-room PK constants', () => {
  it('declares a transition set for every status', () => {
    for (const status of Object.values(VideoRoomPkStatus)) {
      expect(VIDEO_ROOM_PK_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the happy path CREATED → … → COMPLETED', () => {
    const path: VideoRoomPkStatus[] = [
      VideoRoomPkStatus.CREATED,
      VideoRoomPkStatus.INVITED,
      VideoRoomPkStatus.PENDING,
      VideoRoomPkStatus.ACCEPTED,
      VideoRoomPkStatus.COUNTDOWN,
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.COMPLETED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(VIDEO_ROOM_PK_TRANSITIONS[path[i]].has(path[i + 1])).toBe(true);
    }
  });

  it('allows LIVE ⇄ PAUSED and LIVE ⇄ RECOVERING', () => {
    expect(VIDEO_ROOM_PK_TRANSITIONS.LIVE.has(VideoRoomPkStatus.PAUSED)).toBe(true);
    expect(VIDEO_ROOM_PK_TRANSITIONS.PAUSED.has(VideoRoomPkStatus.LIVE)).toBe(true);
    expect(VIDEO_ROOM_PK_TRANSITIONS.LIVE.has(VideoRoomPkStatus.RECOVERING)).toBe(true);
    expect(VIDEO_ROOM_PK_TRANSITIONS.RECOVERING.has(VideoRoomPkStatus.LIVE)).toBe(true);
  });

  // The single most important invariant: a finished battle can never move.
  it('makes every terminal status a dead end', () => {
    for (const status of PK_TERMINAL_STATUSES) {
      expect(VIDEO_ROOM_PK_TRANSITIONS[status].size).toBe(0);
      expect(isPkTerminal(status)).toBe(true);
    }
  });

  it('forbids skipping the countdown', () => {
    expect(VIDEO_ROOM_PK_TRANSITIONS.ACCEPTED.has(VideoRoomPkStatus.LIVE)).toBe(false);
  });

  it('forbids scoring states reached from nowhere', () => {
    expect(VIDEO_ROOM_PK_TRANSITIONS.CREATED.has(VideoRoomPkStatus.LIVE)).toBe(false);
    expect(VIDEO_ROOM_PK_TRANSITIONS.COMPLETED.has(VideoRoomPkStatus.LIVE)).toBe(false);
  });

  it('hash-tags per-room lock keys for Redis Cluster', () => {
    expect(pkLifecycleLockKey('room-1')).toBe('video-room:pk:lifecycle:{room-1}');
  });

  it('does not hash-tag plain data keys', () => {
    expect(pkScoreKey('battle-1')).toBe('video-room:pk:score:battle-1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/constants/video-room-pk.constants.spec.ts`
Expected: FAIL — `Cannot find module './video-room-pk.constants'`.

- [ ] **Step 3: Write the constants file**

Create `src/modules/video-rooms/constants/video-room-pk.constants.ts`:

```ts
import { VideoRoomPkStatus } from '@prisma/client';

/**
 * VR-12 PK engine constants: the `/video-room` socket vocabulary, the BullMQ job
 * names, every Redis key the engine owns, and the validated state machine.
 *
 * Per-room LOCK keys are hash-tagged `{roomId}` so Redis Cluster routes them to a
 * single slot (the VR-11 convention) — a Lua-based lock release must not become a
 * cross-slot operation. Plain data keys are NOT hash-tagged: they are read
 * individually, never in a multi-key command.
 */

/** Outbound socket events on the `/video-room` namespace. */
export const VIDEO_ROOM_PK_SOCKET_EVENTS = {
  INVITATION_SENT: 'pkInvitationSent',
  INVITATION_ACCEPTED: 'pkInvitationAccepted',
  INVITATION_REJECTED: 'pkInvitationRejected',
  STARTED: 'pkStarted',
  COUNTDOWN: 'pkCountdown',
  SCORE_UPDATED: 'pkScoreUpdated',
  PAUSED: 'pkPaused',
  RESUMED: 'pkResumed',
  ENDED: 'pkEnded',
  WINNER: 'pkWinner',
  RECOVERED: 'pkRecovered',
} as const;

/** BullMQ job names registered on QUEUE_NAMES.GIFT_PROCESSING. */
export const VIDEO_ROOM_PK_START_JOB = 'video-room.pk.start';
export const VIDEO_ROOM_PK_END_JOB = 'video-room.pk.end';

/** Serialises lifecycle commands per room. */
export function pkLifecycleLockKey(roomId: string): string {
  return `video-room:pk:lifecycle:{${roomId}}`;
}

/** Fleet-wide sweep lock: many pods, one sweeper. */
export const PK_RECOVERY_LOCK_KEY = 'video-room:pk:recovery';

/** Live scoreboard mirror: HASH { RED, BLUE, giftCount, baseTotal }. */
export function pkScoreKey(battleId: string): string {
  return `video-room:pk:score:${battleId}`;
}

/** Late-join sync snapshot: { status, endsAt }. */
export function pkStateKey(roomId: string): string {
  return `video-room:pk:state:${roomId}`;
}

/** Throttle stamp for `pkScoreUpdated` coalescing. */
export function pkEmitKey(battleId: string): string {
  return `video-room:pk:emit:${battleId}`;
}

/** Multiplier base. 10 000 bps = 1.0×. Bonuses ADD to this, they do not multiply. */
export const PK_MULTIPLIER_BASE_BPS = 10_000;

export const PK_TERMINAL_STATUSES: readonly VideoRoomPkStatus[] = [
  VideoRoomPkStatus.COMPLETED,
  VideoRoomPkStatus.CANCELLED,
  VideoRoomPkStatus.FAILED,
];

export function isPkTerminal(status: VideoRoomPkStatus): boolean {
  return PK_TERMINAL_STATUSES.includes(status);
}

const S = VideoRoomPkStatus;

/**
 * The validated state machine — the single source of truth for what may follow
 * what. Every persisted transition ALSO runs as a conditional UPDATE
 * (`WHERE status = $from`), so this table and the database agree; the table
 * gives a clean domain error, the UPDATE wins the race.
 *
 * CANCELLED and FAILED are reachable from every non-terminal state; terminal
 * states are dead ends, which is what makes settlement replay-safe.
 */
export const VIDEO_ROOM_PK_TRANSITIONS: Record<
  VideoRoomPkStatus,
  ReadonlySet<VideoRoomPkStatus>
> = {
  [S.CREATED]: new Set([S.INVITED, S.CANCELLED, S.FAILED]),
  [S.INVITED]: new Set([S.PENDING, S.ACCEPTED, S.CANCELLED, S.FAILED]),
  [S.PENDING]: new Set([S.ACCEPTED, S.CANCELLED, S.FAILED]),
  [S.ACCEPTED]: new Set([S.COUNTDOWN, S.CANCELLED, S.FAILED]),
  [S.COUNTDOWN]: new Set([S.LIVE, S.CANCELLED, S.FAILED]),
  [S.LIVE]: new Set([S.PAUSED, S.RECOVERING, S.COMPLETED, S.CANCELLED, S.FAILED]),
  [S.PAUSED]: new Set([S.LIVE, S.COMPLETED, S.CANCELLED, S.FAILED]),
  [S.RECOVERING]: new Set([S.LIVE, S.COMPLETED, S.CANCELLED, S.FAILED]),
  [S.COMPLETED]: new Set<VideoRoomPkStatus>(),
  [S.CANCELLED]: new Set<VideoRoomPkStatus>(),
  [S.FAILED]: new Set<VideoRoomPkStatus>(),
};
```

Note `INVITED → ACCEPTED` is permitted directly: a client that accepts without first sending a delivery ack must not be blocked.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/constants/video-room-pk.constants.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Export from the barrel and verify**

Add to `src/modules/video-rooms/constants/index.ts`:
```ts
export * from './video-room-pk.constants';
```

Run: `npx tsc --noEmit`
Expected: clean.

---

## Task 4: Configuration

**Files:**
- Create: `src/modules/video-rooms/config/video-room-pk.config.ts`
- Create: `src/modules/video-rooms/config/video-room-pk.config.spec.ts`
- Modify: `src/config/configuration.ts` (add the `videoRoomPk` namespace)
- Modify: `src/config/env.validation.ts` (add all 20 env vars)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `toBool` from `./video-room-gift.config`
- Produces: `loadVideoRoomPkConfig(config: ConfigService): VideoRoomPkConfig` with fields `enabled, countdownSeconds, minDurationSeconds, maxDurationSeconds, defaultDurationSeconds, invitationTtlSeconds, poolBps, winnerBps, participationBps, bonusBps, multiplierCapBps, vipBonusBpsPerTier, eventBonusBps, eventMultiplierEnabled, scoreEmitPerSecond, recoveryEnabled, monitorIntervalSeconds, orphanTimeoutSeconds, recoveryGraceSeconds, maxPerSweep`

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/config/video-room-pk.config.spec.ts`:

```ts
import { loadVideoRoomPkConfig } from './video-room-pk.config';

const svc = (raw: Record<string, unknown>) =>
  ({ get: () => raw }) as unknown as import('@nestjs/config').ConfigService;

describe('loadVideoRoomPkConfig', () => {
  it('applies defaults when nothing is configured', () => {
    const cfg = loadVideoRoomPkConfig(svc({}));
    expect(cfg.enabled).toBe(true);
    expect(cfg.countdownSeconds).toBe(10);
    expect(cfg.poolBps).toBe(1000);
    expect(cfg.multiplierCapBps).toBe(30_000);
  });

  // The VR-10/VR-11 string-coercion trap: z.coerce.boolean()("false") === true,
  // so booleans bypass zod and are read raw.
  it('reads the STRING "false" as false', () => {
    expect(loadVideoRoomPkConfig(svc({ enabled: 'false' })).enabled).toBe(false);
    expect(loadVideoRoomPkConfig(svc({ recoveryEnabled: 'false' })).recoveryEnabled).toBe(false);
  });

  it('coerces numeric strings', () => {
    expect(loadVideoRoomPkConfig(svc({ poolBps: '2500' })).poolBps).toBe(2500);
  });

  it('keeps the reward split within the pool', () => {
    const cfg = loadVideoRoomPkConfig(svc({}));
    expect(cfg.winnerBps + cfg.participationBps + cfg.bonusBps).toBeLessThanOrEqual(10_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/config/video-room-pk.config.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the config loader**

Create `src/modules/video-rooms/config/video-room-pk.config.ts`:

```ts
import type { ConfigService } from '@nestjs/config';
import { toBool } from './video-room-gift.config';

/**
 * Typed view of the `videoRoomPk` namespace.
 *
 * Namespaced config surfaces as raw process.env strings at runtime, so every
 * value is re-coerced here once (the VR-10 approach). Booleans bypass the zod
 * schema deliberately: `z.coerce.boolean()` turns the STRING "false" into `true`,
 * so an operator writing VIDEO_ROOM_PK_ENABLED=false would silently enable it.
 */
export interface VideoRoomPkConfig {
  /** Master switch. When false, every lifecycle command is refused. */
  enabled: boolean;
  /** Pre-battle countdown before the clock starts. */
  countdownSeconds: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  defaultDurationSeconds: number;
  /** How long an invitation stays actionable. */
  invitationTtlSeconds: number;
  /** Share of BASE contribution minted as the reward pool (1000 = 10%). */
  poolBps: number;
  /** Split of the pool. winner + participation + bonus must be ≤ 10000. */
  winnerBps: number;
  participationBps: number;
  bonusBps: number;
  /** Ceiling on the composed score multiplier. 30000 = 3.0×. */
  multiplierCapBps: number;
  /** Bonus bps added per VIP tier level. */
  vipBonusBpsPerTier: number;
  eventBonusBps: number;
  eventMultiplierEnabled: boolean;
  /** Ceiling on `pkScoreUpdated` broadcasts per battle per second. */
  scoreEmitPerSecond: number;
  recoveryEnabled: boolean;
  monitorIntervalSeconds: number;
  /** A RECOVERING battle older than this is settled with current scores. */
  orphanTimeoutSeconds: number;
  /** Grace given to a dropped host before the battle is settled. */
  recoveryGraceSeconds: number;
  maxPerSweep: number;
}

interface RawVideoRoomPkConfig {
  enabled?: boolean | string;
  countdownSeconds?: number | string;
  minDurationSeconds?: number | string;
  maxDurationSeconds?: number | string;
  defaultDurationSeconds?: number | string;
  invitationTtlSeconds?: number | string;
  poolBps?: number | string;
  winnerBps?: number | string;
  participationBps?: number | string;
  bonusBps?: number | string;
  multiplierCapBps?: number | string;
  vipBonusBpsPerTier?: number | string;
  eventBonusBps?: number | string;
  eventMultiplierEnabled?: boolean | string;
  scoreEmitPerSecond?: number | string;
  recoveryEnabled?: boolean | string;
  monitorIntervalSeconds?: number | string;
  orphanTimeoutSeconds?: number | string;
  recoveryGraceSeconds?: number | string;
  maxPerSweep?: number | string;
}

const num = (v: number | string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
};

export function loadVideoRoomPkConfig(config: ConfigService): VideoRoomPkConfig {
  const raw = config.get<RawVideoRoomPkConfig>('videoRoomPk') ?? {};
  return {
    enabled: toBool(raw.enabled, true),
    countdownSeconds: num(raw.countdownSeconds, 10),
    minDurationSeconds: num(raw.minDurationSeconds, 60),
    maxDurationSeconds: num(raw.maxDurationSeconds, 1800),
    defaultDurationSeconds: num(raw.defaultDurationSeconds, 300),
    invitationTtlSeconds: num(raw.invitationTtlSeconds, 60),
    poolBps: num(raw.poolBps, 1000),
    winnerBps: num(raw.winnerBps, 6000),
    participationBps: num(raw.participationBps, 3000),
    bonusBps: num(raw.bonusBps, 1000),
    multiplierCapBps: num(raw.multiplierCapBps, 30_000),
    vipBonusBpsPerTier: num(raw.vipBonusBpsPerTier, 500),
    eventBonusBps: num(raw.eventBonusBps, 0),
    eventMultiplierEnabled: toBool(raw.eventMultiplierEnabled, false),
    scoreEmitPerSecond: num(raw.scoreEmitPerSecond, 10),
    recoveryEnabled: toBool(raw.recoveryEnabled, false),
    monitorIntervalSeconds: num(raw.monitorIntervalSeconds, 15),
    orphanTimeoutSeconds: num(raw.orphanTimeoutSeconds, 120),
    recoveryGraceSeconds: num(raw.recoveryGraceSeconds, 45),
    maxPerSweep: num(raw.maxPerSweep, 50),
  };
}
```

- [ ] **Step 4: Register the namespace and validate every env var**

In `src/config/configuration.ts`, add a `videoRoomPk` key mapping each field to its `VIDEO_ROOM_PK_*` env var, following the existing `videoRoomTreasure` block verbatim in style.

In `src/config/env.validation.ts`, add all 20 vars as `.optional()` entries. **All 20 must be present** — Phase 9's audit (gap G-M4) found 17 env vars missing from validation, silently falling back to defaults with no signal. Add the matching lines to `.env.example`.

- [ ] **Step 5: Run the test and verify the wiring**

Run:
```bash
npx jest src/modules/video-rooms/config/video-room-pk.config.spec.ts
npx tsc --noEmit
grep -c "VIDEO_ROOM_PK_" src/config/env.validation.ts
```
Expected: 4 tests PASS; tsc clean; the grep prints `20`.

---

## Task 5: Error codes and exceptions

**Files:**
- Create: `src/modules/video-rooms/exceptions/video-room-pk.exceptions.ts`
- Create: `src/modules/video-rooms/exceptions/video-room-pk.exceptions.spec.ts`
- Modify: `src/common/exceptions/error-codes.ts`

**Interfaces:**
- Consumes: `BusinessException`, `ERROR_CODES`
- Produces: `PKBattleException`, `PKInvitationException`, `PKScoreException`, `PKRewardException`, `PKWinnerException`, `DuplicatePKException`, `PKCountdownException`, `BattleRecoveryException` — each `new (message: string, status?: HttpStatus)`, defaulting to 409.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/exceptions/video-room-pk.exceptions.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  BattleRecoveryException,
  DuplicatePKException,
  PKBattleException,
  PKCountdownException,
  PKInvitationException,
  PKRewardException,
  PKScoreException,
  PKWinnerException,
} from './video-room-pk.exceptions';

type Ctor = new (message: string, status?: HttpStatus) => BusinessException;

const CASES: [string, Ctor, string][] = [
  ['PKBattleException', PKBattleException, ERROR_CODES.VIDEO_ROOM_PK_INVALID],
  ['PKInvitationException', PKInvitationException, ERROR_CODES.VIDEO_ROOM_PK_INVITATION_FAILED],
  ['PKScoreException', PKScoreException, ERROR_CODES.VIDEO_ROOM_PK_SCORE_FAILED],
  ['PKRewardException', PKRewardException, ERROR_CODES.VIDEO_ROOM_PK_REWARD_FAILED],
  ['PKWinnerException', PKWinnerException, ERROR_CODES.VIDEO_ROOM_PK_WINNER_FAILED],
  ['DuplicatePKException', DuplicatePKException, ERROR_CODES.VIDEO_ROOM_PK_ALREADY_ACTIVE],
  ['PKCountdownException', PKCountdownException, ERROR_CODES.VIDEO_ROOM_PK_COUNTDOWN_FAILED],
  ['BattleRecoveryException', BattleRecoveryException, ERROR_CODES.VIDEO_ROOM_PK_RECOVERY_FAILED],
];

describe('video-room PK exceptions', () => {
  it.each(CASES)('%s binds its own error code', (_n, Ctor, code) => {
    expect(new Ctor('boom').errorCode).toBe(code);
  });

  it.each(CASES)('%s extends BusinessException so the filter handles it', (_n, Ctor) => {
    expect(new Ctor('boom')).toBeInstanceOf(BusinessException);
  });

  // 409, not 400: each fires when the request was well-formed but the PK state
  // disallows it. A 400 would tell the client to fix its payload — wrong advice.
  it.each(CASES)('%s defaults to 409 CONFLICT', (_n, Ctor) => {
    expect(new Ctor('boom').getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('allows an explicit status override', () => {
    expect(new PKBattleException('nope', HttpStatus.FORBIDDEN).getStatus()).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/exceptions/video-room-pk.exceptions.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the error codes**

In `src/common/exceptions/error-codes.ts`, after the `VIDEO_ROOM_TREASURE_*` block, add:

```ts
  VIDEO_ROOM_PK_INVALID: 'VIDEO_ROOM_PK_INVALID',
  VIDEO_ROOM_PK_NOT_FOUND: 'VIDEO_ROOM_PK_NOT_FOUND',
  VIDEO_ROOM_PK_ALREADY_ACTIVE: 'VIDEO_ROOM_PK_ALREADY_ACTIVE',
  VIDEO_ROOM_PK_INVITATION_FAILED: 'VIDEO_ROOM_PK_INVITATION_FAILED',
  VIDEO_ROOM_PK_SCORE_FAILED: 'VIDEO_ROOM_PK_SCORE_FAILED',
  VIDEO_ROOM_PK_REWARD_FAILED: 'VIDEO_ROOM_PK_REWARD_FAILED',
  VIDEO_ROOM_PK_WINNER_FAILED: 'VIDEO_ROOM_PK_WINNER_FAILED',
  VIDEO_ROOM_PK_COUNTDOWN_FAILED: 'VIDEO_ROOM_PK_COUNTDOWN_FAILED',
  VIDEO_ROOM_PK_RECOVERY_FAILED: 'VIDEO_ROOM_PK_RECOVERY_FAILED',
  VIDEO_ROOM_PK_DISABLED: 'VIDEO_ROOM_PK_DISABLED',
  VIDEO_ROOM_PK_NOT_AUTHORIZED: 'VIDEO_ROOM_PK_NOT_AUTHORIZED',
```

- [ ] **Step 4: Write the exceptions**

Create `src/modules/video-rooms/exceptions/video-room-pk.exceptions.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

/**
 * VR-12 PK exceptions. Each binds one error code so a client can branch on the
 * specific failure instead of parsing a message.
 *
 * All default to 409 CONFLICT: every one of these fires when the request was
 * well-formed but the battle state disallows it. 400 would instruct the client
 * to fix its payload, which is the wrong instruction.
 */

export class PKBattleException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_INVALID, message, status);
  }
}

export class PKInvitationException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_INVITATION_FAILED, message, status);
  }
}

export class PKScoreException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_SCORE_FAILED, message, status);
  }
}

export class PKRewardException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_REWARD_FAILED, message, status);
  }
}

export class PKWinnerException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_WINNER_FAILED, message, status);
  }
}

export class DuplicatePKException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_ALREADY_ACTIVE, message, status);
  }
}

export class PKCountdownException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_COUNTDOWN_FAILED, message, status);
  }
}

export class BattleRecoveryException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_RECOVERY_FAILED, message, status);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/exceptions/video-room-pk.exceptions.spec.ts`
Expected: PASS, 25 assertions across 4 test blocks.

---

## Task 6: Domain events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-pk.events.ts`
- Create: `src/modules/video-rooms/events/video-room-pk.events.spec.ts`
- Modify: `src/modules/video-rooms/events/index.ts`

**Interfaces:**
- Consumes: `DomainEvent` from `src/common/events`
- Produces: `VIDEO_ROOM_PK_EVENTS` (12 keys) and 12 event classes:
  `PkInvitationSentEvent`, `PkInvitationAcceptedEvent`, `PkInvitationRejectedEvent`, `PkCreatedEvent`, `PkStartedEvent`, `PkScoreUpdatedEvent`, `PkPausedEvent`, `PkResumedEvent`, `PkEndedEvent`, `PkWinnerDeclaredEvent`, `PkRewardDistributedEvent`, `PkRecoveredEvent`.
  Every payload carries `roomId` and `battleId`; that pair is what the socket and audit listeners key on.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/events/video-room-pk.events.spec.ts`:

```ts
import {
  PkEndedEvent,
  PkScoreUpdatedEvent,
  VIDEO_ROOM_PK_EVENTS,
} from './video-room-pk.events';

describe('video-room PK events', () => {
  it('declares 12 event names, all namespaced', () => {
    const names = Object.values(VIDEO_ROOM_PK_EVENTS);
    expect(names).toHaveLength(12);
    expect(names.every((n) => n.startsWith('video_room.pk.'))).toBe(true);
    expect(new Set(names).size).toBe(12);
  });

  it('binds each class to its declared name', () => {
    const e = new PkEndedEvent({
      roomId: 'r', battleId: 'b', winningTeamId: 't', isDraw: false,
      teams: [], durationSeconds: 300, giftCount: 4, totalBase: 100,
    });
    expect(e.name).toBe(VIDEO_ROOM_PK_EVENTS.ENDED);
  });

  it('carries roomId and battleId on every payload', () => {
    const e = new PkScoreUpdatedEvent({
      roomId: 'r', battleId: 'b', side: 'RED', teams: [],
      participantId: 'p', userId: 'u', scoredAmount: 10, multiplierBps: 10_000,
    });
    expect(e.payload.roomId).toBe('r');
    expect(e.payload.battleId).toBe('b');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/events/video-room-pk.events.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the events**

Create `src/modules/video-rooms/events/video-room-pk.events.ts`. Declare the name map and the 12 classes. Every payload extends a shared `PkEventBase { roomId: string; battleId: string }`:

```ts
import { DomainEvent } from 'src/common/events';

/**
 * VR-12 PK events owned by the video-rooms module.
 *
 * All 12 are NEW names under `video_room.pk.*`. The audio module's
 * `audio_room.pk.*` events are untouched and are NOT re-published here —
 * doing so would fire every audio listener for a video battle.
 */
export const VIDEO_ROOM_PK_EVENTS = {
  INVITATION_SENT: 'video_room.pk.invitation_sent',
  INVITATION_ACCEPTED: 'video_room.pk.invitation_accepted',
  INVITATION_REJECTED: 'video_room.pk.invitation_rejected',
  CREATED: 'video_room.pk.created',
  STARTED: 'video_room.pk.started',
  SCORE_UPDATED: 'video_room.pk.score_updated',
  PAUSED: 'video_room.pk.paused',
  RESUMED: 'video_room.pk.resumed',
  ENDED: 'video_room.pk.ended',
  WINNER_DECLARED: 'video_room.pk.winner_declared',
  REWARD_DISTRIBUTED: 'video_room.pk.reward_distributed',
  RECOVERED: 'video_room.pk.recovered',
} as const;

/** Every PK payload is addressable by (roomId, battleId). */
export interface PkEventBase {
  roomId: string;
  battleId: string;
}

/** Side totals as broadcast. Numbers, not BigInt — this crosses the wire. */
export interface PkTeamView {
  teamId: string;
  side: string;
  score: number;
}

export class PkInvitationSentEvent extends DomainEvent<
  PkEventBase & {
    invitationId: string;
    inviteeUserId: string;
    inviterUserId: string;
    side: string;
    attempt: number;
    expiresAt: string;
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.INVITATION_SENT;
}

export class PkInvitationAcceptedEvent extends DomainEvent<
  PkEventBase & { invitationId: string; inviteeUserId: string }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED;
}

export class PkInvitationRejectedEvent extends DomainEvent<
  PkEventBase & { invitationId: string; inviteeUserId: string }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED;
}

export class PkCreatedEvent extends DomainEvent<
  PkEventBase & { mode: string; createdBy: string; durationSeconds: number }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.CREATED;
}

export class PkStartedEvent extends DomainEvent<
  PkEventBase & {
    mode: string;
    countdownSeconds: number;
    durationSeconds: number;
    startedAt: string;
    endsAt: string;
    teams: PkTeamView[];
    participants: { userId: string; side: string; teamId: string }[];
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.STARTED;
}

export class PkScoreUpdatedEvent extends DomainEvent<
  PkEventBase & {
    side: string;
    teams: PkTeamView[];
    participantId: string;
    userId: string;
    scoredAmount: number;
    multiplierBps: number;
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED;
}

export class PkPausedEvent extends DomainEvent<
  PkEventBase & { pausedAt: string; remainingMs: number; involuntary: boolean }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.PAUSED;
}

export class PkResumedEvent extends DomainEvent<
  PkEventBase & { resumedAt: string; endsAt: string; resumeSeq: number }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.RESUMED;
}

export class PkEndedEvent extends DomainEvent<
  PkEventBase & {
    winningTeamId: string | null;
    isDraw: boolean;
    teams: PkTeamView[];
    durationSeconds: number;
    giftCount: number;
    totalBase: number;
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.ENDED;
}

export class PkWinnerDeclaredEvent extends DomainEvent<
  PkEventBase & { winningTeamId: string | null; isDraw: boolean; winners: string[] }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED;
}

export class PkRewardDistributedEvent extends DomainEvent<
  PkEventBase & {
    poolAmount: number;
    allocatedAmount: number;
    rewards: { userId: string; kind: string; amount: number }[];
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED;
}

export class PkRecoveredEvent extends DomainEvent<
  PkEventBase & { reason: string; previousStatus: string; newStatus: string }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.RECOVERED;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/events/video-room-pk.events.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Export from the barrel and verify**

Add `export * from './video-room-pk.events';` to `src/modules/video-rooms/events/index.ts`.
Run: `npx tsc --noEmit` — clean.

---

## Task 7: PK repository (battles, teams, participants, contributions)

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-pk.repository.ts`
- Create: `src/modules/video-rooms/repositories/video-room-pk.repository.spec.ts`
- Modify: `src/modules/video-rooms/repositories/index.ts`

**Interfaces:**
- Consumes: `PrismaService`, Task 2 types
- Produces: `VideoRoomPkRepository` with:
  - `findLive(roomId, db?): Promise<VideoRoomPkBattle | null>` — status LIVE only
  - `findCurrent(roomId, db?): Promise<VideoRoomPkBattle | null>` — any non-terminal
  - `getBattle(id, db?)`, `createBattle(data, db?)`
  - `transition(id, from, to, patch?, db?): Promise<VideoRoomPkBattle | null>` — conditional UPDATE, null when it loses
  - `createTeams(rows, db?)`, `listTeams(battleId, db?)`, `getTeam(teamId, db?): Promise<VideoRoomPkTeam | null>`
  - `createParticipants(rows, db?)`, `listParticipants(battleId, db?)`, `findParticipantsByUserIds(battleId, userIds, db?)`, `getParticipant(id, db?): Promise<VideoRoomPkParticipant | null>`
  - `addTeamScore(teamId, seenScore, delta, db?): Promise<VideoRoomPkTeam | null>` — CAS, null on contention
  - `addParticipantScore(participantId, seenScore, delta, db?): Promise<VideoRoomPkParticipant | null>` — CAS
  - `addContribution(data, db?)`, `sumBaseAmount(battleId, db?): Promise<bigint>`, `countGifts(battleId, db?): Promise<number>`
  - `topContributor(battleId, db?): Promise<{ userId: string; total: bigint } | null>`
  - `listBattles(roomId, skip, take): Promise<[VideoRoomPkBattle[], number]>`
  - `findStale(now, statuses, take): Promise<VideoRoomPkBattle[]>`
  - Also exports `export type Db = Prisma.TransactionClient | PrismaService;` — Tasks 10, 11 and 13 import this type.

> `getTeam` / `getParticipant` exist specifically for the CAS retry loop in Task 13: when a compare-and-set loses, the caller must re-read the current score before retrying. Without them the retry would re-submit the same stale `seenScore` and lose forever.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/repositories/video-room-pk.repository.spec.ts`. Mock `PrismaService` with jest fns and assert the *shape* of each query — this is where the CAS semantics get pinned:

```ts
import { VideoRoomPkSide, VideoRoomPkStatus } from '@prisma/client';
import { VideoRoomPkRepository } from './video-room-pk.repository';

const prisma = () =>
  ({
    videoRoomPkBattle: { findFirst: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    videoRoomPkTeam: { updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    videoRoomPkParticipant: { updateMany: jest.fn(), findUnique: jest.fn() },
    videoRoomPkContribution: { create: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  }) as never;

describe('VideoRoomPkRepository', () => {
  it('findLive filters to LIVE only', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (db as never as { videoRoomPkBattle: { findFirst: jest.Mock } }).videoRoomPkBattle
      .findFirst.mockResolvedValue(null);

    await repo.findLive('room-1');

    expect(
      (db as never as { videoRoomPkBattle: { findFirst: jest.Mock } }).videoRoomPkBattle.findFirst,
    ).toHaveBeenCalledWith({ where: { roomId: 'room-1', status: VideoRoomPkStatus.LIVE } });
  });

  // The transition MUST be conditional on the expected status, or two concurrent
  // commands both "succeed" and the FSM is decorative.
  it('transition guards on the expected from-status and returns null when it loses', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    const battles = (db as never as { videoRoomPkBattle: { updateMany: jest.Mock } })
      .videoRoomPkBattle;
    battles.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.transition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED);

    expect(battles.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: VideoRoomPkStatus.LIVE },
      data: expect.objectContaining({ status: VideoRoomPkStatus.PAUSED }),
    });
    expect(result).toBeNull();
  });

  // The CAS guard: the UPDATE must include the score the caller READ, so a
  // concurrent writer invalidates it rather than silently overwriting.
  it('addTeamScore compare-and-sets on the score the caller saw', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    const teams = (db as never as { videoRoomPkTeam: { updateMany: jest.Mock } }).videoRoomPkTeam;
    teams.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.addTeamScore('t1', 100n, 50n);

    expect(teams.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', score: 100n },
      data: { score: 150n, giftCount: { increment: 1 } },
    });
    expect(result).toBeNull();
  });

  it('sumBaseAmount returns 0n when the ledger is empty', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (db as never as { videoRoomPkContribution: { aggregate: jest.Mock } }).videoRoomPkContribution
      .aggregate.mockResolvedValue({ _sum: { baseAmount: null } });

    expect(await repo.sumBaseAmount('b1')).toBe(0n);
  });

  it('findStale filters by status set and deadline', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRepository(db);
    (db as never as { videoRoomPkBattle: { findMany?: jest.Mock } }).videoRoomPkBattle.findMany =
      jest.fn().mockResolvedValue([]);
    const now = new Date('2026-07-22T00:00:00Z');

    await repo.findStale(now, [VideoRoomPkStatus.LIVE], 50);

    expect(
      (db as never as { videoRoomPkBattle: { findMany: jest.Mock } }).videoRoomPkBattle.findMany,
    ).toHaveBeenCalledWith({
      where: { status: { in: [VideoRoomPkStatus.LIVE] }, endsAt: { lte: now } },
      take: 50,
      orderBy: { endsAt: 'asc' },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/repositories/video-room-pk.repository.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the repository**

Create `src/modules/video-rooms/repositories/video-room-pk.repository.ts`, following the `video-room-treasure.repository.ts` style (`type Db = Prisma.TransactionClient | PrismaService`, every method taking an optional `db` defaulting to `this.prisma`). The two methods that carry the design weight:

```ts
  /**
   * Conditional status transition. Returns the updated row, or null when the
   * battle was no longer in `from` — which means another actor moved it first.
   *
   * `updateMany` rather than `update` is deliberate: `update` throws P2025 on a
   * miss, which would turn an ordinary lost race into an exception the caller
   * has to string-match. `count === 0` is the clean signal.
   */
  async transition(
    id: string,
    from: VideoRoomPkStatus,
    to: VideoRoomPkStatus,
    patch: Prisma.VideoRoomPkBattleUpdateInput = {},
    db: Db = this.prisma,
  ): Promise<VideoRoomPkBattle | null> {
    const { count } = await db.videoRoomPkBattle.updateMany({
      where: { id, status: from },
      data: { ...patch, status: to },
    });
    if (count === 0) return null;
    return db.videoRoomPkBattle.findUnique({ where: { id } });
  }

  /**
   * Compare-and-set on the score the caller read. A concurrent writer changes
   * `score`, the WHERE no longer matches, count is 0 and the caller re-reads and
   * retries. Never use `{ increment }` here: it always succeeds, so the caller
   * cannot tell how much of the delta was actually theirs — and the contribution
   * row it then writes would credit this gift with someone else's coins.
   */
  async addTeamScore(
    teamId: string,
    seenScore: bigint,
    delta: bigint,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkTeam | null> {
    const { count } = await db.videoRoomPkTeam.updateMany({
      where: { id: teamId, score: seenScore },
      data: { score: seenScore + delta, giftCount: { increment: 1 } },
    });
    if (count === 0) return null;
    return db.videoRoomPkTeam.findUnique({ where: { id: teamId } });
  }
```

`addParticipantScore` mirrors `addTeamScore` exactly against `videoRoomPkParticipant`. `sumBaseAmount` uses `aggregate({ _sum: { baseAmount: true }, where: { battleId } })` and coalesces `null` to `0n`. `topContributor` uses `groupBy({ by: ['senderId'], _sum: { baseAmount: true }, orderBy: { _sum: { baseAmount: 'desc' } }, take: 1 })`. The remaining methods are direct Prisma calls with no branching.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/repositories/video-room-pk.repository.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export from the barrel and verify**

Add `export * from './video-room-pk.repository';` to `src/modules/video-rooms/repositories/index.ts`.
Run: `npx tsc --noEmit` — clean.

---

## Task 8: Invitation and reward repositories

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-pk-invitation.repository.ts`
- Create: `src/modules/video-rooms/repositories/video-room-pk-invitation.repository.spec.ts`
- Create: `src/modules/video-rooms/repositories/video-room-pk-reward.repository.ts`
- Create: `src/modules/video-rooms/repositories/video-room-pk-reward.repository.spec.ts`
- Modify: `src/modules/video-rooms/repositories/index.ts`

**Interfaces:**
- Produces:
  - `VideoRoomPkInvitationRepository`: `create(data, db?)`, `listForBattle(battleId, db?)`, `findActionable(battleId, inviteeUserId, db?)`, `updateStatus(id, from, to, patch?, db?): Promise<VideoRoomPkInvitation | null>` (conditional), `latestAttempt(battleId, inviteeUserId, db?): Promise<number>`, `findExpired(now, take)`
  - `VideoRoomPkRewardRepository`: `createPool(data, db?): Promise<{ pool: VideoRoomPkRewardPool; created: boolean }>`, `getPool(battleId, db?)`, `createReward(data, db?): Promise<VideoRoomPkReward | null>` (null on unique conflict = replay), `listRewards(battleId, db?)`, `addAllocated(poolId, amount, db?)`

- [ ] **Step 1: Write the failing tests**

Create both spec files. The critical behaviours to pin:

```ts
// video-room-pk-reward.repository.spec.ts
it('createPool reports created:false when the battle already has a pool', async () => {
  const db = prisma();
  const repo = new VideoRoomPkRewardRepository(db);
  const pools = (db as never as { videoRoomPkRewardPool: { create: jest.Mock; findUnique: jest.Mock } })
    .videoRoomPkRewardPool;
  pools.create.mockRejectedValue({ code: 'P2002' });
  pools.findUnique.mockResolvedValue({ id: 'p1', battleId: 'b1' });

  const result = await repo.createPool({
    battleId: 'b1', roomId: 'r1', strategy: 'PERCENTAGE',
    sourceAmount: 100n, poolAmount: 10n,
    winnerBps: 6000, participationBps: 3000, bonusBps: 1000,
  });

  expect(result.created).toBe(false);
  expect(result.pool.id).toBe('p1');
});

it('createReward returns null on a duplicate rather than throwing', async () => {
  const db = prisma();
  const repo = new VideoRoomPkRewardRepository(db);
  (db as never as { videoRoomPkReward: { create: jest.Mock } }).videoRoomPkReward
    .create.mockRejectedValue({ code: 'P2002' });

  expect(
    await repo.createReward({
      battleId: 'b1', roomId: 'r1', userId: 'u1', kind: VideoRoomPkRewardKind.WINNER,
      amount: 10n, currency: WalletCurrency.GOLD, idempotencyKey: 'pk:b1:u1:WINNER',
    }),
  ).toBeNull();
});

it('createReward rethrows a non-P2002 error', async () => {
  const db = prisma();
  const repo = new VideoRoomPkRewardRepository(db);
  (db as never as { videoRoomPkReward: { create: jest.Mock } }).videoRoomPkReward
    .create.mockRejectedValue(new Error('connection lost'));

  await expect(
    repo.createReward({
      battleId: 'b1', roomId: 'r1', userId: 'u1', kind: VideoRoomPkRewardKind.WINNER,
      amount: 10n, currency: WalletCurrency.GOLD, idempotencyKey: 'k',
    }),
  ).rejects.toThrow('connection lost');
});
```

```ts
// video-room-pk-invitation.repository.spec.ts
it('updateStatus guards on the expected from-status', async () => {
  const db = prisma();
  const repo = new VideoRoomPkInvitationRepository(db);
  const inv = (db as never as { videoRoomPkInvitation: { updateMany: jest.Mock } })
    .videoRoomPkInvitation;
  inv.updateMany.mockResolvedValue({ count: 0 });

  const out = await repo.updateStatus(
    'i1', VideoRoomPkInvitationStatus.SENT, VideoRoomPkInvitationStatus.ACCEPTED,
  );

  expect(inv.updateMany).toHaveBeenCalledWith({
    where: { id: 'i1', status: VideoRoomPkInvitationStatus.SENT },
    data: expect.objectContaining({ status: VideoRoomPkInvitationStatus.ACCEPTED }),
  });
  expect(out).toBeNull();
});

it('findActionable only matches SENT or DELIVERED', async () => {
  const db = prisma();
  const repo = new VideoRoomPkInvitationRepository(db);
  const inv = (db as never as { videoRoomPkInvitation: { findFirst: jest.Mock } })
    .videoRoomPkInvitation;
  inv.findFirst.mockResolvedValue(null);

  await repo.findActionable('b1', 'u1');

  expect(inv.findFirst).toHaveBeenCalledWith({
    where: {
      battleId: 'b1', inviteeUserId: 'u1',
      status: { in: [VideoRoomPkInvitationStatus.SENT, VideoRoomPkInvitationStatus.DELIVERED] },
    },
    orderBy: { attempt: 'desc' },
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/repositories/video-room-pk-invitation.repository.spec.ts src/modules/video-rooms/repositories/video-room-pk-reward.repository.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write both repositories**

`createPool` and `createReward` share one pattern — catch Prisma's unique-violation code and treat it as a replay rather than an error:

```ts
  /**
   * Mint the pool, or report the existing one. `battleId @unique` means a
   * replayed settlement lands here with P2002; that is the SUCCESS path for a
   * retry, not a failure, so it returns `created: false` and the original row.
   * Any other error propagates so BullMQ can retry and eventually dead-letter.
   */
  async createPool(
    data: Prisma.VideoRoomPkRewardPoolUncheckedCreateInput,
    db: Db = this.prisma,
  ): Promise<{ pool: VideoRoomPkRewardPool; created: boolean }> {
    try {
      return { pool: await db.videoRoomPkRewardPool.create({ data }), created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const pool = await db.videoRoomPkRewardPool.findUnique({
        where: { battleId: data.battleId },
      });
      if (!pool) throw err; // P2002 on some other constraint — do not swallow
      return { pool, created: false };
    }
  }
```

`createReward` uses the same guard but returns `null` on P2002, because a duplicate reward row means this recipient was already paid and the caller must skip the wallet credit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/repositories/video-room-pk-invitation.repository.spec.ts src/modules/video-rooms/repositories/video-room-pk-reward.repository.spec.ts`
Expected: PASS, 5 tests total.

- [ ] **Step 5: Export from the barrel and verify**

Add both to `src/modules/video-rooms/repositories/index.ts`. Run `npx tsc --noEmit` — clean.

---

## Task 9: DTOs

**Files:**
- Create: `src/modules/video-rooms/dto/video-room-pk.dto.ts`
- Create: `src/modules/video-rooms/dto/video-room-pk.dto.spec.ts`
- Modify: `src/modules/video-rooms/dto/index.ts`

**Interfaces:**
- Produces the 10 briefed DTOs: `CreatePKInvitationDto`, `AcceptPKInvitationDto`, `RejectPKInvitationDto`, `StartPKDto`, `PausePKDto`, `ResumePKDto`, `EndPKDto`, `PKScoreDto`, `PKStatisticsDto`, `PKResponseDto`, plus `PKHistoryQueryDto` for pagination.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/dto/video-room-pk.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePKInvitationDto } from './video-room-pk.dto';

const build = (raw: Record<string, unknown>) =>
  validate(plainToInstance(CreatePKInvitationDto, raw));

describe('CreatePKInvitationDto', () => {
  const valid = {
    mode: 'ONE_VS_ONE',
    durationSeconds: 300,
    red: ['11111111-1111-1111-1111-111111111111'],
    blue: ['22222222-2222-2222-2222-222222222222'],
    invitees: ['22222222-2222-2222-2222-222222222222'],
  };

  it('accepts a well-formed 1v1 invitation', async () => {
    expect(await build(valid)).toHaveLength(0);
  });

  it('rejects a non-uuid participant', async () => {
    expect((await build({ ...valid, red: ['nope'] })).length).toBeGreaterThan(0);
  });

  it('rejects an unknown mode', async () => {
    expect((await build({ ...valid, mode: 'BATTLE_ROYALE' })).length).toBeGreaterThan(0);
  });

  it('rejects an empty side', async () => {
    expect((await build({ ...valid, blue: [] })).length).toBeGreaterThan(0);
  });

  // Cross-side and cardinality rules are business rules, NOT DTO rules — they
  // live in the validation service (Task 12) where the room context is known.
  it('accepts a payload the DTO cannot judge (overlap) — service rejects it later', async () => {
    const overlap = { ...valid, blue: valid.red, invitees: valid.red };
    expect(await build(overlap)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/video-room-pk.dto.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the DTOs**

Create `src/modules/video-rooms/dto/video-room-pk.dto.ts`, using `class-validator` + `@ApiProperty` exactly as `video-room-treasure.dto.ts` does:

```ts
export class CreatePKInvitationDto {
  @ApiProperty({ enum: VideoRoomPkMode, example: VideoRoomPkMode.ONE_VS_ONE })
  @IsEnum(VideoRoomPkMode)
  mode!: VideoRoomPkMode;

  @ApiProperty({ example: 300, minimum: 60, maximum: 1800 })
  @IsInt() @Min(60) @Max(1800)
  durationSeconds!: number;

  @ApiProperty({ type: [String], description: 'User ids on the RED side' })
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  red!: string[];

  @ApiProperty({ type: [String], description: 'User ids on the BLUE side' })
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  blue!: string[];

  @ApiProperty({ type: [String], description: 'Users who must accept before the battle may start' })
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  invitees!: string[];
}
```

`AcceptPKInvitationDto` / `RejectPKInvitationDto` carry an optional `battleId?: string` (`@IsOptional() @IsUUID('4')`) so a client can disambiguate; when absent the service resolves the room's current battle. `PausePKDto` / `ResumePKDto` / `EndPKDto` carry an optional `reason?: string` (`@IsOptional() @IsString() @MaxLength(200)`). `StartPKDto` carries an optional `countdownSeconds?: number` (`@IsOptional() @IsInt() @Min(3) @Max(60)`).

`PKScoreDto`, `PKStatisticsDto` and `PKResponseDto` are response shapes — `@ApiProperty`-annotated classes with no validators.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/dto/video-room-pk.dto.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export from the barrel and verify**

Add `export * from './video-room-pk.dto';` to `src/modules/video-rooms/dto/index.ts`. Run `npx tsc --noEmit` — clean.

---

## Task 10: State service (FSM enforcement)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-state.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-state.service.spec.ts`

**Interfaces:**
- Consumes: `VIDEO_ROOM_PK_TRANSITIONS`, `isPkTerminal` (Task 3); `VideoRoomPkRepository.transition` (Task 7); `PKBattleException` (Task 5)
- Produces: `VideoRoomPkStateService` with
  - `assertTransition(from, to): void` — throws `PKBattleException` on an illegal edge
  - `transition(battleId, from, to, patch?, db?): Promise<VideoRoomPkBattle>` — asserts, then conditionally updates; throws when the update loses
  - `tryTransition(battleId, from, to, patch?, db?): Promise<VideoRoomPkBattle | null>` — same, but returns null instead of throwing (settlement replay path)

- [ ] **Step 1: Write the failing test**

```ts
import { VideoRoomPkStatus } from '@prisma/client';
import { PKBattleException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkStateService } from './video-room-pk-state.service';

const repo = () => ({ transition: jest.fn() });

describe('VideoRoomPkStateService', () => {
  it('permits a legal edge', () => {
    const svc = new VideoRoomPkStateService(repo() as never);
    expect(() =>
      svc.assertTransition(VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED),
    ).not.toThrow();
  });

  it('rejects an illegal edge with PKBattleException', () => {
    const svc = new VideoRoomPkStateService(repo() as never);
    expect(() =>
      svc.assertTransition(VideoRoomPkStatus.CREATED, VideoRoomPkStatus.LIVE),
    ).toThrow(PKBattleException);
  });

  it('rejects any move out of a terminal state', () => {
    const svc = new VideoRoomPkStateService(repo() as never);
    expect(() =>
      svc.assertTransition(VideoRoomPkStatus.COMPLETED, VideoRoomPkStatus.LIVE),
    ).toThrow(PKBattleException);
  });

  it('throws when the conditional update loses the race', async () => {
    const r = repo();
    r.transition.mockResolvedValue(null);
    const svc = new VideoRoomPkStateService(r as never);

    await expect(
      svc.transition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED),
    ).rejects.toThrow(PKBattleException);
  });

  // Settlement must be able to lose without exploding: a replayed end job that
  // finds the battle already COMPLETED should exit quietly, not alert.
  it('tryTransition returns null instead of throwing when it loses', async () => {
    const r = repo();
    r.transition.mockResolvedValue(null);
    const svc = new VideoRoomPkStateService(r as never);

    expect(
      await svc.tryTransition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.COMPLETED),
    ).toBeNull();
  });

  it('passes the patch through to the repository', async () => {
    const r = repo();
    r.transition.mockResolvedValue({ id: 'b1' });
    const svc = new VideoRoomPkStateService(r as never);
    const patch = { pausedAt: new Date('2026-07-22T00:00:00Z') };

    await svc.transition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED, patch);

    expect(r.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED, patch, undefined,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-state.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
/**
 * The only place a PK battle changes status.
 *
 * Enforcement is doubled on purpose. `assertTransition` checks the declared
 * table and produces a clean domain error; the repository's conditional UPDATE
 * then re-checks at the row, which is what actually settles a race between two
 * pods. The table alone would be advisory; the UPDATE alone would give the
 * client a bare 409 with no explanation of which edge was illegal.
 */
@Injectable()
export class VideoRoomPkStateService {
  constructor(private readonly repo: VideoRoomPkRepository) {}

  assertTransition(from: VideoRoomPkStatus, to: VideoRoomPkStatus): void {
    if (!VIDEO_ROOM_PK_TRANSITIONS[from]?.has(to)) {
      throw new PKBattleException(
        isPkTerminal(from)
          ? `This PK battle has already finished (${from}).`
          : `A PK battle cannot move from ${from} to ${to}.`,
      );
    }
  }

  async transition(
    battleId: string,
    from: VideoRoomPkStatus,
    to: VideoRoomPkStatus,
    patch?: Prisma.VideoRoomPkBattleUpdateInput,
    db?: Db,
  ): Promise<VideoRoomPkBattle> {
    const updated = await this.tryTransition(battleId, from, to, patch, db);
    if (!updated) {
      throw new PKBattleException(
        `The PK battle is no longer ${from}; another action changed it first.`,
      );
    }
    return updated;
  }

  // `async` is load-bearing: assertTransition throws SYNCHRONOUSLY, which would
  // escape a `.catch()` chain (the idiom its BullMQ/sweep callers use) and leave
  // this method with a different throw contract from its sibling `transition`.
  async tryTransition(
    battleId: string,
    from: VideoRoomPkStatus,
    to: VideoRoomPkStatus,
    patch?: Prisma.VideoRoomPkBattleUpdateInput,
    db?: Db,
  ): Promise<VideoRoomPkBattle | null> {
    this.assertTransition(from, to);
    return this.repo.transition(battleId, from, to, patch, db);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-state.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 11: Score engine and multiplier strategies

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-score.engine.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-score.engine.spec.ts`
- Create: `src/modules/video-rooms/services/strategies/vip-multiplier.strategy.ts`
- Create: `src/modules/video-rooms/services/strategies/event-multiplier.strategy.ts`
- Create: `src/modules/video-rooms/services/strategies/multiplier-strategies.spec.ts`

**Interfaces:**
- Produces:
  - `interface PkScoreContext { roomId: string; battleId: string; senderId: string; receiverId: string; baseAmount: number; snapshot: PkScoringSnapshot; db: Db }`
  - `interface PkScoringSnapshot { strategies: string[]; vipBonusBpsPerTier: number; eventBonusBps: number; capBps: number }`
  - `interface IPkScoreStrategy { readonly key: string; bonusBps(ctx: PkScoreContext): Promise<number> | number }`
  - `VideoRoomPkScoreEngine` with `register(s: IPkScoreStrategy): void`, `resolve(ctx): Promise<number>`, `snapshot(cfg): PkScoringSnapshot`
  - `VipMultiplierStrategy` (key `'VIP'`), `EventMultiplierStrategy` (key `'EVENT'`)

- [ ] **Step 1: Write the failing test**

```ts
import { PK_MULTIPLIER_BASE_BPS } from '../constants/video-room-pk.constants';
import { VideoRoomPkScoreEngine, type IPkScoreStrategy } from './video-room-pk-score.engine';

const ctx = (snapshot: Partial<{ strategies: string[]; capBps: number }> = {}) =>
  ({
    roomId: 'r', battleId: 'b', senderId: 's', receiverId: 'x', baseAmount: 100,
    snapshot: {
      strategies: snapshot.strategies ?? ['VIP', 'EVENT'],
      vipBonusBpsPerTier: 500, eventBonusBps: 2000,
      capBps: snapshot.capBps ?? 30_000,
    },
    db: {} as never,
  }) as never;

const strat = (key: string, bps: number): IPkScoreStrategy => ({ key, bonusBps: () => bps });

describe('VideoRoomPkScoreEngine', () => {
  it('returns the 1.0× base when nothing is registered', async () => {
    expect(await new VideoRoomPkScoreEngine().resolve(ctx())).toBe(PK_MULTIPLIER_BASE_BPS);
  });

  // Additive, NOT multiplicative: 2x + 2x is 3x here, not 4x. Multiplicative
  // stacking compounds and makes the cap arbitrary.
  it('adds bonuses onto the base rather than multiplying them', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 10_000));
    e.register(strat('EVENT', 10_000));
    expect(await e.resolve(ctx())).toBe(30_000);
  });

  it('caps the composed multiplier', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 50_000));
    expect(await e.resolve(ctx({ capBps: 20_000 }))).toBe(20_000);
  });

  // The snapshot is the frozen rule set. A strategy registered in code but
  // absent from THIS battle's snapshot must not apply to it.
  it('ignores a strategy that is not in the battle snapshot', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 5_000));
    expect(await e.resolve(ctx({ strategies: ['EVENT'] }))).toBe(PK_MULTIPLIER_BASE_BPS);
  });

  // A VIP-lookup failure must never fail a paid gift.
  it('treats a throwing strategy as contributing zero', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register({ key: 'VIP', bonusBps: () => { throw new Error('vip down'); } });
    e.register(strat('EVENT', 1_000));
    expect(await e.resolve(ctx())).toBe(11_000);
  });

  it('refuses a duplicate strategy key', () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 1));
    expect(() => e.register(strat('VIP', 2))).toThrow();
  });

  it('never returns less than the base', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', -99_000));
    expect(await e.resolve(ctx())).toBe(PK_MULTIPLIER_BASE_BPS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-score.engine.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the engine and both strategies**

```ts
  /**
   * Compose the multiplier for one gift leg.
   *
   * Only strategies named in THIS battle's frozen snapshot participate, so an
   * admin registering a new strategy mid-battle cannot change the rules of a
   * battle already in flight.
   *
   * A throwing strategy contributes 0 rather than propagating: this runs inside
   * the gift's money transaction, and a VIP lookup failure must never roll back
   * a paid gift. The floor at base and the ceiling at capBps together mean a
   * misconfigured strategy can neither erase score nor mint unbounded score.
   */
  async resolve(ctx: PkScoreContext): Promise<number> {
    const active = ctx.snapshot.strategies;
    let bonus = 0;
    for (const s of this.strategies.values()) {
      if (!active.includes(s.key)) continue;
      try {
        bonus += await s.bonusBps(ctx);
      } catch (err) {
        this.logger.warn(`PK score strategy ${s.key} failed: ${(err as Error).message}`);
      }
    }
    const total = PK_MULTIPLIER_BASE_BPS + bonus;
    if (total < PK_MULTIPLIER_BASE_BPS) return PK_MULTIPLIER_BASE_BPS;
    return Math.min(total, ctx.snapshot.capBps);
  }
```

`VipMultiplierStrategy.bonusBps` reads the sender's active VIP tier through `ctx.db` (the transaction client — the seam forbids Redis in `onSend`) and returns `tierLevel * ctx.snapshot.vipBonusBpsPerTier`, or 0 when the sender has no VIP. `EventMultiplierStrategy.bonusBps` returns `ctx.snapshot.eventBonusBps` when `eventMultiplierEnabled` is set, else 0.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-score.engine.spec.ts src/modules/video-rooms/services/strategies/multiplier-strategies.spec.ts`
Expected: PASS, 7 engine tests + 4 strategy tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 12: Validation service (the 9 gates)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-validation.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-validation.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomsRepository`, `VideoRoomPermissionService`, `VideoRoomPresenceService`, `VideoRoomMediaStateService`, `VideoRoomPkRepository`, `loadVideoRoomPkConfig`
- Produces: `VideoRoomPkValidationService.assertCanCreate(actor, roomId, dto): Promise<VideoRoom>` running all 9 gates in the order below, and `assertParticipantsDistinct(dto): void`.

Gate order matters — cheapest and most-likely-to-fail first, so a rejected request does the least work:
1. PK enabled (config) → `VIDEO_ROOM_PK_DISABLED` 403
2. room exists → `VIDEO_ROOM_NOT_FOUND` 404
3. room LIVE → `PKBattleException` 409
4. room settings allow PK → `VIDEO_ROOM_PK_DISABLED` 403
5. permission `START_PK` → 403
6. participants distinct / cardinality → `PKBattleException` 400
7. every participant is an active, non-VIEWER member → `PKBattleException` 400
8. every participant is online → `PKBattleException` 409
9. every participant has active media → `PKBattleException` 409
10. no non-terminal battle in the room → `DuplicatePKException` 409

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkValidationService', () => {
  it('refuses when PK is disabled by config', async () => { /* expects VIDEO_ROOM_PK_DISABLED */ });
  it('refuses when the room is not LIVE', async () => { /* expects PKBattleException */ });
  it('refuses when the actor lacks START_PK', async () => { /* expects 403 */ });

  it('refuses overlapping sides', async () => {
    const svc = build();
    expect(() =>
      svc.assertParticipantsDistinct({ mode: 'TEAM', red: ['u1', 'u2'], blue: ['u2'] } as never),
    ).toThrow(PKBattleException);
  });

  it('refuses a 1v1 with more than one per side', async () => {
    const svc = build();
    expect(() =>
      svc.assertParticipantsDistinct({ mode: 'ONE_VS_ONE', red: ['u1', 'u2'], blue: ['u3'] } as never),
    ).toThrow(PKBattleException);
  });

  it('refuses a duplicate within one side', async () => {
    const svc = build();
    expect(() =>
      svc.assertParticipantsDistinct({ mode: 'TEAM', red: ['u1', 'u1'], blue: ['u2'] } as never),
    ).toThrow(PKBattleException);
  });

  // A VIEWER has no seat and no stream, so it can never be a PK side.
  it('refuses a VIEWER as a participant', async () => { /* expects PKBattleException */ });

  it('refuses an offline participant', async () => { /* expects PKBattleException */ });
  it('refuses a participant with no active media', async () => { /* expects PKBattleException */ });

  it('refuses when the room already has a non-terminal battle', async () => {
    /* expects DuplicatePKException */
  });

  it('accepts a fully valid 1v1', async () => { /* resolves */ });
});
```

Each test builds the service with jest-mocked collaborators; assert both the thrown type and that later gates were NOT called (e.g. when the room is not LIVE, `permissions.assertPermission` must not run).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-validation.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Implement the 10 gates in the documented order. The participant-shape gate:

```ts
  /**
   * Cardinality and distinctness. Deliberately NOT a DTO rule: `mode` and the
   * two arrays only mean something together, and class-validator cannot express
   * a cross-field rule without a custom decorator that would be harder to read
   * than this.
   *
   * The "exactly one per side" check is the ONLY thing standing between today's
   * 2-side battles and the multi-host future — sides are rows, so relaxing this
   * method (plus new enum values) is the whole change.
   */
  assertParticipantsDistinct(dto: CreatePKInvitationDto): void {
    const overlap = dto.red.some((u) => dto.blue.includes(u));
    const dupRed = new Set(dto.red).size !== dto.red.length;
    const dupBlue = new Set(dto.blue).size !== dto.blue.length;
    if (overlap || dupRed || dupBlue) {
      throw new PKBattleException(
        'Participants must be distinct and cannot appear on both sides.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.mode === VideoRoomPkMode.ONE_VS_ONE && (dto.red.length !== 1 || dto.blue.length !== 1)) {
      throw new PKBattleException(
        'A 1v1 battle needs exactly one participant per side.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-validation.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 13: Scoring service (in-transaction)

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-scoring.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-scoring.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomPkRepository` (Task 7), `VideoRoomPkScoreEngine` (Task 11), `CacheService`, `REDIS_CLIENT`, `ConfigService`
- Produces: `VideoRoomPkScoringService` with
  - `apply(tx: Prisma.TransactionClient, input: PkScoringInput): Promise<PkScoringResult>` where
    `PkScoringInput = { roomId, senderId, receiverIds: string[], totalCoinValue: number, giftTxnId: string, batchId?: string }`
    `PkScoringResult = { battleId: string | null; applied: number; events: DomainEvent<unknown>[]; mirror: { battleId: string; teams: PkTeamView[]; giftCount: number; baseTotal: number } | null }`
  - `mirror(m): Promise<void>` — post-commit Redis write
  - `shouldEmit(battleId): Promise<boolean>` — throttle gate
  - `reverse(tx, input): Promise<void>` — compensating negative contribution (§6.5)

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkScoringService.apply', () => {
  it('is inert when the room has no LIVE battle', async () => {
    const repo = mockRepo({ findLive: null });
    const svc = build(repo);
    const out = await svc.apply(tx(), input());
    expect(out.battleId).toBeNull();
    expect(out.applied).toBe(0);
    expect(repo.addContribution).not.toHaveBeenCalled();
  });

  it('does not score a PAUSED battle', async () => {
    // findLive filters to LIVE, so a PAUSED battle simply is not found.
    const repo = mockRepo({ findLive: null });
    expect((await build(repo).apply(tx(), input())).applied).toBe(0);
  });

  it('ignores receivers who are not participants', async () => {
    const repo = mockRepo({ findLive: battle(), participants: [] });
    expect((await build(repo).apply(tx(), input())).applied).toBe(0);
  });

  // perReceiver = total / receivers, per gift.service.ts:196-200.
  it('splits a multi-receiver send evenly and scores BOTH sides', async () => {
    const repo = mockRepo({
      findLive: battle(),
      participants: [
        { id: 'p1', userId: 'u1', teamId: 't-red', side: 'RED', score: 0n },
        { id: 'p2', userId: 'u2', teamId: 't-blue', side: 'BLUE', score: 0n },
      ],
      teams: [
        { id: 't-red', side: 'RED', score: 0n },
        { id: 't-blue', side: 'BLUE', score: 0n },
      ],
    });
    const svc = build(repo);

    await svc.apply(tx(), { ...input(), receiverIds: ['u1', 'u2'], totalCoinValue: 200 });

    expect(repo.addTeamScore).toHaveBeenCalledWith('t-red', 0n, 100n, expect.anything());
    expect(repo.addTeamScore).toHaveBeenCalledWith('t-blue', 0n, 100n, expect.anything());
  });

  it('stores baseAmount and scoredAmount separately when a multiplier applies', async () => {
    const repo = mockRepo({ /* one RED participant */ });
    const svc = build(repo, { multiplierBps: 20_000 });

    await svc.apply(tx(), { ...input(), totalCoinValue: 100 });

    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ baseAmount: 100n, multiplierBps: 20_000, scoredAmount: 200n }),
      expect.anything(),
    );
  });

  it('retries the CAS when a concurrent writer moves the score', async () => {
    const repo = mockRepo({ /* one participant */ });
    repo.addTeamScore.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 't-red', score: 150n });
    repo.getTeam.mockResolvedValue({ id: 't-red', score: 50n });

    await build(repo).apply(tx(), input());

    expect(repo.addTeamScore).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry ceiling without failing the gift', async () => {
    const repo = mockRepo({ /* one participant */ });
    repo.addTeamScore.mockResolvedValue(null);
    repo.getTeam.mockResolvedValue({ id: 't-red', score: 50n });

    await expect(build(repo).apply(tx(), input())).resolves.toBeDefined();
  });

  it('emits one PkScoreUpdatedEvent per scored receiver', async () => {
    const out = await build(mockRepo({ /* one participant */ })).apply(tx(), input());
    expect(out.events).toHaveLength(1);
    expect(out.events[0].name).toBe(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED);
  });

  it('writes no Redis, queue or socket calls inside apply', async () => {
    const cache = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
    await build(mockRepo({ /* one participant */ }), { cache }).apply(tx(), input());
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('reverse writes a negative contribution with a :reversal txn id', async () => {
    const repo = mockRepo({ /* one participant */ });
    await build(repo).reverse(tx(), { ...input(), giftTxnId: 'txn-1' });
    expect(repo.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ giftTxnId: 'txn-1:reversal', baseAmount: -100n }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-scoring.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
/** Bounded CAS retries. Losing three times in one gift means extreme contention. */
const MAX_CAS_RETRIES = 3;

/**
 * Raises PK score from inside the gift transaction (VR-12 spec §6).
 *
 * Postgres-only by contract: no Redis, no queue, no sockets here. The mirror and
 * the broadcast are deferred to postCommit, driven by what this returns — which
 * is why a PK failure can never roll back a paid gift, and why a rolled-back
 * gift can never leave score behind.
 *
 * Scoring is a LEDGER, not an escrow: nothing here debits or credits a wallet.
 */
@Injectable()
export class VideoRoomPkScoringService {
  async apply(tx: Prisma.TransactionClient, input: PkScoringInput): Promise<PkScoringResult> {
    const idle: PkScoringResult = { battleId: null, applied: 0, events: [], mirror: null };
    if (input.totalCoinValue <= 0 || input.receiverIds.length === 0) return idle;

    // Only a LIVE battle scores. COUNTDOWN and PAUSED are silent no-ops: the
    // gift still succeeds, it just does not count — a gift while the clock is
    // frozen would create score with no time running against it.
    const battle = await this.repo.findLive(input.roomId, tx);
    if (!battle) return idle;

    // Each receiver gets a WHOLE gift (gift.service.ts:196-200), so the per-leg
    // value is the exact quotient, never a remainder-bearing split.
    const perReceiver = Math.floor(input.totalCoinValue / input.receiverIds.length);
    if (perReceiver <= 0) return idle;

    const participants = await this.repo.findParticipantsByUserIds(
      battle.id, input.receiverIds, tx,
    );
    if (participants.length === 0) return idle;

    const snapshot = battle.scoringSnapshot as unknown as PkScoringSnapshot;
    const events: DomainEvent<unknown>[] = [];
    let applied = 0;

    for (const participant of participants) {
      const multiplierBps = await this.engine.resolve({
        roomId: input.roomId, battleId: battle.id, senderId: input.senderId,
        receiverId: participant.userId, baseAmount: perReceiver, snapshot, db: tx,
      });
      const base = BigInt(perReceiver);
      const scored = (base * BigInt(multiplierBps)) / BigInt(PK_MULTIPLIER_BASE_BPS);

      const team = await this.casTeam(tx, participant.teamId, scored);
      if (!team) continue; // contention beyond retries; the next gift carries it
      await this.casParticipant(tx, participant.id, participant.score, scored);

      await this.repo.addContribution({
        battleId: battle.id, roomId: input.roomId, teamId: participant.teamId,
        participantId: participant.id, side: participant.side,
        senderId: input.senderId, receiverId: participant.userId,
        baseAmount: base, multiplierBps, scoredAmount: scored,
        giftTxnId: input.giftTxnId, batchId: input.batchId ?? null,
      }, tx);

      applied += Number(scored);
      events.push(new PkScoreUpdatedEvent({ /* roomId, battleId, side, teams, … */ }));
    }

    const teams = await this.repo.listTeams(battle.id, tx);
    return {
      battleId: battle.id, applied, events,
      mirror: { battleId: battle.id, teams: toTeamViews(teams), /* … */ },
    };
  }
```

`casTeam` re-reads on a lost CAS and retries up to `MAX_CAS_RETRIES`, exactly like VR-11's `applyToBox`. `mirror`, `shouldEmit` and `reverse` follow the treasure service's equivalents.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-scoring.service.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 14: Wire scoring into the gift seam

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-gift-context.handler.ts`
- Modify: `src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-pk-reversal.listener.ts`
- Create: `src/modules/video-rooms/listeners/video-room-pk-reversal.listener.spec.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`

**Interfaces:**
- Consumes: `VideoRoomPkScoringService.apply` / `mirror` / `shouldEmit` / `reverse` (Task 13); `GIFT_EVENTS.REFUNDED` from the gifts module
- Produces: `VideoRoomPkReversalListener`. `onSend` now returns PK events merged with treasure events, and a `postCommit` that runs both.

> **Why the reversal listener lives here.** Task 13 produces `VideoRoomPkScoringService.reverse()`, and a plan that stopped there would ship a fully unit-tested method that **nothing ever calls** — precisely the failure mode Task 24's wiring gate exists to catch, and exactly what Phase 9's audit found three times over. The refund path is the only consumer, so it is wired in the same task that wires the send path.

- [ ] **Step 1: Write the failing test**

Add to `video-room-gift-context.handler.spec.ts`:

```ts
it('merges PK events with treasure events', async () => {
  pkScoring.apply.mockResolvedValue({
    battleId: 'b1', applied: 100,
    events: [new PkScoreUpdatedEvent({ roomId: 'r1', battleId: 'b1' } as never)],
    mirror: { battleId: 'b1', teams: [], giftCount: 1, baseTotal: 100 },
  });
  treasureProgress.apply.mockResolvedValue({ sessionId: null, events: [], /* … */ });

  const effects = await handler.onSend(tx, ctx());

  expect(effects.events).toHaveLength(1);
  expect(effects.events[0].name).toBe(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED);
});

// The whole point of the seam: PK must not be able to fail a paid gift.
it('still returns the gift as accepted when PK scoring throws', async () => {
  pkScoring.apply.mockRejectedValue(new Error('pk exploded'));

  const effects = await handler.onSend(tx, ctx());

  expect(effects.acceptedAmount).toBe(ctx().totalCoinValue);
  expect(effects.refundAmount).toBe(0);
});

it('mirrors PK score only after commit', async () => {
  pkScoring.apply.mockResolvedValue({
    battleId: 'b1', applied: 100, events: [],
    mirror: { battleId: 'b1', teams: [], giftCount: 1, baseTotal: 100 },
  });

  const effects = await handler.onSend(tx, ctx());
  expect(pkScoring.mirror).not.toHaveBeenCalled();   // not during onSend

  await effects.postCommit?.();
  expect(pkScoring.mirror).toHaveBeenCalledTimes(1); // only after commit
});

it('throttles the score broadcast', async () => {
  pkScoring.shouldEmit.mockResolvedValue(false);
  pkScoring.apply.mockResolvedValue({
    battleId: 'b1', applied: 10,
    events: [new PkScoreUpdatedEvent({} as never)], mirror: null,
  });

  expect((await handler.onSend(tx, ctx())).events).toHaveLength(0);
});

it('does not let a treasure failure suppress PK scoring', async () => {
  treasureProgress.apply.mockRejectedValue(new Error('treasure down'));
  pkScoring.apply.mockResolvedValue({
    battleId: 'b1', applied: 10,
    events: [new PkScoreUpdatedEvent({} as never)], mirror: null,
  });

  expect((await handler.onSend(tx, ctx())).events.length).toBeGreaterThan(0);
});
```

And in a new `src/modules/video-rooms/listeners/video-room-pk-reversal.listener.spec.ts`:

```ts
// Spec §6.5. Without this listener, VideoRoomPkScoringService.reverse() exists
// and is unit-tested but is never called by anything — a refunded gift would
// keep its PK score forever.
describe('VideoRoomPkReversalListener', () => {
  it('compensates PK score when a video-room gift is refunded', async () => {
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, {
      contextType: GiftContextType.VIDEO_ROOM, contextId: 'r1',
      receiverId: 'u1', transactionId: 'txn-1', totalCoinValue: 100,
    });
    expect(pkScoring.reverse).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ giftTxnId: 'txn-1' }),
    );
  });

  it('ignores refunds from other gift contexts', async () => {
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, { contextType: GiftContextType.AUDIO_ROOM });
    expect(pkScoring.reverse).not.toHaveBeenCalled();
  });

  // Post-settlement refunds are NOT unwound (spec §6.5). Rewards are paid;
  // retroactively rewriting a finished battle's winner would be worse.
  it('records an anomaly instead of unwinding a COMPLETED battle', async () => {
    repo.findCurrent.mockResolvedValue(null);   // no non-terminal battle
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, {
      contextType: GiftContextType.VIDEO_ROOM, contextId: 'r1', transactionId: 'txn-1',
    });
    expect(pkScoring.reverse).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('txn-1'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts`
Expected: FAIL — `pkScoring` is not a constructor dependency.

- [ ] **Step 3: Wire it in**

Inject `VideoRoomPkScoringService` and restructure `onSend` so each subsystem is independently guarded:

```ts
  /**
   * Treasure contribution (VR-11) and PK scoring (VR-12), both inside the send
   * transaction.
   *
   * Each is guarded SEPARATELY. A single try/catch around both would mean a
   * treasure fault silently stops PK scoring — two unrelated subsystems sharing
   * one failure domain for no reason. Either can degrade to "gift succeeded,
   * nothing counted" without touching the other.
   */
  async onSend(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects> {
    const inert: GiftSendEffects = {
      acceptedAmount: ctx.totalCoinValue, refundAmount: 0, events: [],
    };

    const treasure = await this.applyTreasure(tx, ctx);  // existing body, extracted
    const pk = await this.applyPk(tx, ctx);              // new, guarded the same way

    const pkEvents =
      pk.mirror && (await this.pkScoring.shouldEmit(pk.battleId!)) ? pk.events : [];

    return {
      ...inert,
      events: [...treasure.events, ...pkEvents],
      postCommit: async () => {
        await treasure.postCommit?.();
        if (pk.mirror) await this.pkScoring.mirror(pk.mirror).catch(() => undefined);
      },
    };
  }
```

- [ ] **Step 4: Write the reversal listener**

Create `src/modules/video-rooms/listeners/video-room-pk-reversal.listener.ts`, subscribing to `GIFT_EVENTS.REFUNDED`, filtering to `contextType === VIDEO_ROOM`, and calling `pkScoring.reverse` inside a transaction **only when the room has a non-terminal battle**:

```ts
/**
 * Compensates PK score for a refunded gift (VR-12 spec §6.5).
 *
 * A gift rolled back INSIDE its transaction un-scores itself for free; this
 * listener exists for the other case — a reversal after commit, which needs a
 * compensating negative contribution.
 *
 * Deliberately does NOT unwind a settled battle. Once a battle is COMPLETED the
 * rewards are paid, and retroactively changing the winner would be worse than
 * the inconsistency. Those refunds are logged as an anomaly for an operator and
 * the result stands. Best-effort throughout: a compensation failure must never
 * fail the refund itself.
 */
```

Add it to `src/modules/video-rooms/listeners/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-gift-context.handler.spec.ts src/modules/video-rooms/listeners/video-room-pk-reversal.listener.spec.ts src/modules/video-rooms/video-rooms-gift.integration.spec.ts`
Expected: PASS — all new tests plus every pre-existing handler and gift-integration test.

- [ ] **Step 6: Verify no gift regression**

Run: `npx jest src/modules/gifts src/modules/video-rooms`
Expected: PASS with no new failures versus the Task 1 baseline.

---

## Task 15: Timer service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-timer.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-timer.service.spec.ts`

**Interfaces:**
- Consumes: `QueueService.enqueueDelayed`, `QUEUE_NAMES.GIFT_PROCESSING`, `VIDEO_ROOM_PK_START_JOB`, `VIDEO_ROOM_PK_END_JOB`
- Produces: `VideoRoomPkTimerService` with
  - `scheduleCountdown(battle, now: Date): Promise<void>` — jobId `pk-start:{battleId}`
  - `scheduleEnd(battle, now: Date): Promise<void>` — jobId `pk-end:{battleId}:{resumeSeq}`
  - `cancelEnd(battle): Promise<void>` — removes the pending job
  - `computeResume(battle, now): { endsAt: Date; totalPausedMs: number; resumeSeq: number }`
  - `remainingMs(battle, now): number`
  - `interface PkTimerJob { roomId: string; battleId: string; resumeSeq: number }`

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkTimerService', () => {
  const at = (iso: string) => new Date(iso);

  it('schedules the end job with the resumeSeq in its id', async () => {
    const queue = { enqueueDelayed: jest.fn(), remove: jest.fn() };
    const svc = new VideoRoomPkTimerService(queue as never);

    await svc.scheduleEnd({
      id: 'b1', roomId: 'r1', resumeSeq: 2,
      endsAt: at('2026-07-22T00:05:00Z'),
    } as never, at('2026-07-22T00:00:00Z'));

    expect(queue.enqueueDelayed).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_PK_END_JOB,
      { roomId: 'r1', battleId: 'b1', resumeSeq: 2 },
      300_000,
      expect.objectContaining({ jobId: 'pk-end:b1:2' }),
    );
  });

  // The arithmetic that PAUSE exists for. 60s elapsed of a 300s battle, paused
  // for 120s, must still have 240s left — not 120s.
  it('pushes endsAt forward by exactly the paused duration', () => {
    const svc = new VideoRoomPkTimerService({} as never);
    const out = svc.computeResume(
      {
        id: 'b1', resumeSeq: 0, totalPausedMs: 0,
        endsAt: at('2026-07-22T00:05:00Z'),
        pausedAt: at('2026-07-22T00:01:00Z'),
      } as never,
      at('2026-07-22T00:03:00Z'),
    );

    expect(out.endsAt.toISOString()).toBe('2026-07-22T00:07:00.000Z');
    expect(out.totalPausedMs).toBe(120_000);
    expect(out.resumeSeq).toBe(1);
  });

  it('accumulates across repeated pauses', () => {
    const svc = new VideoRoomPkTimerService({} as never);
    const out = svc.computeResume(
      {
        id: 'b1', resumeSeq: 3, totalPausedMs: 45_000,
        endsAt: at('2026-07-22T00:05:00Z'),
        pausedAt: at('2026-07-22T00:02:00Z'),
      } as never,
      at('2026-07-22T00:02:30Z'),
    );
    expect(out.totalPausedMs).toBe(75_000);
    expect(out.resumeSeq).toBe(4);
  });

  it('never schedules a negative delay', async () => {
    const queue = { enqueueDelayed: jest.fn(), remove: jest.fn() };
    const svc = new VideoRoomPkTimerService(queue as never);

    await svc.scheduleEnd(
      { id: 'b1', roomId: 'r1', resumeSeq: 0, endsAt: at('2026-07-22T00:00:00Z') } as never,
      at('2026-07-22T00:10:00Z'),
    );

    expect(queue.enqueueDelayed).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 0, expect.anything(),
    );
  });

  it('removes the pending end job on pause', async () => {
    const queue = { enqueueDelayed: jest.fn(), remove: jest.fn() };
    await new VideoRoomPkTimerService(queue as never).cancelEnd({
      id: 'b1', resumeSeq: 1,
    } as never);
    expect(queue.remove).toHaveBeenCalledWith(QUEUE_NAMES.GIFT_PROCESSING, 'pk-end:b1:1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-timer.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
  /**
   * Resume arithmetic.
   *
   * `endsAt` moves forward by exactly the paused duration, so a 300-second
   * battle paused for two minutes still has its full remaining time. Bumping
   * `resumeSeq` is what neutralises the job scheduled before the pause: it
   * carries the OLD sequence, and the settlement handler drops any job whose
   * `resumeSeq` no longer matches the row. Without it, a pause/resume cycle
   * would leave a stale job that settles the battle early.
   */
  computeResume(battle: VideoRoomPkBattle, now: Date) {
    const pausedFor = battle.pausedAt ? now.getTime() - battle.pausedAt.getTime() : 0;
    return {
      endsAt: new Date((battle.endsAt?.getTime() ?? now.getTime()) + pausedFor),
      totalPausedMs: battle.totalPausedMs + pausedFor,
      resumeSeq: battle.resumeSeq + 1,
    };
  }

  /** Clamped at 0: BullMQ treats a negative delay as immediate anyway, and an
   *  explicit 0 keeps the intent readable in the queue dashboard. */
  remainingMs(battle: VideoRoomPkBattle, now: Date): number {
    return Math.max(0, (battle.endsAt?.getTime() ?? now.getTime()) - now.getTime());
  }
```

If `QueueService` has no `remove`, add `cancelEnd` using `queue.getQueue(...).remove(jobId)` through the existing public accessor — do not add a method to `QueueService` (shared infra is frozen).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-timer.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 16: Invitation service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-invitation.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-invitation.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomPkInvitationRepository` (Task 8), `VideoRoomPkStateService` (Task 10), `LockService`, `EVENT_BUS`
- Produces: `VideoRoomPkInvitationService` with `send(battle, invitees, inviterId)`, `markDelivered(battleId, userId)`, `accept(actorId, battle)`, `reject(actorId, battle)`, `cancelAll(battleId, reason)`, `retry(battleId, inviteeUserId, inviterId)`, `expireDue(now, take)`

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkInvitationService', () => {
  it('creates one row and one event per invitee', async () => {
    await svc.send(battle(), ['u1', 'u2'], 'owner');
    expect(repo.create).toHaveBeenCalledTimes(2);
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(bus.publish.mock.calls[0][0].name).toBe(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT);
  });

  it('stamps targetRoomId as the current room today', async () => {
    await svc.send(battle({ roomId: 'r1' }), ['u1'], 'owner');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', targetRoomId: 'r1' }), undefined,
    );
  });

  it('markDelivered moves the battle INVITED → PENDING', async () => {
    repo.findActionable.mockResolvedValue({ id: 'i1', status: 'SENT' });
    await svc.markDelivered(battle({ status: VideoRoomPkStatus.INVITED }), 'u1');
    expect(state.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.INVITED, VideoRoomPkStatus.PENDING,
    );
  });

  it('markDelivered is idempotent for an already-PENDING battle', async () => {
    repo.findActionable.mockResolvedValue({ id: 'i1', status: 'DELIVERED' });
    await svc.markDelivered(battle({ status: VideoRoomPkStatus.PENDING }), 'u1');
    expect(state.transition).not.toHaveBeenCalled();
  });

  // Authority is being the named invitee — a row lookup, NOT a permission.
  it('refuses an accept from someone with no invitation', async () => {
    repo.findActionable.mockResolvedValue(null);
    await expect(svc.accept('stranger', battle())).rejects.toThrow(PKInvitationException);
  });

  it('does not advance the battle while another invitee is outstanding', async () => {
    repo.updateStatus.mockResolvedValue({ id: 'i1' });
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.ACCEPTED },
      { id: 'i2', status: VideoRoomPkInvitationStatus.SENT },
    ]);
    await svc.accept('u1', battle());
    expect(state.transition).not.toHaveBeenCalled();
  });

  it('advances to ACCEPTED once nothing is actionable', async () => {
    repo.updateStatus.mockResolvedValue({ id: 'i1' });
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.ACCEPTED },
    ]);
    await svc.accept('u1', battle({ status: VideoRoomPkStatus.PENDING }));
    expect(state.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.PENDING, VideoRoomPkStatus.ACCEPTED,
    );
  });

  it('a double-tapped accept records once', async () => {
    repo.updateStatus.mockResolvedValue(null); // conditional update lost
    await svc.accept('u1', battle());
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('reject cancels the battle when nothing actionable remains', async () => {
    repo.updateStatus.mockResolvedValue({ id: 'i1' });
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.REJECTED },
    ]);
    await svc.reject('u1', battle());
    expect(state.transition).toHaveBeenCalledWith(
      'b1', expect.anything(), VideoRoomPkStatus.CANCELLED, expect.anything(),
    );
  });

  it('retry creates attempt + 1', async () => {
    repo.latestAttempt.mockResolvedValue(1);
    repo.findActionable.mockResolvedValue({ id: 'i1', status: VideoRoomPkInvitationStatus.SENT });
    await svc.retry('b1', 'u1', 'owner');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2 }), undefined,
    );
  });

  // You retry an invitation the client never acknowledged. One it DID
  // acknowledge is simply unanswered — resending would spam the invitee.
  it('refuses to retry a DELIVERED invitation', async () => {
    repo.findActionable.mockResolvedValue({
      id: 'i1', status: VideoRoomPkInvitationStatus.DELIVERED,
    });
    await expect(svc.retry('b1', 'u1', 'owner')).rejects.toThrow(PKInvitationException);
  });

  it('expireDue expires past-TTL rows', async () => {
    repo.findExpired.mockResolvedValue([{ id: 'i1', battleId: 'b1', status: 'SENT' }]);
    await svc.expireDue(new Date(), 50);
    expect(repo.updateStatus).toHaveBeenCalledWith(
      'i1', 'SENT', VideoRoomPkInvitationStatus.EXPIRED, expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-invitation.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

The acceptance rule carries the design weight:

```ts
  /**
   * Accept. Authority is BEING THE NAMED INVITEE — a row lookup, not a
   * permission. `START_PK` is deliberately not consulted: the person accepting a
   * challenge is the opponent, who by definition does not manage this room.
   *
   * The battle only advances to ACCEPTED once NOTHING is still actionable, so a
   * Team PK with three invitees waits for all three. `updateStatus` is
   * conditional, so a double-tapped accept updates once and the second call
   * finds nothing to change.
   */
  async accept(actorId: string, battle: VideoRoomPkBattle): Promise<void> {
    const invitation = await this.repo.findActionable(battle.id, actorId);
    if (!invitation) {
      throw new PKInvitationException(
        'You have no pending invitation for this PK battle.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.repo.updateStatus(
      invitation.id, invitation.status,
      VideoRoomPkInvitationStatus.ACCEPTED, { respondedAt: new Date() },
    );
    if (!updated) return; // lost the race with another accept — already recorded

    await this.bus.publish(new PkInvitationAcceptedEvent({ /* … */ }));

    const outstanding = (await this.repo.listForBattle(battle.id)).filter(
      (i) =>
        i.status === VideoRoomPkInvitationStatus.SENT ||
        i.status === VideoRoomPkInvitationStatus.DELIVERED,
    );
    if (outstanding.length > 0) return;

    await this.state.transition(battle.id, battle.status, VideoRoomPkStatus.ACCEPTED);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-invitation.service.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 17: Lifecycle service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 4, 7, 8, 10, 12, 15, 16; `LockService`, `EVENT_BUS`, `PrismaService` (via repos only)
- Produces: `VideoRoomPkService`. **Every method takes a trailing `requestId?: string`** (the controller passes `@RequestId()` through so the audit listener can correlate):
  `invite(actor, roomId, dto, requestId?)`, `accept(actor, roomId, dto, requestId?)`, `reject(actor, roomId, dto, requestId?)`, `cancel(actor, roomId, requestId?)`, `start(actor, roomId, dto, requestId?)`, `pause(actor, roomId, dto, requestId?)`, `resume(actor, roomId, dto, requestId?)`, `end(actor, roomId, dto, requestId?)` — all returning a `PKResponseDto` view, all serialised under `pkLifecycleLockKey(roomId)`.

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkService', () => {
  it('creates battle, two teams, participants and invitations in one transaction', async () => {
    await svc.invite(owner, 'r1', inviteDto, 'req-1');
    expect(repo.createBattle).toHaveBeenCalledTimes(1);
    expect(repo.createTeams).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ side: VideoRoomPkSide.RED }),
        expect.objectContaining({ side: VideoRoomPkSide.BLUE }),
      ]),
      expect.anything(),
    );
    expect(invitations.send).toHaveBeenCalledTimes(1);
  });

  it('freezes the scoring and reward snapshots at create time', async () => {
    await svc.invite(owner, 'r1', inviteDto, 'req-1');
    expect(repo.createBattle).toHaveBeenCalledWith(
      expect.objectContaining({
        scoringSnapshot: expect.objectContaining({ capBps: 30_000 }),
        rewardSnapshot: expect.objectContaining({ poolBps: 1000 }),
      }),
      expect.anything(),
    );
  });

  // The partial unique index is the real gate; this maps its raw violation to a
  // domain error so the client sees ALREADY_ACTIVE, not a 500.
  it('surfaces the partial-unique violation as DuplicatePKException', async () => {
    repo.createBattle.mockRejectedValue({
      code: 'P2002',
      meta: { target: 'video_room_pk_battles_one_active_per_room' },
    });
    await expect(svc.invite(owner, 'r1', inviteDto)).rejects.toThrow(DuplicatePKException);
  });

  it('emits PkCreatedEvent before any invitation event', async () => {
    await svc.invite(owner, 'r1', inviteDto);
    expect(bus.publish.mock.calls[0][0].name).toBe(VIDEO_ROOM_PK_EVENTS.CREATED);
  });

  it('start requires ACCEPTED and schedules the countdown job', async () => {
    repo.findCurrent.mockResolvedValue({ id: 'b1', status: VideoRoomPkStatus.ACCEPTED });
    await svc.start(owner, 'r1', {});
    expect(state.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.ACCEPTED, VideoRoomPkStatus.COUNTDOWN, expect.anything(),
    );
    expect(timer.scheduleCountdown).toHaveBeenCalled();
  });

  it('start refuses a battle still awaiting acceptance', async () => {
    repo.findCurrent.mockResolvedValue({ id: 'b1', status: VideoRoomPkStatus.PENDING });
    await expect(svc.start(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });

  it('pause cancels the pending end job and stamps pausedAt', async () => {
    repo.findCurrent.mockResolvedValue({ id: 'b1', status: VideoRoomPkStatus.LIVE });
    await svc.pause(owner, 'r1', {});
    expect(timer.cancelEnd).toHaveBeenCalled();
    expect(state.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED,
      expect.objectContaining({ pausedAt: expect.any(Date) }),
    );
  });

  it('pause refuses a COUNTDOWN battle', async () => {
    repo.findCurrent.mockResolvedValue({ id: 'b1', status: VideoRoomPkStatus.COUNTDOWN });
    await expect(svc.pause(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });

  it('resume recomputes endsAt and reschedules with the bumped resumeSeq', async () => {
    repo.findCurrent.mockResolvedValue({
      id: 'b1', status: VideoRoomPkStatus.PAUSED, resumeSeq: 0, totalPausedMs: 0,
      endsAt: new Date('2026-07-22T00:05:00Z'), pausedAt: new Date('2026-07-22T00:01:00Z'),
    });
    timer.computeResume.mockReturnValue({
      endsAt: new Date('2026-07-22T00:07:00Z'), totalPausedMs: 120_000, resumeSeq: 1,
    });
    await svc.resume(owner, 'r1', {});
    expect(state.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.PAUSED, VideoRoomPkStatus.LIVE,
      expect.objectContaining({ resumeSeq: 1, totalPausedMs: 120_000, pausedAt: null }),
    );
    expect(timer.scheduleEnd).toHaveBeenCalled();
  });

  it.each([VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED])(
    'end settles a %s battle', async (status) => {
      repo.findCurrent.mockResolvedValue({ id: 'b1', status });
      await svc.end(owner, 'r1', {});
      expect(settlement.settle).toHaveBeenCalledWith('b1', 'manual');
    },
  );

  it('serialises every command under the room lifecycle lock', async () => {
    await svc.pause(owner, 'r1', {});
    expect(locks.withLock).toHaveBeenCalledWith(
      'video-room:pk:lifecycle:{r1}', expect.any(Function),
    );
  });

  it('rejects a second concurrent pause via the conditional transition', async () => {
    repo.findCurrent.mockResolvedValue({ id: 'b1', status: VideoRoomPkStatus.LIVE });
    state.transition.mockRejectedValue(new PKBattleException('no longer LIVE'));
    await expect(svc.pause(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`invite` freezes both snapshots at creation:

```ts
  /**
   * Create the battle and its invitations.
   *
   * The scoring and reward snapshots are frozen HERE, from config, and never
   * re-read afterwards. An admin retuning multipliers or the pool share mid-
   * battle must not change the rules of a battle already in flight — the same
   * reason VR-11 freezes its level ladder into the session.
   */
  async invite(actor: RoomActor, roomId: string, dto: CreatePKInvitationDto) {
    const cfg = loadVideoRoomPkConfig(this.config);
    await this.validation.assertCanCreate(actor, roomId, dto);

    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const scoringSnapshot: PkScoringSnapshot = {
        strategies: cfg.eventMultiplierEnabled ? ['VIP', 'EVENT'] : ['VIP'],
        vipBonusBpsPerTier: cfg.vipBonusBpsPerTier,
        eventBonusBps: cfg.eventBonusBps,
        capBps: cfg.multiplierCapBps,
      };
      const rewardSnapshot = {
        poolBps: cfg.poolBps, winnerBps: cfg.winnerBps,
        participationBps: cfg.participationBps, bonusBps: cfg.bonusBps,
      };
      // … create battle + teams + participants + invitations in one transaction,
      // mapping P2002 on video_room_pk_battles_one_active_per_room to
      // DuplicatePKException …
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk.service.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 18: Settlement service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-settlement.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-settlement.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 7, 8, 10; `IWalletService`, `ICosmeticsService`, `CacheService`, `QueueService`, `EVENT_BUS`, `VideoRoomsMetrics`
- Produces: `VideoRoomPkSettlementService.settle(battleId, reason): Promise<PkSettlementResult>` where `PkSettlementResult = { settled: boolean; winningTeamId: string | null; isDraw: boolean; poolAmount: number; allocatedAmount: number }`. `settled: false` means it was already settled — a replay, not an error.

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkSettlementService.settle', () => {
  it('exits quietly when the battle is already COMPLETED', async () => {
    const state = { tryTransition: jest.fn().mockResolvedValue(null) };
    const out = await build({ state }).settle('b1', 'timer');
    expect(out.settled).toBe(false);
    expect(rewards.createPool).not.toHaveBeenCalled();
  });

  it('declares the higher-scoring team the winner', async () => { /* winningTeamId = t-red */ });

  it('declares a draw on equal scores', async () => { /* isDraw true, winningTeamId null */ });

  // Sizing on scoredAmount would let a 3x multiplier triple the platform's
  // liability for coins nobody spent.
  it('sizes the pool on BASE contribution, not scored', async () => {
    repo.sumBaseAmount.mockResolvedValue(1000n);   // base
    repo.listTeams.mockResolvedValue([
      { id: 't-red', side: 'RED', score: 3000n },  // scored, 3x
      { id: 't-blue', side: 'BLUE', score: 0n },
    ]);
    await build().settle('b1', 'timer');
    expect(rewards.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAmount: 1000n, poolAmount: 100n }), // 10% of BASE
      expect.anything(),
    );
  });

  it('mints no winner slice on a draw', async () => {
    // pool 100, winnerBps 6000 -> the 60 is NOT minted and NOT redistributed
    const out = await build({ draw: true }).settle('b1', 'timer');
    expect(out.allocatedAmount).toBe(40);
  });

  it('leaves integer-division dust unminted', async () => {
    // winner share 10 across 3 winners -> 3 each, 1 left unminted
    const out = await build({ winners: 3, winnerShare: 10 }).settle('b1', 'timer');
    expect(out.poolAmount - out.allocatedAmount).toBeGreaterThan(0);
  });

  it('credits each recipient with a per-kind idempotency key', async () => {
    await build().settle('b1', 'timer');
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: WalletTxnReason.PK_REWARD,
        idempotencyKey: 'pk:b1:u1:WINNER',
      }),
      expect.anything(),
    );
  });

  // Two guards, independently: our table AND the wallet.
  it('skips the wallet credit when the reward row already exists', async () => {
    rewards.createReward.mockResolvedValue(null);   // P2002 = already paid
    await build().settle('b1', 'timer');
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('is idempotent end to end — settling twice pays once', async () => {
    const svc = build();
    await svc.settle('b1', 'timer');
    rewards.createPool.mockResolvedValue({ pool: existingPool, created: false });
    rewards.createReward.mockResolvedValue(null);
    await svc.settle('b1', 'timer');
    expect(wallet.credit).toHaveBeenCalledTimes(2); // once per recipient, first pass only
  });

  it('prefixes the badge grantKey with video-pk to avoid the audio namespace', async () => {
    await build().settle('b1', 'timer');
    expect(cosmetics.grantToUser).toHaveBeenCalledWith(
      expect.objectContaining({ grantKey: 'video-pk:b1:u1' }),
    );
  });

  it('emits PkEndedEvent, PkWinnerDeclaredEvent then PkRewardDistributedEvent', async () => {
    await build().settle('b1', 'timer');
    expect(bus.publish.mock.calls.map((c) => c[0].name)).toEqual([
      VIDEO_ROOM_PK_EVENTS.ENDED,
      VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED,
      VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED,
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-settlement.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
  /**
   * Settle a battle. Safe to call any number of times for the same battle.
   *
   * The CAS transition at the top is the whole replay story: whoever flips
   * LIVE|PAUSED → COMPLETED owns the settlement, everyone else exits with
   * `settled: false`. The pool's `battleId @unique` and the reward rows'
   * `(battleId, userId, kind)` unique are the second and third guards, so even a
   * crash midway through distribution resumes correctly rather than double-paying.
   */
  async settle(battleId: string, reason: string): Promise<PkSettlementResult> {
    const battle = await this.repo.getBattle(battleId);
    if (!battle || isPkTerminal(battle.status)) return notSettled;

    const completed = await this.state.tryTransition(
      battleId, battle.status, VideoRoomPkStatus.COMPLETED,
      { completedAt: new Date() },
    );
    if (!completed) return notSettled;

    const teams = await this.repo.listTeams(battleId);
    const ranked = [...teams].sort((a, b) => Number(b.score - a.score));
    const isDraw = ranked.length > 1 && ranked[0].score === ranked[1].score;
    const winningTeamId = isDraw ? null : (ranked[0]?.id ?? null);

    // BASE, never scored. Multipliers decide who wins; they must not decide how
    // much money exists.
    const sourceAmount = await this.repo.sumBaseAmount(battleId);
    const snapshot = completed.rewardSnapshot as unknown as PkRewardSnapshot;
    const poolAmount = (sourceAmount * BigInt(snapshot.poolBps)) / 10_000n;

    // … createPool, split, per-recipient createReward + wallet.credit inside one
    // transaction, badge grants, events, analytics enqueue, Redis cleanup …
  }
```

Distribution runs inside a single `prisma.$transaction`, and the badge grant plus event publishing happen **after** it commits.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-settlement.service.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 19: Queue job handlers

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-jobs.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-jobs.service.spec.ts`

**Interfaces:**
- Consumes: `QueueJobRegistry`, `VIDEO_ROOM_PK_START_JOB`, `VIDEO_ROOM_PK_END_JOB`, Tasks 10, 15, 18
- Produces: `VideoRoomPkJobsService implements OnModuleInit` registering both job names on `QUEUE_NAMES.GIFT_PROCESSING`, with `handleStart(job: PkTimerJob)` and `handleEnd(job: PkTimerJob)`.

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomPkJobsService', () => {
  it('registers both job names on the gift queue', () => {
    const registry = { register: jest.fn() };
    build(registry).onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_PK_START_JOB, expect.any(Function),
    );
    expect(registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_PK_END_JOB, expect.any(Function),
    );
  });

  it('handleStart moves COUNTDOWN → LIVE and schedules the end job', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'COUNTDOWN', resumeSeq: 0 });
    await build().handleStart({ roomId: 'r1', battleId: 'b1', resumeSeq: 0 });
    expect(state.transition).toHaveBeenCalledWith(
      'b1', VideoRoomPkStatus.COUNTDOWN, VideoRoomPkStatus.LIVE, expect.anything(),
    );
    expect(timer.scheduleEnd).toHaveBeenCalled();
  });

  // THE stale-job test. A job scheduled before a pause carries the old sequence;
  // running it would settle the battle early, mid-pause.
  it('handleEnd ignores a job whose resumeSeq is stale', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'LIVE', resumeSeq: 3 });
    await build().handleEnd({ roomId: 'r1', battleId: 'b1', resumeSeq: 1 });
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('handleEnd settles when the resumeSeq matches', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'LIVE', resumeSeq: 3 });
    await build().handleEnd({ roomId: 'r1', battleId: 'b1', resumeSeq: 3 });
    expect(settlement.settle).toHaveBeenCalledWith('b1', 'timer');
  });

  it('handleEnd is a no-op for a battle that no longer exists', async () => {
    repo.getBattle.mockResolvedValue(null);
    await expect(
      build().handleEnd({ roomId: 'r1', battleId: 'gone', resumeSeq: 0 }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-jobs.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Register both handlers in `onModuleInit` exactly as `VideoRoomTreasureUnlockService` does. `handleEnd` drops any job whose `resumeSeq` differs from the row's — this is the mechanism that makes pause/resume safe against already-scheduled jobs.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-jobs.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 20: Recovery service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-recovery.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-recovery.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 4, 7, 8, 10, 16, 18; `LockService`, `EVENT_BUS`, `VideoRoomsMetrics`
- Produces: `VideoRoomPkRecoveryService implements OnModuleInit, OnModuleDestroy` with `tick(): Promise<void>` and `handleHostDrop(roomId, userId): Promise<void>` / `handleHostReturn(roomId, userId): Promise<void>`.

- [ ] **Step 1: Write the failing test**

One test per recovery condition, plus the gating rules:

```ts
it('settles a non-terminal battle past its endsAt', async () => { /* settle called */ });
it('moves a COUNTDOWN battle past its deadline to LIVE', async () => { /* transition called */ });
it('expires invitations past their TTL', async () => { /* expireDue called */ });
it('cancels the battle when no invitation remains actionable', async () => { /* CANCELLED */ });
it('settles a RECOVERING battle past the orphan timeout', async () => { /* settle called */ });
it('settles a LIVE battle whose room is no longer live', async () => { /* settle called */ });

it('holds the fleet-wide lock so only one pod sweeps', async () => {
  await build().tick();
  expect(locks.acquire).toHaveBeenCalledWith(PK_RECOVERY_LOCK_KEY, expect.any(Number));
});

it('caps the work per sweep', async () => {
  await build({ maxPerSweep: 2 }).tick();
  expect(repo.findStale).toHaveBeenCalledWith(expect.any(Date), expect.any(Array), 2);
});

// The VR-11 lesson: gating the TIMER left the queue-depth metric reporting zero
// forever in the default configuration, which is worse than no metric.
it('still records metrics when recovery ACTIONS are disabled', async () => {
  await build({ recoveryEnabled: false }).tick();
  expect(metrics.setPkActive).toHaveBeenCalled();
  expect(settlement.settle).not.toHaveBeenCalled();
});

it('moves LIVE → RECOVERING when a host drops', async () => { /* transition + pausedAt */ });
it('moves RECOVERING → LIVE when the host returns inside the grace window', async () => { /* … */ });
it('emits PkRecoveredEvent on a successful recovery', async () => { /* … */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-recovery.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
  /**
   * The tick ALWAYS runs; only the recovery ACTIONS are config-gated.
   *
   * VR-11 learned this the hard way: gating the timer itself on
   * `recoveryEnabled` (default false) left the queue-depth gauge reporting zero
   * forever in the default configuration — worse than having no metric, because
   * a zero reads as "healthy". Observability is not opt-in; automatic repair is.
   */
  async tick(): Promise<void> {
    const cfg = loadVideoRoomPkConfig(this.config);
    await this.recordGauges();
    if (!cfg.recoveryEnabled) return;

    const release = await this.locks.acquire(PK_RECOVERY_LOCK_KEY, cfg.monitorIntervalSeconds * 1000);
    if (!release) return;   // another pod owns this sweep
    try {
      await this.sweepExpiredBattles(cfg);
      await this.sweepCountdowns(cfg);
      await this.sweepInvitations(cfg);
      await this.sweepOrphans(cfg);
      await this.sweepDeadRooms(cfg);
    } finally {
      await release();
    }
  }
```

`handleHostDrop` transitions `LIVE → RECOVERING` and stamps `pausedAt`, reusing the pause clock machinery; `handleHostReturn` runs the resume arithmetic through `VideoRoomPkTimerService.computeResume`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-recovery.service.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 21: Query service

**Files:**
- Create: `src/modules/video-rooms/services/video-room-pk-query.service.ts`
- Create: `src/modules/video-rooms/services/video-room-pk-query.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 7, 8; `CacheService`, `VideoRoomPermissionService`, `buildPaginated`
- Produces: `VideoRoomPkQueryService` with `getCurrent(roomId): Promise<PKResponseDto>`, `history(actor, roomId, q): Promise<Paginated<...>>`, `statistics(actor, roomId): Promise<PKStatisticsDto>`

- [ ] **Step 1: Write the failing test**

```ts
it('returns { active: false } when the room has no battle', async () => { /* … */ });

// Late join: the client needs the server's clock to correct its own skew.
it('includes serverTime so a late joiner can correct clock skew', async () => {
  const out = await build().getCurrent('r1');
  expect(out.serverTime).toBeDefined();
  expect(Date.parse(out.serverTime!)).not.toBeNaN();
});

it('reads live scores from the Redis mirror when present', async () => { /* … */ });
it('falls back to Postgres when the mirror is cold', async () => { /* … */ });
it('converts BigInt scores to Number at the boundary', async () => {
  const out = await build().getCurrent('r1');
  expect(typeof out.teams[0].score).toBe('number');
});
it('history returns only terminal battles', async () => { /* … */ });
it('history paginates via buildPaginated', async () => { /* … */ });
it('statistics requires VIEW_ANALYTICS', async () => { /* expects 403 */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-query.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Read the Redis mirror first for live scores, fall back to Postgres on a miss, and always convert `BigInt → Number` at the view boundary. `getCurrent` returns `serverTime: new Date().toISOString()`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-pk-query.service.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit` — clean.

---

## Task 22: REST controller

**Files:**
- Create: `src/modules/video-rooms/controllers/video-rooms-pk.controller.ts`
- Create: `src/modules/video-rooms/controllers/video-rooms-pk.controller.spec.ts`
- Modify: `src/modules/video-rooms/controllers/index.ts`

**Interfaces:**
- Consumes: `VideoRoomPkService` (Task 17), `VideoRoomPkQueryService` (Task 21)
- Produces: `VideoRoomsPkController` on `@Controller('video-rooms')` with the 11 endpoints from spec §11.1.

- [ ] **Step 1: Write the failing test**

```ts
describe('VideoRoomsPkController', () => {
  it('delegates invite to the lifecycle service with a RoomActor', async () => {
    await controller.invite(user, 'room-1', dto, 'req-1');
    expect(lifecycle.invite).toHaveBeenCalledWith(
      { id: user.id, roles: user.roles }, 'room-1', dto, 'req-1',
    );
  });

  // Reads Nest's route metadata off each handler. Declared inline (not imported)
  // so this spec has no helper to keep in sync with the controller.
  const routesOf = (ctrl: object): string[] =>
    Object.getOwnPropertyNames(ctrl.constructor.prototype)
      .filter((m) => m !== 'constructor')
      .map((m) => {
        const handler = (ctrl.constructor.prototype as Record<string, object>)[m];
        const path = Reflect.getMetadata('path', handler) as string | undefined;
        const method = Reflect.getMetadata('method', handler) as number | undefined;
        return path === undefined ? null : `${RequestMethod[method ?? 0]} ${path}`;
      })
      .filter((r): r is string => r !== null);

  it('exposes all 11 routes', () => {
    expect(routesOf(controller)).toEqual(
      expect.arrayContaining([
        'POST :id/pk/invite', 'POST :id/pk/accept', 'POST :id/pk/reject',
        'POST :id/pk/cancel', 'POST :id/pk/start', 'POST :id/pk/pause',
        'POST :id/pk/resume', 'POST :id/pk/end',
        'GET :id/pk', 'GET :id/pk/history', 'GET :id/pk/statistics',
      ]),
    );
  });

  // Authorization belongs in the services, never inline in the controller —
  // the VR-10/VR-11 convention. This test is what stops it drifting back.
  it('performs no authorization inline', () => {
    const src = readFileSync(
      'src/modules/video-rooms/controllers/video-rooms-pk.controller.ts', 'utf8',
    );
    expect(src).not.toMatch(/assertPermission|hasPermission|VideoRoomPermission\./);
  });

  it('parses the room id as a uuid', async () => { /* ParseUuidPipe applied */ });
  it('delegates the read endpoints to the query service', async () => { /* … */ });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-pk.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the controller**

Follow `video-rooms-treasure.controller.ts` exactly: `@ApiTags('video-room-pk')`, `@ApiBearerAuth()`, `@Controller('video-rooms')`, `@NotGuest()` on every mutating route, `@Param('id', ParseUuidPipe)`, `@CurrentUser()`, `@RequestId()`, a private `actor()` helper, and a private `page()` helper for history. Every endpoint gets `@ApiOperation` (summary + which permission it needs), `@ApiParam`, and `@ApiResponse` entries for the success shape plus each error code it can produce.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/video-rooms/controllers/video-rooms-pk.controller.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export from the barrel and verify**

Add to `src/modules/video-rooms/controllers/index.ts`. Run `npx tsc --noEmit` — clean.

---

## Task 23: Listeners and metrics

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-pk-socket.listener.ts` (+ spec)
- Create: `src/modules/video-rooms/listeners/video-room-pk-audit.listener.ts` (+ spec)
- Create: `src/modules/video-rooms/listeners/video-room-pk-metrics.listener.ts` (+ spec)
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts`
- Modify: `src/modules/video-rooms/listeners/index.ts`

**Interfaces:**
- Produces:
  - `VideoRoomPkSocketListener` — subscribes to all 12 domain events, relays 11 to `/video-room`
  - `VideoRoomPkAuditListener` — writes `video_room_logs` rows using the 9 `PK_*` actions
  - `VideoRoomPkMetricsListener` — drives the 9 metric families
  - On `VideoRoomsMetrics`: `setPkActive(n)`, `observePkBattleDuration(s)`, `incPkGiftThroughput()`, `observePkScoreLatency(s)`, `incPkRecovery(reason)`, `incPkInvitationOutcome(outcome)`, `observePkWinnerCalculation(s)`, `observePkRewardDistribution(s)`, `incPkRedisSync(result)`

- [ ] **Step 1: Write the failing tests**

```ts
// socket listener
it('relays all 11 outbound socket events', () => {
  new VideoRoomPkSocketListener(bus, sockets).onModuleInit();
  expect(bus.subscribe).toHaveBeenCalledTimes(11);
});

it('emits to the room channel on the /video-room namespace', () => { /* … */ });

// PkCreatedEvent is audit/metrics only — it fires before anyone is invited, so
// relaying it would tell clients a battle exists that they cannot yet act on.
it('does not relay PkCreatedEvent to sockets', () => {
  const names = bus.subscribe.mock.calls.map((c) => c[0]);
  expect(names).not.toContain(VIDEO_ROOM_PK_EVENTS.CREATED);
});

// audit listener
it('writes one log row per audited action with the battle id', async () => { /* … */ });
it('carries requestId through to the log row', async () => { /* … */ });

// metrics listener
it('drives every one of the 9 metric families', () => { /* one assertion per family */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-pk`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the listeners and metrics**

Add the 9 metric families to `VideoRoomsMetrics` following the existing constructor style (`new Counter({ name: 'video_rooms_pk_...', help: '...', labelNames: [...], registers: [registry] })`). Write the three listeners following `video-room-treasure-*.listener.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-pk src/modules/video-rooms/video-rooms.metrics.spec.ts`
Expected: PASS.

- [ ] **Step 5: Export from the barrel and verify**

Add all three to `src/modules/video-rooms/listeners/index.ts`. Run `npx tsc --noEmit` — clean.

---

## Task 24: Module wiring, wiring gate and final verification

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Modify: `src/modules/video-rooms/services/index.ts`
- Create: `src/modules/video-rooms/video-rooms-pk.integration.spec.ts`

**Interfaces:**
- Consumes: every prior task
- Produces: a booting module and a passing full suite.

- [ ] **Step 1: Write the failing integration test**

Create `src/modules/video-rooms/video-rooms-pk.integration.spec.ts` driving the whole path against mocked infrastructure:

```ts
describe('VR-12 PK integration', () => {
  it('runs invite → accept → start → countdown → gift → end → reward', async () => {
    const battle = await pk.invite(owner, roomId, inviteDto);
    await pk.accept(opponent, roomId, {});
    await pk.start(owner, roomId, {});
    await jobs.handleStart({ roomId, battleId: battle.id, resumeSeq: 0 });

    // Gift flows through the REAL gift-context handler seam.
    const effects = await giftHandler.onSend(tx, giftCtx({ receiverIds: [opponentId] }));
    await effects.postCommit?.();

    await jobs.handleEnd({ roomId, battleId: battle.id, resumeSeq: 0 });

    const rewards = await rewardRepo.listRewards(battle.id);
    expect(rewards.length).toBeGreaterThan(0);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: WalletTxnReason.PK_REWARD }), expect.anything(),
    );
  });

  it('survives a pause/resume without losing time or settling early', async () => { /* … */ });
  it('recovers a battle whose end job never ran', async () => { /* … */ });
  it('scores nothing for a gift sent during COUNTDOWN', async () => { /* … */ });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/video-rooms/video-rooms-pk.integration.spec.ts`
Expected: FAIL — providers not registered.

- [ ] **Step 3: Wire the module**

Register in `video-rooms.module.ts`: the 3 repositories, the 12 services, the 2 strategies, the controller and the **4** listeners (socket, audit, metrics, **reversal**). Export nothing new — PK is consumed only inside this module and over HTTP/sockets. Add every service to `services/index.ts`.

Services to register: `VideoRoomPkStateService`, `VideoRoomPkScoreEngine`, `VideoRoomPkValidationService`, `VideoRoomPkScoringService`, `VideoRoomPkTimerService`, `VideoRoomPkInvitationService`, `VideoRoomPkService`, `VideoRoomPkSettlementService`, `VideoRoomPkJobsService`, `VideoRoomPkRecoveryService`, `VideoRoomPkQueryService` — plus `VipMultiplierStrategy` and `EventMultiplierStrategy`, which self-register with the engine in `onModuleInit`.

- [ ] **Step 4: Run the integration test and the full suite**

Run:
```bash
npx jest src/modules/video-rooms/video-rooms-pk.integration.spec.ts
npx jest
```
Expected: integration PASS; full suite shows **no new failures** versus `docs/superpowers/plans/vr12-baseline.txt` (the 3 known `TreasureService` failures may remain).

- [ ] **Step 5: Run the wiring gate**

Every declared thing must have a real producer or consumer. Phase 9's audit found three metrics that were declared and never called and a config field read nowhere — TDD proves "the code does what you said", not "anything calls the code".

Run each and confirm a **non-test** call site exists for every entry:

```bash
# 1. Every metric method is called outside its own definition and specs
for m in setPkActive observePkBattleDuration incPkGiftThroughput observePkScoreLatency \
         incPkRecovery incPkInvitationOutcome observePkWinnerCalculation \
         observePkRewardDistribution incPkRedisSync; do
  n=$(grep -rn "$m" --include="*.ts" src/ | grep -v spec | grep -vc "video-rooms.metrics.ts")
  echo "$m -> $n"; done

# 2. Every PK error code is actually thrown
grep -o "VIDEO_ROOM_PK_[A-Z_]*" src/common/exceptions/error-codes.ts | sort -u | \
  while read c; do echo "$c -> $(grep -rl "$c" --include="*.ts" src/modules/video-rooms | grep -vc spec)"; done

# 3. Every socket event has a producer
grep -o "'pk[A-Za-z]*'" src/modules/video-rooms/constants/video-room-pk.constants.ts | sort -u | \
  while read e; do echo "$e -> $(grep -rn "$e" --include="*.ts" src/modules/video-rooms/listeners | grep -vc spec)"; done

# 4. Every config field is read somewhere
node -e "const{loadVideoRoomPkConfig}=require('./dist/modules/video-rooms/config/video-room-pk.config');" \
  2>/dev/null || true
for f in enabled countdownSeconds minDurationSeconds maxDurationSeconds defaultDurationSeconds \
         invitationTtlSeconds poolBps winnerBps participationBps bonusBps multiplierCapBps \
         vipBonusBpsPerTier eventBonusBps eventMultiplierEnabled scoreEmitPerSecond \
         recoveryEnabled monitorIntervalSeconds orphanTimeoutSeconds recoveryGraceSeconds \
         maxPerSweep; do
  n=$(grep -rn "cfg\.$f\|config\.$f" --include="*.ts" src/modules/video-rooms | grep -vc spec)
  echo "$f -> $n"; done

# 5. Every repository method is called from a service
for m in findLive findCurrent getBattle createBattle transition createTeams listTeams getTeam \
         createParticipants listParticipants findParticipantsByUserIds getParticipant \
         addTeamScore addParticipantScore addContribution sumBaseAmount countGifts \
         topContributor listBattles findStale; do
  n=$(grep -rn "\.$m(" --include="*.ts" src/modules/video-rooms/services | grep -vc spec)
  echo "$m -> $n"; done

# 5b. The method most likely to be orphaned: reverse() must have a caller
grep -rn "pkScoring.reverse\|\.reverse(" --include="*.ts" \
  src/modules/video-rooms/listeners | grep -v spec

# 6. Zero audio-room mutation
git diff --stat 9d31ece -- src/modules/audio-rooms prisma/schema/audio_rooms_pk.prisma
```

Expected: every count in checks 1–5 is **≥ 1**. Any zero is a real gap — fix it before closing the phase, do not rationalise it.

> Check 6 is the one exception to the no-git rule: `git diff --stat` is a **read-only** inspection that changes nothing. If you prefer to avoid git entirely, substitute a filesystem check that no file under `src/modules/audio-rooms/` has a modification time later than the phase start.

- [ ] **Step 6: Final gates**

Run:
```bash
npx tsc --noEmit

# CHANGED-FILE lint gate (see the Task 1 amendment). Repo-wide lint is NOT clean
# and cannot be made clean without editing directories this phase must not touch.
# VR-12 is accountable for its OWN files only.
npx eslint $(git status --porcelain 2>/dev/null | awk '{print $2}' | grep '\.ts$') --max-warnings 0 \
  || echo "FAIL: VR-12 introduced lint problems"

# Repo-wide count must be UNCHANGED from the Task 1 baseline (123), proving no
# untouched file regressed.
npm run lint 2>&1 | tail -3

npx jest
```
Expected: tsc clean; **zero** lint problems in VR-12's own files; repo-wide lint count still exactly the baseline's 123; and the suite at baseline + ~200 new passing tests with zero new failures.

> If `git status` is unavailable to you, substitute an explicit list of the files VR-12 created or modified — the file-structure table at the top of this plan enumerates every one.

- [ ] **Step 7: Confirm nothing was committed**

Run: `git log --oneline -1`
Expected: `9d31ece feat: implement video room gift engine...` — **unchanged**. All VR-12 work is uncommitted in the working directory. If HEAD has moved, a commit was made in violation of the global constraints; report it rather than resetting.

---

## Deferred / not built (deliberate)

| Item | Why |
|---|---|
| Migration application | Authored only, per the VR-11 posture. Applying it is an ops decision. |
| `pk_timers` / `pk_history` / `pk_analytics` tables | Spec §4.3 — each would be a second copy of state that already exists. |
| Global rankings, rocket events, tournaments, seasonal events, family wars, cross-country | Explicitly out of scope. |
| Multi-host / cross-room PK | Schema and services are shaped for it (spec §12); no code ships this phase. |
| Post-settlement refund unwind | Spec §6.5 — a stated permanent limitation, not a gap. |
