# User-Location-Based Timings — Design

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan

## Problem

Every scheduled reset and period boundary in the platform is computed in UTC (or, in three
places, in the server's local timezone). A user in India sees their daily tasks reset at
05:30 IST and a room's treasure box restart mid-morning. Timings should follow the user's
location.

Three facts constrain the solution:

1. **No timezone data exists.** `User`, `UserProfile`, and `UserDevice` carry `country` but
   no timezone. The mobile app sends none. There is no date/timezone library and no
   `@nestjs/schedule` — every schedule is a hand-rolled `setTimeout`/`setInterval`.
2. **Timing is already inconsistent.** Treasure boxes use UTC midnight; task period keys and
   two limit checks use *server*-local time; `RankingPeriodResolver` carries a `utc | local`
   toggle whose `local` mode means server-local, not user-local.
3. **Not everything is per-user.** A treasure session is keyed by `roomId`, one per day per
   room. Users in one room can be in different countries, so a per-viewer reset would mean
   two people in the same room seeing different box states.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Personal timings follow the user's local midnight; shared/competitive timings follow one fixed platform anchor.** | The only option without a contradiction. A room's box and a global ladder must close at one instant for everyone; a user's own task list need not. |
| 2 | **Timezone comes from the device**, as an IANA zone reported on register/login, with a fallback chain. | Accurate, auto-follows travel, and `RegisterDeviceDto` already carries an optional `country`, so the field slots in with no new endpoint. |
| 3 | **The platform anchor is configurable, defaulting to `'UTC'`.** | Behaviour is identical to today until someone changes it — the lever exists without a forced migration of live ladder data. |
| 4 | **Add `luxon`** for the timezone math. | Local-midnight-as-UTC-instant, DST gaps, half-hour offsets and ±14h zones are exactly where hand-rolled code breaks; the existing hand-rolled ISO-week helpers already demonstrate the risk. |
| 5 | **The daily withdrawal cap stays on the platform anchor**, despite being per-user. | It is a risk control, not a user-facing restart. User-local would let a device-timezone change unlock two limit windows inside 24 hours. |
| 6 | **One-time rollout discontinuity absorbed by deploy timing, not a backfill.** | See [Rollout](#rollout) — the exposed offset ranges are empty at 09:00–10:00 UTC. |

## Architecture

Two new units under `src/common/time/`, split so the error-prone half needs no mocks.

### `TimeService` — pure, no I/O, zone always a parameter

```ts
type PeriodName = 'daily' | 'weekly' | 'monthly';

periodKey(period: PeriodName, at: Date, zone: string): string
// 'daily' → '20260728' | 'weekly' → '2026W31' | 'monthly' → '202607'

window(period: PeriodName, at: Date, zone: string): { start: Date; end: Date }
// half-open [start, end) as UTC instants

nextMidnight(zone: string, from?: Date): Date
// start of the next local day, as a UTC instant

isValidZone(s: string): boolean
```

### `ZoneResolverService` — the I/O half

```ts
platform(): Promise<string>            // reads platform config, cached
forUser(userId: string): Promise<string>
```

Call sites read as `const zone = await this.zones.forUser(userId)` (personal) or
`await this.zones.platform()` (shared), then `this.time.window('daily', now, zone)`.

`RankingPeriodResolver` keeps its shape, but its `'local'` mode — which today means
*server*-local, as its own docblock concedes — is deleted in favour of an explicit zone
parameter. Its sole `'local'` caller is `rankings.service.ts:434-436`; since the production
container runs UTC, moving it to the anchor preserves production behaviour exactly.

**No new scheduler.** Personal resets are lazy: the period key is derived at read/write time,
so a user's day rolls over implicitly with no job touching their row. The only scheduled
timing remains the existing treasure reset, on the platform anchor.

## Data model

```prisma
model User {
  preferredLanguage String?
  timezone          String?   // IANA, e.g. "Asia/Kolkata"; null → fallback chain
}

model UserDevice {
  country  String?
  timezone String?            // last IANA zone this device reported
}

model TaskProgress {
  periodKey String  @default("alltime")   // existing
  zone      String?                       // new: zone the key was derived in, for audit
}

model VipMembership {
  lastClaimedDailyAt    DateTime?   // existing, retained for audit
  lastClaimedWeeklyAt   DateTime?
  lastClaimedMonthlyAt  DateTime?
  lastClaimedDailyKey   String?     // new
  lastClaimedWeeklyKey  String?     // new
  lastClaimedMonthlyKey String?     // new
}
```

Plus one platform-configuration key `platform.timezone`, default `'UTC'`.

`TaskProgress.periodKey` already exists and is covered by `@@unique([taskId, userId, periodKey])`,
so the design needs no change to its uniqueness semantics.

VIP needs the new key columns because it currently compares *timestamps*: recomputing an old
`lastClaimedDailyAt` in a user's **new** zone can flip which day it belongs to. Storing the key
at claim time makes a claim immutable under later zone changes.

## Zone resolution

`forUser(userId)`, first hit wins:

1. `User.timezone`, if present and still a valid IANA zone
2. `timezone` of the most-recently-active non-deleted `UserDevice`
3. static `country → zone` map, keyed off `User.country` — **single-timezone countries only**
4. the platform anchor

Rung 3 deliberately covers only countries that have exactly one timezone. Multi-timezone
countries (US, RU, BR, AU, CA, MX, ID, KZ, …) are omitted from the map and fall straight
through to the anchor, because picking a "representative" zone for them is wrong for most of
their users and wrong silently. A country is either unambiguous or it is not a signal.

`forUser` is cached per user for 15 minutes and invalidated on device register, because gift and
task increments are hot paths. `platform()` follows the existing platform-configuration
cache/reload pattern (`CONFIG_RELOAD_MS`) rather than introducing a second caching scheme.

**Ingestion.** `timezone?: string` is added to `RegisterDeviceDto`, validated by an
`@IsIanaTimeZone()` decorator backed by `Intl.supportedValuesOf('timeZone')` (Node reports 418
zones in this environment). The device upsert writes it to `UserDevice` and through to
`User.timezone` when it differs.

**Mobile change, in full:** send `Intl.DateTimeFormat().resolvedOptions().timeZone` on device
register and on app foreground. Nothing else.

## Surface inventory

### Personal → user's local midnight

| Surface | Location |
|---------|----------|
| Task period keys (daily/weekly/monthly) | `tasks/services/task-progress.service.ts:145` (`buildPeriodKey`), `:171` (`isoWeek`) |
| VIP "already claimed today" gate | `vip/services/vip-reward.service.ts:29-36` |

### Shared → platform anchor

| Surface | Location |
|---------|----------|
| Treasure sessions + midnight reset job | `treasure-boxes/services/treasure-box.service.ts:33,114`; `treasure-progress.service.ts:68`; `treasure-reset.service.ts:32,66`; `treasure.service.ts:110,252,444` |
| Ranking period resolver | `rankings/services/ranking-period.resolver.ts:49-93`; caller `rankings.service.ts:434-436` |
| Enterprise rankings | `leaderboard.service.ts:136`; `ranking-calculation.service.ts:288,318`; `ranking-snapshot.service.ts:100`; `ranking-statistics.service.ts:14`; `ranking.service.ts:114` |
| Gift leaderboard | `gifts/services/gift-leaderboard.service.ts:133,138,140` |
| Video-room rankings + analytics | `video-room-analytics.listener.ts:19`; `video-room-analytics-aggregation.service.ts:29`; `dateKeyFor` callers in `video-room-ranking{,-jobs,-query}.service.ts`, `video-room-leaderboard.service.ts` |
| Enterprise event statistics | `enterprise-events/services/event-statistics.service.ts:14` |
| Achievement statistics | `achievements/services/achievement-statistics.service.ts:9` |
| EXP/level statistics | `exp/services/level-statistics.service.ts:9` |
| Global broadcast daily quota | `notification/services/notification-validation.service.ts:44` |
| Daily withdrawal cap (decision 5) | `withdrawals/services/withdrawal-validation.service.ts:63` |

The last two currently use `setHours` (server-local). No `TZ` is set in the `Dockerfile` or
either compose file, so the container runs UTC and these are *accidentally* correct in
production while being wrong on every developer machine. Moving them onto the anchor fixes the
latent bug and preserves production behaviour.

## Rollout

The shared half is a pure refactor: the anchor defaults to `'UTC'`, so output is byte-identical
and the existing treasure and ranking specs pass unchanged. That is the evidence the shared
migration is behaviour-preserving. All real risk is in the two personal surfaces.

At the instant the personal switch goes live, a user's period key changes from UTC-derived to
local-derived. Two failure shapes:

- **East of UTC** (`utcHour + offset ≥ 24`): the key jumps forward, tasks reset early, the user
  gets one extra claim. A giveaway.
- **West of UTC** (`utcHour + offset < 0`): the key jumps backward onto a key the user may have
  already claimed, so the claim is silently lost until their local midnight. This is the shape
  that produces support tickets.

Solving both: east exposure requires `offset ≥ 24 − utcHour`; west exposure requires
`offset < −utcHour`. A deploy landing at **09:00–10:00 UTC** leaves east exposed only above
+14 (no such zone exists) and west only below −9.5 (Niue, Midway, Hawaii). The discontinuity is
therefore empty for essentially every real user, with no backfill and no feature flag.

A backfill was rejected on the strength of that window alone: it closes the gap for effectively
the entire user base without touching a row. Note that because Phase 1 ships and bakes first
(see [Delivery phases](#delivery-phases)), most active users **will** already have a real
timezone stored by the time the personal switch lands — so the discontinuity is computed against
genuine zones, not a fallback-to-UTC population, and the deploy-window math above applies at
full strength.

## Delivery phases

Three phases, each independently mergeable and shippable. Phases 2 and 3 both depend on Phase 1
and are independent of each other, so they can ship in either order or in parallel. Risk is
deliberately concentrated in Phase 3 alone.

### Phase 1 — Foundation (zero behaviour change)

Add `luxon`. Build `src/common/time/` (`TimeService`, `ZoneResolverService`). Add the
`platform.timezone` config key defaulting to `'UTC'`. Migrate `User.timezone` and
`UserDevice.timezone`. Add `timezone?` to `RegisterDeviceDto` with the `@IsIanaTimeZone()`
validator, and the device-upsert write-through. Ship the one-line mobile change.

Nothing consumes the resolver for timing decisions yet — this phase only *collects* timezones
and makes the primitives available.

*Exit criteria:* new `TimeService` and `ZoneResolverService` suites pass; the entire existing
test suite passes untouched; timezone values are observably landing on `UserDevice` in staging.

**This phase should bake for at least one app release cycle before Phase 3**, so that by the
time the personal switch lands, the active user base has real zones on record rather than
falling through to the anchor.

### Phase 2 — Shared surfaces onto the anchor (zero behaviour change)

Replace the ~23 hardcoded UTC and server-local day-boundary sites listed in the
[inventory](#shared--platform-anchor) with `zones.platform()` + `TimeService`. Delete
`RankingPeriodResolver`'s `'local'` mode and update its sole caller. Move the withdrawal cap and
the broadcast quota off `setHours`, fixing the latent server-local bug.

*Exit criteria:* the existing treasure and ranking specs pass **unchanged** — that is the
regression proof — plus the new test pinning the anchor default to `'UTC'`. No deploy-timing
constraint; this phase can ship any hour of any day.

### Phase 3 — The personal switch (the only user-visible risk)

Migrate `TaskProgress.zone` and the three `VipMembership.lastClaimed*Key` columns. Switch
`buildPeriodKey` and the VIP claim gate to `zones.forUser()`. Add the missing `WEEKLY`/`MONTHLY`
guards. Add `nextResetAt` + `timezone` to the personal endpoints.

*Exit criteria:* task and VIP specs cover a non-UTC user crossing their local midnight; deploy
lands in the 09:00–10:00 UTC window per [Rollout](#rollout).

## Edge cases

- **Travel / zone change mid-period.** Period keys are derived at action time and only ever
  *compared*, never used as timers, so a zone change cannot retroactively un-claim anything. A
  westward traveller can get a second "today"; this is accepted and is standard behaviour.
  `TaskProgress.zone` and the VIP key columns keep it auditable.
- **DST.** Local midnight may not exist (spring-forward at midnight in America/Santiago,
  Asia/Beirut) or may occur twice (fall-back). Luxon resolves nonexistent times forward and
  ambiguous times to the earlier offset. `nextMidnight` is therefore "start of next local day",
  never "now + 24h" — a 23-hour or 25-hour day is correct, not a bug.
- **Invalid zone.** Rejected at the DTO; the resolver re-validates on read (a zone can be
  dropped from the IANA database) and falls through to the next rung rather than throwing on a
  hot path.
- **Guests / no device / no country.** The chain terminates at the platform anchor.
- **Extreme zones.** Pacific/Kiritimati (+14) and Pacific/Niue (−11) are 25 hours apart, so two
  users' "today" can be fully disjoint. This only touches per-user surfaces, where no
  cross-user comparison exists.

## Adjacent bug fixed in scope

`vip-reward.service.ts:29-36` guards only `DAILY`. `WEEKLY` and `MONTHLY` have no claim check at
all and can be claimed without limit. This design rewrites exactly those lines, so the missing
guards are added here rather than left behind.

## API changes

Personal endpoints (tasks, VIP) return `nextResetAt` (UTC ISO-8601) and `timezone`, so clients
render a correct countdown instead of assuming midnight. Shared endpoints (treasure status,
leaderboards) return `nextResetAt` computed on the anchor.

## Testing

`TimeService` is pure, so it is tested with no mocks across:

- Asia/Kolkata (+5:30, no DST) and Asia/Kathmandu (+5:45)
- America/New_York (DST in both directions)
- Australia/Lord_Howe (30-minute DST shift)
- America/Santiago (DST transition at midnight → nonexistent local midnight)
- Pacific/Kiritimati (+14) and Pacific/Niue (−11)

Property test: for any instant `t` and zone `z`, `window(p,t,z).start ≤ t < window(p,t,z).end`;
`periodKey` is constant across a window and distinct across adjacent windows.

`ZoneResolverService`: one test per fallback rung, cache hit/miss, invalidation on device
register, and invalid-zone fall-through.

Per-surface: existing specs updated. Treasure and ranking specs asserting UTC boundaries keep
passing unchanged, which is the regression proof for the shared refactor.

Plus a regression test pinning the anchor default to `'UTC'`, so nobody silently moves global
ladder boundaries.

## Out of scope

- Per-room timezones (considered and rejected: adds a field and admin UI per room, and muddies
  cross-room comparison).
- Per-user or per-timezone scheduled jobs (considered and rejected: ~38 repeatable jobs mutating
  user rows, with retry, idempotency and deploy-gap backfill problems, buying nothing the lazy
  period-key approach does not already provide).
- Localised *formatting* of timestamps in API responses beyond `nextResetAt` + `timezone`.
- Migrating the remaining hand-rolled `setInterval` monitors (expiry sweeps, heartbeats); these
  are interval-based, not calendar-based, and have no timezone semantics.
