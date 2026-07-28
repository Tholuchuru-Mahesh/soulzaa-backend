# Attendance Streak — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation plan
**PRD reference:** Volume 3 §13 (Attendance Rewards), §2 (Coin Economy — Game Coins)

## Problem

Game Coins have no earning path. The PRD lists Daily Login, Lucky Spin, Events, Daily
Tasks, Achievement Rewards and Promotions as sources; only Events and level-up rewards
are implemented. Casual games (Ludo, Carrom) are priced in Game Coins with a minimum
stake of 10, so a new user with a zero balance cannot play at all.

Three layers are missing:

1. **No trigger.** `user.logged_in` is published by `AuthService` and has no subscriber.
2. **No content.** The Tasks & Missions engine (Phase 17) seeds zero task definitions,
   and `TaskEvaluationService.evaluateEvent()` is never called from any domain event.
3. **No payout.** `TaskRewardService.dispatchReward()` writes a `TaskReward` row and
   publishes `reward.dispatched` — nothing subscribes, so no wallet is ever credited.

This spec covers the attendance streak only. It does not fix the Tasks engine.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | Daily login + attendance streak only |
| Claim model | Explicit claim — login does not pay; the user claims |
| Missed day | Streak resets to Day 1 |
| After Day 30 | Cycle repeats from Day 1 |
| Day boundary | Local midnight, derived from the user's country |
| Ladder shape | Rising with milestone spikes (~12,900 Game Coins per cycle) |

## Architecture

A dedicated `src/modules/attendance` module. It owns its tables and consumes three
existing public ports, so it introduces no module-boundary violations:

- `WALLET_SERVICE` (`IWalletService.credit`) — credits FREE coins
- `COSMETICS_SERVICE` (`ICosmeticsService.grantToUser`) — grants milestone frames
- `EXP_SERVICE` (`IExpService.award`) — awards EXP with `ExpSource.DAILY_LOGIN`

All three are idempotent on a caller-supplied key, which the claim flow relies on.

**Rejected alternatives.** Modelling attendance as a repeating DAILY task in the Tasks
engine would mean fixing a dormant engine and bending it to a shape it lacks (no streak,
no claim endpoint, no payout). Extending the EXP module would bury an unrelated concern
in a frozen module — attendance is not progression.

## Data model

### `AttendanceLadderRung` — seeded, admin-editable

One row per day of the cycle. Follows the treasure-box ladder pattern
(`treasure-config.seeder.service.ts`): seeded on bootstrap, idempotent by day, operators
tune values through the admin API afterwards.

| Field | Type | Notes |
| --- | --- | --- |
| `day` | Int, unique | 1–30 |
| `coins` | Int | Game Coins paid |
| `currency` | WalletCurrency | `FREE` |
| `expAmount` | Int? | null on non-milestone days |
| `cosmeticId` | String? | null unless the day grants a frame |

### `UserAttendance` — current state, one row per user

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | String, PK | |
| `currentDay` | Int | 1–30, the day last claimed |
| `cycleCount` | Int | completed 30-day cycles |
| `lastClaimDayKey` | String | `YYYY-MM-DD` in the user's zone at claim time |
| `lastClaimAt` | DateTime | absolute instant, drives the minimum-interval guard |
| `lastClaimTimezone` | String | IANA zone used for that claim |

### `AttendanceClaim` — immutable log, one row per claim

user, day, cycle, dayKey, coins, currency, expAmount, cosmeticId, timezone, claimedAt.

Support and analytics read this rather than inferring history from wallet balances.
Never updated or deleted.

## Reward ladder

| Day | Coins | EXP | Cosmetic |
| --- | --- | --- | --- |
| 1 | 100 | — | — |
| 2 | 150 | — | — |
| 3 | 200 | — | — |
| 4–6 | 250 | — | — |
| 7 | 500 | 100 | — |
| 8–14 | 300 | — | — |
| 15 | 1000 | 250 | frame |
| 16–29 | 400 | — | — |
| 30 | 2500 | 500 | frame |

Cycle total: **12,900 Game Coins**.

EXP is awarded on all three milestone days (7, 15, 30). The approved outline showed EXP
only against Day 7; awarding it at every milestone is a deliberate change, because a
Day 7 that grants EXP while Day 30 does not would read as an oversight. Flagged here for
veto.

Cosmetic grants are best-effort: the seeder leaves `cosmeticId` null when no matching
catalog cosmetic exists, and a claim with a null `cosmeticId` simply skips that step. The
ladder therefore never hard-depends on catalog contents, and a missing frame cannot block
a user's coins.

## Claim algorithm

Resolve the user's IANA zone from their `country` (canonical map, UTC fallback), then
compute `todayKey` as the local date.

1. `lastClaimDayKey == todayKey` → already claimed. Return current state. This is an
   idempotent success, not an error — a double-tap must not surface as a failure.
2. **Only if the resolved zone differs from `lastClaimTimezone`:**
   `now - lastClaimAt < minHoursBetweenClaims` → reject. See the exploit note below for
   why this is conditional rather than unconditional.
3. `lastClaimDayKey == yesterdayKey` (the previous local date, computed in the resolved
   zone) → advance. `currentDay 30` rolls to Day 1 and increments `cycleCount`.
4. Otherwise → reset to Day 1.

Then, for the resolved day's rung:

- credit `coins` FREE via `WALLET_SERVICE`
- award `expAmount` via `EXP_SERVICE` when non-null
- grant `cosmeticId` via `COSMETICS_SERVICE` when non-null
- write the `AttendanceClaim` row and update `UserAttendance`

Every external call is keyed `attendance:{userId}:{dayKey}` (plus a per-kind suffix), so a
retry maps to the same wallet, EXP and backpack rows rather than paying twice. The whole
sequence runs in one Prisma transaction under the user's wallet lock, so two concurrent
claims cannot both advance the streak.

## Timezone handling

The day boundary is local midnight derived from `User.country`. Two risks follow, both
addressed rather than accepted:

**Multi-zone countries.** A country maps to a single canonical IANA zone (India →
`Asia/Kolkata`, USA → `America/New_York`). Users in other zones of the same country see a
boundary offset from their wall clock. The zone used is written to each claim row, so a
later mapping correction is auditable instead of silently rewriting history. A country
absent from the map — and a user with no country set at all, since the field is nullable —
falls back to UTC.

**Country-edit exploit.** Because the boundary is local, a user could switch country to a
zone already on tomorrow's date and claim a second time within a few hours. The
`minHoursBetweenClaims` guard (default 20) blocks this.

The guard is applied **only when the resolved zone differs from the zone recorded on the
previous claim**. An unconditional interval check would reject honest users: someone in
`Asia/Kolkata` claiming at 23:00 and again at 00:30 the next night is 1.5 hours apart but
genuinely on a new local day, and would be refused. Since the exploit requires changing
country, gating the check on a zone change targets it exactly and leaves every same-zone
claim to the day-key rule alone — which in a fixed zone cannot advance more than once per
24 hours.

A user who does change country waits at most 20 hours before their next claim, which is
close to a normal daily cadence and an acceptable cost for a rare action.

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `feature.attendance.enabled` | `true` | Feature flag; a disabled module rejects claims |
| `attendance.min_hours_between_claims` | `20` | Minimum interval between claims |

Seeded through `DEFAULT_PLATFORM_SETTINGS`, consistent with the economy keys. The ladder
itself lives in its own table rather than config, because it is tabular data with 30 rows.

## API

Both routes are member-scoped and JWT-guarded, matching other user-facing endpoints.

**`GET /attendance`** — current day, `cycleCount`, whether today is claimable, the full
ladder, and the instant the next day opens (local midnight in the user's zone).

**`POST /attendance/claim`** — claims today's rung. Returns the day claimed, coins paid,
EXP awarded, cosmetic granted, the new streak state, and whether this call was a replay of
an existing claim.

## Error handling

| Case | Behaviour |
| --- | --- |
| Claim twice in one local day | Idempotent success; returns existing state, pays nothing |
| Claim inside the minimum interval after a country change | `409` with the instant the next claim opens |
| Wallet credit fails | Transaction rolls back; no state advanced, no claim row |
| Cosmetic missing from catalog | Coins and EXP still paid; cosmetic skipped and logged |
| Ladder rung missing for a day | `500` — a gap in a seeded 30-row ladder is a defect, not a user-facing condition |
| Feature flag disabled | `403` on claim; `GET` still returns state |

## Testing

Streak arithmetic carries the most risk, so it gets the most coverage:

- consecutive days advance 1 → 2 → 3
- a one-day gap resets to Day 1
- Day 30 → Day 1 with `cycleCount` incremented
- claims either side of local midnight in a non-UTC zone
- a claim at 23:00 followed by one at 00:30 next local day is **accepted** (the guard must
  not fire when the zone is unchanged)
- a country change inside the minimum interval is **rejected**
- a country change after the minimum interval is accepted
- a user with no country, and a country absent from the map, both falling back to UTC

Plus: claiming twice in a day is idempotent and pays once; two concurrent claims produce
exactly one payment; a wallet failure leaves no `AttendanceClaim` row and no advanced
streak; a null `cosmeticId` still pays coins.

## Out of scope

Daily tasks, Lucky Spin, and wiring `reward.dispatched` to real payouts. The Tasks engine
remains dormant after this work; making it functional is its own piece.

## Future extension points

- The ladder table generalises to other cycle lengths by seeding a different row count.
- `AttendanceClaim` gives the Tasks engine a precedent for a real payout log when it is
  wired up.
- If per-user timezones are added to the profile later, the country map becomes a
  fallback rather than the source.
