# Agency Dashboard — Design

**Date:** 2026-08-13
**Repos:** `soulzaa-backend` (API), `soulzaa-mobile` (Flutter screen)
**Status:** Approved for planning

## Problem

An approved agency has nowhere to go. `AgencyStatusScreen`'s "Go to Dashboard" button sends
them to `/home` — the ordinary user home — because no agency dashboard exists. The Figma
design defines one: eleven sections covering wallet, community size, growth, performance and
top performers.

There is also no agency-owner-facing API. `AgencySettlementController` exists but every route
is RBAC-gated for platform staff (`agency.settlement.view`), takes `agencyId` as a path
parameter, and returns global platform figures. An agency owner asking about their own
community has no endpoint to call.

## Constraints

1. **No hardcoded or invented numbers.** Every figure rendered comes from a real query. Where
   the platform has no data source, the card renders a muted `—`, never a plausible-looking
   fake. Confirmed by the user: "muted is acceptable as of now there is no data".
2. **The agency is a user.** There is no `Agency` entity. An approved `AGENCY` role request
   grants the RBAC role, and `agencyId` throughout `agencies.prisma` is that user's id —
   `AgencySettlementService` credits `walletService.credit({ userId: agencyId, … })`.
   The dashboard is therefore scoped to the JWT caller's own id.
3. **No new Flutter dependencies.** `build_runner` cannot run in this repo (`dart_style` is
   too old for Dart 3.10.7), so models are hand-written `fromJson` — no `@freezed`. No chart
   package is installed; the growth chart is a `CustomPainter`.
4. **Layout must match the Figma.** Card order, chrome and iconography follow the export in
   `soulzaa-mobile/assets/Dashboard/`.

## Data sources — every figure and its origin

Seven sections resolve to real queries. Four have no source in the platform today.

| # | Section | Source | Real? |
|---|---------|--------|-------|
| 1 | Header — agency name | caller's user profile `displayName` | yes |
| 2 | Agency wallet | `walletService.getBalance(callerId).diamond` | yes |
| 3 | Coin seller status | `RoleResolver.hasRole(callerId, 'COIN_SELLER')` → Active / Not active | yes |
| 3b | Coin seller balance | `CoinSellerInventory.availableBalance` where `sellerId = callerId` | yes |
| 4 | Total users | `agency_relationships` where `agencyId = callerId AND status = 'ACTIVE'` | yes |
| 4b | Daily active users | those `hostId`s having a `user_sessions.lastActivityAt >= now - 24h` | yes |
| 4c | Monthly active users | same, `>= now - 30d` | yes |
| 4d | Deltas ("vs last month") | same window shifted back one period, as a percentage change | yes |
| 5 | Target progress | **nothing stores an agency target** | no |
| 6 | Performance score / grade | **no scoring formula exists** | no |
| 7 | Operations (4 counters) | **no agency-scoped tasks/events/achievements; no support-ticket system at all** | no |
| 8 | Reward inventory | **no agency reward inventory** | no |
| 9 | Assigned tasks | **nothing assigns tasks to an agency** | no |
| 10 | Community growth | cumulative active relationships per day from `effectiveFrom` / `effectiveUntil` | yes |
| 11 | Top performers | `agency_settlements` grouped by `hostId`, summed over the period, joined to profile | yes |

### Why `diamond` and not `EARNINGS`

`WalletCurrency.EARNINGS` is marked `@deprecated — use DIAMOND instead` in `wallet.prisma`,
and `Wallet.earningsBalance` is a legacy column kept only so old ledger rows stay valid.
`AgencySettlementService` still credits `EARNINGS`, but the canonical balance to *read* is
`diamondBalance`, exposed as `WalletBalances.diamond`. Reading `earningsBalance` would show a
stale number.

### The unavailable metrics

The endpoint returns `null` — not `0` — for every metric with no source. `null` and `0` mean
different things: an agency with zero assigned tasks and an agency on a platform with no task
system both deserve different treatment, and only `null` is honest about the second. The
Flutter layer turns `null` into a muted `—` plus a one-line note. When those features are
built later, the endpoint starts returning numbers and the UI needs no change.

## Architecture

### Backend — `src/modules/agencies/`

New files, following the `creator-center` self-serve pattern rather than the admin
`AgencySettlementController` pattern:

| File | Responsibility |
|------|----------------|
| `controllers/agency-dashboard.controller.ts` | `@Controller('agencies/me')`; `GET /dashboard`, `GET /growth` |
| `services/agency-dashboard.service.ts` | Composes the payload |
| `services/agency-community.service.ts` | Member counts, active counts, deltas, growth series |
| `dto/agency-dashboard-query.dto.ts` | `range` enum for the growth endpoint |

`AgencyDashboardService` stays an orchestrator; the member/session/growth queries — the only
non-trivial SQL here — live in `AgencyCommunityService` so each file has one job and can be
tested on its own. Top performers extends the existing `AgencyQueryService`, which already owns
grouped settlement queries.

**Security.** Both routes derive the agency id from `@CurrentUser().id`. `agencyId` is never
accepted from the client, in any form — this is the rule `CreatorCenterController` documents
and follows, and it is what keeps one agency from reading another's community. The global
`JwtAuthGuard` authenticates; the existing `RbacRolesGuard` + `@RequireRoles('AGENCY')`
authorizes. No new guard is written — `RbacRolesGuard` resolves roles from the `user_roles`
RBAC tables via `RoleResolver`, which is the source role-request approval writes to
(`roleService.assignRoleToUser`). The legacy `User.roles` column is explicitly documented as
"being retired" in `users.prisma` and must not be read.

For the same reason, coin-seller status is `RoleResolver.hasRole(callerId, 'COIN_SELLER')`,
not a `User.roles` array check.

### Endpoints

```
GET /agencies/me/dashboard
GET /agencies/me/growth?range=week|month|quarter     (default: month)
```

`GET /dashboard` embeds the default (`month`) growth series so the first paint draws a complete
screen in one request. `GET /growth` exists only for subsequent dropdown changes, refetching
~30 points instead of the whole page.

`GET /agencies/me/dashboard` response:

```jsonc
{
  "agency":      { "displayName": "…", "avatarUrl": "…" },
  "wallet":      { "coins": "15222" },
  "coinSeller":  { "active": true, "availableBalance": "4300" },   // availableBalance null if no inventory row
  "community":   {
    "totalUsers":   { "value": 7541, "changePercent": 10.1, "comparedTo": "LAST_MONTH" },
    "dailyActive":  { "value": 2168, "changePercent":  9.8, "comparedTo": "YESTERDAY" },
    "monthlyActive":{ "value": 5639, "changePercent": 15.8, "comparedTo": "LAST_MONTH" }
  },
  "target":      null,          // no source
  "performance": null,          // no source
  "operations":  null,          // no source
  "rewardInventory": null,      // no source
  "assignedTasks":   null,      // no source
  "growth":      { "range": "month", "points": [{ "date": "2026-08-01", "value": 6900 }] },
  "topPerformers": [
    { "rank": 1, "userId": "…", "displayName": "Ramya", "avatarUrl": "…", "points": "10221" }
  ]
}
```

Coin amounts are strings — they are `BigInt` in Prisma and JSON numbers lose precision past
2^53. This matches how `AgencyQueryService` and `AgencyStatisticsService` already serialise.

`changePercent` compares against a baseline measured the same way, one period earlier:
`totalUsers` against the active member count as of 30 days ago, `monthlyActive` against the
30-day window ending 30 days ago, `dailyActive` against the 24-hour window ending 24 hours ago.
It is `null` when that baseline is zero — a change from 0 is not a percentage, and rendering
`∞%` or `100%` would both be wrong.

### Mobile — `soulzaa-mobile/lib/features/profile/`

The agency flow already lives under `profile/`; the dashboard joins it rather than starting a
parallel feature tree.

```
data/models/agency_dashboard_models.dart          hand-written fromJson, null-preserving
data/datasources/agency_dashboard_remote_data_source.dart
data/repositories/agency_dashboard_repository.dart
presentation/controllers/agency_dashboard_controller.dart   AsyncNotifier, mirrors AgencyStatusController
presentation/providers/agency_dashboard_providers.dart      appended to the existing agency_providers style
presentation/screens/agency_dashboard_screen.dart           scroll + pull-to-refresh, composes the cards
presentation/widgets/dashboard/
    dashboard_card.dart              shared white-rounded chrome (replaces the Rectangle *.png exports)
    dashboard_metric.dart            value + label + delta; owns the null → "—" decision, one place
    dashboard_header.dart            hamburger, bell, "Agency dashboard", welcome line
    agency_summary_row.dart          wallet + coin seller
    community_overview_card.dart
    target_progress_card.dart
    performance_card.dart
    operations_card.dart
    quick_actions_row.dart           reward inventory + assigned tasks
    community_growth_card.dart       range dropdown + chart
    growth_chart_painter.dart        CustomPainter: gradient fill, axis labels, grid
    top_performers_card.dart
```

One card per file keeps every file small enough to reason about, and `dashboard_metric.dart`
being the single place that decides `—` vs a number means the "no fake data" rule is enforced
in one spot rather than repeated in nine widgets.

The growth range dropdown is backed by its own family provider keyed by range, so changing it
leaves the rest of the screen untouched.

### Assets

`assets/Dashboard/` is registered in `pubspec.yaml`. Only the twelve icons are used:

| File | Use |
|------|-----|
| `image 234.png` | total users |
| `image 235.png` | daily active users |
| `image 239.png` | monthly active users |
| `image 241.png` | target progress |
| `image 242.png` | operations — tasks |
| `image 243.png` | performance grade badge |
| `image 244.png` | operations — trophy |
| `image 245.png` | operations — events |
| `image 246.png` | operations — support tickets |
| `image 247.png` | reward inventory |
| `image 248.png` | assigned tasks |
| `image 32.png` | coin |

The `Rectangle *.png` and `Line 41.png` exports are fixed-size empty card backgrounds, a pink
pill and a chart gradient. They are deliberately **not** used — a 368px-wide PNG card
background does not scale across phone widths. `BoxDecoration` and the `CustomPainter`
reproduce them at any size.

### Navigation

- New route `/profile/agency/dashboard`, `RouteNames.agencyDashboard`.
- `AgencyFlowGate` gains a third outcome: no application → marketing screen; open request →
  status tracker; `APPROVED` → the dashboard. Today the gate only distinguishes
  `blocksNewApplication` from everything else, so an approved agency is shown the
  "Become an Agency" pitch for something they already have.
- `AgencyStatusScreen`'s "Go to Dashboard" points at the new route instead of `/home`.

### Link targets

Per the approved decision, links go to screens that exist and are visibly disabled otherwise:

| Affordance | Behaviour |
|------------|-----------|
| `view wallet >` | existing wallet screen |
| bell | existing notifications screen |
| hamburger | drawer listing only the destinations that exist |
| `view coin panel >`, `view details >`, `view inventory >`, `view Tasks >`, `view full leaderboard >` | rendered greyed and non-tappable |

A disabled link is honest; a link that navigates nowhere reads as a bug.

## Error handling

- **Load failure** — whole-screen error state with a retry button, matching how
  `AgencyStatusController` maps errors through `ErrorMapper.toException`.
- **Growth failure** — only the chart card shows an inline retry; the rest of the screen keeps
  its data.
- **Non-agency caller** — `RbacRolesGuard` throws `ForbiddenException`. The route is only
  reachable via the gate, so this is defense in depth rather than an expected path.
- **Brand-new agency (zero hosts)** — every real metric legitimately returns `0`, the growth
  series is flat, and top performers is empty. This is a correct answer, not an error, and the
  cards render zeros with an empty-leaderboard message.

## Testing

**Backend**
- `AgencyCommunityService`: member counts exclude `TERMINATED` relationships; active counts
  only count hosts belonging to the caller; deltas return `null` on a zero baseline.
- `AgencyDashboardService`: unavailable metrics serialise as `null`, never `0`; `BigInt`
  fields serialise as strings.
- Scoping: an agency requesting the dashboard never sees another agency's hosts.

`RbacRolesGuard` is already covered by `rbac-permissions.guard.spec.ts` and is not re-tested.

**Mobile**
- `fromJson` preserves `null` for unavailable metrics rather than defaulting to `0`.
- `dashboard_metric.dart` renders `—` for `null` and the formatted number otherwise.
- `AgencyFlowGate` routes an `APPROVED` application to the dashboard.

## Out of scope

Deliberately not built here — each needs its own spec:

- Agency target model and target-setting UI
- Agency performance scoring formula
- Agency-scoped tasks, events and achievements
- Agency reward inventory
- A support-ticket system (none exists platform-wide)
- The five screens behind the disabled links

The dashboard is built so that each of these, once it exists, changes only a service method —
the endpoint shape and the UI already accommodate them.
