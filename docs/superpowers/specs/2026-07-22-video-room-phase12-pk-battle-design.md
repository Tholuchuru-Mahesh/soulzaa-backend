# VR-12 — Video Room PK Battle Engine (Design)

**Phase:** 12 · **Date:** 2026-07-22 · **Status:** approved, not implemented
**Depends on:** VR-0…VR-11 (infrastructure, schema, lifecycle, members, seats, media, viewers, RBAC, seat workflow, chat, gifts, treasure)

---

## 1. Scope

Implements a production-grade PK Battle engine for Video Rooms: 1v1 and Team
battles, a persisted invitation workflow, a validated 11-state machine, a
pre-battle countdown, gift-driven real-time scoring, pause/resume, automatic
recovery, winner calculation, wallet-backed reward distribution, battle
history, Redis synchronisation, socket broadcasting, event publishing, audit
logging and monitoring.

**Out of scope** (explicitly not built): global rankings, rocket events,
tournament engine, seasonal events, family wars, cross-country competitions.
Multi-host and cross-room PK are *not built* but the schema and service
boundaries are shaped so they are additive rather than a redesign (§12).

---

## 2. Reuse audit — what already exists

Everything below is consumed as-is. No new infrastructure is created.

| Capability | Existing component | How VR-12 uses it |
|---|---|---|
| Gift → context seam | `IGiftContextHandler.onSend(tx, ctx)` | scoring runs inside the gift transaction |
| Gift context handler | `VideoRoomGiftContextHandler` | one new call added beside the treasure call |
| Per-receiver gift value | `gift.service.ts:196-200` | `perReceiver = totalCoinValue / receiverIds.length` |
| Wallet | `IWalletService.credit(input, tx)` | reward payout, idempotent |
| Locks | `LockService` (hash-tagged `{roomId}`) | lifecycle command serialisation, recovery sweep |
| Cache / Redis | `CacheService`, `REDIS_CLIENT` | score mirror, state mirror, broadcast throttle |
| Queue | `QueueService`, `QUEUE_NAMES.GIFT_PROCESSING` | countdown-end and battle-end delayed jobs |
| Event bus | `EVENT_BUS` / `IEventBus` | 12 domain events |
| Sockets | `SocketManager`, `VIDEO_ROOM_NAMESPACE` | 11 outbound events, no new gateway |
| RBAC | `VideoRoomPermission.START_PK` (OWNER+ADMIN), `VIEW_ANALYTICS` | all management commands; no matrix change |
| Presence | `VideoRoomPresenceService` | "host online" validation, disconnect → RECOVERING |
| Media | `VideoRoomMediaStateService.getSnapshot` | "media active" validation |
| Cosmetics | `ICosmeticsService.grantToUser` | winner badge |
| Metrics | `VideoRoomsMetrics` | 9 new metric families on the existing class |
| Audit | `video_room_logs` + `VideoRoomLogAction` | 9 new additive enum values |
| Config | `loadVideoRoom*Config` pattern, `toBool` | `loadVideoRoomPkConfig` |

### 2.1 Why the Audio Room PK tables are NOT reused

`PkBattleRepository.findExpired()` (`audio-rooms/repositories/pk-battle.repository.ts:103`)
selects **globally** with no room-type discriminator:

```ts
findExpired(now: Date, take = 100) {
  return this.prisma.pkBattle.findMany({
    where: { status: PkStatus.ACTIVE, endsAt: { lte: now } }, take,
  });
}
```

`PkExpiryMonitor` sweeps that fleet-wide and calls the audio `complete()` on
every row, which grants an audio cosmetic badge, writes the shared
`PK_WINS_LEADERBOARD_KEY` and publishes an **audio-room** `PkEndedEvent` onto
the `/audio-room` namespace.

A video-room battle written into `pk_battles` would therefore be silently
completed by the audio engine, under audio rules, broadcast to the wrong socket
namespace. Additionally `PkStatus` has only `ACTIVE|COMPLETED|CANCELLED`, so
every VR-12 state (`COUNTDOWN`, `PAUSED`, `RECOVERING`, …) would either be
unrepresentable or would change the meaning of "not ACTIVE" for every audio
query already in production.

This is the same class of hazard VR-11 documented for `TreasureBoxConfig`
("read UNFILTERED by the audio engine"). **Decision: video-owned tables. Audio
PK code, tables and enums are not touched.**

---

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Video-owned `video_room_pk_*` tables + video-owned enums | §2.1 — unfiltered audio sweep + incompatible status enum |
| D2 | Sides are **rows** (`VideoRoomPkTeam`), exactly 2 enforced in service | multi-host later = new enum values + relaxed validation, not a migration |
| D3 | Scoring writes **inside the gift transaction**, Redis is a mirror | makes atomicity, rollback and dedup structural, not compensating |
| D4 | **One battle aggregate** holds all 11 states; invitations are child rows | audit requires a Battle ID on invitation records; one recovery sweep |
| D5 | **BullMQ delayed jobs** for countdown/end + a recovery sweep backstop | exact settlement + survives the commit-without-job crash window |
| D6 | Rewards are a **minted pool sized from battle gift volume** | liability ∝ real spend; reuses the VR-11 treasure pool pattern |
| D7 | Multipliers compose **additively on a 10 000 base, capped** | multiplicative stacking compounds and makes the cap arbitrary |
| D8 | `PAUSED` (operator) and `RECOVERING` (system) share the clock machinery | recovery is a reuse of pause, not a parallel implementation |
| D9 | Reuse `START_PK`; add no permission | zero permission-matrix change ⇒ zero BC surface |
| D10 | Routes use `/video-rooms/…` (plural) | matches every existing video-room controller; the brief writes the singular form |
| D11 | Reward pool is sized on **base** (pre-multiplier) contribution, summed at settlement | minting must track real coins spent, not multiplied score; also removes a hot row (§4.2) |

---

## 4. Schema — `prisma/schema/video_rooms_pk.prisma` (new file)

### 4.1 Enums (all video-owned, all new)

```prisma
enum VideoRoomPkStatus {
  CREATED  INVITED  PENDING  ACCEPTED  COUNTDOWN
  LIVE     PAUSED   RECOVERING
  COMPLETED  CANCELLED  FAILED
}
enum VideoRoomPkMode             { ONE_VS_ONE  TEAM }
enum VideoRoomPkSide             { RED  BLUE }
enum VideoRoomPkInvitationStatus { SENT  DELIVERED  ACCEPTED  REJECTED  CANCELLED  EXPIRED }
enum VideoRoomPkRewardKind       { WINNER  PARTICIPATION  BONUS }
```

### 4.2 Tables (7)

**`VideoRoomPkBattle`** — the aggregate root.
`id · roomId · mode · status · createdBy` ·
timing: `countdownSeconds · durationSeconds · startedAt? · endsAt? · pausedAt? · totalPausedMs · resumeSeq` ·
frozen rules: `scoringSnapshot Json · rewardSnapshot Json` ·
outcome: `winningTeamId? · isDraw · completedAt? · cancelledAt? · failureReason?` ·
`createdAt · updatedAt`

> **No `totalContributed` / `giftCount` counters on the battle row.** An earlier
> revision denormalised them here; that would make *every* gift in the battle
> take a row lock on the single battle row, serialising both sides against each
> other — strictly worse than the per-side contention the team rows already
> have, and a denormalisation that can drift from the ledger. Live counters live
> in the Redis mirror (§6.4); the authoritative figures are derived at settlement
> from the contribution ledger (§9.3).

- `@@index([roomId, status])` — the scoring fast path
- `@@index([status, endsAt])` — the recovery sweep
- **partial unique** `(roomId) WHERE status NOT IN (COMPLETED, CANCELLED, FAILED)`
  — raw SQL in the migration; this *is* the duplicate-PK gate, enforced at storage
  rather than by a read-then-write inside a lock.

**`VideoRoomPkTeam`** — `battleId · roomId · side · score BigInt · giftCount · memberCount`, `@@unique([battleId, side])`.

**`VideoRoomPkParticipant`** — `battleId · teamId · roomId · userId · side · score BigInt · giftCount · joinedAt`, `@@unique([battleId, userId])`, `@@index([battleId])`.

**`VideoRoomPkInvitation`** — `battleId · roomId · targetRoomId · inviteeUserId · inviterUserId · side · status · attempt · expiresAt · deliveredAt? · respondedAt? · createdAt`,
`@@unique([battleId, inviteeUserId, attempt])`, `@@index([battleId])`, `@@index([inviteeUserId, status])`.
`targetRoomId` equals `roomId` today; it is the cross-room extension point (§12).

**`VideoRoomPkContribution`** — append-only ledger.
`battleId · roomId · teamId · participantId · side · senderId · receiverId · baseAmount BigInt · multiplierBps Int · scoredAmount BigInt · giftTxnId · batchId? · createdAt`,
`@@unique([battleId, giftTxnId, participantId])` ← duplicate-gift guard,
`@@index([battleId])`, `@@index([participantId])`.

> Audio's equivalent stores `contributorId: receiverId` (`pk-battle.service.ts:256`)
> — the column named "who gave this" holds "who received it", making the sender
> unrecoverable and "top contributor" unanswerable. VR-12 stores both.

**`VideoRoomPkRewardPool`** — `battleId @unique · roomId · strategy · sourceAmount BigInt · poolAmount BigInt · winnerBps · participationBps · bonusBps · allocatedAmount BigInt · computedAt`.
`battleId @unique` is the mint-once guard: a replayed settlement hits the
constraint and loads the existing row instead of minting twice.

**`VideoRoomPkReward`** — `battleId · roomId · userId · teamId? · side? · kind · amount BigInt · currency · walletTxnId? · idempotencyKey · createdAt`,
`@@unique([battleId, userId, kind])` ← replay fails closed,
`@@index([battleId])`, `@@index([userId])`.

### 4.3 Deliberately NOT created

| Brief item | Where it actually lives | Why not a table |
|---|---|---|
| PK Timers | `endsAt` / `pausedAt` / `totalPausedMs` / `resumeSeq` columns + BullMQ jobs | a table would be a third copy of the same truth |
| PK History | `VideoRoomPkBattle` filtered to terminal statuses | every briefed history field is already reachable |
| PK Analytics | derived at query time; settlement enqueues to `ANALYTICS_PROCESSING` | no rollup until a query is measurably too slow |
| `VideoRoomPkResult` RED/BLUE enum | `winningTeamId` + `isDraw` | a 2-valued result enum reintroduces the two-side assumption D2 removes |

### 4.4 Additive changes to shared enums

- `WalletTxnReason` += `PK_REWARD` — `ALTER TYPE ADD VALUE`, safe on the deployed
  PostgreSQL 16; no query enumerates the type exhaustively.
- `VideoRoomLogAction` += `PK_INVITED`, `PK_INVITATION_ACCEPTED`,
  `PK_INVITATION_REJECTED`, `PK_STARTED`, `PK_PAUSED`, `PK_RESUMED`, `PK_ENDED`,
  `PK_RECOVERED`, `PK_REWARD_DISTRIBUTED`.
- `ERROR_CODES` += 11 `VIDEO_ROOM_PK_*` keys (plain object; additive).

---

## 5. State machine

```
CREATED ──invite──▶ INVITED ──client ack──▶ PENDING ──accept──▶ ACCEPTED
                                                                     │ start
                                                                     ▼
                                                                COUNTDOWN
                                                                     │ countdown job fires
                                                                     ▼
                        pause ◀────────────────────────────────▶   LIVE
                     PAUSED  ─────────────── resume ───────────────▶ ▲
                                                                     │ reconnect
                   host drop ────────────────────────────────▶ RECOVERING
                                                                     │ grace expired
                                                                     ▼
     COMPLETED   ◀── end job · manual end · grace expired · room ended
     CANCELLED   ◀── reject · cancel · invitation expiry      (from any non-terminal)
     FAILED      ◀── unrecoverable error                      (from any non-terminal)
```

Terminal: `COMPLETED`, `CANCELLED`, `FAILED`.

`INVITED` vs `PENDING` is not redundant: `INVITED` means rows written and
published; `PENDING` means the invitee's client acknowledged receipt — the
same `DELIVERED` concept VR-8 already established on `VideoRoomInvitation`.
The distinction is what makes **Retry** well-defined: you retry an invitation
stuck in `INVITED`, never one in `PENDING`.

**Enforcement is doubled.** A `const VIDEO_ROOM_PK_TRANSITIONS: Record<Status,
ReadonlySet<Status>>` is the single source of truth and is unit-tested in
isolation; `assertTransition(from, to)` throws `PKBattleException`. Every
persisted transition is additionally a conditional update:

```sql
UPDATE video_room_pk_battles SET status = $to, ... WHERE id = $id AND status = $from
```

Zero rows affected ⇒ another actor moved it ⇒ throw. Two concurrent `pause`
calls: one wins, one gets a 409.

---

## 6. Scoring engine

### 6.1 Placement

`VideoRoomPkScoringService.apply(tx, input)` is invoked from
`VideoRoomGiftContextHandler.onSend`, beside the existing treasure call. Both
returns are merged into one `GiftSendEffects`:

```ts
async onSend(tx, ctx): Promise<GiftSendEffects> {
  const treasure = await this.treasureProgress.apply(tx, { ... });   // existing
  const pk       = await this.pkScoring.apply(tx, {                  // VR-12
    roomId: ctx.contextId, senderId: ctx.senderId,
    receiverIds: ctx.receiverIds, totalCoinValue: ctx.totalCoinValue,
    giftTxnId: ctx.transactionId, batchId: ctx.batchId,
  });
  return {
    acceptedAmount: ctx.totalCoinValue, refundAmount: 0,
    events: [...treasure.events, ...pk.events],
    postCommit: async () => { await treasurePostCommit(); await pkPostCommit(); },
  };
}
```

The `GiftSendEffects` contract is honoured exactly: **Postgres only** inside
`onSend`; Redis, sockets, queue and metrics all happen in `postCommit`. A
treasure or PK fault degrades to "gift succeeded, nothing scored" and never
fails a paid gift.

### 6.2 Algorithm

1. **Fast path** — `SELECT … WHERE roomId=? AND status='LIVE' LIMIT 1` on
   `@@index([roomId, status])`. No live battle ⇒ return inert. Rooms without a
   battle pay one index probe.
   **`COUNTDOWN` and `PAUSED` do not score** — a gift while the clock is frozen
   would create score with no time running against it.
2. **Per-leg value** — `perReceiver = totalCoinValue / receiverIds.length`,
   exact per `gift.service.ts:196-200` (each receiver receives a whole gift). A
   send targeting one host on each side scores both sides correctly.
3. **Per receiver that is a participant of this battle:**
   - `multiplierBps = scoreEngine.resolve(ctx)` (§6.3)
   - `scoredAmount = perReceiver × multiplierBps / 10_000`
   - CAS `UPDATE video_room_pk_teams SET score = score + $n WHERE id = $id AND score = $seen`
     with bounded retry (the VR-11 `applyToBox` pattern); the delta credited is
     the one from the CAS that succeeded, never a re-read difference.
   - CAS `UPDATE video_room_pk_participants` likewise
   - `INSERT video_room_pk_contributions` — storing **both** `baseAmount`
     (pre-multiplier, what the sender actually spent) and `scoredAmount`
     (post-multiplier, what the scoreboard shows). The unique constraint fails a
     replayed send closed at the database.
4. **Return** score events + a `postCommit` that mirrors to Redis (including the
   running gift count and base total) and broadcasts (throttled, §6.4).

No battle-row counter is written, so concurrent gifts to opposite sides never
contend on a shared row (§4.2).

### 6.3 Replaceable score engine

```ts
export interface IPkScoreStrategy {
  readonly key: string;                                    // 'VIP' | 'EVENT' | 'BONUS'
  bonusBps(ctx: PkScoreContext): Promise<number> | number;
}
// totalBps = min(10_000 + Σ strategy.bonusBps(ctx), cfg.multiplierCapBps)
```

Strategies self-register with `VideoRoomPkScoreStrategyRegistry` (the
`GiftContextRegistry` pattern). Ships with `VipMultiplierStrategy` and
`EventMultiplierStrategy`. The **active set and their rates** are frozen into
`scoringSnapshot` at battle creation, so an admin retuning multipliers cannot
change the rules of a battle already in flight; the per-gift VIP tier is still
resolved live per sender.

Additive rather than multiplicative: two "2×" bonuses compose to 3× additively
and 4× multiplicatively. Additive keeps `multiplierCapBps` meaningful and stops
a VIP+event stack becoming the dominant term.

**Known cost:** `VipMultiplierStrategy` reads the sender's tier through `tx`
(the seam forbids Redis in `onSend`) — one indexed read per gift, only when a
battle is live. Escape hatch if it ever shows in the latency budget: a
per-request memo in the handler.

### 6.4 Redis keys (mirror only; Postgres is authoritative)

```
video-room:pk:score:{battleId}      HASH  { RED, BLUE,
                                            giftCount, baseTotal }  live scoreboard + counters
video-room:pk:state:{roomId}        JSON  { status, endsAt }   late-join sync
video-room:pk:emit:{battleId}       stamp                      broadcast throttle
video-room:pk:lifecycle:{roomId}    LOCK  (hash-tagged)        command serialisation
video-room:pk:recovery              LOCK                       fleet-wide sweep
```

Broadcast is throttled to `cfg.scoreEmitPerSecond` per battle (the treasure
`shouldEmit` pattern) so a gift storm cannot fan out hundreds of near-identical
payloads per second. Lifecycle transitions bypass the throttle.

Late join: `GET /pk` returns `{ status, endsAt, serverTime, teams, participants }`.
`serverTime` lets the client correct clock skew rather than trusting its own.

### 6.5 Refund handling — a stated limitation

A gift rolled back *inside* its transaction un-scores itself for free. A gift
reversed *after* commit (`VideoRoomGiftReversalService`) is compensated: a
**negative** contribution row plus a CAS decrement, and **only while the battle
is non-terminal**. Once a battle is `COMPLETED`, rewards are paid and there is
nothing sound to unwind — a post-settlement refund records an audit anomaly and
leaves the result standing. Retroactively changing a finished battle's winner
would be worse than the inconsistency.

---

## 7. Invitation workflow

`create → send → deliver → accept | reject | cancel | expire | retry`.

- **Create** — `POST /pk/invite` under `START_PK`. Creates the battle in
  `CREATED`, its 2 teams, its participants, and one `VideoRoomPkInvitation` per
  invitee; transitions to `INVITED`.
- **Deliver** — the invitee's client acks; invitation → `DELIVERED`, battle →
  `PENDING`.
- **Accept** — authority is *being the named invitee* (a row lookup), not a
  permission. Last required acceptance transitions the battle to `ACCEPTED`.
- **Reject / Cancel** — invitation terminal; if no invitation remains actionable
  the battle → `CANCELLED`.
- **Expire** — the recovery sweep expires past-`expiresAt` invitations.
- **Retry** — a new invitation row with `attempt + 1` for an invitation still in
  `SENT` (never `DELIVERED`); `@@unique([battleId, inviteeUserId, attempt])`
  keeps attempts distinct and replay-safe.
- **Duplicate invitation** is prevented by that same unique constraint.

---

## 8. Timers

- `COUNTDOWN → LIVE`: delayed job `pk-start:{battleId}`, delay `countdownSeconds`.
- `LIVE → COMPLETED`: delayed job `pk-end:{battleId}:{resumeSeq}`, delay = remaining ms.
- **Pause** — remove the pending end job, stamp `pausedAt`, transition to `PAUSED`.
- **Resume** — `resumeSeq += 1`, `totalPausedMs += now − pausedAt`,
  `endsAt += (now − pausedAt)`, reschedule with the new `resumeSeq` in the jobId.
  Bumping `resumeSeq` is what makes a stale job from before the pause a no-op:
  it settles against a `resumeSeq` that no longer matches.
- Stable job ids make queue-level replays idempotent before the service's own
  guards run.
- Both jobs run on `QUEUE_NAMES.GIFT_PROCESSING` (where treasure's jobs already
  live) — no new queue, processor or module registration.

---

## 9. Settlement & rewards

Under the `{roomId}` lifecycle lock:

1. **CAS transition** `LIVE|PAUSED → COMPLETED`. Zero rows ⇒ already settled ⇒
   exit. This alone makes the entire path replay-safe.
2. **Winner** — teams `ORDER BY score DESC`. Distinct top ⇒ `winningTeamId`;
   equal ⇒ `isDraw = true`, `winningTeamId = null`.
3. **Mint the pool** — `sourceAmount = SUM(baseAmount)` over the battle's
   contribution ledger (positive rows minus any §6.5 compensating negatives),
   then `poolAmount = sourceAmount × poolBps / 10_000`. Every bps is read from
   the frozen `rewardSnapshot`, never from live config.
   `INSERT VideoRoomPkRewardPool`; `battleId @unique` is the mint-once guard, and
   on conflict the existing row is loaded rather than a second pool minted.

   **Base, not scored.** Sizing the pool on `scoredAmount` would let a VIP
   multiplier mint money that nobody spent — a 3× multiplier would triple the
   platform's liability for the same coins. Multipliers decide *who wins*; they
   must not decide *how much money exists*. This is what makes D6's "liability ∝
   real spend" actually true.
4. **Distribute** in one transaction:
   - `winnerShare` split evenly across the winning team's participants
   - `participationShare` split across **all** participants (winners receive
     winner + participation)
   - `bonusShare` to the top contributor by `scoredAmount`
   - per recipient: `INSERT VideoRoomPkReward` (unique on `battleId+userId+kind`)
     then `wallet.credit(…, tx)` with
     `idempotencyKey = pk:{battleId}:{userId}:{kind}` — two independent replay
     guards, one at our table and one inside the wallet
   - **Draw** ⇒ the winner slice is not minted at all (not redistributed): a
     drawn battle costs the platform less
   - **Dust** from integer division stays unminted, derivable as
     `poolAmount − allocatedAmount` (the VR-11 rule) rather than handed to an
     arbitrary user
5. **Badge** — `cosmetics.grantToUser({ grantKey: 'video-pk:{battleId}:{userId}' })`.
   The `video-pk:` prefix matters: `grantKey` is a **global** idempotency key and
   audio uses the bare `pk:{battleId}:{userId}` form, so the prefix makes a
   collision structurally impossible rather than merely improbable.
6. **Publish** `PKWinnerDeclared` + `PKRewardDistributed`, enqueue analytics,
   clear the Redis mirror, invalidate cached views.

---

## 10. Recovery

`VideoRoomPkRecoveryService` — periodic tick under the fleet-wide
`video-room:pk:recovery` lock, capped at `MAX_PER_SWEEP` per tick so a backlog
degrades gracefully. The tick always runs; the recovery *actions* are config-gated
(the VR-11 lesson: gating the timer itself left the queue-depth metric reporting
zero forever).

| Condition | Action |
|---|---|
| non-terminal past `endsAt` | re-settle (idempotent via §9.1 + unique constraints) |
| `COUNTDOWN` past its deadline | → `LIVE` |
| invitation past `expiresAt`, still `SENT`/`DELIVERED` | → `EXPIRED`; if none actionable remain → battle `CANCELLED` |
| `RECOVERING` past `orphanTimeoutSeconds` | settle with current scores |
| `LIVE` but room no longer `LIVE` | settle |

**Host disconnect** is driven by the existing presence/media events:
`LIVE → RECOVERING` freezes the clock through the *same* `pausedAt` /
`totalPausedMs` / `resumeSeq` machinery as `PAUSED`. A host reconnecting inside
`recoveryGraceSeconds` resumes to `LIVE`; one who does not triggers settlement
with the scores as they stand. `PAUSED` is operator-initiated, `RECOVERING` is
system-initiated — that is their only difference, and it is why recovery is a
reuse of pause rather than a parallel implementation.

---

## 11. Surface

### 11.1 REST — `@Controller('video-rooms')`, all Swagger-documented

| Method | Path | Guard |
|---|---|---|
| POST | `/video-rooms/:roomId/pk/invite` | `START_PK` |
| POST | `/video-rooms/:roomId/pk/accept` | named invitee |
| POST | `/video-rooms/:roomId/pk/reject` | named invitee |
| POST | `/video-rooms/:roomId/pk/cancel` | `START_PK` |
| POST | `/video-rooms/:roomId/pk/start` | `START_PK` |
| POST | `/video-rooms/:roomId/pk/pause` | `START_PK` |
| POST | `/video-rooms/:roomId/pk/resume` | `START_PK` |
| POST | `/video-rooms/:roomId/pk/end` | `START_PK` |
| GET | `/video-rooms/:roomId/pk` | member |
| GET | `/video-rooms/:roomId/pk/history` | member |
| GET | `/video-rooms/:roomId/pk/statistics` | `VIEW_ANALYTICS` |

Swagger documents authentication, required permission, validation rules,
request/response examples and every error code per endpoint.

### 11.2 Socket — outbound on `/video-room`, relayed by `VideoRoomPkSocketListener`

`pkInvitationSent · pkInvitationAccepted · pkInvitationRejected · pkStarted ·
pkCountdown · pkScoreUpdated · pkPaused · pkResumed · pkEnded · pkWinner ·
pkRecovered`

No new gateway — inbound stays the shared `BaseGateway`, outbound is `EVENT_BUS`
relayed here (the VR-10/11 pattern).

### 11.3 Domain events (`EVENT_BUS`)

`PKInvitationSent · PKInvitationAccepted · PKInvitationRejected · PKCreated ·
PKStarted · PKScoreUpdated · PKPaused · PKResumed · PKEnded · PKWinnerDeclared ·
PKRewardDistributed · PKRecovered`

### 11.4 Listeners (3)

`VideoRoomPkSocketListener` (relay) · `VideoRoomPkAuditListener`
(`video_room_logs`, the 9 new `PK_*` actions, carrying battleId, roomId, hostId,
winnerId, giftId, transactionId, timestamp, requestId) ·
`VideoRoomPkMetricsListener`.

### 11.5 Metrics (9 families on `VideoRoomsMetrics`)

`video_rooms_pk_active` (Gauge) · `video_rooms_pk_battle_duration_seconds` (H) ·
`video_rooms_pk_gift_throughput_total` (C) · `video_rooms_pk_score_latency_seconds` (H) ·
`video_rooms_pk_recoveries_total` (C) · `video_rooms_pk_invitation_outcomes_total` (C, labelled) ·
`video_rooms_pk_winner_calculation_seconds` (H) ·
`video_rooms_pk_reward_distribution_seconds` (H) · `video_rooms_pk_redis_sync_total` (C)

### 11.6 Exceptions (8)

`PKBattleException · PKInvitationException · PKScoreException · PKRewardException ·
PKWinnerException · DuplicatePKException · PKCountdownException ·
BattleRecoveryException` — each binds its own `ERROR_CODES` key, extends
`BusinessException`, defaults to 409 (the treasure precedent: the request was
well-formed, the state disallows it).

### 11.7 DTOs (10)

`CreatePKInvitationDto · AcceptPKInvitationDto · RejectPKInvitationDto ·
StartPKDto · PausePKDto · ResumePKDto · EndPKDto · PKScoreDto ·
PKStatisticsDto · PKResponseDto`

### 11.8 Repositories (3) — no Prisma in any service

`VideoRoomPkRepository` (battles, teams, participants, contributions) ·
`VideoRoomPkInvitationRepository` · `VideoRoomPkRewardRepository` (pool, rewards).

### 11.9 Validations (9)

1. **room exists** — `VideoRoomsRepository.findById`
2. **host exists** — every named participant (both sides) resolves to a user AND
   is an active member of the room whose effective role is seat-bearing
   (`OWNER`/`ADMIN`/`HOST`/`PARTICIPANT`); a `VIEWER` cannot be a PK participant
3. **room LIVE** — `VideoRoomStatus.LIVE`
4. **PK enabled** — config master switch AND the room's settings flag
5. **host online** — presence lookup for every named participant
6. **media active** — `VideoRoomMediaStateService.getSnapshot` shows each
   participant publishing
7. **room not already in PK** — the partial unique index is the enforcement; a
   pre-check exists only to return `DuplicatePKException` instead of a raw
   constraint violation
8. **permission** — `START_PK` for management commands; accept/reject authorise
   on *being the named invitee*
9. **duplicate invitation** — `@@unique([battleId, inviteeUserId, attempt])`

---

## 12. Extensibility — what "no redesign" means concretely

| Future capability | Change required | Not required |
|---|---|---|
| Multi-host PK | add `GREEN`/`YELLOW` to `VideoRoomPkSide`; relax "exactly 2 teams" validation | any table change; any scoring change |
| Cross-room PK | populate `VideoRoomPkInvitation.targetRoomId` with a different room; relax the same-room validation | any table change |
| New scoring algorithm | register another `IPkScoreStrategy` | touching `VideoRoomPkScoringService` |
| New reward strategy | new `strategy` value + branch in the pool service | any table change |
| Tournament PK | out of scope; the battle aggregate is already the natural bracket leaf | — |

---

## 13. Testing (~200 new tests)

Unit · repository · battle · invitation · score-engine · reward · wallet · gift
integration · socket · concurrency · recovery · API · integration. Specifically:

- FSM transition table in isolation; every illegal transition rejected
- scoring CAS under contention; the credited delta is the CAS delta, not a re-read difference
- duplicate gift replay fails closed on the contribution unique constraint
- multi-receiver send split across **both** sides scores both correctly
- `COUNTDOWN`/`PAUSED` gifts do not score
- pause → resume → `endsAt` arithmetic exact; stale pre-pause job is a no-op
- settlement run twice ⇒ exactly one pool, one reward row per (user, kind), one wallet credit
- draw mints no winner slice; dust stays unminted
- all five recovery conditions
- concurrency: two pauses, two settlements, two accepts — one wins, one 409s
- gift-integration path end to end through `VideoRoomGiftContextHandler.onSend`

---

## 14. Acceptance gates

1. **Zero audio regression** — no file under `src/modules/audio-rooms/` or
   `prisma/schema/audio_rooms_*.prisma` modified; the audio PK suite passes
   unchanged.
2. **Zero shared-infrastructure mutation** — no changes under `src/common/`,
   `src/infra/`, `src/modules/gifts/`, `src/modules/wallet/` beyond the three
   additive enum/constant additions in §4.4 and the one new call inside
   `VideoRoomGiftContextHandler.onSend`.
3. **Wiring gate** — grep-proven that every new metric, error code, socket
   event, domain event, config field and repository method has a real
   producer/consumer. *(Carried forward from the Phase 9 audit, which found
   three declared-but-never-called metrics and a config field read nowhere: TDD
   proves "the code does what you said", not "anything calls the code".)*
4. `tsc` clean · ESLint clean · module boundaries clean · DI boots.
5. No pre-existing test regressions.

---

## 15. Open items for the implementation plan

- Migration is authored but **not applied** in this phase (the VR-11 posture);
  the partial unique index requires raw SQL Prisma cannot express.
- Default config values (`poolBps`, `winnerBps`, `participationBps`, `bonusBps`,
  `multiplierCapBps`, `countdownSeconds`, `scoreEmitPerSecond`,
  `orphanTimeoutSeconds`, `recoveryGraceSeconds`, invitation TTL) are set in the
  plan and must all appear in `env.validation.ts` — Phase 9's G-M4 found 17 env
  vars missing from validation, silently falling back to defaults.
