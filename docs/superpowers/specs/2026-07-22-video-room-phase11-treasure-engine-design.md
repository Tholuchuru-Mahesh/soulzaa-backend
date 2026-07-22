# VR-11 — Enterprise Treasure Box Engine (Video Rooms)

**Status:** approved design (Checkpoints A, B, C signed off)
**Date:** 2026-07-22
**Phase:** 11 of the Video Room backend
**Depends on:** VR-10 (gift engine), VR-7 (RBAC), VR-6 (viewer mode), VR-3 (membership), AR-6 (`treasure-boxes` — reused, never modified)

---

## 1. Objective

A configurable, sequential Treasure Box ladder for Video Rooms. Gift value in a room
raises a progress counter; when a level's threshold is crossed the box unlocks, a
reward pool is minted, winners are drawn from eligible participants, rewards are
credited to wallets, and the next box begins — automatically, atomically, and
recoverably.

### Out of scope (explicit)

- PK battles, rankings, rocket events, seasonal events, moderation, analytics
  dashboards, family rewards.
- **Any change to audio rooms, `src/modules/treasure-boxes/`, or `TreasureBoxConfig`.**
- Mobile / Flutter work.

---

## 2. What already exists (reuse map)

| Asset | Location | Used for |
|---|---|---|
| `IGiftContextHandler.onSend` | `gifts/interfaces/gift-context-handler.interface.ts` | The only integration seam. VR-10 left it unimplemented for video. |
| `RewardDistributor` | `treasure-boxes/services/reward-distributor.service.ts` | Idempotent wallet + backpack grants. Reused **as-is**, not modified. |
| `QueueJobRegistry` | `infra/queue/workers/queue-job.registry.ts` | Registers `treasure.unlock` on the shared gift queue. VR-10 infra. |
| `LockService` / `CacheService` | `infra/redis/` | Per-room unlock ordering; progress mirror; throttle stamps. |
| `VideoRoomPresenceService` | `video-rooms/services/` | Redis role SETs — the candidate source for the draw. |
| `VideoRoomEventsRepository` | `video-rooms/repositories/` | `VideoRoomEvent.eventType` is an open string ⇒ audit with zero schema change. |
| `VideoRoomsMetrics` | `video-rooms/video-rooms.metrics.ts` | Event-driven metrics (VR-9/VR-10 pattern). |
| `VideoRoomPermissionService` + code matrix | `video-rooms/constants/video-room-permissions.ts` | RBAC; matrix is code, not data. |
| `video_room_settings.allowTreasure` | `prisma/schema/video_rooms.prisma:199` | Per-room toggle. Already exists. |
| `TreasureSession` / `TreasureBox` / `TreasureContribution` / `TreasureReward` | `prisma/schema/treasure_boxes.prisma` | Shared, room-scoped tables. Safe to share (§12). |

---

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Progress is a counter, not an escrow.** Gift coins are never consumed by treasure. | VR-10 already pays the receiver creator earnings. Escrowing would double-spend. |
| D2 | **Reward pool is minted by the platform at unlock**, default 10% of the level threshold. | Funded from the platform's residual share of gift revenue. |
| D3 | **Default winner algorithm is `RANDOM` over eligible participants.** | Per brief. Rewards presence, which is what makes eligibility rules load-bearing. |
| D4 | **Lifecycle is manual and owner-driven.** No daily auto-reset. | Matches the REST surface; owners schedule giveaways. |
| D5 | **Eligibility = live Redis presence at unlock, filtered in Postgres.** | `SRANDMEMBER` oversample scales; ban/stay/activity live in Postgres. |
| D6 | **Lean schema.** Video owns its own level table; shared tables gain only additive columns. | §12 proves audio is untouched. |
| D7 | **`ACTIVE → UNLOCKING` conditional update is the concurrency primitive.** | No distributed lock needed; Postgres row lock is sufficient and cheaper. |
| D8 | **Combo unlocks chain, never fan out.** | Deterministic ordering of payouts, broadcasts and animations. |
| D9 | **Config is frozen into the session at create time.** | An admin editing levels cannot change the rules of a running ladder. |
| D10 | **The video engine never writes `RoomContributionCounter` / `UserContributionCounter`.** | `UserContributionCounter` is keyed by `userId` alone; writing it would change totals displayed inside audio rooms. |

---

## 4. Architecture

All new code lives under `src/modules/video-rooms/`. This mirrors the VR-10 split:
the shared module keeps the shared economy, the video module owns its context.

```
video-rooms/
  services/
    video-room-treasure.service.ts              lifecycle commands (RBAC-gated)
    video-room-treasure-progress.service.ts     counter + cascade + claim
    video-room-treasure-unlock.service.ts       queue-driven unlock pipeline
    video-room-treasure-pool.service.ts         pool strategies
    video-room-treasure-winner.service.ts       winner strategy registry
    video-room-treasure-eligibility.service.ts  Redis oversample -> PG filter
    video-room-treasure-query.service.ts        status / history / winners / statistics
    video-room-treasure-recovery.service.ts     DLQ replay + orphan reconciliation
    video-room-gift-context.handler.ts          MODIFIED: gains onSend
  repositories/
    video-room-treasure.repository.ts           sessions, boxes, contributions, levels
    video-room-treasure-reward.repository.ts    pools, winners, reward rows
  config/video-room-treasure.config.ts
  constants/video-room-treasure.constants.ts
  events/video-room-treasure.events.ts
  listeners/video-room-treasure-socket.listener.ts
  listeners/video-room-treasure-metrics.listener.ts
  listeners/video-room-treasure-audit.listener.ts
  controllers/video-rooms-treasure.controller.ts
  dto/video-room-treasure.dto.ts
  exceptions/video-room-treasure.exceptions.ts
  interfaces/video-room-treasure.interfaces.ts
```

**Exactly one existing file is modified in the entire phase:**
`video-room-gift-context.handler.ts`, which gains `onSend` and drops its
`// no treasure box this phase` comment.

---

## 5. Storage

### 5.1 New tables (video-owned)

```prisma
/// The video-room treasure ladder config. Deliberately NOT TreasureBoxConfig:
/// that table is globally keyed by `level @unique` and is read unfiltered by the
/// audio engine, so adding video rows there would corrupt audio thresholds (§12).
model VideoRoomTreasureLevel {
  id                String   @id @default(uuid()) @db.Uuid
  level             Int      @unique
  threshold         BigInt
  enabled           Boolean  @default(true)
  poolStrategy      String   @default("PERCENTAGE")   // PERCENTAGE | FIXED | ADMIN_OVERRIDE
  poolPercentBps    Int      @default(1000)           // 10%
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

/// 1:1 extension of TreasureSession for video-only state. `levelSnapshot` freezes
/// the entire ladder (thresholds, pool params, winner params, eligibility rules,
/// algorithmVersion) at create time, so admin edits cannot change a running
/// session's rules (D9).
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

/// The minted pool for one unlocked box. `boxId @unique` makes a replayed unlock
/// job fail closed at the database rather than mint twice.
model TreasureRewardPool {
  id               String   @id @default(uuid()) @db.Uuid
  boxId            String   @unique @db.Uuid
  sessionId        String   @db.Uuid
  roomId           String   @db.Uuid
  level            Int
  strategy         String
  sourceAmount     BigInt                       // threshold the pool derives from
  poolAmount       BigInt                       // minted
  allocatedAmount  BigInt   @default(0)         // sum paid; dust = pool - allocated
  winnerCount      Int                          // winners ACTUALLY drawn, not configured
  algorithm        String
  algorithmVersion Int      @default(1)
  selectionSeed    String                       // draw reproducible from (algo, ver, seed, candidates)
  computedAt       DateTime @default(now())
  @@index([roomId])
  @@index([sessionId])
  @@map("treasure_reward_pools")
}

/// One winner of one box. The unique constraint is the primary duplicate-reward
/// defence and lives on a video-owned table, never on a shared one.
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

### 5.2 Additive changes to shared enums / tables

```prisma
enum TreasureSessionStatus { ACTIVE COMPLETED CANCELLED  DRAFT PAUSED CLOSED ARCHIVED }
enum TreasureBoxStatus     { PENDING ACTIVE OPENED  UNLOCKING }

model TreasureReward {
  // ... existing columns unchanged ...
  status        TreasureRewardStatus @default(DISTRIBUTED)   // default keeps audio rows correct
  attempts      Int                  @default(0)
  lastError     String?
  failureStage  String?                                       // see §6.4
  distributedAt DateTime?
}
enum TreasureRewardStatus { PENDING DISTRIBUTED FAILED }
```

**No unique constraint is added to `TreasureReward`.** `RewardDistributor` legitimately
emits multiple rows for one `(boxId, userId)` when a rank is configured with both
coins and an item; constraining it would crash audio box-opens inside a gift
transaction (§12).

### 5.3 Redis keys (all `video-room:` namespaced)

| Key | Type | Purpose |
|---|---|---|
| `vr:treasure:progress:{roomId}` | HASH | level → progress mirror for fast reads |
| `vr:treasure:level:{roomId}` | STRING | current level |
| `vr:treasure:activity:{roomId}:{sessionId}` | HASH | per-user activity counter (eligibility) |
| `vr:treasure:emit:{roomId}` | STRING (TTL) | progress-broadcast throttle stamp |
| `vr:treasure:unlock:{roomId}` | lock | per-room unlock ordering |
| `vr:treasure:stats:{roomId}:{sessionId}` | HASH | temporary statistics |

Postgres remains **authoritative** for progress; Redis is a read-through mirror.

---

## 6. The engine

### 6.0 Session lifecycle (normative)

```
          POST /            POST /start         threshold L4 unlocked
   (none) --------> DRAFT -------------> ACTIVE ---------------------> COMPLETED
                      |                  |    ^                              |
                      |          /pause  |    | /resume                      |
                      |                  v    |                              |
                      |                PAUSED -                              |
                      |                  |                                   |
                      |  /close          | /close                            |
                      +--------------+---+                                   |
                                     v                                       |
                                  CLOSED <---------------------------------- +
                                     |            /archive
                                     +----------------------> ARCHIVED
```

| State | Contributions counted? | Meaning |
|---|---|---|
| `DRAFT` | no | Ladder created, not yet started. |
| `ACTIVE` | **yes** | Accumulating into `currentLevel`. |
| `PAUSED` | no | Intake stopped by owner; in-flight `UNLOCKING` boxes still complete. |
| `COMPLETED` | no | Final level unlocked — the ladder finished naturally. |
| `CLOSED` | no | Ended early by owner; remaining boxes never unlock, nothing is minted. |
| `ARCHIVED` | no | Hidden from `GET /`; still readable via `/history` and `/winners`. |

`COMPLETED` and `CLOSED` are deliberately distinct: `COMPLETED` means the ladder ran to
its end, `CLOSED` means an owner stopped it. Conflating them would make "how many
ladders actually finished?" unanswerable from the data.

**Guards:**
- `POST /` when a session in `DRAFT`/`ACTIVE`/`PAUSED` exists → `VIDEO_ROOM_TREASURE_ALREADY_ACTIVE`.
- `POST /` when `video_room_settings.allowTreasure = false` → `VIDEO_ROOM_TREASURE_DISABLED`.
- `POST /start` from any state but `DRAFT`, `/pause` from any but `ACTIVE`, `/resume`
  from any but `PAUSED`, `/archive` from any but `COMPLETED`/`CLOSED` → `TreasureBoxException`.
- Every transition is a conditional `UPDATE … WHERE status = $expected`, so two
  concurrent owner actions cannot both succeed.

### 6.1 Transaction boundaries (normative)

`GiftSendEffects` requires `onSend` to be Postgres-only, with non-Postgres work
returned as `events` or `postCommit`.

| Stage | Where | Work |
|---|---|---|
| `onSend(tx, ctx)` | inside the gift transaction | increment counter, write `TreasureContribution`, claim crossed boxes |
| returned `events` | after commit | `treasureProgressUpdated` |
| returned `postCommit` | after commit | enqueue **one** `treasure.unlock` job |
| unlock job | BullMQ worker | pool → eligibility → winners → distribute → broadcast → chain |

`onSend` performs **no wallet operations**. A treasure failure can never roll back a
paid gift, and VR-10's <100 ms send budget is preserved.

`contextLockKeys` stays **absent** for video: the Postgres row lock taken by the
progress `UPDATE` is sufficient. Only VR-10's wallet locks are acquired.

### 6.2 The claim (D7)

```sql
UPDATE treasure_boxes SET progress = progress + $applied
 WHERE id = $id AND progress = $observed        -- optimistic; re-read and retry on 0 rows
RETURNING progress;

UPDATE treasure_boxes SET status = 'UNLOCKING'
 WHERE id = $id AND status = 'ACTIVE';          -- exactly one transaction gets rowcount 1
```

N concurrent gifts may all push progress past the threshold; exactly one receives
`rowcount = 1` and is therefore the unique enqueuer. No dedupe logic, no distributed
lock, no race window.

### 6.3 Combo gifts — chaining (D8)

The cascade arithmetic runs inside `onSend`; unlock work is chained one box at a time.

```
onSend: remaining = 400,000 into a fresh ladder
  L1 needs  15,000 -> apply, claim UNLOCKING, remaining 385,000
  L2 needs  60,000 -> apply, claim UNLOCKING, remaining 325,000
  L3 needs 200,000 -> apply, claim UNLOCKING, remaining 125,000
  L4 needs 350,000 -> apply 125,000 (partial), remaining 0
postCommit: enqueue unlock(L1) ONLY
  unlock(L1) -> step 9 sees L2 claimed -> enqueue unlock(L2)
  unlock(L2) -> enqueue unlock(L3)
  unlock(L3) -> L4 below threshold, stop
```

Step 9 is the sole enqueue path after the first job, so ordering is guaranteed by
causality rather than by BullMQ delivery order. Overflow past the final level simply
stops counting — nothing is escrowed, so there is nothing to refund.

### 6.4 The unlock pipeline

```
withLock(vr:treasure:unlock:{roomId}):
  1 VALIDATE          box.status === OPENED -> replay, return {replayed:true}
                      box.status !== UNLOCKING -> TreasureUnlockException
                      room exists; session is ACTIVE or PAUSED
                      (PAUSED passes deliberately: the box was claimed before the
                       pause, so its winners are already owed -- see 6.7)
  2 POOL              pure arithmetic from session levelSnapshot
  3 ELIGIBILITY       Redis SRANDMEMBER oversample -> Postgres filter   (pre-transaction)
  4 WINNER_SELECTION  strategy.select(candidates, contributions, seed)  (pre-transaction)
  5 DISTRIBUTION  --- ONE POSTGRES TRANSACTION ---------------------------
        INSERT TreasureRewardPool        (boxId @unique      -> replay-safe)
        INSERT TreasureWinner[]          (@@unique(boxId,userId) -> replay-safe)
        INSERT TreasureReward[]          status = PENDING
        RewardDistributor.distribute(tx, prefix = `vr-treasure:${boxId}`)
        UPDATE TreasureReward            status = DISTRIBUTED, distributedAt
        UPDATE TreasureRewardPool        allocatedAmount
        UPDATE TreasureBox               status = OPENED, openedAt
        UPDATE TreasureSession           currentLevel++ | status = COMPLETED
      ----------------------------------------------------------------------
  6 BROADCAST         publish events post-commit -> socket listener
  7 AUDIT             VideoRoomEvent rows, one correlationId
  8 ANALYTICS         Redis stat counters + metrics
  9 CHAIN             next box already >= threshold ? claim + enqueue
catch(err) -> persist attempts, lastError, failureStage; rethrow -> BullMQ retry -> DLQ
```

Steps 3–4 are deliberately **outside** the transaction: holding a Postgres transaction
open across a Redis round-trip exhausts the connection pool under load. The eligibility
result is snapshotted into the transaction, and the unique constraints make a retry
that re-draws different winners fail closed rather than double-pay.

**`failureStage`** is one of `VALIDATE | POOL | ELIGIBILITY | WINNER_SELECTION |
DISTRIBUTION | BROADCAST | CHAIN | RECOVERY`, persisted on the reward row, attached to
`TreasureUnlockFailedEvent`, and emitted as a metric label — so an operator attributes
a failure without reading code.

### 6.5 Strategies

| Pool strategy | Formula |
|---|---|
| `PERCENTAGE` *(default, 1000 bps)* | `floor(threshold × bps / 10000)` — L1 → 1,500 |
| `FIXED` | `poolFixedAmount` |
| `ADMIN_OVERRIDE` | value supplied at create, frozen into `levelSnapshot` |

| Winner algorithm | Selection |
|---|---|
| `RANDOM` *(default)* | uniform over eligible |
| `WEIGHTED_RANDOM` | weight ∝ contribution to that box |
| `ACTIVITY_BASED` | weight ∝ activity events this session |
| `CONTRIBUTION_BASED` | top-N contributors (audio parity) |
| `VIP_PRIORITY` | VIP tier multiplier on weight |

Registered in a `WinnerSelectionRegistry` keyed by algorithm — the `GiftContextRegistry`
shape. A sixth algorithm is a new class plus one `register()` call, never an edit to the
selector. Each strategy declares an `algorithmVersion`; pool rows persist
`(algorithm, algorithmVersion, selectionSeed)` so a historical draw stays reproducible
after a strategy is rewritten.

### 6.6 Eligibility

Oversample `max(3 × winnerCount, 50)` candidates via `SRANDMEMBER` across the viewer,
participant and host presence sets, then filter in Postgres:

- active `video_room_members` row
- no active `VideoRoomBlock`
- `joinedAt <= now() − minStaySeconds`
- `activityEvents >= minActivityEvents` (Redis hash; default 0 ⇒ opt-in)

If fewer than `winnerCount` survive, widen the oversample once, then accept fewer.

### 6.7 Edge cases (normative)

| Case | Behaviour |
|---|---|
| Zero eligible | Box opens; pool row written with `winnerCount: 0`; unlock broadcast with empty winners; **nothing minted**. |
| Fewer eligible than `winnerCount` | Full pool splits evenly among those present; `floor` dust is not minted, derivable as `poolAmount − allocatedAmount`. |
| Session `PAUSED` | Contribution intake stops; an already-claimed `UNLOCKING` box still completes. Winners were claimed before the pause. |
| Session in any non-`ACTIVE` state (`DRAFT`, `PAUSED`, `COMPLETED`, `CLOSED`, `ARCHIVED`), or no session at all | `onSend` is a no-op; the gift proceeds normally and the sender is charged exactly as VR-10 defines. See §6.0. |
| `allowTreasure = false` | `onSend` is a no-op; gift proceeds normally. |
| Overflow past final level | Progress stops counting. No refund (nothing escrowed). |

### 6.8 Recovery

- **DLQ replay** — monitor tick replays dead-lettered `treasure.unlock` jobs, gated by
  `recoveryEnabled` (VR-10 precedent).
- **Orphan reconciliation** — a box `UNLOCKING` longer than `orphanTimeoutSeconds` with
  no `TreasureRewardPool` row means the process died between claim and execution;
  re-enqueue.
- Both emit `TreasureRecoveredEvent` → `treasureRecovered`.

Exactly-once reward semantics are preserved by the `@unique` constraints plus
`RewardDistributor`'s `${prefix}:r${rank}:coins` idempotency keys.

---

## 7. API surface

### REST — base `video-rooms/:id/treasure`, JWT-guarded, fully Swagger-documented

| Method | Path | Guard |
|---|---|---|
| `POST` | `/` — create ladder (DRAFT) | `MANAGE_TREASURE` |
| `POST` | `/start` | `MANAGE_TREASURE` |
| `POST` | `/pause` | `MANAGE_TREASURE` |
| `POST` | `/resume` | `MANAGE_TREASURE` |
| `POST` | `/close` | `MANAGE_TREASURE` |
| `POST` | `/archive` | `MANAGE_TREASURE` |
| `GET` | `/` — current state | member |
| `GET` | `/history` | member, paginated |
| `GET` | `/winners` | member, paginated |
| `GET` | `/statistics` | `VIEW_ANALYTICS` |

Path convention follows the shipped video controllers (`video-rooms/:id/...`), not the
brief's singular `/video-room/:roomId/...`, so client path-building stays uniform.

### Socket — `/video-room` namespace

`treasureProgressUpdated`, `treasureUnlocked`, `treasureWinnerSelected`,
`treasureRewardDistributed`, `treasureLevelChanged`, `treasureAnimation`,
`treasureRecovered`.

**Throttling:** `treasureProgressUpdated` is coalesced per room to
`progressEmitPerSecond` (default 5) using a Redis-stamped last-emit key. Only the
**latest** value is emitted in a window — never a queued backlog. A **threshold
crossing always bypasses the throttle** and is delivered immediately. All other
treasure events (unlock, winner, reward, recovery, lifecycle) are **unthrottled**.

### EVENT_BUS

`TreasureCreated`, `TreasureStarted`, `TreasureProgressUpdated`, `TreasureUnlocked`,
`TreasureRewardGenerated`, `TreasureWinnerSelected`, `TreasureRewardDistributed`,
`TreasureClosed`, `TreasureRecovered`, `TreasureUnlockFailed`.

**Every event carries:** `correlationId`, `roomId`, `sessionId`, `boxId`, `level`, and
`batchId` where a gift batch originated it. One `correlationId` spans a complete unlock
lifecycle, so `VideoRoomEvent` reconstructs the full causal chain for tracing, replay,
auditing and debugging.

### DTOs

`CreateTreasureBoxDto`, `TreasureProgressDto`, `TreasureRewardDto`, `TreasureWinnerDto`,
`TreasureStatisticsDto`, `TreasureResponseDto` — each Swagger-annotated with
authentication, permissions, validation rules, examples, responses and error codes.

---

## 8. RBAC and exceptions

One additive permission, `MANAGE_TREASURE`, added to the code matrix in
`video-room-permissions.ts` and granted to OWNER + ADMIN. The file is explicit that
permissions are "a CODE matrix … NOT a database-driven permission table", so this is a
code change with no migration. Statistics reuse the existing `VIEW_ANALYTICS`.
Participants require no permission — viewing progress and receiving rewards are
membership-level.

Seven domain exceptions, each a thin `BusinessException` subclass binding its own code,
so the global `ERROR_CODES` registry stays the single source of truth for clients:

| Exception | Error code |
|---|---|
| `TreasureBoxException` | `VIDEO_ROOM_TREASURE_INVALID` |
| `TreasureProgressException` | `VIDEO_ROOM_TREASURE_PROGRESS_FAILED` |
| `TreasureUnlockException` | `VIDEO_ROOM_TREASURE_UNLOCK_FAILED` |
| `RewardPoolException` | `VIDEO_ROOM_TREASURE_POOL_INVALID` |
| `WinnerSelectionException` | `VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED` |
| `RewardDistributionException` | `VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED` |
| `DuplicateRewardException` | `VIDEO_ROOM_TREASURE_DUPLICATE_REWARD` |

Plus `VIDEO_ROOM_TREASURE_NOT_FOUND`, `VIDEO_ROOM_TREASURE_ALREADY_ACTIVE`,
`VIDEO_ROOM_TREASURE_DISABLED`, `VIDEO_ROOM_TREASURE_NOT_AUTHORIZED`.

---

## 9. Observability

Metrics are appended to `VideoRoomsMetrics` under `// ---- VR-11 treasure ----` and
driven by a decoupled `video-room-treasure-metrics.listener.ts` (VR-9/VR-10 pattern —
metrics subscribe to events; services never call the metrics object).

| Metric | Type | Labels |
|---|---|---|
| treasure progress | gauge | room, level |
| unlocks | counter | level, algorithm |
| reward distribution duration | histogram | level |
| distribution failures | counter | **failureStage** |
| wallet call latency | histogram | — |
| unlock queue depth | gauge | — |
| concurrent in-flight unlocks | gauge | — |
| pool minted (treasure revenue) | counter | level, strategy |

`production.txt:1561` — "reward distribution shall complete automatically within 5
seconds" — becomes an explicit SLO on the duration histogram.

**Audit:** every pipeline stage appends a `VideoRoomEvent` row (`treasure.created`,
`treasure.started`, `treasure.progress`, `treasure.unlocked`, `treasure.pool_generated`,
`treasure.winner_selected`, `treasure.reward_distributed`, `treasure.closed`,
`treasure.recovered`, `treasure.failed`) carrying room id, treasure/session/box id,
level, transaction id, winner id, actor id, timestamp, request id and `correlationId`.

---

## 10. Configuration

New `videoRoomTreasure` namespace, coerced through the `toBool` idiom from
`video-room-gift.config.ts` (which exists because `z.coerce.boolean()` turns the string
`"false"` into `true`).

| Env var | Default |
|---|---|
| `VIDEO_ROOM_TREASURE_ENABLED` | `true` |
| `VIDEO_ROOM_TREASURE_POOL_BPS` | `1000` |
| `VIDEO_ROOM_TREASURE_WINNER_COUNT` | `3` |
| `VIDEO_ROOM_TREASURE_OVERSAMPLE_FACTOR` | `3` |
| `VIDEO_ROOM_TREASURE_OVERSAMPLE_MIN` | `50` |
| `VIDEO_ROOM_TREASURE_MIN_STAY_SECONDS` | `120` |
| `VIDEO_ROOM_TREASURE_MIN_ACTIVITY_EVENTS` | `0` |
| `VIDEO_ROOM_TREASURE_PROGRESS_EMIT_PER_SECOND` | `5` |
| `VIDEO_ROOM_TREASURE_ORPHAN_TIMEOUT_SECONDS` | `120` |
| `VIDEO_ROOM_TREASURE_RECOVERY_ENABLED` | `false` |
| `VIDEO_ROOM_TREASURE_MONITOR_INTERVAL_SECONDS` | `30` |

Default level ladder seeded into `VideoRoomTreasureLevel`: **15,000 / 60,000 / 200,000 /
350,000**. No value is hardcoded in business logic.

---

## 11. Performance targets

| Path | Target |
|---|---|
| `onSend` counter + claim | < 15 ms added to the VR-10 send path |
| Gift send total (unchanged) | < 100 ms single, < 300 ms multi |
| Unlock pipeline end-to-end | < 5 s (production.txt:1561) |
| Winner draw, 100k-viewer room | < 200 ms (oversample is O(candidates), not O(room)) |
| Progress broadcast fan-out | ≤ 5/sec/room, threshold crossings immediate |

---

## 12. Backward compatibility — mandatory release gate

Three hazards were found by inspection and designed out. All three are regression-tested.

**H1 — `TreasureBoxConfig` collision (would silently corrupt audio thresholds).**
`listEnabledConfigs()` (`treasure.repository.ts:37`) and its in-transaction twin
(`treasure.service.ts:249`) query the table **unfiltered**. `treasure.service.ts:136`
then builds `new Map(configs.map(c => [c.level, c]))` — keyed by level alone. Video and
audio levels would collide (audio L3 = 120,000 vs video L3 = 200,000; audio L4 = 300,000
vs video L4 = 350,000), last writer wins, and the `byLevel.size < TREASURE_BOX_COUNT`
guard still passes — so it fails **silently**.
→ **Resolved:** video uses its own `VideoRoomTreasureLevel`. `TreasureBoxConfig` is not
touched.

**H2 — `@@unique([boxId, userId])` on `TreasureReward` could roll back a paid gift.**
`RewardDistributor` (`reward-distributor.service.ts:66`) emits **one row per matching
reward entry**, and the admin API (`treasure-admin.controller.ts:28`) accepts arbitrary
reward JSON — so a rank configured with both coins and an item legitimately produces two
rows for one `(boxId, userId)`.
→ **Resolved:** no unique constraint on `TreasureReward`. Duplicate prevention lives on
the video-owned `TreasureWinner`.

**H3 — contribution counters are globally keyed.**
`UserContributionCounter` is keyed by `userId` **alone** (`treasure.repository.ts:258`).
Writing it from video would change contribution totals displayed inside audio rooms.
→ **Resolved:** D10 — the video engine never writes either counter.

**Verified safe to share.** All 40 Prisma calls against `TreasureSession`,
`TreasureBox`, `TreasureContribution` and `TreasureReward` are scoped by `roomId`,
`sessionId`, `boxId` or `id` — including `listSessions` (`:121`) and `listRewards`
(`:241`), both filtering `{ roomId }`. There is no unscoped query. Video room UUIDs
never collide with audio room UUIDs.

**`UNLOCKING` is safe.** Audio writes only `ACTIVE`/`PENDING`/`OPENED` (`treasure.service.ts`
152, 268, 460, 481; `treasure.repository.ts` 166, 174). Every read is an `if`/`else`
chain with a fallback — there is no exhaustive `switch` a new variant would break, and
audio never reads a video box.

### Release gate

1. `treasure.service.spec.ts` and `rocket.service.spec.ts` pass **unmodified**.
2. No file under `src/modules/treasure-boxes/` or `src/modules/audio-rooms/` is changed
   (asserted by diff in CI).
3. A video unlock writes neither `RoomContributionCounter` nor `UserContributionCounter`.
4. Full suite green (~2,145 baseline + new), `tsc` clean, lint clean.

---

## 13. Testing strategy

TDD throughout.

| Suite | Covers |
|---|---|
| Unit | every service in isolation |
| Repository | both repositories against the real schema |
| Reward distribution | coins + items, idempotency, partial failure |
| Winner selection | all five algorithms; determinism from `(algo, version, seed, candidates)` |
| Queue | registry dispatch, retry, DLQ |
| Wallet | credit correctness, latency budget |
| Socket | all seven events, throttle behaviour, threshold bypass |
| API | all ten endpoints, RBAC, validation, Swagger contract |
| **Concurrency** | N parallel gifts crossing one threshold ⇒ exactly one claim, one payout |
| **Combo** | one 400k gift ⇒ four *sequential* unlocks in level order |
| **Replay** | re-running a completed unlock is a no-op; balances unchanged |
| **Recovery** | orphaned `UNLOCKING` box and DLQ replay both converge exactly-once |
| **Eligibility** | zero-eligible, under-filled, blocked, min-stay, min-activity |
| **BC regression** | §12 release gate |

---

## 14. Deliverables

- 8 services, 2 repositories, 1 controller, 3 listeners, 1 config, 1 constants, 1 events,
  1 DTO, 1 exceptions, 1 interfaces module — each with a co-located `.spec.ts`.
- 4 new Prisma models, 2 enum extensions, 1 new enum, 5 additive columns on
  `TreasureReward` (`status`, `attempts`, `lastError`, `failureStage`, `distributedAt`).
- 1 migration **file**, authored but not applied by the implementation — the operator
  runs `prisma migrate deploy`. Every column is additive or defaulted, so the migration
  is backward-compatible with running instances and requires no backfill.
- 1 modified file: `video-room-gift-context.handler.ts`.
- Level seeder for the default 15k/60k/200k/350k ladder.
- Swagger documentation for all ten endpoints.
- Green BC release gate.
