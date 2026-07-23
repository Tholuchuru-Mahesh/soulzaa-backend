# VR-13 — Enterprise Ranking & Leaderboard Engine (Video Rooms)

**Status:** design approved, pending implementation plan
**Date:** 2026-07-22
**Phase:** 13 (follows VR-12 PK Battle Engine)

---

## 1. Context: what already exists

Exploration of the codebase before design established the following. All of it is
reused; none of it is rebuilt.

### 1.1 A platform ranking engine already ships

`src/modules/rankings/` is live and in production use:

| Component | Detail |
|---|---|
| Redis keys | `rankings:{type}:{period}:{dateKey}` ZSETs |
| Types | `gifters`, `receivers`, `families`, `streamers` |
| Periods | `daily`, `weekly`, `monthly`, `alltime` |
| Persistence | `RankingSnapshot` (`prisma/schema/rankings.prisma`) |
| Queue | `QUEUE_NAMES.RANKING_PROCESSING` + `RankingsProcessor` |
| Schedule | `RankingsScheduler`, cron `5 0 * * *` → `rankings.snapshot` |
| Write trigger | `RankingsActivityListener` on `gift.sent` |
| REST | `GET /rankings/{gifters,receivers,families,streamers}` |

**Critical finding.** `RankingsActivityListener` subscribes to `gift.sent`, and
video-room gifts publish `gift.sent` with `contextType: VIDEO_ROOM`. The platform
gifter/receiver/streamer ladders therefore **already include video-room gifts
today**. Any listener in VR-13 that re-increments those same keys would double
count real coins.

### 1.2 Per-room gift leaderboards already ship

`VideoRoomGiftStatisticsService` maintains `giftTopSendersKey(roomId)` and
`giftTopKey(roomId)` ZSETs, surfaced through `summary()` / `breakdown()`. These
are **untimed** (all-time-per-room, no period dimension) and drive the live gift
panel. VR-13 does not rewrite them.

### 1.3 Infrastructure available and `@Global`

`PrismaService`, `REDIS_CLIENT`, `CacheService`, `LockService`, `SocketManager`,
`EVENT_BUS`, `MetricsService`, `QueueService`, `QueueJobRegistry`,
`SOCIAL_SERVICE` (`friendIds`, `followerIds`), `VIP_SERVICE`
(`getLevelOrdinal`), `WALLET_SERVICE`, `VideoRoomEventsRepository` (append-only
audit store), `VideoRoomPermissionService` + `VideoRoomPermissionCache`.

### 1.4 Sources VR-13 aggregates from

`gift_transactions`, video-room PK battles/rewards (`video_rooms_pk.prisma`),
video-room treasure rewards (`video_rooms_treasure.prisma`),
`video_room_statistics`, `video_room_presence`.

---

## 2. Decisions

Seven decisions were taken during design. Each is recorded with its rejected
alternatives so the reasoning survives the phase.

### D1 — Placement: hybrid (core in `rankings/`, surface in `video-rooms/`)

`src/modules/rankings/` is promoted into a **generic ranking core** with no video
knowledge. `src/modules/video-rooms/` gets the VR-13 surface built on it.

*Rejected:* a self-contained engine inside `video-rooms/` (re-implements ZSET
store, period resolution and snapshotting; two engines can disagree on the same
number). *Rejected:* growing `rankings/` into the whole enterprise engine (edits
a module that audio-rooms, live-streaming and families already read — blast
radius this phase must avoid).

### D2 — Scope model: GLOBAL + ROOM + COUNTRY + CITY, one scope-aware key

A ranking is identified by `(scope, dimension, period)`. The same code path
serves "top gifters worldwide this week" and "top gifters in room X today".

*Rejected:* global-only (a room could never show "top supporters this week").
*Rejected:* room-only (drops Top Rooms / Global / Country leaderboards, all
explicit deliverables).

### D3 — Periods: hot five materialised, three derived

Materialised on the write path: `hourly`, `daily`, `weekly`, `monthly`,
`alltime` — five `ZINCRBY`s per dimension per event. Derived by aggregation job
via `ZUNIONSTORE` over constituent keys: `quarterly`, `yearly`, `custom`.

*Rejected:* materialising all eight (8+ writes per dimension per gift multiplies
the hot path several-fold at the stated scale). *Rejected:* materialising only
the platform's existing four (makes `hourly` — the ladder users watch during a
live room — lag-bound on a job).

### D4 — Correctness: lambda (fast incremental path + authoritative recompute)

*Rejected:* dedupe markers alone (a Redis flush, an eviction, or a marker
expiring before a very late retry leaves permanently wrong scores with nothing
to correct them). *Rejected:* recompute-only (contradicts requirement 1 —
rankings must update in real time).

### D5 — Persistence: three new tables in a new schema file

`prisma/schema/video_rooms_rankings.prisma`. `RankingSnapshot` is **not**
migrated and **not** namespaced.

*Rejected:* reusing `RankingSnapshot` (no scope/roomId column, no metrics
breakdown, nowhere for aggregation logs). *Rejected:* widening
`RankingSnapshot` with a scope column (migrates a table three shipped modules
read).

### D6 — Geo: country and city are *scopes*, not dimensions

`COUNTRY:IN` and `CITY:<id>` rank users/rooms **within** a geography ("top hosts
in India this week"). Countries are not ranked against each other. Falls out of
D2 with zero new machinery. Country from `User.country`, city from
`UserProfile.city`.

### D7 — Guest limit: top 10, no self-rank, no history

Guests read the head of any public ladder. No pagination past rank 10, no
self-position lookup, no historical `dateKey` queries.

---

## 3. Architecture

### 3.1 Core additions to `src/modules/rankings/`

| Component | Responsibility |
|---|---|
| `RankingPeriodResolver` | dateKey math for all 8 periods; window bounds `(start, end)` for a dateKey; the constituent-key list a derived period unions over |
| `LeaderboardStore` | scope/dimension-aware ZSET ops: `increment`, `incrementMany`, `range`, `rank`, `score`, `scoreMany`, `count`, `derive` (ZUNIONSTORE), `replace` (atomic swap), `expire` |
| `LeaderboardCache` | hydrated top-N page cache keyed by `(scope, dimension, period, dateKey, page)`; short TTL; emits hit/miss counters |

`RankingsService` is refactored onto `RankingPeriodResolver` and
`LeaderboardStore`. This refactor is **behaviour-preserving**: identical Redis
keys, identical `RankingSnapshot` rows, identical responses from the four
existing endpoints. Its existing spec file is the regression harness.

`RankingsProcessor.handle()` gains a fallthrough to `QueueJobRegistry.dispatch()`
so domain modules can own jobs on `RANKING_PROCESSING` — mirroring how the
gift-processing processor already lets VR-12 register `video-room.pk.start`.
Backward compatible: `rankings.snapshot` keeps its explicit branch.

### 3.2 Key model

```
vrank:{<scope>|<dimension>}:<period>:<dateKey>
```

The hash tag is `scope|dimension`. Rationale: every `ZUNIONSTORE` is within one
scope+dimension across dateKeys (quarterly ← 3× monthly), so derivation stays
Redis-Cluster-safe, while load spreads across dimensions instead of collapsing
every global ladder onto a single `{GLOBAL}` slot.

| Element | Values |
|---|---|
| scope | `g` · `r:<roomId>` · `c:<ISO2>` · `y:<cityId>` |
| dimension | `hosts` `gifters` `receivers` `rooms` `pk` `treasure` `vip` |
| period | `hourly` `daily` `weekly` `monthly` `alltime` `quarterly` `yearly` `custom` |

Examples: `vrank:{g|hosts}:daily:20260722`,
`vrank:{r:abc-123|gifters}:hourly:2026072214`,
`vrank:{c:IN|rooms}:weekly:2026W30`.

Auxiliary keys:

| Key | Purpose | TTL |
|---|---|---|
| `vrank:seen:<source>:<naturalId>` | fan-out dedupe marker (`SET NX`) | 48h |
| `vrank:cache:{<scope>\|<dim>}:<period>:<dateKey>:<page>` | hydrated leaderboard page | config, seconds |
| `vrank:agg:lock:<jobKey>` | one aggregation run fleet-wide (`LockService`) | job duration |
| `vrank:coalesce:{r:<roomId>}` | socket broadcast coalescing window | 1s |
| `vrank:ver:{<scope>\|<dim>}` | monotonic ladder version (`INCR` on every replace/derive) | none |

Room-scoped ladders carry a TTL refreshed on write, so ended rooms self-evict
rather than accumulating forever. Global/country/city ladders are snapshotted at
period close and then TTL'd, matching what `takeMidnightSnapshots` already does.

### 3.3 Composite scoring

A ZSET score is a single number, but Host Ranking has seven inputs. Every
contributing signal increments the **same** key by `weight × delta`, with
weights in the `videoRoomRanking` config namespace:

```ts
weights.host  = { coins: 1, gifts: 5, watchSeconds: 0.01, peakViewers: 2, pkWin: 500, treasureEvent: 50 }
weights.rooms = { giftCoins: 1, peakViewers: 10, avgWatchSeconds: 0.05, pkCount: 100, treasureCount: 25 }
weights.pk    = { win: 1000, loss: 0, score: 1, giftCoins: 0.5 }
```

Redis holds **only the composite**. The per-metric breakdown is computed by the
recompute pass from source tables and persisted to
`VideoRoomRankingSnapshot.metrics` (JSON). This keeps the hot path to one
`ZINCRBY` per (scope, dimension, period) instead of a parallel metrics hash, and
makes the breakdown authoritative rather than an accumulation of deltas.

`VideoRoomRankingScoreEngine` owns the weight application and is the single
place both the incremental path and the recompute path call — which is what
makes the two produce the same number.

### 3.4 Correctness: the lambda model

**Fast path.** Each source event has a natural id (`transactionId`, `battleId`,
`rewardId`). `SET NX vrank:seen:<source>:<id>` guards the entire fan-out for
that event. Refunds (`gift.refunded`) apply a negative delta under their own
marker, so a refund is not itself replayable.

Known and accepted gap: a crash between setting the marker and completing the
fan-out leaves some keys un-incremented. This is deliberately not solved with a
distributed transaction — it is what the batch path exists to heal.

**Batch path.** `video-room.ranking.aggregate` recomputes a closed window from
the source tables using `VideoRoomRankingScoreEngine` — the same weights — and
swaps the result in atomically (`replace`: build into a temp key, `RENAME`).
Every run writes a `VideoRoomRankingAggregationLog` row keyed on
`(scope, dimension, period, dateKey)`; a run that finds a `SUCCEEDED` row for
its key is a no-op. Recovery for any corruption is "re-run the job for that
dateKey".

### 3.5 Write triggers

| Bus event | Filter | Dimensions |
|---|---|---|
| `gift.sent` | `contextType === VIDEO_ROOM` | `gifters`, `receivers`, `hosts` (receiver holds a seat), `rooms` |
| `gift.refunded` | video-room context | same, negative delta |
| `video_room.pk.winner_declared` | — | `pk` |
| `video_room.pk.ended` | — | `pk` (score, duration), `rooms` |
| `video_room.treasure.reward_distributed` | — | `treasure` |
| `video_room.closed` | — | `rooms` (watch time, session totals) |
| `VideoRoomSessionMonitor` tick | — | `rooms` (peak viewers) |

Each write fans out across the applicable scopes: `g`, `c:<country>`,
`y:<city>`, and `r:<roomId>`.

**Viewer count is sampled from the monitor tick, not from join/leave events.**
Per-event ladder writes would storm during a raid; the monitor already runs a
fleet-locked sweep on a cadence and knows current occupancy.

`VideoRoomRankingScopeResolver` resolves a user's country/city once and caches
it (Redis, long TTL) — the write path must not hit Postgres per gift.

### 3.6 Derived leaderboards are projections, not ZSETs

Friends, Following and VIP leaderboards do **not** get their own keys. They are
computed as: fetch the id set (`SOCIAL_SERVICE.friendIds` /
`followerIds`; VIP membership), `ZMSCORE` those ids against the relevant ladder,
sort, hydrate. Zero write-path cost, always consistent with the base ladder.

The `vip` **dimension** is separate and does exist as a ZSET — it ranks by VIP
level ordinal with coin spend as tiebreak, which is not a projection of any
other ladder.

---

## 4. Data model

New file `prisma/schema/video_rooms_rankings.prisma`. No cross-module relations —
other domains are referenced by id, matching the convention in
`rankings.prisma` and the other `video_rooms_*.prisma` files.

### `VideoRoomRankingSnapshot`

Per-entity historical position.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `scope` | String | `g`, `r:<uuid>`, `c:IN`, `y:<uuid>` |
| `dimension` | String | |
| `period` | String | |
| `dateKey` | String | |
| `targetId` | String @db.Uuid | user id or room id |
| `rank` | Int | |
| `score` | BigInt | composite |
| `metrics` | Json? | authoritative per-metric breakdown |
| `createdAt` | DateTime | |

`@@unique([scope, dimension, period, dateKey, targetId])`
`@@index([scope, dimension, period, dateKey, rank])`
`@@index([targetId, dimension, period])` — "my ranking history"

### `VideoRoomLeaderboardSnapshot`

One materialised top-N row per ladder close. Serves historical reads and cache
warmup in a single query instead of N snapshot rows.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `scope` `dimension` `period` `dateKey` | String | |
| `entries` | Json | ordered top-N `[{targetId, rank, score}]` |
| `totalEntries` | Int | full ladder cardinality |
| `capturedAt` | DateTime | |

`@@unique([scope, dimension, period, dateKey])`

### `VideoRoomRankingAggregationLog`

The idempotency guard and the aggregation audit.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `scope` `dimension` `period` `dateKey` | String | |
| `status` | String | `RUNNING` `SUCCEEDED` `FAILED` |
| `windowStart` `windowEnd` | DateTime | |
| `sourceRows` | Int | rows scanned |
| `entriesWritten` | Int | |
| `durationMs` | Int | |
| `error` | String? | |
| `startedAt` `finishedAt` | DateTime | |

`@@unique([scope, dimension, period, dateKey])`
`@@index([status, startedAt])`

---

## 5. REST surface

Base `video-rooms` (the codebase prefix; the brief writes `/video-room/...`
singular — **deviation noted and intentional**, every shipped controller uses
`video-rooms`).

| Route | Returns |
|---|---|
| `GET /video-rooms/rankings/global` | scope `g` for the requested `?dimension=` (default `hosts`) — the global entry point, not a separate ladder |
| `GET /video-rooms/rankings/hosts` | `hosts` |
| `GET /video-rooms/rankings/gifters` | `gifters` |
| `GET /video-rooms/rankings/receivers` | `receivers` |
| `GET /video-rooms/rankings/rooms` | `rooms` |
| `GET /video-rooms/rankings/pk` | `pk` |
| `GET /video-rooms/rankings/vip` | `vip` |
| `GET /video-rooms/rankings/country` | scope `c:<code>`, `?country=` |
| `GET /video-rooms/rankings/history` | snapshot-backed historical ladder |
| `GET /video-rooms/rankings/me` | caller's rank across dimensions (auth only) |
| `GET /video-rooms/:id/rankings` | room-scoped ladder, `?dimension=` |

Shared query DTO: `dimension`, `period`, `dateKey?`, `scope?`, `country?`,
`city?`, `limit`, `page`, `audience?` (`all` \| `friends` \| `following`).

Responses reuse `Paginated<T>` / `buildPaginated` from
`src/common/utils/pagination.util.ts`.

Every endpoint fully documented with `@ApiOperation`, `@ApiQuery`,
`@ApiResponse` (200/400/403/404), examples and error codes — the VR-12
controller is the template.

---

## 6. Socket events

Emitted into the existing `/video-room` namespace by
`VideoRoomRankingSocketListener` via `SocketManager`. No new gateway.

Names follow the codebase `video_room.*` convention rather than the brief's
camelCase (deviation noted; every shipped event uses the dotted form):

| Constant | Wire name | Brief's name |
|---|---|---|
| `RANKING_UPDATED` | `video_room.ranking.updated` | `rankingUpdated` |
| `LEADERBOARD_UPDATED` | `video_room.leaderboard.updated` | `leaderboardUpdated` |
| `HOST_RANK_UPDATED` | `video_room.ranking.host_updated` | `hostRankUpdated` |
| `GIFTER_RANK_UPDATED` | `video_room.ranking.gifter_updated` | `gifterRankUpdated` |
| `ROOM_RANK_UPDATED` | `video_room.ranking.room_updated` | `roomRankUpdated` |
| `PK_RANK_UPDATED` | `video_room.ranking.pk_updated` | `pkRankUpdated` |
| `TREASURE_RANK_UPDATED` | `video_room.ranking.treasure_updated` | `treasureRankUpdated` |

**Broadcasts are coalesced per room on a ~1s window.** Emitting a ranking update
per gift is not survivable during a gift storm. The coalescer holds the latest
top-N per (room, dimension) and flushes on the window boundary. Unlike the
treasure listener — which deliberately does not throttle because coalescing
already happened upstream — there is no upstream coalescing here, so it belongs
in this listener.

---

## 7. Event bus

`events/video-room-ranking.events.ts`, `DomainEvent` subclasses:

`video_room.ranking.updated`, `video_room.leaderboard.updated`,
`video_room.ranking.host_updated`, `video_room.ranking.room_updated`,
`video_room.ranking.gifter_updated`, `video_room.ranking.pk_updated`,
`video_room.ranking.treasure_updated`, plus
`video_room.ranking.aggregated` and `video_room.ranking.snapshot_created`
(job lifecycle, consumed by the audit and metrics listeners).

---

## 8. Background jobs

Registered on the existing `RANKING_PROCESSING` queue through
`QueueJobRegistry` (no new queue), scheduled by
`VideoRoomRankingScheduler.onModuleInit` with `QueueService.schedule` repeatable
patterns — the `RankingsScheduler` pattern.

| Job | Cron | Work |
|---|---|---|
| `video-room.ranking.aggregate.hourly` | `2 * * * *` | recompute closed hour; derive |
| `video-room.ranking.aggregate.daily` | `10 0 * * *` | recompute closed day; snapshot |
| `video-room.ranking.aggregate.weekly` | `20 0 * * 1` | recompute + snapshot |
| `video-room.ranking.aggregate.monthly` | `30 0 1 * *` | recompute + snapshot; derive quarterly |
| `video-room.ranking.aggregate.yearly` | `40 0 1 1 *` | derive + snapshot |
| `video-room.ranking.cache-refresh` | `*/2 * * * *` | warm hot leaderboard pages |
| `video-room.ranking.cleanup` | `50 3 * * *` | prune snapshots past retention; expire Redis |

Retention is config-driven (`videoRoomRanking.retention`), defaulting to 90 days
for `hourly` snapshots, 400 days for `daily`/`weekly`, and unbounded for
`monthly`/`quarterly`/`yearly` — long-horizon rows are small and are what
year-over-year reporting reads.

Every job takes a fleet-wide `LockService` lock and writes a
`VideoRoomRankingAggregationLog` row. A job whose key already has a `SUCCEEDED`
row returns without work — safe under BullMQ redelivery. Handlers never throw on
"nothing to do"; they throw only on genuine failure, so BullMQ's retry and
dead-letter path stays meaningful (the VR-12 jobs-service convention).

---

## 9. Permissions

Reads go through `VideoRoomPermissionService` for room-scoped ladders only.

| Actor | Access |
|---|---|
| Owner / Admin / Moderator | full, including room-scoped analytics ladders |
| Participant / Host / Viewer | full read of public ladders + own self-rank |
| Guest | top 10 only; no pagination past rank 10, no self-rank, no history |

Guest gating uses the existing guest flag on `AuthenticatedUser` (the mechanism
behind `@NotGuest()`), applied in `VideoRoomRankingQueryService` — not inline in
the controller, matching the VR-10/11/12 convention that authorization never
lives in a controller.

`VIEW_ANALYTICS` gates the metric **breakdown** on a room-scoped ladder (who
gifted what), consistent with `VideoRoomGiftStatisticsService.breakdown()`.

---

## 10. Exceptions

`exceptions/video-room-ranking.exceptions.ts`, thin `BusinessException`
subclasses over new `ERROR_CODES` entries, defaulting to 409 except where noted:

| Class | Error code | Default |
|---|---|---|
| `RankingException` | `VIDEO_ROOM_RANKING_INVALID` | 409 |
| `LeaderboardException` | `VIDEO_ROOM_LEADERBOARD_INVALID` | 409 |
| `AggregationException` | `VIDEO_ROOM_RANKING_AGGREGATION_FAILED` | 409 |
| `RankingCacheException` | `VIDEO_ROOM_RANKING_CACHE_FAILED` | 409 |
| `RankingPeriodException` | `VIDEO_ROOM_RANKING_PERIOD_INVALID` | 400 |

`RankingPeriodException` is 400 because an unparseable period/dateKey **is** a
malformed request — unlike the others, which fire on well-formed requests the
engine state disallows.

---

## 11. Validation

- **Period** — must be a known period; `dateKey` must parse for that period
  (`RankingPeriodResolver.isValid`); `custom` requires both bounds and a range
  within a configured maximum span.
- **Dimension / scope** — enum membership; `r:<id>`/`y:<id>` must be a uuid,
  `c:<code>` an ISO-3166-alpha-2.
- **Duplicate aggregation** — the `AggregationLog` unique key.
- **Cache consistency** — cached pages embed the ladder's `dateKey` plus the
  `vrank:ver:{scope|dim}` counter read at write time; on read, an embed that does
  not match the current counter is treated as a miss. This is the same
  version-stamp technique `VideoRoomPermissionCache` already uses
  (`videoRoomPermissionVersionKey`), so invalidating a whole ladder is one
  `INCR` regardless of how many pages are cached.
- **Historical integrity** — snapshot writes are `skipDuplicates` + unique-keyed;
  a recompute that would rewrite an existing dateKey logs and requires an
  explicit `force` flag on the job.

---

## 12. Metrics

Added to the existing `VideoRoomsMetrics` (registered on the shared
`MetricsService` registry, exposed at `GET /metrics`):

| Metric | Type |
|---|---|
| `rankingUpdateLatency` | Histogram |
| `rankingCacheHits` / `rankingCacheMisses` | Counter |
| `rankingAggregationDuration` | Histogram (labelled by period) |
| `rankingApiLatency` | Histogram (labelled by dimension) |
| `rankingSnapshotDuration` | Histogram |
| `rankingUpdates` | Counter (labelled by dimension) |
| `rankingDedupeSkips` | Counter |
| `rankingBroadcasts` / `rankingBroadcastsCoalesced` | Counter |
| `rankingLadderSize` | Gauge |

Redis latency is already emitted by infra `MonitoringMetrics` — reused, not
duplicated.

---

## 13. Audit logging

`VideoRoomRankingAuditListener` appends to the existing append-only
`VideoRoomEvent` store via `VideoRoomEventsRepository` — no new log table,
mirroring `VideoRoomTreasureAuditListener`. Event types `ranking.updated`,
`ranking.aggregated`, `ranking.snapshot_created`, `ranking.cache_refreshed`,
`ranking.leaderboard_changed`, each carrying ranking id / room id / user id /
timestamp / correlation id. Failures are swallowed and logged: audit is
observational and must never poison the bus for the socket bridge.

---

## 14. Component boundaries

Each unit has one purpose, a stated dependency set, and is testable alone.

**Core — `src/modules/rankings/`**

| Unit | Depends on | Purpose |
|---|---|---|
| `RankingPeriodResolver` | — (pure) | dateKey math, window bounds, constituent keys |
| `LeaderboardStore` | `REDIS_CLIENT` | ZSET ops + derive + atomic replace |
| `LeaderboardCache` | `CacheService`, metrics | hydrated page cache |

**VR-13 — `src/modules/video-rooms/`**

| Unit | Depends on | Purpose |
|---|---|---|
| `VideoRoomRankingScoreEngine` | config | weights → composite; used by both paths |
| `VideoRoomRankingScopeResolver` | Prisma, Redis | user → country/city, cached |
| `VideoRoomRankingRepository` | Prisma | the three tables; **no Prisma in services** |
| `VideoRoomRankingService` | store, engine, scope resolver | write path + dedupe fan-out |
| `VideoRoomRankingQueryService` | store, cache, repo, permissions | read path + hydration + guest gate |
| `VideoRoomLeaderboardService` | store, `SOCIAL_SERVICE`, `VIP_SERVICE` | friends/following/VIP projections |
| `VideoRoomRankingAggregationService` | repo, store, engine | recompute a window from sources |
| `VideoRoomRankingSnapshotService` | repo, store | persist top-N at period close |
| `VideoRoomRankingJobsService` | `QueueJobRegistry`, above | BullMQ handlers |
| `VideoRoomRankingRecoveryService` | repo, aggregation | replay a dateKey; heal drift |
| `VideoRoomRankingScheduler` | `QueueService` | repeatable job registration |

Listeners: `...-activity` (write triggers), `...-socket` (coalesced broadcast),
`...-metrics`, `...-audit`. Controller: `VideoRoomsRankingsController`.

---

## 15. Error handling

- **Listeners swallow and log.** A ranking failure must never fail a gift, a PK
  settlement or a treasure payout — the money has already moved.
- **Job handlers throw only on genuine failure.** "Nothing to do" / "already
  done" return quietly so BullMQ's retries are not burned on a job that can
  never succeed.
- **Query path degrades.** Redis unavailable → fall back to the latest
  `VideoRoomLeaderboardSnapshot` rather than 500. A stale ladder beats no ladder.
- **Write path never blocks.** Dedupe-marker failure is treated as "not seen"
  (fail open), because a missed increment is healed by recompute whereas a
  blocked write is not.

---

## 16. Testing

| Kind | Coverage |
|---|---|
| Unit | period resolver (every period + boundaries: DST, ISO week 53, year rollover), score engine weights, scope resolver, exceptions, constants/key builders |
| Repository | the three tables, unique-key idempotency, pagination, retention pruning |
| Aggregation | recompute equals incremental for a clean window; heals a deliberately corrupted ladder; duplicate run is a no-op |
| Redis | ZSET store ops, `ZUNIONSTORE` derivation, atomic replace, TTL, cluster-safe key shapes |
| Leaderboard | friends/following/VIP projections, empty sets, hydration of missing users |
| Socket | coalescing window, per-room isolation, event names/payload shapes |
| Background job | scheduling, lock contention, idempotency via the log table, failure → dead letter |
| API | every endpoint, every status code, guest limit, permission gates, validation rejects |
| Concurrency | parallel increments to one ladder, simultaneous aggregation attempts, cache stampede on one key |

Plus a `video-rooms-ranking.integration.spec.ts` walking gift → ladder →
snapshot → historical read, matching the existing gift/treasure/PK integration
specs.

---

## 17. Explicitly out of scope

Per the phase brief: notifications, seasonal events, tournament rankings, family
rankings (the platform `families` ladder is untouched), admin dashboard,
recommendation engine.

"Future Event Rankings" is served by the extensibility of the dimension enum —
adding a dimension requires a constant, a weight entry and a source mapping,
with no change to the store, cache, jobs or REST layer. No speculative event
machinery is built.

---

## 18. Backward compatibility

- `RankingSnapshot` and `prisma/schema/rankings.prisma` unchanged.
- The four existing `/rankings/*` endpoints unchanged in shape and value.
- `rankings:*` Redis keys unchanged; VR-13 never writes them.
- `RankingsActivityListener` untouched — no double counting.
- `giftTopSendersKey` / `giftTopKey` and the gift panel untouched.
- `RankingsProcessor` gains a registry fallthrough; its existing branch is
  unchanged.
- Audio-rooms, live-streaming and families see no change.
